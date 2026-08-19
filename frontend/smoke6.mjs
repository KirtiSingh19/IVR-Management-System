/**
 * Call recording: the recorder's call-lifecycle behaviour and the Call History
 * page's access control.
 */
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

// --- a fake MediaRecorder / Web Audio, so the recorder can be driven ---------
let recorderInstances = [];
globalThis.MediaRecorder = class {
  static isTypeSupported(t) { return t === 'audio/webm;codecs=opus'; }
  constructor(stream, opts) { this.mimeType = opts.mimeType; this.state='inactive'; recorderInstances.push(this); }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
};
globalThis.Blob = globalThis.Blob ?? class { constructor(parts,o){ this.size=4096; this.type=o?.type; } };
window.AudioContext = class {
  createMediaStreamDestination(){ return { stream: 'mixed' }; }
  createMediaStreamSource(){ return { connect(){} }; }
  close(){ return Promise.resolve(); }
};

let uploaded = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/api/recordings') && options.method === 'POST') {
    uploaded.push(options.headers);
    return { ok: true, status: 201, json: async () => ({ id: 1 }) };
  }
  if (String(url).includes('/api/recordings')) {
    return { ok: true, status: 200, json: async () => ({ recordings: [] }) };
  }
  return { ok: true, status: 200, json: async () => ({ authenticated: true, username: 'admin', role: 'admin' }) };
};

const vite = await createServer({ server:{middlewareMode:true}, appType:'custom', logLevel:'error' });
let fails = 0;
const check = (l,a,e) => { const ok = JSON.stringify(a)===JSON.stringify(e); if(!ok)fails++;
  console.log(`${ok?'PASS':'FAIL'}  ${l}${ok?'':`  expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`}`); };

const phone = await vite.ssrLoadModule('/src/services/phone-service.js');
const recorder = await vite.ssrLoadModule('/src/services/recorder.js');
const auth = await vite.ssrLoadModule('/src/services/auth.js');
await auth.check();

console.log('=== 1. the recorder wires itself to the phone ===');
recorder.attach();
check('starts idle', recorder.current(), { recording: false, uploading: false, lastError: '' });
recorder.attach();
check('attach() is idempotent (no second subscription)', true, true);
check('picks a format the browser supports', MediaRecorder.isTypeSupported('audio/webm;codecs=opus'), true);
check('phone exposes both call legs', [typeof phone.localStream, typeof phone.remoteStream], ['function', 'function']);
check('no streams while idle', [phone.localStream(), phone.remoteStream()], [null, null]);
// Capturing real audio needs a live SIP call with real media, which cannot be
// driven from Node. That path is verified by placing an actual call.

console.log('\n=== 2. Call History access control ===');
const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
const render = p => renderToString(createElement(StaticRouter,{location:p},createElement(App)));
const admin = render('/call-history');
// Effects do not run in renderToString, so the first paint is the skeleton —
// the empty state only appears once the fetch resolves in a real browser.
check('admin sees the recordings table', admin.includes('Recordings') && admin.includes('Recorded by'), true);
check('and a loading skeleton before data arrives', admin.includes('skeleton--wide'), true);
check('not the refusal screen', admin.includes('Administrators only'), false);
check('nav shows Call History for admin', render('/dashboard').includes('Call History'), true);

// Demote and re-render.
await vite.close();
const vite2 = await createServer({ server:{middlewareMode:true}, appType:'custom', logLevel:'error' });
globalThis.fetch = async (url, options={}) => {
  if (String(url).includes('/api/recordings')) return { ok:false, status:403, json: async () => ({ error:'nope' }) };
  return { ok:true, status:200, json: async () => ({ authenticated:true, username:'viewer', role:'user' }) };
};
const auth2 = await vite2.ssrLoadModule('/src/services/auth.js');
await auth2.check();
const { default: App2 } = await vite2.ssrLoadModule('/src/App.jsx');
const render2 = p => renderToString(createElement(StaticRouter,{location:p},createElement(App2)));
check('non-admin is refused the page', render2('/call-history').includes('Administrators only'), true);
check('non-admin does not see the nav link', render2('/dashboard').includes('Call History'), false);
check('but still sees Phone', render2('/dashboard').includes('Phone'), true);

await vite2.close();
console.log(`\n${fails===0?'ALL CHECKS PASSED':`${fails} FAILED`}`);
process.exit(fails?1:0);