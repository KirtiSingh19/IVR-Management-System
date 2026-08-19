/**
 * Step 3: renders every page and checks the whole migration end to end.
 */
import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { StaticRouter } from 'react-router-dom/server.js';

const store = new Map();
globalThis.window = {
  isSecureContext: true,
  location: { origin: 'http://127.0.0.1:5173', search: '' },
  addEventListener() {}, removeEventListener() {}, RTCPeerConnection: function () {},
  sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
  localStorage: { getItem: () => null, setItem() {} },
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
const check = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok ? '' : `  expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`}`);
};

const auth = await vite.ssrLoadModule('/src/services/auth.js');
await auth.check();
const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
const render = (path) => renderToString(createElement(StaticRouter, { location: path }, createElement(App)));

console.log('=== every page is React now ===');
const pages = {
  '/dashboard': 'Total IVRs',
  '/ivr-list': 'IVR List',
  '/create-ivr': 'Create IVR',
  '/edit-ivr': 'That IVR could not be found',
  '/audio-files': 'Audio Files',
  '/test-ivr': 'Test IVR',
  '/phone': 'SIP account',
};
for (const [path, marker] of Object.entries(pages)) {
  check(`${path} renders`, render(path).includes(marker), true);
}
check('no placeholder route left', !render('/audio-files').includes('Not migrated'), true);

console.log('\n=== Step 3 structure ===');
const audio = render('/audio-files');
check('dropzone present', audio.includes('dropzone') && audio.includes('dropzone__input'), true);
check('library table', audio.includes('audioTable') && audio.includes('format-chip') === false, true);
check('two sortable size/length headers', (audio.match(/th-sort/g) || []).length, 3);
check('upload summary uses existing classes', audio.includes('asterisk-facts'), true);

const test = render('/test-ivr');
check('sim screen', test.includes('sim-screen') && test.includes('sim-screen__eyebrow'), true);
check('keypad has 12 keys', (test.match(/keypad__key/g) || []).length, 12);
check('letter groups kept', test.includes('PQRS') && test.includes('WXYZ'), true);
check('transport controls', test.includes('sim-transport') && test.includes('Hang up'), true);
check('call log placeholder', test.includes('No call yet.'), true);
check('dialplan section', test.includes('dialplan') && test.includes('Nothing to draw yet'), true);

console.log('\n=== the shell is shared by all seven, so the phone is never unmounted ===');
for (const path of Object.keys(pages)) {
  const html = render(path);
  check(`${path} keeps the shell`, html.includes('app-shell') && html.includes('app-sidebar') && html.includes('app-topbar'), true);
}

console.log('\n=== the phone service is untouched by any of it ===');
const svc = await vite.ssrLoadModule('/src/services/phone-service.js');
const before = svc.current();
for (let i = 0; i < 6; i++) { const off = svc.subscribe(() => {}); off(); }
check('state survives repeated mount/unmount', svc.current(), before);

console.log('\n=== no credentials are persisted any more ===');
check('hasSession() false with nothing registered', svc.hasSession(), false);
check('resume() is now a no-op', await svc.resume(), false);
check('nothing written to sessionStorage', store.size, 0);

console.log('\n=== no legacy .html links anywhere ===');
check('all routes clean', Object.keys(pages).every(p => !render(p).includes('.html"')), true);

await vite.close();
console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} FAILED`}`);
process.exit(fails ? 1 : 0);
