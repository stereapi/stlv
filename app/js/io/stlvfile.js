// The native .stlv format: a zip with manifest.json (document + layer tree,
// everything editable: text, fills, adjustments, styles, live filters,
// masks, guides, selection) and raw deflated RGBA for every pixel buffer
// (lossless, no PNG round trip). composite.png is there for previews.

import { zip, unzip } from './binary.js';
import { canvas, ctx, getData, canvasToBlob } from '../util.js';
import { Doc, PixelLayer, TextLayer, FillLayer, AdjustLayer, GroupLayer } from '../doc.js';

const COMMON = ['id', 'type', 'name', 'visible', 'opacity', 'fill', 'blend', 'lock', 'clip', 'style', 'filters', 'isBackground'];
const TEXT = ['text', 'font', 'fontStyle', 'weight', 'italic', 'size', 'color', 'tracking', 'leading', 'align', 'x', 'y', 'box', 'aa', 'xform', 'warp', 'caps'];

function rawOf(c) { const id = getData(c); return new Uint8Array(id.data.buffer.slice(0)); }
function canvasOf(bytes, w, h) { const c = canvas(w, h); ctx(c).putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + w * h * 4)), w, h), 0, 0); return c; }

/** -> Uint8Array (.stlv). composite: canvas of the flattened image (optional) */
export async function saveStlv(doc, composite) {
  const files = [];
  const ser = (l) => {
    const o = {};
    for (const k of COMMON) if (l[k] !== undefined) o[k] = JSON.parse(JSON.stringify(l[k]));
    if (l.type === 'pixel') { o.x = l.x; o.y = l.y; o.w = l.canvas.width; o.h = l.canvas.height; o.file = `px/${l.id}`; files.push({ name: o.file, data: rawOf(l.canvas), compress: true }); }
    if (l.type === 'text') for (const k of TEXT) o[k] = JSON.parse(JSON.stringify(l[k] ?? null));
    if (l.type === 'fill') { o.kind = l.kind; o.color = l.color; o.gradient = l.gradient; }
    if (l.type === 'adjust') { o.adj = l.adj; o.params = l.params; }
    if (l.isGroup) { o.open = l.open; o.children = l.children.map(ser); }
    if (l.mask) { const m = l.mask; o.mask = { x: m.x, y: m.y, w: m.canvas.width, h: m.canvas.height, bg: m.bg, enabled: m.enabled, linked: m.linked, file: `mask/${l.id}` }; files.push({ name: o.mask.file, data: rawOf(m.canvas), compress: true }); }
    return o;
  };
  const manifest = {
    format: 'stlv', version: 1, app: '0.1.0', name: doc.name, width: doc.width, height: doc.height, ppi: doc.ppi,
    guides: doc.guides, guidesLocked: doc.guidesLocked, active: doc.active ? doc.active.id : null, meta: doc.meta,
    layers: doc.root.children.map(ser),
  };
  if (doc.selection.active) { manifest.selection = 'selection'; files.push({ name: 'selection', data: rawOf(doc.selection.maskCanvas()), compress: true }); }
  files.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)), compress: true });
  if (composite) files.push({ name: 'composite.png', data: new Uint8Array(await (await canvasToBlob(composite)).arrayBuffer()), compress: false });
  return zip(files);
}

export async function loadStlv(buf, nameHint) {
  const f = await unzip(buf);
  if (!f['manifest.json']) throw new Error('Not an stlv file');
  const m = JSON.parse(new TextDecoder().decode(f['manifest.json']));
  if (m.format !== 'stlv') throw new Error('Not an stlv file');
  if (m.version > 1) throw new Error('This file was made by a newer stlv');
  const doc = new Doc({ name: m.name || nameHint, width: m.width, height: m.height, ppi: m.ppi, background: 'none' });
  doc.guides = m.guides || []; doc.guidesLocked = !!m.guidesLocked; doc.meta = m.meta || {};
  const build = (o, parent) => {
    let l;
    if (o.type === 'pixel') { l = new PixelLayer(o.name, o.w, o.h, o.x, o.y); l.canvas = canvasOf(f[o.file], o.w, o.h); }
    else if (o.type === 'text') { const p = {}; for (const k of TEXT) if (o[k] !== undefined && o[k] !== null) p[k] = o[k]; l = new TextLayer(o.name, p); }
    else if (o.type === 'fill') l = new FillLayer(o.name, o.kind, { color: o.color, gradient: o.gradient });
    else if (o.type === 'adjust') l = new AdjustLayer(o.name, o.adj, o.params);
    else if (o.type === 'group') { l = new GroupLayer(o.name); l.open = o.open !== false; }
    else return;
    for (const k of COMMON) if (k !== 'type' && o[k] !== undefined) l[k] = o[k];
    l.style = o.style || {};
    if (o.mask) l.mask = { canvas: canvasOf(f[o.mask.file], o.mask.w, o.mask.h), x: o.mask.x, y: o.mask.y, bg: o.mask.bg, enabled: o.mask.enabled, linked: o.mask.linked, rev: 1 };
    doc.insert(l, parent);
    if (o.children) for (const c of o.children) build(c, l);
  };
  for (const o of m.layers) build(o, doc.root);
  if (m.selection && f[m.selection]) { const c = canvasOf(f[m.selection], m.width, m.height); doc.selection.mask = c; doc.selection.active = true; }
  const all = doc.all();
  doc.active = all.find(l => l.id === m.active) || all[all.length - 1] || null;
  doc.selected = new Set(doc.active ? [doc.active.id] : []);
  return doc;
}
