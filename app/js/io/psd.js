// Photoshop PSD read + write (RGB, 8 bit). Layers with blend modes, opacity,
// fill, clipping, visibility, masks, groups (section dividers), Unicode
// names, resolution and guides. Text, fill and styled layers are written as
// pixels; adjustment layers only show in the merged image.

import { Writer, Reader, inflate } from './binary.js';
import { canvas, ctx } from '../util.js';
import { Doc, PixelLayer, GroupLayer } from '../doc.js';

const KEYS = { normal: 'norm', dissolve: 'diss', darken: 'dark', multiply: 'mul ', colorBurn: 'idiv', linearBurn: 'lbrn', darkerColor: 'dkCl', lighten: 'lite', screen: 'scrn', colorDodge: 'div ', linearDodge: 'lddg', lighterColor: 'lgCl', overlay: 'over', softLight: 'sLit', hardLight: 'hLit', vividLight: 'vLit', linearLight: 'lLit', pinLight: 'pLit', hardMix: 'hMix', difference: 'diff', exclusion: 'smud', subtract: 'fsub', divide: 'fdiv', hue: 'hue ', saturation: 'sat ', color: 'colr', luminosity: 'lum ', pass: 'pass' };
const FROM_KEY = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [v, k]));

/* ---------- PackBits ---------- */
function packRow(src, off, n, w) {
  let i = 0;
  while (i < n) {
    let j = i; while (j + 1 < n && src[off + j + 1] === src[off + i] && j - i < 127) j++;
    if (j > i) { w.u8(257 - (j - i + 1)); w.u8(src[off + i]); i = j + 1; continue; }   // run
    j = i; while (j + 1 < n && j - i < 127 && !(j + 2 < n && src[off + j + 1] === src[off + j + 2])) j++;
    w.u8(j - i); for (let k = i; k <= j; k++) w.u8(src[off + k]); i = j + 1;          // literal
  }
}
function unpackRow(r, n, out, off) {
  let k = 0;
  while (k < n && r.left > 0) {
    const c = r.i8();
    if (c >= 0) { for (let i = 0; i <= c; i++) out[off + k++] = r.u8(); }
    else if (c !== -128) { const v = r.u8(); for (let i = 0; i < 1 - c; i++) out[off + k++] = v; }
  }
}
/** one channel's bytes: compression + RLE rows */
function channelData(plane, w, h) {
  const out = new Writer(plane.length / 2 + 64);
  out.u16(1);
  const rows = new Writer(plane.length / 2 + 64), counts = [];
  for (let y = 0; y < h; y++) { const p0 = rows.p; packRow(plane, y * w, w, rows); counts.push(rows.p - p0); }
  for (const c of counts) out.u16(c);
  out.bytes(rows.out());
  return out.out();
}
function planes(id) {
  const n = id.width * id.height, d = id.data, P = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0; i < n; i++) { P[0][i] = d[i * 4]; P[1][i] = d[i * 4 + 1]; P[2][i] = d[i * 4 + 2]; P[3][i] = d[i * 4 + 3]; }
  return P;
}
function pascal(w, s, pad) {
  const b = new TextEncoder().encode(s).slice(0, 255).filter(c => c < 128);
  w.u8(b.length); w.bytes(b); let len = b.length + 1; while (len % pad) { w.u8(0); len++; }
}
function block(w, key, write) { w.ascii('8BIM'); w.ascii(key); const at = w.p; w.u32(0); const s = w.p; write(w); if ((w.p - s) % 2) w.u8(0); w.dv.setUint32(at, w.p - s); }

/** write a PSD. pixelsOf(layer) -> {canvas, x, y} or null; merged: ImageData of the composite */
export function writePSD(doc, pixelsOf, merged) {
  const w = new Writer(1 << 22);
  const alphaMerged = merged.data.some((v, i) => (i & 3) === 3 && v < 255);
  w.ascii('8BPS'); w.u16(1); w.bytes(new Uint8Array(6)); w.u16(alphaMerged ? 4 : 3); w.u32(doc.height); w.u32(doc.width); w.u16(8); w.u16(3);
  w.u32(0);   // colour mode data
  // image resources
  const res = new Writer(256);
  const resBlock = (id, data) => { res.ascii('8BIM'); res.u16(id); res.u16(0); res.u32(data.length); res.bytes(data); if (data.length % 2) res.u8(0); };
  const ri = new Writer(16), fx = Math.round(doc.ppi * 65536);
  ri.u32(fx); ri.u16(1); ri.u16(1); ri.u32(fx); ri.u16(1); ri.u16(1); resBlock(0x03ED, ri.out());
  if (doc.guides.length) { const g = new Writer(16 + doc.guides.length * 5); g.u32(1); g.u32(576); g.u32(576); g.u32(doc.guides.length); for (const gd of doc.guides) { g.u32(Math.round(gd.pos * 32)); g.u8(gd.axis === 'v' ? 0 : 1); } resBlock(0x0408, g.out()); }
  const rb = res.out(); w.u32(rb.length); w.bytes(rb);

  // flatten the tree bottom -> top, with group dividers
  const recs = [];
  const walk = (g) => {
    for (const l of g.children) {
      if (l.isGroup) { recs.push({ divider: true, l }); walk(l); recs.push({ group: true, l }); }
      else if (l.type === 'adjust') continue;
      else recs.push({ l, px: pixelsOf(l) });
    }
  };
  walk(doc.root);
  const li = new Writer(1 << 20);
  li.i16(recs.length);
  const chans = [];
  for (const r of recs) {
    const l = r.l, list = [];
    let top = 0, left = 0, bottom = 0, right = 0;
    if (r.px && r.px.canvas) {
      const c = r.px.canvas, id = ctx(c).getImageData(0, 0, c.width, c.height), P = planes(id);
      top = r.px.y; left = r.px.x; bottom = top + c.height; right = left + c.width;
      list.push([-1, channelData(P[3], c.width, c.height)], [0, channelData(P[0], c.width, c.height)], [1, channelData(P[1], c.width, c.height)], [2, channelData(P[2], c.width, c.height)]);
    } else { for (const id of [-1, 0, 1, 2]) list.push([id, new Uint8Array([0, 0])]); }
    let mask = null;
    if (!r.divider && l.mask) {
      const m = l.mask, id = ctx(m.canvas).getImageData(0, 0, m.canvas.width, m.canvas.height), P = planes(id);
      mask = { top: m.y, left: m.x, bottom: m.y + m.canvas.height, right: m.x + m.canvas.width, bg: m.bg, disabled: !m.enabled };
      list.push([-2, channelData(P[0], m.canvas.width, m.canvas.height)]);
    }
    li.i32(top); li.i32(left); li.i32(bottom); li.i32(right);
    li.u16(list.length); for (const [cid, data] of list) { li.i16(cid); li.u32(data.length); }
    li.ascii('8BIM'); li.ascii(r.divider ? 'norm' : r.group ? (l.blend === 'pass' ? 'pass' : KEYS[l.blend] || 'norm') : KEYS[l.blend] || 'norm');
    li.u8(r.divider ? 255 : Math.round(l.opacity * 255)); li.u8(!r.divider && l.clip ? 1 : 0);
    let flags = 0x08; if (!r.divider && !l.visible) flags |= 0x02; if (l.lock && l.lock.alpha) flags |= 0x01; if (r.divider || r.group) flags |= 0x10;
    li.u8(flags); li.u8(0);
    const ex = new Writer(256);
    if (mask) { ex.u32(20); ex.i32(mask.top); ex.i32(mask.left); ex.i32(mask.bottom); ex.i32(mask.right); ex.u8(mask.bg); ex.u8(mask.disabled ? 2 : 0); ex.u16(0); } else ex.u32(0);
    ex.u32(0);   // blending ranges
    const name = r.divider ? '</Layer group>' : l.name;
    pascal(ex, name, 4);
    block(ex, 'luni', b => { b.u32(name.length); for (let i = 0; i < name.length; i++) b.u16(name.charCodeAt(i)); });
    if (r.divider) block(ex, 'lsct', b => b.u32(3));
    if (r.group) block(ex, 'lsct', b => { b.u32(l.open ? 1 : 2); b.ascii('8BIM'); b.ascii(l.blend === 'pass' ? 'pass' : KEYS[l.blend] || 'norm'); });
    if (!r.divider && !r.group && l.fill < 1) block(ex, 'iOpa', b => { b.u8(Math.round(l.fill * 255)); b.u8(0); b.u8(0); b.u8(0); });
    const exb = ex.out(); li.u32(exb.length); li.bytes(exb);
    chans.push(list);
  }
  for (const list of chans) for (const [, data] of list) li.bytes(data);
  if (li.p % 2) li.u8(0);
  const lib = li.out();
  w.u32(lib.length + 4 + 4); w.u32(lib.length); w.bytes(lib); w.u32(0);   // layer & mask info, global mask info
  // merged image, planar RLE
  const P = planes(merged), nch = alphaMerged ? 4 : 3, W = doc.width, H = doc.height;
  w.u16(1);
  const rows = new Writer(W * H * nch / 2 + 1024), counts = [];
  for (let c = 0; c < nch; c++) { const plane = P[c === 3 ? 3 : c]; for (let y = 0; y < H; y++) { const p0 = rows.p; packRow(plane, y * W, W, rows); counts.push(rows.p - p0); } }
  for (const c of counts) w.u16(c);
  w.bytes(rows.out());
  return w.out();
}

/* ---------- read ---------- */
async function readChannel(r, len, w, h, out) {
  const end = r.p + len, comp = r.u16();
  if (w <= 0 || h <= 0) { r.p = end; return; }
  if (comp === 0) out.set(r.bytes(w * h).subarray(0, w * h));
  else if (comp === 1) { const counts = []; for (let y = 0; y < h; y++) counts.push(r.u16()); for (let y = 0; y < h; y++) { const p0 = r.p; unpackRow(r, w, out, y * w); r.p = p0 + counts[y]; } }
  else if (comp === 2 || comp === 3) {
    const raw = await inflate(r.bytes(end - r.p));
    if (comp === 3) for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) raw[y * w + x] = (raw[y * w + x] + raw[y * w + x - 1]) & 255;
    out.set(raw.subarray(0, w * h));
  }
  r.p = end;
}
function toCanvas(P, w, h, gray) {
  const c = canvas(w, h), id = ctx(c).createImageData(w, h), d = id.data;
  for (let i = 0; i < w * h; i++) { const R_ = P[0][i]; d[i * 4] = R_; d[i * 4 + 1] = gray ? R_ : P[1][i]; d[i * 4 + 2] = gray ? R_ : P[2][i]; d[i * 4 + 3] = P[3] ? P[3][i] : 255; }
  ctx(c).putImageData(id, 0, 0); return c;
}
export async function readPSD(buf, name = 'Untitled') {
  const r = new Reader(buf);
  if (r.ascii(4) !== '8BPS') throw new Error('Not a Photoshop file');
  const ver = r.u16(); if (ver !== 1) throw new Error('Large-document (PSB) files are not supported');
  r.skip(6);
  const nch = r.u16(), H = r.u32(), W = r.u32(), depth = r.u16(), mode = r.u16();
  if (depth !== 8) throw new Error(`Only 8-bit PSD files can be opened (this one is ${depth}-bit)`);
  if (mode !== 3 && mode !== 1) throw new Error('Only RGB and grayscale PSD files can be opened');
  const gray = mode === 1;
  r.skip(r.u32());
  // resources
  let ppi = 72; const guides = [];
  const resEnd = r.p + 4 + r.u32();
  while (r.p < resEnd) {
    if (r.ascii(4) !== '8BIM') break;
    const id = r.u16(), nl = r.u8(); r.skip(nl + ((nl + 1) % 2)); const size = r.u32(), start = r.p;
    if (id === 0x03ED) { ppi = r.u32() / 65536; }
    if (id === 0x0408) { r.skip(12); const n = r.u32(); for (let i = 0; i < n; i++) { const pos = r.i32() / 32, dir = r.u8(); guides.push({ axis: dir === 0 ? 'v' : 'h', pos: Math.round(pos) }); } }
    r.p = start + size + (size % 2);
  }
  r.p = resEnd;
  const doc = new Doc({ name, width: W, height: H, ppi, background: 'none' });
  doc.guides = guides;
  // layers
  const lmLen = r.u32(), lmEnd = r.p + lmLen;
  let layersRead = 0;
  if (lmLen) {
    const liLen = r.u32(), liEnd = r.p + liLen;
    if (liLen) {
      let count = r.i16(); count = Math.abs(count);
      const recs = [];
      for (let i = 0; i < count; i++) {
        const rec = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), ch: [] };
        const nc = r.u16(); for (let c = 0; c < nc; c++) rec.ch.push({ id: r.i16(), len: r.u32() });
        r.skip(4); rec.blend = r.ascii(4); rec.opacity = r.u8(); rec.clip = r.u8(); rec.flags = r.u8(); r.skip(1);
        const exLen = r.u32(), exEnd = r.p + exLen;
        const mLen = r.u32();
        if (mLen >= 20) { const mp = r.p; rec.mask = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), bg: r.u8(), flags: r.u8() }; r.p = mp + mLen; } else r.skip(mLen);
        r.skip(r.u32());
        const nl = r.u8(); rec.name = new TextDecoder('latin1').decode(r.bytes(nl)); r.skip((4 - ((nl + 1) % 4)) % 4);
        while (r.p + 12 <= exEnd) {
          const sig = r.ascii(4); if (sig !== '8BIM' && sig !== '8B64') break;
          const key = r.ascii(4), len = r.u32(), st = r.p;
          if (key === 'luni') { const n = r.u32(); let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(r.u16()); rec.name = s.replace(/\0+$/, ''); }
          else if (key === 'lsct' || key === 'lsdk') { rec.section = r.u32(); if (len >= 12) { r.skip(4); rec.sectionBlend = r.ascii(4); } }
          else if (key === 'iOpa') rec.fill = r.u8();
          else if (['levl', 'curv', 'hue2', 'brit', 'blwh', 'vibA', 'nvrt', 'thrs', 'SoCo', 'GdFl', 'PtFl', 'selc', 'mixr', 'grdm', 'phfl', 'expA', 'post'].includes(key)) rec.adjustment = key;
          r.p = st + len + (len % 2 && sig === '8BIM' && false ? 1 : 0);
        }
        r.p = exEnd;
        recs.push(rec);
      }
      for (const rec of recs) {
        const w = rec.right - rec.left, hh = rec.bottom - rec.top, P = [], cw = w, ch = hh;
        for (const c of rec.ch) {
          if (c.id === -2 && rec.mask) { const mw = rec.mask.right - rec.mask.left, mh = rec.mask.bottom - rec.mask.top, buf = new Uint8Array(Math.max(0, mw * mh)); await readChannel(r, c.len, mw, mh, buf); rec.maskData = buf; continue; }
          if (c.id < -1 || c.id > 2) { r.skip(c.len); continue; }
          const buf = new Uint8Array(Math.max(0, cw * ch)); await readChannel(r, c.len, cw, ch, buf);
          P[c.id === -1 ? 3 : c.id] = buf;
        }
        rec.planes = P;
      }
      r.p = liEnd;
      // build the tree: records are bottom -> top; a divider (3) opens a group, a folder (1/2) closes it
      const stack = [doc.root];
      for (const rec of recs) {
        const parent = stack[stack.length - 1];
        if (rec.section === 3) { const g = new GroupLayer(rec.name); doc.insert(g, parent); stack.push(g); g._pending = true; continue; }
        if (rec.section === 1 || rec.section === 2) {
          const g = stack.length > 1 ? stack.pop() : new GroupLayer(rec.name);
          if (!g.parent) doc.insert(g, stack[stack.length - 1]);
          g.name = rec.name; g.open = rec.section === 1; g.blend = FROM_KEY[rec.sectionBlend || rec.blend] || 'pass';
          g.opacity = rec.opacity / 255; g.visible = !(rec.flags & 2); delete g._pending;
          applyMask(g, rec);
          continue;
        }
        if (rec.adjustment && !(rec.planes[0] && rec.planes[0].length)) continue;   // adjustment / fill layers: not supported, skipped
        const w = rec.right - rec.left, hh = rec.bottom - rec.top;
        const l = new PixelLayer(rec.name || 'Layer', Math.max(1, w), Math.max(1, hh), rec.left, rec.top);
        if (w > 0 && hh > 0 && rec.planes[0]) l.canvas = toCanvas(rec.planes, w, hh, gray);
        l.blend = FROM_KEY[rec.blend] || 'normal'; l.opacity = rec.opacity / 255; l.clip = rec.clip === 1; l.visible = !(rec.flags & 2);
        if (rec.flags & 1) l.lock.alpha = true;
        if (rec.fill != null) l.fill = rec.fill / 255;
        applyMask(l, rec);
        doc.insert(l, parent);
        layersRead++;
      }
    }
    r.p = lmEnd;
  }
  if (!layersRead) {
    // no layers: the merged image
    const comp = r.u16(), n = W * H, P = [];
    const chans = Math.min(nch, gray ? 2 : 4);
    if (comp === 1) {
      const counts = []; for (let i = 0; i < nch * H; i++) counts.push(r.u16());
      let k = 0;
      for (let c = 0; c < nch; c++) { const buf = new Uint8Array(n); for (let y = 0; y < H; y++) { const p0 = r.p; unpackRow(r, W, buf, y * W); r.p = p0 + counts[k++]; } if (c < chans) P.push(buf); }
    } else if (comp === 0) { for (let c = 0; c < nch; c++) { const b = r.bytes(n).slice(); if (c < chans) P.push(b); } }
    else throw new Error('Unsupported PSD compression');
    const planesRGBA = gray ? [P[0], P[0], P[0], P[1]] : [P[0], P[1], P[2], P[3]];
    const l = new PixelLayer('Background', W, H, 0, 0); l.canvas = toCanvas(planesRGBA, W, H, false); l.isBackground = !planesRGBA[3]; if (l.isBackground) l.lock.pos = true;
    doc.insert(l, doc.root);
  }
  const all = doc.all(); doc.active = all[all.length - 1] || null; doc.selected = new Set(doc.active ? [doc.active.id] : []);
  return doc;
}
function applyMask(l, rec) {
  if (!rec.mask || !rec.maskData) return;
  const m = rec.mask, w = m.right - m.left, hh = m.bottom - m.top; if (w <= 0 || hh <= 0) return;
  const c = canvas(w, hh), id = ctx(c).createImageData(w, hh);
  for (let i = 0; i < w * hh; i++) { const v = rec.maskData[i]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  ctx(c).putImageData(id, 0, 0);
  l.mask = { canvas: c, x: m.left, y: m.top, bg: m.bg, enabled: !(m.flags & 2), linked: !(m.flags & 1) || true, rev: 1 };
}
