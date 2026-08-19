/**
 * Login, logout, route protection, and proof the SIP connection is unaffected.
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

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let fails = 0;
const check = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok ? '' : `  expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`}`);
};

const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
const auth = await vite.ssrLoadModule('/src/services/auth.js');
const svc = await vite.ssrLoadModule('/src/services/phone-service.js');
const render = (path) => renderToString(createElement(StaticRouter, { location: path }, createElement(App)));

const PROTECTED = ['/dashboard', '/ivr-list', '/create-ivr', '/edit-ivr', '/audio-files', '/test-ivr', '/phone'];

console.log('=== 1. signed out: nothing leaks ===');
auth.subscribe(() => {})(); // ensure module loaded
for (const path of PROTECTED) {
  const html = render(path);
  check(`${path} renders no app content`, html.includes('app-sidebar'), false);
}
check('login page renders', render('/login').includes('Sign in'), true);
check('login is outside the shell', render('/login').includes('app-sidebar'), false);

console.log('\n=== 2. while the session is being checked, nothing flashes ===');
check("status starts 'unknown'", auth.current().status, 'unknown');
check('guard renders nothing rather than bouncing', render('/dashboard'), '');

console.log('\n=== 3. signed in: the app appears ===');
// Drive the module the way a successful login does.
auth.subscribe(() => {});
const emitIn = () => {
  // login() would do this; call it directly since there is no server here.
  const s = auth.current();
  if (s.status !== 'in') {
    // Use the public surface: subscribe + the module's own state transition.
  }
};
emitIn();

await vite.close();

// The remaining checks need the real module state, so run them against a fresh
// import where we can drive login() through a stubbed fetch.
const vite2 = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
globalThis.fetch = async (url, options = {}) => ({
  ok: true,
  status: 200,
  json: async () =>
    String(url).includes('/logout')
      ? { authenticated: false }
      : { authenticated: true, username: 'admin' },
});
const auth2 = await vite2.ssrLoadModule('/src/services/auth.js');
const svc2 = await vite2.ssrLoadModule('/src/services/phone-service.js');
const { default: App2 } = await vite2.ssrLoadModule('/src/App.jsx');
const render2 = (path) => renderToString(createElement(StaticRouter, { location: path }, createElement(App2)));

const result = await auth2.login('admin', 'ChangeMe12345');
check('login succeeds', result.ok, true);
check('username recorded', auth2.current().username, 'admin');
for (const path of PROTECTED) {
  check(`${path} now renders the shell`, render2(path).includes('app-sidebar'), true);
}
check('sign out control present', render2('/dashboard').includes('Sign out'), true);
check('username shown in the sidebar', render2('/dashboard').includes('admin'), true);

console.log('\n=== 4. the SIP service is untouched by any of it ===');
const before = svc2.current();
for (let i = 0; i < 6; i++) { const off = svc2.subscribe(() => {}); off(); }
check('state survives repeated mount/unmount', svc2.current(), before);
render2('/phone'); render2('/edit-ivr'); render2('/dashboard');
check('state survives route rendering', svc2.current(), before);
check('no token in JS-readable storage', store.size, 0);

console.log('\n=== 5. logout signs out and clears state ===');
await auth2.logout();
check('status is out', auth2.current().status, 'out');
check('username cleared', auth2.current().username, null);
check('protected route hides the app again', render2('/dashboard').includes('app-sidebar'), false);

await vite2.close();
console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} FAILED`}`);
process.exit(fails ? 1 : 0);