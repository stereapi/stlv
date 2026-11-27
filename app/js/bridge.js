// Talks to the native shell (mac/main.swift). In a plain browser (dev) every
// call falls back to web APIs, so the editor runs in both.

import { native, h, download } from './util.js';

let seq = 0;
const waiting = new Map();
const handlers = {};

window.stlvBridge = {
  reply(id, v) { const f = waiting.get(id); if (f) { waiting.delete(id); f(v); } },
  event(name, payload) { (handlers[name] || []).forEach(f => { try { f(payload); } catch (e) { console.error(e); } }); },
};

function call(cmd, args = {}) {
  if (!native) return Promise.reject(new Error('not native'));
  return new Promise(res => { const id = ++seq; waiting.set(id, res); window.webkit.messageHandlers.stlv.postMessage({ id, cmd, ...args }); });
}
function send(cmd, args = {}) { if (native) window.webkit.messageHandlers.stlv.postMessage({ cmd, ...args }); }

/* ---------- browser fallbacks ---------- */
let idb;
function db() {
  if (idb) return idb;
  idb = new Promise((res, rej) => { const r = indexedDB.open('stlv', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return idb;
}
async function idbGet(k) { const d = await db(); return new Promise(res => { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); }); }
async function idbSet(k, v) { const d = await db(); return new Promise(res => { const t = d.transaction('kv', 'readwrite'); v == null ? t.objectStore('kv').delete(k) : t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); }
let webClip = null;
// WebKit streams Blob bodies to custom schemes; send plain bytes so the shell gets httpBody
const bodyOf = async b => b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : b;

export const bridge = {
  native,
  on(name, f) { (handlers[name] ||= []).push(f); },
  url: (kind, token) => `stlv://${kind}/${token}`,

  /** -> [{name, path?, token?, file?}] or null */
  async openFiles({ types = [], multiple = false } = {}) {
    if (native) return call('open', { types, multiple });
    return new Promise(res => {
      const inp = h('input', { type: 'file', multiple, accept: types.map(t => '.' + t).join(','), style: { display: 'none' } });
      inp.onchange = () => { res([...inp.files].map(f => ({ name: f.name, file: f }))); inp.remove(); };
      document.body.append(inp); inp.click();
      setTimeout(() => { window.addEventListener('focus', () => setTimeout(() => { if (!inp.files.length) res(null); }, 400), { once: true }); }, 0);
    });
  },
  async read(entry) {
    if (entry.file) return entry.file.arrayBuffer();
    const r = await fetch(this.url('file', entry.token));
    if (!r.ok) throw new Error(`Couldn't read ${entry.name}`);
    return r.arrayBuffer();
  },
  /** -> {name, path, token} | {name, web:true} | null */
  async saveDialog({ name, types = [] }) {
    if (native) return call('save', { name, types });
    const n = prompt('Save as', name); return n ? { name: n, web: true } : null;
  },
  async write(target, blob) {
    if (target.web) { download(blob, target.name); return true; }
    const r = await fetch(this.url('save', target.token), { method: 'POST', body: await bodyOf(blob) });
    const j = await r.json(); if (!j.ok) throw new Error(j.error || 'write failed'); return true;
  },
  async tokenFor(path) { return native ? call('token', { path }) : null; },
  /** a writable file next to one the user chose in a save panel (export each layer) */
  async siblingTarget(target, name) { if (target.web) return { web: true, name }; return call('sibling', { token: target.token, name }); },

  /* app data (settings, autosave, recents) */
  async getData(name, as = 'json') {
    if (!native) { const v = await idbGet(name); if (v == null) return null; if (as === 'json') return typeof v === 'string' ? JSON.parse(v) : v; if (v instanceof Blob) return as === 'blob' ? v : v.arrayBuffer(); return v; }
    const r = await fetch(this.url('data', name)); if (!r.ok) return null;
    return as === 'json' ? r.json() : as === 'blob' ? r.blob() : r.arrayBuffer();
  },
  async setData(name, value) {
    if (!native) return idbSet(name, value instanceof Blob || value == null ? value : JSON.stringify(value));
    const body = value == null ? new ArrayBuffer(0) : value instanceof Blob ? await bodyOf(value) : new TextEncoder().encode(JSON.stringify(value));
    await fetch(this.url('data', name), { method: 'POST', body });
    return true;
  },

  /* clipboard images */
  async clipWrite(blob) {
    webClip = blob;
    if (native) { await fetch('stlv://clip/', { method: 'POST', body: await bodyOf(blob) }); return; }
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch { }
  },
  /** plain text to the system clipboard (it replaces any image there) */
  async clipWriteText(text) {
    webClip = null;
    if (native) { await fetch('stlv://clip/text', { method: 'POST', body: new TextEncoder().encode(text) }); return; }
    try { await navigator.clipboard.writeText(text); } catch { }
  },
  async clipRead() {
    if (native) { const r = await fetch('stlv://clip/'); return r.ok ? r.blob() : null; }
    try { for (const it of await navigator.clipboard.read()) for (const t of it.types) if (t.startsWith('image/')) return it.getType(t); } catch { }
    return webClip;
  },

  fonts: () => call('fonts'),
  fontFile: (family, style) => native ? call('fontFile', { family, style }) : Promise.resolve(null),
  title(title, edited, path) { if (native) send('title', { title, edited, path: path || '' }); else document.title = (edited ? '• ' : '') + title + ' — stlv'; },
  menu(menus) { send('menu', { menus }); },
  menuState(items) { send('menuState', { items }); },
  reveal(path) { send('reveal', { path }); },
  terminate() { if (native) send('terminate'); },
  log(text) { send('log', { text }); },
  beep() { send('beep'); },
  /** a text field has focus: the shell hands ⌘A / ⌘C / ⌘X / ⌘V to it instead of the menus */
  typing(on) { send('typing', { on }); },
  testDone(report, failed) { send('testDone', { report, failed }); },
  snapshot: path => call('snapshot', { path }),
  quitNow() { send('quitNow'); },
};
