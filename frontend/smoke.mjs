/**
 * Renders the real component tree through Vite's SSR transform, then exercises
 * the mount/unmount contract the SIP connection depends on.
 */
import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { StaticRouter } from 'react-router-dom/server.js';

const store = new Map();
globalThis.window = {
  isSecureContext: true,
  location: { origin: 'http://127.0.0.1:5173', search: '' },
  addEventListener() {}, RTCPeerConnection: function () {},
  sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k,v)=>store.set(k,v), removeItem: k=>store.delete(k) },
  localStorage:   { getItem: () => null, setItem() {} },
  // react-bootstrap's responsive Offcanvas asks the viewport its width.
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
};
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia() {} } }, configurable: true });


// The routes below are guarded now, so the suite must be signed in to render
// them. A stubbed fetch stands in for the API; the guard only cares what
// services/auth.js reports.
globalThis.fetch = async (url) => ({
  ok: true, status: 200,
  json: async () => ({ authenticated: true, username: 'admin' }),
});

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let fails = 0;
const check = (l, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e); if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok ? '' : `  expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`}`); };

console.log('=== 1. the tree renders ===');
const auth = await vite.ssrLoadModule('/src/services/auth.js');
await auth.check();
const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
const html = renderToString(createElement(StaticRouter, { location: '/phone' }, createElement(App)));
check('renders without throwing', html.length > 500, true);
check('shell classes preserved', ['app-shell','app-content','app-main','app-topbar','app-sidebar'].every(c => html.includes(c)), true);
check('phone page rendered', html.includes('SIP account') && html.includes('Dialer'), true);
check('dial pad has 12 keys', (html.match(/keypad__key/g) || []).length, 12);
check('shows Not registered initially', html.includes('Not registered'), true);
check('existing CSS hooks intact', ['card-header__hint','phone-state','phone-actions','asterisk-facts','status--neutral'].every(c => html.includes(c)), true);
check('nav links are router paths, not .html', !html.includes('.html"'), true);

console.log('\n=== 2. unmounting the Phone UI must not touch the connection ===');
const svc = await vite.ssrLoadModule('/src/services/phone-service.js');
const before = svc.current();
// What usePhone does on mount/unmount, twice over, as StrictMode does it.
for (let i = 0; i < 4; i++) { const off = svc.subscribe(() => {}); off(); }
check('state survives repeated mount/unmount', svc.current(), before);
check('no session was invented', svc.hasSession(), false);

console.log('\n=== 3. the service is one module, shared by every consumer ===');
const again = await vite.ssrLoadModule('/src/services/phone-service.js');
check('same module instance for all importers', again === svc, true);
const hook = await vite.ssrLoadModule('/src/hooks/usePhone.js');
check('the hook re-exports that same service', hook.phone.current(), svc.current());

console.log('\n=== 4. subscribe paints immediately, so a remount shows a live call ===');
let seen = null;
svc.subscribe((s) => { seen = s; })();
check('listener called on subscribe', seen !== null, true);

await vite.close();
console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} FAILED`}`);
process.exit(fails ? 1 : 0);
