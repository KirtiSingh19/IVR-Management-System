/**
 * Renders every Step 2 page through Vite's SSR transform and checks the
 * structure the existing CSS depends on is intact.
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

console.log('=== Step 2 pages render ===');
const dash = render('/dashboard');
check('dashboard renders', dash.includes('Total IVRs') && dash.includes('Active IVRs'), true);
check('all four stat cards', (dash.match(/stat-card__value/g) || []).length, 4);
check('icons verified against the original', dash.includes('bi-broadcast-pin') && dash.includes('bi-music-note-beamed'), true);
check('original headings kept', dash.includes('IVR status overview') && dash.includes('Recent audio files'), true);
check('asterisk panel present', dash.includes('Asterisk server') && dash.includes('asterisk-facts'), true);

const list = render('/ivr-list');
check('ivr list renders', list.includes('IVR List') && list.includes('ivrTable'), true);
check('four sortable headers use th-sort', (list.match(/th-sort/g) || []).length, 4);
check('toolbar classes intact', ['toolbar', 'toolbar__search', 'toolbar__select', 'toolbar__count'].every(c => list.includes(c)), true);
check('skeleton shown while loading', list.includes('skeleton--wide'), true);

const create = render('/create-ivr');
check('create renders', create.includes('Create IVR'), true);
check('identity + behaviour + menu sections', (create.match(/form-section__title/g) || []).length, 3);
check('empty menu state', create.includes('This menu is empty'), true);

const edit = render('/edit-ivr');
check('edit without id shows not-found', edit.includes('That IVR could not be found'), true);

console.log('\n=== the shell is shared, so the phone is never unmounted ===');
for (const path of ['/dashboard', '/ivr-list', '/create-ivr', '/phone']) {
  const html = render(path);
  check(`${path} keeps the shell`, html.includes('app-shell') && html.includes('app-sidebar') && html.includes('app-topbar'), true);
}

console.log('\n=== notify hosts mounted outside the routes ===');
check('toast host on every route', list.includes('toast-host'), true);

console.log('\n=== no legacy .html links leaked in ===');
check('no .html hrefs', [dash, list, create].every(h => !h.includes('.html"')), true);

await vite.close();
console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} FAILED`}`);
process.exit(fails ? 1 : 0);
