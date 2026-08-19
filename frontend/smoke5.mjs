import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { StaticRouter } from 'react-router-dom/server.js';

const store = new Map();
globalThis.window = {
  isSecureContext: true, location: { origin: 'http://127.0.0.1:5173', search: '' },
  addEventListener() {}, removeEventListener() {}, RTCPeerConnection: function () {},
  sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k,v)=>store.set(k,v), removeItem: k=>store.delete(k) },
  localStorage: { getItem: () => null, setItem() {} },
  matchMedia: () => ({ matches: true, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }),
};
Object.defineProperty(globalThis,'navigator',{value:{mediaDevices:{getUserMedia(){}}},configurable:true});
globalThis.fetch = async () => ({ ok:true, status:200, json: async () => ({ authenticated:true, username:'admin' }) });

const vite = await createServer({ server:{middlewareMode:true}, appType:'custom', logLevel:'error' });
let fails=0; const check=(l,a,e)=>{const ok=JSON.stringify(a)===JSON.stringify(e); if(!ok)fails++;
  console.log(`${ok?'PASS':'FAIL'}  ${l}${ok?'':`  expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`}`);};

const auth = await vite.ssrLoadModule('/src/services/auth.js');
await auth.check();
const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
const render = p => renderToString(createElement(StaticRouter,{location:p},createElement(App)));

const dash = render('/dashboard');
check('sign out is on the dashboard', dash.includes('topbar-signout'), true);
check('inside the top bar, not the page', dash.indexOf('topbar-signout') > dash.indexOf('app-topbar') && dash.indexOf('topbar-signout') < dash.indexOf('app-main'), true);
check('right of the search box', dash.indexOf('topbar-signout') > dash.indexOf('topbar-search'), true);
check('last element in the top bar', dash.indexOf('topbar-signout') > dash.indexOf('topbar-toggle'), true);
check('exactly one sign-out control', (dash.match(/>Sign out</g) || []).length, 1);
check('username still shown in the sidebar', dash.includes('sidebar-user') && dash.includes('admin'), true);

for (const p of ['/dashboard','/ivr-list','/create-ivr','/edit-ivr','/audio-files','/test-ivr','/phone'])
  check(`present on ${p}`, render(p).includes('topbar-signout'), true);
check('not on the login screen', render('/login').includes('topbar-signout'), false);

await vite.close();
console.log(`\n${fails===0?'ALL CHECKS PASSED':`${fails} FAILED`}`);
process.exit(fails?1:0);
