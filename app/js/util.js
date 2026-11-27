// Small shared helpers: DOM, math, rects, canvases, colour, units, events.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const round = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };
let _uid = 0;
export const uid = (p = 'l') => p + (++_uid).toString(36) + Math.random().toString(36).slice(2, 6);
export const isMac = /Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
export const native = !!window.stlvNative;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const nextFrame = () => new Promise(r => requestAnimationFrame(r));

/** Tiny DOM builder: h('div.cls#id', {attrs, on:{click}}, ...children) */
export function h(sel, attrs, ...kids) {
  const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const p of (m[2] || '').match(/[.#][\w-]+/g) || []) p[0] === '.' ? el.classList.add(p.slice(1)) : el.id = p.slice(1);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [e, f] of Object.entries(v)) el.addEventListener(e, f);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(9)) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Event emitter */
export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, new Set()); this._h.get(ev).add(fn); return () => this._h.get(ev).delete(fn); }
  emit(ev, ...a) { for (const f of [...(this._h.get(ev) || [])]) { try { f(...a); } catch (e) { console.error(e); } } }
}

/* ---------- rects {x,y,w,h} ---------- */
export const R = {
  make: (x, y, w, h) => ({ x, y, w, h }),
  empty: r => !r || r.w <= 0 || r.h <= 0,
  union(a, b) { if (R.empty(a)) return b ? { ...b } : null; if (R.empty(b)) return { ...a }; const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; },
  inter(a, b) { if (R.empty(a) || R.empty(b)) return null; const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), w = Math.min(a.x + a.w, b.x + b.w) - x, hh = Math.min(a.y + a.h, b.y + b.h) - y; return w > 0 && hh > 0 ? { x, y, w, h: hh } : null; },
  out(r) { const x = Math.floor(r.x), y = Math.floor(r.y); return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y }; },
  pad: (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p }),
  fromPts(pts) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of pts) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y); } return { x: a, y: b, w: c - a, h: d - b }; },
  contains: (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h,
  eq: (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h,
};

/* ---------- canvases ---------- */
export function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
const CTX = new WeakMap();
/** 2D context, CPU-backed: layers are read back often (uploads, undo, filters) */
export function ctx(c) { let x = CTX.get(c); if (!x) { x = c.getContext('2d', { willReadFrequently: true }); CTX.set(c, x); } return x; }
export function cloneCanvas(c) { const n = canvas(c.width, c.height); ctx(n).drawImage(c, 0, 0); return n; }
export function getData(c, r) { r = r || { x: 0, y: 0, w: c.width, h: c.height }; return ctx(c).getImageData(r.x, r.y, r.w, r.h); }
export function putData(c, d, x = 0, y = 0) { ctx(c).putImageData(d, x, y); }
export async function loadImage(src) { const i = new Image(); i.decoding = 'async'; i.src = src; await i.decode(); return i; }
export async function blobToImage(blob) {
  if (window.createImageBitmap) { try { return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch { } }
  const u = URL.createObjectURL(blob); try { return await loadImage(u); } finally { setTimeout(() => URL.revokeObjectURL(u), 1000); }
}
export function canvasFromImage(img) { const c = canvas(img.width, img.height); ctx(c).drawImage(img, 0, 0); return c; }
export function canvasToBlob(c, type = 'image/png', q) { return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode failed')), type, q)); }
/** Bounding box of non-transparent pixels, or null */
export function opaqueBounds(c, thr = 0) {
  const w = c.width, hh = c.height, d = getData(c).data;
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) { let row = y * w * 4 + 3; for (let x = 0; x < w; x++, row += 4) if (d[row] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; } }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ---------- colour (r,g,b 0..255, a 0..1) ---------- */
export const C = {
  hex(c) { return '#' + [c.r, c.g, c.b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''); },
  parse(s) {
    s = String(s).trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map(c => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
  },
  css: (c, a = c.a ?? 1) => `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`,
  toHsv({ r, g, b }) {
    r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let hh = 0;
    if (d) hh = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: hh * 60, s: mx ? d / mx : 0, v: mx };
  },
  fromHsv({ h: hh, s, v }) {
    const f = n => { const k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return { r: Math.round(f(5) * 255), g: Math.round(f(3) * 255), b: Math.round(f(1) * 255) };
  },
  eq: (a, b) => a && b && a.r === b.r && a.g === b.g && a.b === b.b,
  lum: c => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255,
};

/* ---------- units ---------- */
export const UNITS = { px: 'Pixels', in: 'Inches', cm: 'Centimeters', mm: 'Millimeters', pt: 'Points', pct: 'Percent' };
export function toPx(v, unit, ppi, ref = 0) {
  switch (unit) { case 'in': return v * ppi; case 'cm': return v * ppi / 2.54; case 'mm': return v * ppi / 25.4; case 'pt': return v * ppi / 72; case 'pct': return v / 100 * ref; default: return v; }
}
export function fromPx(px, unit, ppi, ref = 0) {
  switch (unit) { case 'in': return px / ppi; case 'cm': return px / ppi * 2.54; case 'mm': return px / ppi * 25.4; case 'pt': return px / ppi * 72; case 'pct': return ref ? px / ref * 100 : 100; default: return px; }
}
export function fmtUnit(px, unit, ppi, ref) {
  const v = fromPx(px, unit, ppi, ref);
  const d = unit === 'px' ? 0 : unit === 'mm' || unit === 'pt' || unit === 'pct' ? 1 : 2;
  return String(round(v, d));
}
export const fmtBytes = n => n > 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';

/* ---------- 3x3 matrices (row-major [a b c; d e f; g h i]) for affine / projective maps ---------- */
export const M3 = {
  id: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  mul(a, b) { const o = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]; return o; },
  apply(m, x, y) { const w = m[6] * x + m[7] * y + m[8]; return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w }; },
  inv(m) {
    const [a, b, c, d, e, f, g, hh, i] = m, A = e * i - f * hh, B = -(d * i - f * g), Cc = d * hh - e * g, det = a * A + b * B + c * Cc;
    if (Math.abs(det) < 1e-12) return null;
    return [A / det, -(b * i - c * hh) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, Cc / det, -(a * hh - b * g) / det, (a * e - b * d) / det];
  },
  translate: (x, y) => [1, 0, x, 0, 1, y, 0, 0, 1],
  scale: (sx, sy = sx) => [sx, 0, 0, 0, sy, 0, 0, 0, 1],
  rotate: a => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; },
  /** projective map taking unit square corners (0,0)(1,0)(1,1)(0,1) to quad p[0..3] */
  squareToQuad(p) {
    const [p0, p1, p2, p3] = p;
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
    let g = 0, hh = 0;
    if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) { const den = dx1 * dy2 - dx2 * dy1; g = (sx * dy2 - dx2 * sy) / den; hh = (dx1 * sy - sx * dy1) / den; }
    return [p1.x - p0.x + g * p1.x, p3.x - p0.x + hh * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + hh * p3.y, p0.y, g, hh, 1];
  },
  quadToQuad(a, b) { const A = M3.squareToQuad(a), B = M3.squareToQuad(b); return M3.mul(B, M3.inv(A)); },
};

/* ---------- misc ---------- */
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function throttleFrame(fn) { let q = false, args; return (...a) => { args = a; if (q) return; q = true; requestAnimationFrame(() => { q = false; fn(...args); }); }; }
export function download(blob, name) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
export function fnv(str) { let h1 = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h1 ^= str.charCodeAt(i); h1 = Math.imul(h1, 16777619); } return (h1 >>> 0).toString(36); }
