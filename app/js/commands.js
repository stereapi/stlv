// Every menu command and its implementation. Each edit records one undo step.

import { R, C, canvas, ctx, cloneCanvas, getData, putData, clamp, round, uid, toPx, canvasToBlob, blobToImage, canvasFromImage, M3, sleep } from './util.js';
import { Doc, PixelLayer, TextLayer, FillLayer, AdjustLayer, GroupLayer, makeMask, clone, shiftLayer } from './doc.js';
import { bridge } from './bridge.js';
import { newDocDialog, imageSizeDialog, canvasSizeDialog, numberPrompt, fillDialog, strokeDialog, newGuideDialog, guideLayoutDialog, settingsDialog, aboutDialog } from './ui/dialogs.js';
import { exportDialog } from './ui/export.js';
import { ADJUSTMENTS, defaultParams, adjustImageData } from './adjust.js';
import { SB_GROUPS, SB_NAMES, sbLayerParams } from './sbfx.js';
import { FILTERS, defaultFilterParams, bakeFilter } from './filters.js';
import { defaultGradient, cloneGradient } from './gradient.js';
import { resampleCanvas } from './transform.js';
import { cropDoc } from './tools/crop.js';
import { contentBox, layerBox, topSelected, moveLayers } from './tools/basic.js';
import { loadStlv, saveStlv } from './io/stlvfile.js';
import { readPSD } from './io/psd.js';
import { pngPPI, jpegPPI, blobBytes } from './io/binary.js';
import { edt } from './blur.js';
import { rasterizeText, defaultTextBox } from './text.js';

/* ---------- helpers ---------- */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'avif'];
const ext = n => (n.split('.').pop() || '').toLowerCase();
const base = n => n.replace(/\.[^.]+$/, '');

/** a layer rendered alone at full strength (style + filters + warp, no opacity / blend / mask / clip) -> {canvas, x, y} trimmed, or null */
export function layerPixels(app, layer, doc = app.doc) {
  const saved = { opacity: layer.opacity, blend: layer.blend, visible: layer.visible, clip: layer.clip, mask: layer.mask, fill: layer.fill };
  Object.assign(layer, { opacity: 1, blend: layer.isGroup ? 'normal' : 'normal', visible: true, clip: false, mask: null });
  if (layer.type === 'text' && !layer.raster) rasterizeText(layer, doc);
  let id;
  try { id = app.view.comp.readLayer(doc, layer); } finally { Object.assign(layer, saved); layer.touch(); }
  const c = canvas(doc.width, doc.height); ctx(c).putImageData(id, 0, 0);
  const b = opaqueRect(id); if (!b) return null;
  const t = canvas(b.w, b.h); ctx(t).drawImage(c, -b.x, -b.y);
  return { canvas: t, x: b.x, y: b.y };
}
function opaqueRect(id) {
  const { width: w, height: h, data: d } = id; let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) { let i = y * w * 4 + 3; for (let x = 0; x < w; x++, i += 4) if (d[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; } }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
/** turn a text / fill / styled layer into pixels in place (one undo step). out: optional precomputed {canvas,x,y} */
export function rasterizeLayer(app, l, out) {
  const d = app.doc;
  const px = out || layerPixels(app, l) || { canvas: canvas(1, 1), x: 0, y: 0 };
  const np = new PixelLayer(l.name, px.canvas.width, px.canvas.height, px.x, px.y); np.canvas = px.canvas;
  Object.assign(np, { visible: l.visible, opacity: l.opacity, fill: 1, blend: l.blend, clip: l.clip, mask: l.mask, lock: { ...l.lock } });
  np.id = l.id;   // keep the identity (clipping, selection)
  const parent = l.parent, idx = parent.children.indexOf(l);
  d.edit('Rasterize Layer', () => { parent.children[idx] = np; np.parent = parent; l.parent = null; if (d.active === l) d.active = np; }, () => { parent.children[idx] = l; l.parent = parent; np.parent = null; if (d.active === np) d.active = l; });
  return np;
}
function dupLayer(l, doc) {
  let n;
  if (l.type === 'pixel') { n = new PixelLayer(l.name + ' copy', 1, 1, l.x, l.y); n.canvas = cloneCanvas(l.canvas); }
  else if (l.type === 'text') { n = new TextLayer(l.name + ' copy', {}); for (const k of ['text', 'font', 'fontStyle', 'weight', 'italic', 'size', 'color', 'tracking', 'leading', 'align', 'x', 'y', 'box', 'aa', 'xform', 'warp', 'caps']) n[k] = clone(l[k]); }
  else if (l.type === 'fill') n = new FillLayer(l.name + ' copy', l.kind, { color: { ...l.color }, gradient: l.gradient ? cloneGradient(l.gradient) : null });
  else if (l.type === 'adjust') n = new AdjustLayer(l.name + ' copy', l.adj, clone(l.params));
  else { n = new GroupLayer(l.name + ' copy'); n.open = l.open; for (const c of l.children) { const k = dupLayer(c, doc); k.name = c.name; k.parent = n; n.children.push(k); } }
  for (const k of ['visible', 'opacity', 'fill', 'blend', 'clip']) n[k] = l[k];
  n.lock = { ...l.lock, pos: l.isBackground ? false : l.lock.pos }; n.style = clone(l.style); n.filters = clone(l.filters);
  if (l.mask) n.mask = { ...l.mask, canvas: cloneCanvas(l.mask.canvas), rev: 1 };
  return n;
}
function fitsDoc(app, w, h) { const max = Math.min(12000, app.view.comp.g.maxTex); if (w > max || h > max) { app.ui.alert('Too large', `stlv documents can be up to ${max} px on a side. This image is ${w} × ${h}.`); return false; } return true; }

/* ---------- opening ---------- */
async function decodeImage(bytes, name) {
  const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', avif: 'image/avif' }[ext(name)] || 'application/octet-stream';
  const img = await blobToImage(new Blob([bytes], { type }));
  const c = canvasFromImage(img);
  const ppi = pngPPI(bytes) || jpegPPI(bytes) || 72;
  return { canvas: c, ppi };
}
export async function openEntry(app, entry) {
  const name = entry.name, e = ext(name);
  const bytes = new Uint8Array(await bridge.read(entry));
  let doc;
  if (e === 'stlv' || (bytes[0] === 0x50 && bytes[1] === 0x4B)) doc = await loadStlv(bytes, base(name));
  else if (e === 'psd' || (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53)) doc = await readPSD(bytes, base(name));
  else {
    const { canvas: c, ppi } = await decodeImage(bytes, name);
    if (!fitsDoc(app, c.width, c.height)) return null;
    doc = new Doc({ name: base(name), width: c.width, height: c.height, ppi, background: 'none' });
    const l = new PixelLayer('Background', c.width, c.height); l.canvas = c; l.isBackground = true; l.lock.pos = true;
    doc.insert(l, doc.root); doc.active = l; doc.selected = new Set([l.id]);
  }
  if (!fitsDoc(app, doc.width, doc.height)) return null;
  doc.name = base(name);
  if (e === 'stlv') { doc.path = entry.path || null; doc.token = entry.token || null; doc.format = 'stlv'; }
  else { doc.sourcePath = entry.path || null; }
  doc.openedAs = 'Open';
  app.addDoc(doc);
  if (entry.path) addRecent(app, entry.path);
  return doc;
}
function addRecent(app, path) { const r = (app.prefs.recent || []).filter(p => p !== path); r.unshift(path); app.setPref('recent', r.slice(0, 12)); app.menus && app.menus.sync(); }

/** place an image as a new layer: mode fit | fill | stretch | original */
export async function placeEntry(app, entry, mode = app.prefs.placeMode || 'fit', at = null) {
  const d = app.doc; if (!d) return openEntry(app, entry);
  const bytes = new Uint8Array(await bridge.read(entry));
  if (ext(entry.name) === 'stlv' || (bytes[0] === 0x50 && bytes[1] === 0x4B)) {   // another project: its layers come in as a group
    const src = await loadStlv(bytes, base(entry.name)), g = new GroupLayer(base(entry.name));
    g.children = [...src.root.children]; g.children.forEach(l => l.parent = g);
    return pasteLayers(app, { layers: [g], ppi: src.ppi, w: src.width, h: src.height }, false, 'Place Project');
  }
  let src;
  if (ext(entry.name) === 'psd') { const pd = await readPSD(bytes); const id = app.view.comp.readComposite(pd); src = canvas(pd.width, pd.height); ctx(src).putImageData(id, 0, 0); app.view.comp.dispose(); app.view.compDoc = null; }
  else {
    const im = await decodeImage(bytes, entry.name); src = im.canvas;
    if (isFreshDoc(d) && fitsDoc(app, src.width, src.height)) return adoptImage(app, d, src, im.ppi, base(entry.name));
  }
  placeCanvas(app, src, base(entry.name), mode, at);
}
/** a New document nothing has been done to yet: the first image dropped in sets its size */
function isFreshDoc(d) { return d.openedAs === 'New' && d.history.index === 0 && !d.history.canRedo && d.all().length <= 1; }
function adoptImage(app, d, src, ppi, name) {
  const old = { w: d.width, h: d.height, ppi: d.ppi, kids: [...d.root.children], active: d.active, sel: new Set(d.selected), guides: d.guides.map(g => ({ ...g })) };
  const hadBg = old.kids.some(l => l.isBackground);
  const l = new PixelLayer(hadBg ? 'Background' : name, src.width, src.height); l.canvas = src;
  if (hadBg) { l.isBackground = true; l.lock.pos = true; }
  d.edit('Place', () => {
    d.width = src.width; d.height = src.height; d.ppi = ppi;
    d.root.children = []; d.insert(l, d.root, 0); d.active = l; d.selected = new Set([l.id]); d.guides = [];
  }, () => {
    d.width = old.w; d.height = old.h; d.ppi = old.ppi;
    d.root.children = old.kids; old.kids.forEach(k => k.parent = d.root); l.parent = null; d.active = old.active; d.selected = old.sel; d.guides = old.guides;
  }, { kind: 'size' });
  app.view.fit();
  return l;
}
export function placeCanvas(app, src, name, mode = 'fit', at = null) {
  const d = app.doc;
  let w = src.width, h = src.height;
  if (mode === 'fit' && (w > d.width || h > d.height)) { const k = Math.min(d.width / w, d.height / h); w *= k; h *= k; }
  else if (mode === 'fill') { const k = Math.max(d.width / w, d.height / h); w *= k; h *= k; }
  else if (mode === 'stretch') { w = d.width; h = d.height; }
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const c = w === src.width && h === src.height ? src : resampleCanvas(app.view.comp, src, w, h, 'auto');
  if (at && at.cx != null) at = { x: Math.round(at.cx - w / 2), y: Math.round(at.cy - h / 2) };   // centred on a drop point
  const x = at ? at.x : Math.round((d.width - w) / 2), y = at ? at.y : Math.round((d.height - h) / 2);
  const l = new PixelLayer(name || d.layerName(), w, h, x, y); l.canvas = c;
  d.addLayer(l, { label: 'Place' });
  return l;
}

/* ---------- saving ---------- */
async function compositeCanvas(app, doc) { const id = app.view.comp.readComposite(doc); const c = canvas(doc.width, doc.height); ctx(c).putImageData(id, 0, 0); return c; }
export async function saveDoc(app, doc, as) {
  if (!doc) return false;
  if (app.tool && app.tool.commit && app.tool.editing) app.tool.commit(app);
  let target = !as && doc.format === 'stlv' && doc.token ? { token: doc.token, path: doc.path, name: doc.name + '.stlv' } : null;
  if (!target) {
    target = await bridge.saveDialog({ name: doc.name + '.stlv', types: ['stlv'] });
    if (!target) return false;
  }
  const comp = await compositeCanvas(app, doc);
  // composite.png: Finder thumbnails and the spacebar Quick Look preview (mac/ql) show it
  const thumb = canvas(Math.min(2048, doc.width), Math.min(2048, doc.height));
  { const k = Math.min(2048 / doc.width, 2048 / doc.height, 1); thumb.width = Math.max(1, Math.round(doc.width * k)); thumb.height = Math.max(1, Math.round(doc.height * k)); const x = ctx(thumb); x.imageSmoothingQuality = 'high'; x.drawImage(comp, 0, 0, thumb.width, thumb.height); }
  const bytes = await app.ui.busy('Saving…', async () => saveStlv(doc, thumb));
  await bridge.write(target, new Blob([bytes], { type: 'application/zip' }));
  if (!target.web) { doc.token = target.token; doc.path = target.path; }
  doc.format = 'stlv'; doc.name = base(target.name);
  doc.history.markSaved();
  app.autosave && app.autosave.drop(doc);
  if (target.path) addRecent(app, target.path);
  app.emit('tabs'); app.updateTitle();
  app.ui.toast(`Saved ${target.name}`);
  return true;
}

/* ---------- clipboard ---------- */
let internalClip = null;   // {canvas, x, y} — exact pixels (the system clipboard gets a PNG too)
                           // or {layers, ppi, w, h} — whole layers (the system clipboard gets their text)
async function copy(app, merged, cut) {
  const d = app.doc, sel = d.selection;
  if (!merged && d.active && d.active.type !== 'pixel') return copyLayers(app, cut);
  let src, x0, y0;
  if (merged) { src = await compositeCanvas(app, d); x0 = 0; y0 = 0; }
  else { const l = app.editableLayer('pixels'); if (!l) return; src = l.canvas; x0 = l.x; y0 = l.y; }
  const b = sel.active ? sel.bounds() : merged ? { x: 0, y: 0, w: d.width, h: d.height } : contentBox(d.active, d);
  if (!b) return app.ui.toast('Nothing to copy');
  const c = canvas(b.w, b.h), x = ctx(c);
  x.drawImage(src, x0 - b.x, y0 - b.y);
  if (sel.active) { x.globalCompositeOperation = 'destination-in'; x.drawImage(sel.maskCanvas(), -b.x, -b.y); }
  internalClip = { canvas: c, x: b.x, y: b.y };
  bridge.clipWrite(await canvasToBlob(c)).catch(() => { });
  if (cut && !merged) clearPixels(app, 'Cut');
  app.ui.toast(cut ? 'Cut' : merged ? 'Copied (merged)' : 'Copied');
}
/** Layer via Copy / Cut: the selected area of the active layer becomes a new pixel layer just above it.
 *  Copy works on any layer (text, fills, groups copy what they show); Cut rasterizes a non-pixel layer first */
function layerVia(app, cut) {
  const d = app.doc, sel = d.selection;
  let l = d.active;
  if (!l) return app.ui.toast('Select a layer first');
  if (!sel.active) return app.ui.toast('Make a selection first');
  if (cut && (l.lock.all || l.lock.px)) return app.ui.toast('The layer is locked');
  if (cut && l.isGroup) return app.ui.toast('Select a layer inside the group to cut from');
  if (cut && l.type !== 'pixel') { l = rasterizeLayer(app, l); app.ui.toast('Rasterized the layer to cut from it'); }
  const src = l.type === 'pixel' ? { canvas: l.canvas, x: l.x, y: l.y } : layerPixels(app, l);
  const b = src && R.inter(sel.bounds(), { x: src.x, y: src.y, w: src.canvas.width, h: src.canvas.height });
  if (!b || b.w < 1 || b.h < 1) return app.ui.toast('The selected area of this layer is empty');
  const c = canvas(b.w, b.h), x = ctx(c);
  x.drawImage(src.canvas, src.x - b.x, src.y - b.y);
  x.globalCompositeOperation = 'destination-in'; x.drawImage(sel.maskCanvas(), -b.x, -b.y); x.globalCompositeOperation = 'source-over';
  const n = new PixelLayer(d.layerName(), b.w, b.h, b.x, b.y); n.canvas = c;
  // cut: the hole in the source layer, as before/after pixels of the cut rect (background layers fill with the background colour)
  let hole = null;
  if (cut) {
    const r = { x: b.x - l.x, y: b.y - l.y, w: b.w, h: b.h }, before = getData(l.canvas, r), lx = ctx(l.canvas);
    if (l.isBackground) { const m = cloneCanvas(sel.maskCanvas()), mx = ctx(m); mx.globalCompositeOperation = 'source-in'; mx.fillStyle = C.hex(app.bg); mx.fillRect(0, 0, m.width, m.height); lx.globalCompositeOperation = 'source-atop'; lx.drawImage(m, -l.x, -l.y); }
    else { lx.globalCompositeOperation = 'destination-out'; lx.drawImage(sel.maskCanvas(), -l.x, -l.y); }
    lx.globalCompositeOperation = 'source-over';
    hole = { r, before, after: getData(l.canvas, r) };
  }
  const parent = l.parent, prevActive = d.active, prevSel = new Set(d.selected), src0 = l;
  const set = data => { if (hole) { putData(src0.canvas, data, hole.r.x, hole.r.y); src0.touch(); } };
  d.edit(cut ? 'Layer via Cut' : 'Layer via Copy',
    () => { set(hole && hole.after); d.insert(n, parent, parent.children.indexOf(src0) + 1); d.active = n; d.selected = new Set([n.id]); },
    () => { set(hole && hole.before); d.detach(n); d.active = prevActive; d.selected = prevSel; });
}
function clearPixels(app, label = 'Clear') {
  const d = app.doc, l = app.editableLayer('pixels'); if (!l) return;
  if (!d.selection.active) return app.ui.toast('Make a selection first');
  const rec = d.pixelEdit(l, label), x = ctx(l.canvas);
  if (l.isBackground) { x.globalCompositeOperation = 'source-atop'; const m = cloneCanvas(d.selection.maskCanvas()), mx = ctx(m); mx.globalCompositeOperation = 'source-in'; mx.fillStyle = C.hex(app.bg); mx.fillRect(0, 0, m.width, m.height); x.drawImage(m, -l.x, -l.y); }
  else { x.globalCompositeOperation = 'destination-out'; x.drawImage(d.selection.maskCanvas(), -l.x, -l.y); }
  x.globalCompositeOperation = 'source-over'; l.touch();
  rec.commit({ x: 0, y: 0, w: l.canvas.width, h: l.canvas.height });
}
/* text (and other non-pixel) layers copy as live layers, so they paste editable into any open document */
const layerText = ls => ls.map(l => l.type === 'text' ? l.text : l.isGroup ? layerText(l.children) : '').filter(Boolean).join('\n');
function copyLayers(app, cut) {
  const d = app.doc, ls = topSelected(d); if (!ls.length) return;
  internalClip = { layers: ls.map(l => { const n = dupLayer(l, d); n.name = l.name; return n; }), ppi: d.ppi, w: d.width, h: d.height };
  bridge.clipWriteText(layerText(ls)).catch(() => { });   // also replaces any image there, so paste picks these layers
  if (cut) d.removeLayers(ls, 'Cut');
  app.ui.toast(`${cut ? 'Cut' : 'Copied'} ${ls.length === 1 ? 'layer' : ls.length + ' layers'}`);
}
function pasteLayers(app, clip, inPlace, label) {
  const d = app.doc || app.newDoc({ name: 'Pasted', width: clip.w, height: clip.h, ppi: clip.ppi, background: 'none' });
  // same pixel size when the ppi differs; same relative spot when the canvas size differs
  const k = clip.ppi / d.ppi, same = inPlace || (d.width === clip.w && d.height === clip.h), sx = same ? 1 : d.width / clip.w, sy = same ? 1 : d.height / clip.h;
  const fit = l => {
    if (l.isGroup) return l.children.forEach(fit);
    if (l.type === 'text' && k !== 1) { l.size = round(l.size * k, 1); if (l.leading) l.leading = round(l.leading * k, 1); }
    if (l.type === 'text' || l.type === 'pixel') { l.x = Math.round(l.x * sx); l.y = Math.round(l.y * sy); }
  };
  const ls = clip.layers.map(l => { const n = dupLayer(l, d); n.name = l.name; fit(n); return n; });
  let top = d.active; while (top && top.parent && top.parent !== d.root) top = top.parent;
  const parent = d.root, at = top && top.parent === parent ? parent.children.indexOf(top) + 1 : parent.children.length;
  const prevActive = d.active, prevSel = new Set(d.selected);
  d.edit(label || (ls.length === 1 ? 'Paste Layer' : 'Paste Layers'), () => { ls.forEach((n, i) => d.insert(n, parent, at + i)); d.active = ls[ls.length - 1]; d.selected = new Set(ls.map(n => n.id)); },
    () => { ls.forEach(n => d.detach(n)); d.active = prevActive; d.selected = prevSel; });
}
async function paste(app, inPlace) {
  const d = app.doc;
  let src = null, at = null;
  const blob = await bridge.clipRead().catch(() => null);
  if (internalClip && internalClip.layers) { if (!blob) return pasteLayers(app, internalClip, inPlace); internalClip = null; }   // an image copied since wins
  if (internalClip && (!blob || blob === internalClip.blob)) { src = cloneCanvas(internalClip.canvas); at = inPlace ? { x: internalClip.x, y: internalClip.y } : null; }
  else if (blob) {
    // prefer our own copy if the system clipboard still holds it
    const img = await blobToImage(blob); src = canvasFromImage(img);
    if (internalClip && src.width === internalClip.canvas.width && src.height === internalClip.canvas.height) { src = cloneCanvas(internalClip.canvas); at = inPlace ? { x: internalClip.x, y: internalClip.y } : null; }
  }
  if (!src) return app.ui.toast('The clipboard has no image');
  if (!d) { const nd = app.newDoc({ name: 'Pasted', width: src.width, height: src.height, ppi: 72, background: 'none' }); const l = new PixelLayer('Layer 1', src.width, src.height); l.canvas = src; nd.insert(l, nd.root); nd.active = l; nd.selected = new Set([l.id]); nd.changed('all'); return; }
  if (!at && d.selection.active) { const b = d.selection.bounds(); at = { x: Math.round(b.x + (b.w - src.width) / 2), y: Math.round(b.y + (b.h - src.height) / 2) }; }
  placeCanvas(app, src, d.layerName(), 'original', at);
}

/* ---------- image-wide transforms ---------- */
function rotateCanvasExact(c, op) {
  const w = c.width, h = c.height, swap = op === 'cw' || op === 'ccw', n = canvas(swap ? h : w, swap ? w : h), x = ctx(n);
  if (op === 'cw') { x.translate(h, 0); x.rotate(Math.PI / 2); }
  else if (op === 'ccw') { x.translate(0, w); x.rotate(-Math.PI / 2); }
  else if (op === '180') { x.translate(w, h); x.rotate(Math.PI); }
  else if (op === 'fh') { x.translate(w, 0); x.scale(-1, 1); }
  else if (op === 'fv') { x.translate(0, h); x.scale(1, -1); }
  x.drawImage(c, 0, 0);
  x.setTransform(1, 0, 0, 1, 0, 0);   // contexts are cached per canvas: never leave a transform behind
  return n;
}
/** maps a doc rect / point through a canvas-wide op on a W x H doc */
function mapRect(r, op, W, H) {
  switch (op) {
    case 'cw': return { x: H - (r.y + r.h), y: r.x, w: r.h, h: r.w };
    case 'ccw': return { x: r.y, y: W - (r.x + r.w), w: r.h, h: r.w };
    case '180': return { x: W - (r.x + r.w), y: H - (r.y + r.h), w: r.w, h: r.h };
    case 'fh': return { x: W - (r.x + r.w), y: r.y, w: r.w, h: r.h };
    case 'fv': return { x: r.x, y: H - (r.y + r.h), w: r.w, h: r.h };
  }
}
function opMatrix(op, W, H) {
  return { cw: [0, -1, H, 1, 0, 0, 0, 0, 1], ccw: [0, 1, 0, -1, 0, W, 0, 0, 1], '180': [-1, 0, W, 0, -1, H, 0, 0, 1], fh: [-1, 0, W, 0, 1, 0, 0, 0, 1], fv: [1, 0, 0, 0, -1, H, 0, 0, 1] }[op];
}
function rotateDoc(app, op, label) {
  const d = app.doc, W = d.width, H = d.height, layers = d.all();
  const saved = layers.map(l => ({ l, c: l.canvas, x: l.x, y: l.y, mask: l.mask, xform: l.xform, grad: l.gradient ? cloneGradient(l.gradient) : null }));
  const old = { w: W, h: H, guides: d.guides.map(g => ({ ...g })), sel: d.selection.snapshot() };
  const M = opMatrix(op, W, H), swap = op === 'cw' || op === 'ccw';
  d.edit(label, () => {
    for (const l of layers) {
      if (l.type === 'pixel') { const r = mapRect(l.bounds(), op, W, H); l.canvas = rotateCanvasExact(l.canvas, op); l.x = r.x; l.y = r.y; }
      if (l.type === 'text') { const p = M3.apply(M, l.x, l.y), X = l.xform || [1, 0, 0, 1, 0, 0], L = [M[0], M[1], 0, M[3], M[4], 0, 0, 0, 1], X3 = [X[0], X[2], X[4], X[1], X[3], X[5], 0, 0, 1], N = M3.mul(L, X3); l.x = p.x; l.y = p.y; l.xform = [N[0], N[3], N[1], N[4], N[2], N[5]]; l.raster = null; }
      if (l.type === 'fill' && l.gradient) { const g = l.gradient; if (g.p0) { g.p0 = M3.apply(M, g.p0.x, g.p0.y); g.p1 = M3.apply(M, g.p1.x, g.p1.y); } else { g.angle = (g.angle ?? 90) + ({ cw: -90, ccw: 90, '180': 180, fh: 0, fv: 0 }[op]); if (op === 'fh') g.angle = 180 - g.angle; if (op === 'fv') g.angle = -g.angle; } }
      if (l.mask) { const m = l.mask, r = mapRect({ x: m.x, y: m.y, w: m.canvas.width, h: m.canvas.height }, op, W, H); l.mask = { ...m, canvas: rotateCanvasExact(m.canvas, op), x: r.x, y: r.y, rev: (m.rev || 0) + 1 }; }
      l.touch();
    }
    d.guides = d.guides.map(g => { if (swap) return { axis: g.axis === 'v' ? 'h' : 'v', pos: op === 'cw' ? (g.axis === 'h' ? H - g.pos : g.pos) : (g.axis === 'v' ? W - g.pos : g.pos) }; if ((op === 'fh' || op === '180') && g.axis === 'v') return { ...g, pos: W - g.pos }; if ((op === 'fv' || op === '180') && g.axis === 'h') return { ...g, pos: H - g.pos }; return g; });
    if (swap) { d.width = H; d.height = W; }
    if (d.selection.mask && d.selection.active) { d.selection.mask = rotateCanvasExact(d.selection.mask, op); d.selection.changed(); } else d.selection.resize(d.width, d.height);
  }, () => {
    for (const s of saved) { s.l.canvas = s.c; s.l.x = s.x; s.l.y = s.y; s.l.mask = s.mask; s.l.xform = s.xform; if (s.grad) s.l.gradient = cloneGradient(s.grad); s.l.raster = null; s.l.touch(); }
    d.width = old.w; d.height = old.h; d.guides = old.guides.map(g => ({ ...g })); d.selection.restore(old.sel);
  }, { kind: 'size' });
}
/** flip / rotate the active layer about its own centre */
function transformLayerExact(app, op, label) {
  const d = app.doc, l = d.active; if (!l) return;
  if (l.lock.all || l.lock.pos) return app.ui.toast('The layer is locked');
  if (l.type === 'pixel') {
    const b = l.bounds(), cx = b.x + b.w / 2, cy = b.y + b.h / 2, n = rotateCanvasExact(l.canvas, op);
    d.replaceCanvas(l, n, Math.round(cx - n.width / 2), Math.round(cy - n.height / 2), label);
  } else if (l.type === 'text') {
    const q = contentBox(l, d), cx = q.x + q.w / 2, cy = q.y + q.h / 2;
    const T = { cw: M3.rotate(Math.PI / 2), ccw: M3.rotate(-Math.PI / 2), '180': M3.rotate(Math.PI), fh: M3.scale(-1, 1), fv: M3.scale(1, -1) }[op];
    const A = M3.mul(M3.translate(cx, cy), M3.mul(T, M3.translate(-cx, -cy))), ax = Math.round(l.x), ay = Math.round(l.y), X = l.xform || [1, 0, 0, 1, 0, 0];
    const N = M3.mul(M3.translate(-ax, -ay), M3.mul(A, M3.mul(M3.translate(ax, ay), [X[0], X[2], X[4], X[1], X[3], X[5], 0, 0, 1])));
    d.setProps(l, { xform: [N[0], N[3], N[1], N[4], N[2], N[5]] }, label);
  } else app.ui.toast('Flip and rotate work on pixel and text layers');
}

/* ---------- image size ---------- */
function resizeDoc(app, w, h, ppi, method, label = 'Image Size') {
  const d = app.doc, W = d.width, H = d.height, sx = w / W, sy = h / H, layers = d.all();
  if (!method || (w === W && h === H)) { const o = d.ppi; d.edit('Image Size', () => { d.ppi = ppi; }, () => { d.ppi = o; }, { kind: 'size' }); return; }
  const comp = app.view.comp;
  const saved = layers.map(l => ({ l, c: l.canvas, x: l.x, y: l.y, mask: l.mask, size: l.size, xform: l.xform, box: l.box, grad: l.gradient ? cloneGradient(l.gradient) : null }));
  const next = new Map();
  for (const l of layers) {
    const o = {};
    if (l.type === 'pixel') { const nw = Math.max(1, Math.round(l.canvas.width * sx)), nh = Math.max(1, Math.round(l.canvas.height * sy)); o.c = resampleCanvas(comp, l.canvas, nw, nh, method); o.x = Math.round(l.x * sx); o.y = Math.round(l.y * sy); }
    if (l.mask) { const m = l.mask; o.mask = { ...m, canvas: resampleCanvas(comp, m.canvas, Math.max(1, Math.round(m.canvas.width * sx)), Math.max(1, Math.round(m.canvas.height * sy)), method === 'nearest' ? 'nearest' : 'bilinear'), x: Math.round(m.x * sx), y: Math.round(m.y * sy), rev: (m.rev || 0) + 1 }; }
    next.set(l, o);
  }
  const selOld = d.selection.snapshot(), guidesOld = d.guides.map(g => ({ ...g })), oldPPI = d.ppi;
  const selNew = d.selection.active ? resampleCanvas(comp, d.selection.mask, w, h, 'bilinear') : null;
  d.edit(label, () => {
    for (const l of layers) {
      const o = next.get(l);
      if (o.c) { l.canvas = o.c; l.x = o.x; l.y = o.y; }
      if (o.mask) l.mask = o.mask;
      if (l.type === 'text') { const k = Math.sqrt(sx * sy); l.x *= sx; l.y *= sy; l.size = l.size * k * (ppi ? d.ppi / ppi : 1); if (l.box) l.box = { w: l.box.w * sx, h: l.box.h * sy }; if (Math.abs(sx - sy) > 1e-6) { const X = l.xform || [1, 0, 0, 1, 0, 0]; l.xform = [X[0] * sx / k, X[1] * sy / k, X[2] * sx / k, X[3] * sy / k, X[4], X[5]]; } l.raster = null; }
      if (l.type === 'fill' && l.gradient) { const g = l.gradient; if (g.p0) { g.p0 = { x: g.p0.x * sx, y: g.p0.y * sy }; g.p1 = { x: g.p1.x * sx, y: g.p1.y * sy }; } g.ox = (g.ox || 0) * sx; g.oy = (g.oy || 0) * sy; }
      l.touch();
    }
    d.guides.forEach(g => g.pos = Math.round(g.pos * (g.axis === 'v' ? sx : sy)));
    d.width = w; d.height = h; if (ppi) d.ppi = ppi;
    if (selNew) { d.selection.mask = selNew; d.selection.changed(); } else d.selection.resize(w, h);
  }, () => {
    for (const s of saved) { s.l.canvas = s.c; s.l.x = s.x; s.l.y = s.y; s.l.mask = s.mask; if (s.size != null) s.l.size = s.size; s.l.xform = s.xform; s.l.box = s.box; if (s.grad) s.l.gradient = cloneGradient(s.grad); s.l.raster = null; s.l.touch(); }
    d.guides = guidesOld.map(g => ({ ...g })); d.width = W; d.height = H; d.ppi = oldPPI; d.selection.restore(selOld);
  }, { kind: 'size' });
}

/* ---------- merging ---------- */
function mergeDown(app) {
  const d = app.doc, top = d.active; if (!top) return;
  const sib = top.parent.children, i = sib.indexOf(top), below = sib[i - 1];
  if (!below) return app.ui.toast('There is no layer below');
  if (below.type === 'adjust') return app.ui.toast('Can’t merge into an adjustment layer');
  // render [below, top] alone, with below at full strength; the result takes below's place and properties
  const g = new GroupLayer('merge'); g.blend = 'normal';
  const savedBelow = { opacity: below.opacity, blend: below.blend, visible: below.visible, mask: below.mask, clip: below.clip };
  Object.assign(below, { opacity: 1, blend: 'normal', visible: true, mask: null, clip: false });
  const tParent = top.parent; g.children = [below, top];
  const pB = below.parent, pT = top.parent; below.parent = g; top.parent = g;
  let px; try { px = layerPixels(app, g); } finally { below.parent = pB; top.parent = pT; Object.assign(below, savedBelow); }
  const np = new PixelLayer(below.name, 1, 1, 0, 0);
  if (px) { np.canvas = px.canvas; np.x = px.x; np.y = px.y; }
  Object.assign(np, { opacity: below.opacity, blend: below.blend, visible: below.visible, mask: below.mask, clip: below.clip, isBackground: below.isBackground, lock: { ...below.lock } });
  const idx = i - 1;
  d.edit('Merge Down', () => { tParent.children.splice(idx, 2, np); np.parent = tParent; below.parent = null; top.parent = null; d.active = np; d.selected = new Set([np.id]); },
    () => { tParent.children.splice(idx, 1, below, top); below.parent = tParent; top.parent = tParent; np.parent = null; d.active = top; d.selected = new Set([top.id]); });
}
/** the selected layers (as they look, with their own opacity and blend) become one pixel layer in the
 *  topmost one's place and name. Hidden selected layers are left alone */
function mergeSelected(app) {
  const d = app.doc, all = d.all();
  const sel = topSelected(d).filter(l => !d.hiddenChain(l)).sort((a, b) => all.indexOf(a) - all.indexOf(b));   // bottom -> top
  if (sel.length < 2) return app.ui.toast('Select two or more visible layers to merge');
  const top = sel[sel.length - 1], rest = sel.slice(0, -1);
  const g = new GroupLayer('merge'); g.blend = 'normal';
  const parents = sel.map(l => l.parent); g.children = sel; sel.forEach(l => l.parent = g);
  let px; try { px = layerPixels(app, g); } finally { sel.forEach((l, i) => l.parent = parents[i]); }
  const np = new PixelLayer(top.name, 1, 1, 0, 0);
  if (px) { np.canvas = px.canvas; np.x = px.x; np.y = px.y; }
  const prevActive = d.active, prevSel = new Set(d.selected), spots = [];
  d.edit('Merge Layers', () => {
    const p = top.parent; p.children[p.children.indexOf(top)] = np; np.parent = p; top.parent = null;
    spots.length = 0; for (const l of rest) spots.push(d.detach(l));
    d.active = np; d.selected = new Set([np.id]);
  }, () => {
    for (let i = rest.length - 1; i >= 0; i--) d.insert(rest[i], spots[i].parent, spots[i].index);
    const p = np.parent; p.children[p.children.indexOf(np)] = top; top.parent = p; np.parent = null;
    d.active = prevActive; d.selected = prevSel;
  });
}
async function mergeVisible(app, flatten) {
  const d = app.doc, id = app.view.comp.readComposite(d);
  const c = canvas(d.width, d.height); ctx(c).putImageData(id, 0, 0);
  if (flatten) { const x = ctx(c); x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
  const L = new PixelLayer(flatten ? 'Background' : 'Merged', d.width, d.height); L.canvas = c;
  if (flatten) { L.isBackground = true; L.lock.pos = true; }
  const oldChildren = [...d.root.children], oldActive = d.active, oldSel = new Set(d.selected);
  const keep = flatten ? [] : oldChildren.filter(l => !l.visible);
  d.edit(flatten ? 'Flatten Image' : 'Merge Visible', () => { d.root.children = [...(flatten ? [] : keep), L]; for (const l of oldChildren) if (!keep.includes(l)) l.parent = null; L.parent = d.root; d.active = L; d.selected = new Set([L.id]); },
    () => { d.root.children = oldChildren; for (const l of oldChildren) l.parent = d.root; L.parent = null; d.active = oldActive; d.selected = oldSel; });
}

/* ---------- filters (session from the Filter menu) ---------- */
function fxStart(app, type) {
  const d = app.doc; let l = d && d.active;
  if (!l || !(l.type === 'pixel' || l.type === 'text')) return app.ui.toast('Filters work on pixel and text layers');
  if (l.lock.all || l.lock.px) return app.ui.toast('The layer is locked');
  if (app.fxSession) fxEnd(app, false);
  const params = (app.lastFilter && app.lastFilter.type === type) ? clone(app.lastFilter.params) : defaultFilterParams(type, app, d);
  const canLive = !(d.selection.active && l.type === 'pixel');
  const s = { layer: l, type, params, keepLive: canLive, canLive, before: clone(l.filters), prevTool: app.tool ? app.tool.id : 'move' };
  l.filters = [...l.filters, { type, params, visible: true, preview: true }]; l.touch();
  app.fxSession = s; app.panels.props.render(); app.view.invalidate();
  if (FILTERS[type].center) app.setTool('fxcenter', true);
}
function fxPreview(app, interactive) {
  const s = app.fxSession; if (!s) return;
  const l = s.layer; l.filters = [...s.before, { type: s.type, params: s.params, visible: true, preview: true }]; l.touch();
  app.fxInteractive = interactive; app.view.invalidate();
  const t0 = performance.now(); requestAnimationFrame(() => { s.ms = Math.round(performance.now() - t0); });
  if (!interactive) setTimeout(() => app.view.invalidate(), 0);
}
function fxSwitch(app, type) {
  const s = app.fxSession; if (!s) return;
  s.type = type; s.params = defaultFilterParams(type, app, app.doc);
  fxPreview(app, false); app.panels.props.render();
  if (FILTERS[type].center && app.tool.id !== 'fxcenter') app.setTool('fxcenter', true); else if (!FILTERS[type].center && app.tool.id === 'fxcenter') app.setTool(s.prevTool);
}
async function fxEnd(app, ok) {
  const s = app.fxSession; if (!s) return;
  app.fxSession = null; app.fxInteractive = false;
  const d = app.doc, l = s.layer;
  l.filters = clone(s.before); l.touch();
  if (ok) {
    app.lastFilter = { type: s.type, params: clone(s.params) };
    if (s.keepLive && s.canLive) d.setProps(l, { filters: [...s.before, { type: s.type, params: s.params, visible: true }] }, FILTERS[s.type].name);
    else if (l.type === 'pixel') {
      const out = await app.ui.busy(FILTERS[s.type].name + '…', async () => { await sleep(10); return bakeFilter(s.type, s.params, l, d.selection); });
      d.replaceCanvas(l, out.canvas, out.x, out.y, FILTERS[s.type].name);
    }
  }
  if (app.tool && app.tool.id === 'fxcenter') app.setTool(s.prevTool || 'move');
  d.changed('all'); app.panels.props.render();
}

/* ---------- align ---------- */
function align(app, k) {
  const d = app.doc, layers = topSelected(d).filter(l => !l.lock.pos && !l.lock.all); if (!layers.length) return;
  const boxes = layers.map(l => contentBox(l, d)).filter(Boolean); if (!boxes.length) return;
  const ref = d.selection.active ? d.selection.bounds() : layers.length > 1 ? boxes.reduce((a, b) => R.union(a, b)) : { x: 0, y: 0, w: d.width, h: d.height };
  const moves = layers.map((l, i) => {
    const b = boxes[i]; let dx = 0, dy = 0;
    if (k === 'left') dx = ref.x - b.x; if (k === 'right') dx = ref.x + ref.w - (b.x + b.w); if (k === 'hcenter') dx = Math.round(ref.x + ref.w / 2 - (b.x + b.w / 2));
    if (k === 'top') dy = ref.y - b.y; if (k === 'bottom') dy = ref.y + ref.h - (b.y + b.h); if (k === 'vcenter') dy = Math.round(ref.y + ref.h / 2 - (b.y + b.h / 2));
    return { l, dx: Math.round(dx), dy: Math.round(dy) };
  });
  d.edit('Align', () => moves.forEach(m => moveLayers(d, [m.l], m.dx, m.dy)), () => moves.forEach(m => moveLayers(d, [m.l], -m.dx, -m.dy)));
}

/* ---------- stroke selection ---------- */
function strokeSelection(app, st) {
  const d = app.doc, l = app.editableLayer('pixels'); if (!l) return;
  if (!d.selection.active) return app.ui.toast('Make a selection first');
  const W = d.width, H = d.height, a = d.selection.alpha(), inside = new Uint8Array(W * H), outside = new Uint8Array(W * H);
  for (let i = 0; i < a.length; i++) { inside[i] = a[i] >= 128; outside[i] = !inside[i]; }
  const dIn = edt(inside, W, H), dOut = edt(outside, W, H), wd = st.width;
  const c = canvas(W, H), id = ctx(c).createImageData(W, H), col = st.color;
  for (let i = 0; i < a.length; i++) {
    const din = Math.sqrt(dOut[i]), dout = Math.sqrt(dIn[i]);   // inside pixel: distance to the edge; outside: distance to the selection
    let v = 0;
    if (st.where === 'inside') v = inside[i] ? clamp(wd + 0.5 - din, 0, 1) : 0;
    else if (st.where === 'outside') v = !inside[i] ? clamp(wd + 0.5 - dout, 0, 1) : 0;
    else v = inside[i] ? clamp(wd / 2 + 0.5 - din, 0, 1) : clamp(wd / 2 + 0.5 - dout, 0, 1);
    id.data[i * 4] = col.r; id.data[i * 4 + 1] = col.g; id.data[i * 4 + 2] = col.b; id.data[i * 4 + 3] = v * 255;
  }
  ctx(c).putImageData(id, 0, 0);
  const rec = d.pixelEdit(l, 'Stroke', { x: 0, y: 0, w: W, h: H }), x = ctx(l.canvas);
  x.globalAlpha = st.opacity / 100; x.globalCompositeOperation = l.lock.alpha ? 'source-atop' : 'source-over'; x.drawImage(c, -l.x, -l.y); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
  l.touch(); rec.commit({ x: -l.x, y: -l.y, w: W, h: H });
}

/* ---------- registration ---------- */
export function registerCommands(app) {
  const C_ = (id, run, extra = {}) => app.command(id, { run, ...extra });
  const hasDoc = a => !!a.doc;
  const hasLayer = a => !!(a.doc && a.doc.active);
  const hasSel = a => !!(a.doc && a.doc.selection.active);

  // app
  C_('app.about', () => aboutDialog());
  C_('app.settings', () => settingsDialog(app));
  // file
  C_('file.new', async () => { const d = await newDocDialog(app); if (d) d.openedAs = 'New'; });
  C_('file.open', async () => { const list = await bridge.openFiles({ types: ['stlv', 'psd', ...IMAGE_EXT], multiple: true }); if (list) for (const e of list) await app.run('file.openFile', e); });
  C_('file.openFile', async (a, entry) => { try { await openEntry(app, entry); } catch (e) { console.error(e); app.ui.alert(`Couldn’t open “${entry.name}”`, String(e.message || e)); } });
  C_('file.openRecent', async (a, path) => { const t = await bridge.tokenFor(path); if (!t) { app.ui.toast('That file is no longer there'); app.setPref('recent', (app.prefs.recent || []).filter(p => p !== path)); app.menus.sync(); return; } await app.run('file.openFile', t); });
  C_('file.clearRecent', () => { app.setPref('recent', []); app.menus.sync(); });
  for (const m of ['fit', 'fill', 'stretch', 'original']) C_('file.place.' + m, async () => { app.prefs.placeMode = m; const list = await bridge.openFiles({ types: ['psd', ...IMAGE_EXT], multiple: false }); if (list && list[0]) await app.run('file.placeFile', list[0]); }, { enabled: hasDoc });
  C_('file.placeFile', async (a, entry, at) => { try { await placeEntry(app, entry, undefined, at); } catch (e) { app.ui.alert(`Couldn’t place “${entry.name}”`, String(e.message || e)); } });
  C_('file.close', () => app.doc && app.closeDoc(app.doc), { enabled: hasDoc });
  C_('file.closeAll', async () => { for (const d of [...app.docs]) if (!(await app.closeDoc(d))) return; }, { enabled: hasDoc });
  C_('file.save', () => saveDoc(app, app.doc, false), { enabled: hasDoc });
  C_('file.saveAs', () => saveDoc(app, app.doc, true), { enabled: hasDoc });
  C_('file.export', () => exportDialog(app), { enabled: hasDoc });
  C_('file.quickExport', () => exportDialog(app, { quick: true }), { enabled: hasDoc });
  C_('file.revert', async () => { const d = app.doc; if (!d.token) return; if ((await app.ui.confirm('Revert to the saved file?', 'Changes since the last save will be lost.', ['Revert', 'Cancel'])) !== 0) return; await app.closeDoc(d, true); await app.run('file.openFile', { token: d.token, path: d.path, name: d.name + '.stlv' }); }, { enabled: a => !!(a.doc && a.doc.token) });

  // edit
  C_('edit.undo', () => { if (app.tool && app.tool.editing) return document.execCommand('undo'); app.doc.history.undo(); }, { enabled: a => !!(a.doc && a.doc.history.canUndo) });
  C_('edit.redo', () => app.doc.history.redo(), { enabled: a => !!(a.doc && a.doc.history.canRedo) });
  C_('edit.cut', () => copy(app, false, true), { enabled: hasLayer });
  C_('edit.copy', () => copy(app, false, false), { enabled: hasLayer });
  C_('edit.copyMerged', () => copy(app, true, false), { enabled: hasDoc });
  C_('edit.paste', () => paste(app, false));
  C_('edit.pasteInPlace', () => paste(app, true), { enabled: hasDoc });
  C_('edit.clear', () => clearPixels(app), { enabled: hasSel });
  C_('edit.fill', async () => {
    const l = app.editableLayer('pixels'); if (!l) return; const st = await fillDialog(app); if (!st) return;
    const d = app.doc, col = st.use === 'fg' ? app.fg : st.use === 'bg' ? app.bg : st.use === 'black' ? { r: 0, g: 0, b: 0 } : st.use === 'white' ? { r: 255, g: 255, b: 255 } : st.use === 'gray' ? { r: 128, g: 128, b: 128 } : st.color;
    const rec = d.pixelEdit(l, 'Fill', { x: 0, y: 0, w: d.width, h: d.height }), c = canvas(d.width, d.height), x = ctx(c); x.fillStyle = C.hex(col); x.fillRect(0, 0, c.width, c.height);
    if (d.selection.active) { x.globalCompositeOperation = 'destination-in'; x.drawImage(d.selection.maskCanvas(), 0, 0); }
    const lc = ctx(l.canvas); lc.globalAlpha = st.opacity / 100; lc.globalCompositeOperation = st.preserve || l.lock.alpha ? 'source-atop' : (st.mode === 'normal' ? 'source-over' : st.mode.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
    lc.drawImage(c, -l.x, -l.y); lc.globalAlpha = 1; lc.globalCompositeOperation = 'source-over'; l.touch(); rec.commit({ x: -l.x, y: -l.y, w: d.width, h: d.height });
  }, { enabled: hasLayer });
  C_('edit.stroke', async () => { const st = await strokeDialog(app); if (st) strokeSelection(app, st); }, { enabled: hasSel });
  C_('edit.transform', (a, mode = 'free', opts) => app.tools.transform.start(app, mode, opts), { enabled: hasLayer });
  for (const m of ['free', 'distort', 'perspective', 'warp']) C_('edit.transform.' + m, () => app.tools.transform.start(app, m), { enabled: hasLayer });
  for (const [k, op, lab] of [['rot180', '180', 'Rotate 180°'], ['rotcw', 'cw', 'Rotate 90° Clockwise'], ['rotccw', 'ccw', 'Rotate 90° Counter Clockwise'], ['flipH', 'fh', 'Flip Horizontal'], ['flipV', 'fv', 'Flip Vertical']]) {
    C_('edit.' + k, () => transformLayerExact(app, op, lab), { enabled: hasLayer });
    C_('image.' + k, () => rotateDoc(app, op, 'Image ' + lab), { enabled: hasDoc });
  }
  C_('edit.cas', () => app.tools.cas.start(app, 'layer'), { enabled: hasLayer });

  // image
  // Image > Adjustments: a temporary adjustment layer clipped to the layer, tuned in Properties, then baked
  for (const k of Object.keys(ADJUSTMENTS)) C_('image.adjust.' + k, () => {
    const l = app.editableLayer('pixels'); if (!l) return;
    if (app.adjSession) app.adjEnd(false);
    const d = app.doc, A = new AdjustLayer(ADJUSTMENTS[k].name + ' (preview)', k, defaultParams(k)); A.clip = true; A._temp = true;
    d.insert(A, l.parent, l.parent.children.indexOf(l) + 1);
    app.adjSession = { layer: l, A, prevActive: d.active };
    d.active = A; d.selected = new Set([A.id]); d.changed('all');
  }, { enabled: hasLayer });
  app.adjEnd = (ok) => {
    const s = app.adjSession; if (!s) return; app.adjSession = null;
    const d = app.doc, l = s.layer, A = s.A;
    d.detach(A); d.active = l; d.selected = new Set([l.id]);
    if (ok) {
      const rec = d.pixelEdit(l, ADJUSTMENTS[A.adj].name), id = getData(l.canvas);
      adjustImageData(A.adj, A.params, id);
      if (d.selection.active) {
        const t = canvas(l.canvas.width, l.canvas.height); ctx(t).putImageData(id, 0, 0); const tx = ctx(t); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(d.selection.maskCanvas(), -l.x, -l.y);
        const lc = ctx(l.canvas); lc.globalCompositeOperation = 'destination-out'; lc.drawImage(d.selection.maskCanvas(), -l.x, -l.y); lc.globalCompositeOperation = 'source-over'; lc.drawImage(t, 0, 0);
      } else ctx(l.canvas).putImageData(id, 0, 0);
      l.touch(); rec.commit({ x: 0, y: 0, w: l.canvas.width, h: l.canvas.height });
    }
    d.changed('all');
  };
  C_('image.size', async () => { const r = await imageSizeDialog(app); if (r) await app.ui.busy('Resizing…', async () => { await sleep(10); resizeDoc(app, r.w, r.h, r.ppi, r.method); }); }, { enabled: hasDoc });
  C_('image.resizeTo', (a, w, h, ppi) => resizeDoc(app, Math.round(w), Math.round(h), ppi, 'auto', 'Crop'), { enabled: hasDoc });
  C_('image.canvasSize', async () => {
    const r = await canvasSizeDialog(app); if (!r) return; const d = app.doc;
    const bg = d.all().find(l => l.isBackground && l.type === 'pixel');
    if (bg && r.ext !== 'transparent') {
      const col = r.ext === 'bg' ? app.bg : r.ext === 'fg' ? app.fg : r.ext === 'white' ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
      const old = { c: bg.canvas, x: bg.x, y: bg.y }, n = canvas(r.w, r.h), x = ctx(n); x.fillStyle = C.hex(col); x.fillRect(0, 0, r.w, r.h); x.drawImage(bg.canvas, bg.x + r.dx, bg.y + r.dy);
      d.resizeCanvas(r.w, r.h, r.dx, r.dy);
      d.edit('Canvas Size', () => { bg.canvas = n; bg.x = 0; bg.y = 0; bg.touch(); }, () => { bg.canvas = old.c; bg.x = old.x + r.dx; bg.y = old.y + r.dy; bg.touch(); }, { kind: 'size' });
    } else d.resizeCanvas(r.w, r.h, r.dx, r.dy);
  }, { enabled: hasDoc });
  C_('image.cas', () => app.tools.cas.start(app, 'canvas'), { enabled: hasDoc });
  C_('image.cropToSelection', () => { const b = app.doc.selection.bounds(); if (b) cropDoc(app, b, true); }, { enabled: hasSel });
  C_('image.trim', () => { const d = app.doc, id = app.view.comp.readComposite(d), b = opaqueRect(id); if (!b) return app.ui.toast('The image is empty'); if (b.w === d.width && b.h === d.height) return app.ui.toast('Nothing to trim'); cropDoc(app, b, true); }, { enabled: hasDoc });

  // layer
  C_('layer.new', () => { const d = app.doc; d.addLayer(new PixelLayer(d.layerName(), d.width, d.height)); }, { enabled: hasDoc });
  C_('layer.newGroup', () => { const d = app.doc; d.addLayer(new GroupLayer(d.layerName('Group')), { label: 'New Group' }); }, { enabled: hasDoc });
  C_('layer.group', () => {
    const d = app.doc, sel = topSelected(d); if (!sel.length) return;
    const g = new GroupLayer(d.layerName('Group')), anchor = sel[sel.length - 1], parent = anchor.parent;
    const spots = sel.map(l => ({ l, p: l.parent, i: l.parent.children.indexOf(l) }));
    d.edit('Group Layers', () => {
      const idx = parent.children.indexOf(anchor);
      d.insert(g, parent, idx + 1);
      for (const l of sel) { d.detach(l); g.children.push(l); l.parent = g; }
      d.active = g; d.selected = new Set([g.id]);
    }, () => {
      for (const l of sel) { const k = g.children.indexOf(l); if (k >= 0) g.children.splice(k, 1); }
      d.detach(g);
      for (const s of [...spots].sort((a, b) => a.i - b.i)) d.insert(s.l, s.p, s.i);
      d.active = anchor; d.selected = new Set(sel.map(l => l.id));
    });
  }, { enabled: hasLayer });
  C_('layer.ungroup', () => {
    const d = app.doc, g = d.active; if (!g || !g.isGroup) return app.ui.toast('Select a group');
    const parent = g.parent, idx = parent.children.indexOf(g), kids = [...g.children];
    d.edit('Ungroup Layers', () => { parent.children.splice(idx, 1, ...kids); kids.forEach(k => k.parent = parent); g.parent = null; d.active = kids[kids.length - 1] || null; d.selected = new Set(kids.map(k => k.id)); },
      () => { parent.children.splice(idx, kids.length, g); g.parent = parent; g.children = kids; kids.forEach(k => k.parent = g); d.active = g; d.selected = new Set([g.id]); });
  }, { enabled: a => !!(a.doc && a.doc.active && a.doc.active.isGroup) });
  C_('layer.viaCopy', () => layerVia(app, false), { enabled: hasSel });
  C_('layer.viaCut', () => layerVia(app, true), { enabled: hasSel });
  C_('layer.duplicate', () => {
    const d = app.doc, sel = topSelected(d); if (!sel.length) return;
    if (d.selection.active && sel.length === 1) return layerVia(app, false);   // ⌘J with a selection = Layer via Copy (as in Photoshop)
    const pairs = sel.map(l => ({ l, n: dupLayer(l, d) }));
    d.edit('Duplicate Layer', () => { for (const { l, n } of pairs) d.insert(n, l.parent, l.parent.children.indexOf(l) + 1); d.active = pairs[pairs.length - 1].n; d.selected = new Set(pairs.map(p => p.n.id)); },
      () => { for (const { n } of pairs) d.detach(n); d.active = pairs[pairs.length - 1].l; d.selected = new Set(pairs.map(p => p.l.id)); });
  }, { enabled: hasLayer });
  // ⌥-drag in the Layers panel: copies of `layers` land at parent/index, the originals stay put
  // a layer dragged onto another document's tab: copies of the selected layers go there
  C_('layer.copyToDoc', (_, target, layerId) => {
    const d = app.doc, dragged = d && d.find(layerId); if (!dragged || !target || target === d) return;
    const ls = d.selected.has(dragged.id) ? topSelected(d) : [dragged];
    const clip = { layers: ls.map(l => { const n = dupLayer(l, d); n.name = l.name; return n; }), ppi: d.ppi, w: d.width, h: d.height };
    app.activate(target); pasteLayers(app, clip, false, ls.length === 1 ? 'Drop Layer' : 'Drop Layers');
  });
  C_('layer.copyTo', (_, layers, parent, index) => {
    const d = app.doc; if (!layers || !layers.length) return;
    const pairs = layers.map(l => ({ l, n: dupLayer(l, d) }));
    d.edit('Duplicate Layer', () => { pairs.forEach(({ n }, i) => d.insert(n, parent, Math.min(index + i, parent.children.length))); d.active = pairs[pairs.length - 1].n; d.selected = new Set(pairs.map(p => p.n.id)); },
      () => { for (const { n } of pairs) d.detach(n); d.active = pairs[pairs.length - 1].l; d.selected = new Set(pairs.map(p => p.l.id)); });
  }, { enabled: hasLayer });
  C_('layer.delete', () => { const d = app.doc; d.removeLayers(topSelected(d)); }, { enabled: hasLayer });
  C_('layer.new.fill.solid', () => { const d = app.doc, L = new FillLayer(d.layerName('Color Fill'), 'solid', { color: { ...app.fg } }); if (d.selection.active) L.mask = makeMask(d, L, 'selection'); d.addLayer(L, { label: 'New Fill Layer' }); }, { enabled: hasDoc });
  C_('layer.new.fill.gradient', () => { const d = app.doc, L = new FillLayer(d.layerName('Gradient Fill'), 'gradient', { gradient: { ...defaultGradient(app.fg, app.bg), angle: 90 } }); if (d.selection.active) L.mask = makeMask(d, L, 'selection'); d.addLayer(L, { label: 'New Fill Layer' }); }, { enabled: hasDoc });
  for (const [, modes] of SB_GROUPS) for (const m of modes) C_('layer.new.sbfx.' + m, () => { const d = app.doc, L = new AdjustLayer(d.layerName('SB ' + SB_NAMES[m]), 'sbfx', sbLayerParams(m)); if (d.selection.active) L.mask = makeMask(d, L, 'selection'); d.addLayer(L, { label: 'New SB FX Layer' }); }, { enabled: hasDoc });
  for (const k of Object.keys(ADJUSTMENTS)) C_('layer.new.adj.' + k, () => { const d = app.doc, L = new AdjustLayer(d.layerName(ADJUSTMENTS[k].name), k, defaultParams(k)); if (d.selection.active) L.mask = makeMask(d, L, 'selection'); d.addLayer(L, { label: 'New ' + ADJUSTMENTS[k].name + ' Layer' }); }, { enabled: hasDoc });
  C_('layer.style.gradOverlay', () => {
    const d = app.doc, l = d.active; if (!l || l.type === 'adjust' || l.isGroup) return app.ui.toast('Layer styles work on pixel, text and fill layers');
    if (!l.style.gradOverlay) d.setProps(l, { style: { ...l.style, gradOverlay: { ...defaultGradient(app.fg, app.bg), blend: 'normal', opacity: 1, align: true, enabled: true } } }, 'Gradient Overlay');
    app.panels.props.focus = 'style'; app.panels.props.render();
  }, { enabled: hasLayer });
  // text box: a box behind each line of text (or one around a group's text); every selected text layer / group gets one
  C_('layer.style.textBox', () => {
    const d = app.doc, a = d.active, Ls = [...new Set([a, ...d.selectedLayers()])].filter(l => l && (l.type === 'text' || l.isGroup));
    if (!Ls.length) return app.ui.toast('Text boxes go on text layers or groups');
    const add = Ls.filter(l => !l.style.textBox), old = add.map(l => l.style);
    if (add.length) d.edit('Text Box', () => add.forEach(l => { l.style = { ...l.style, textBox: defaultTextBox() }; l.touch(); }), () => add.forEach((l, i) => { l.style = old[i]; l.touch(); }));
    if (!a || !(a.type === 'text' || a.isGroup)) d.setActive(Ls[0]);
    app.panels.props.focus = 'textbox'; app.panels.props.render();
  }, { enabled: hasLayer });
  C_('layer.style.clear', () => { const d = app.doc, l = d.active; if (l && (l.style.gradOverlay || l.style.textBox)) d.setProps(l, { style: {} }, 'Clear Layer Style'); }, { enabled: a => !!(a.doc && a.doc.active && (a.doc.active.style.gradOverlay || a.doc.active.style.textBox)) });
  const maskCmd = (how) => () => { const d = app.doc, l = d.active; if (!l) return; if (l.mask) return app.ui.toast('The layer already has a mask'); if (l.isBackground) return app.ui.toast('Make the background a normal layer first'); d.replaceMask(l, makeMask(d, l, how), 'Add Layer Mask'); l.maskEdit = true; d.changed('all'); };
  C_('layer.mask.reveal', maskCmd('reveal'), { enabled: hasLayer }); C_('layer.mask.hide', maskCmd('hide'), { enabled: hasLayer });
  C_('layer.mask.revealSel', maskCmd('selection'), { enabled: hasSel }); C_('layer.mask.hideSel', maskCmd('inverse'), { enabled: hasSel });
  C_('layer.mask.delete', () => { const d = app.doc, l = d.active; if (l && l.mask) { l.maskEdit = false; d.replaceMask(l, null, 'Delete Layer Mask'); } }, { enabled: a => !!(a.doc && a.doc.active && a.doc.active.mask) });
  C_('layer.mask.toggle', () => { const d = app.doc, l = d.active; if (!l || !l.mask) return; d.edit(l.mask.enabled ? 'Disable Layer Mask' : 'Enable Layer Mask', () => { l.mask.enabled = !l.mask.enabled; l.touch(); }, () => { l.mask.enabled = !l.mask.enabled; l.touch(); }); }, { enabled: a => !!(a.doc && a.doc.active && a.doc.active.mask) });
  C_('layer.mask.target', () => { const l = app.doc.active; if (l && l.mask) { l.maskEdit = !l.maskEdit; app.ui.toast(l.maskEdit ? 'Painting on the mask' : 'Painting on the layer'); app.emit('change', 'active'); } });
  C_('layer.mask.invert', () => { const d = app.doc, l = d.active; if (!l || !l.mask) return; const m = l.mask, c = cloneCanvas(m.canvas), id = getData(c); for (let i = 0; i < id.data.length; i += 4) { id.data[i] = id.data[i + 1] = id.data[i + 2] = 255 - id.data[i]; } ctx(c).putImageData(id, 0, 0); d.replaceMask(l, { ...m, canvas: c, bg: 255 - m.bg, rev: (m.rev || 0) + 1 }, 'Invert Mask'); }, { enabled: a => !!(a.doc && a.doc.active && a.doc.active.mask) });
  C_('layer.mask.apply', () => {
    const d = app.doc, l = d.active; if (!l || !l.mask) return; if (l.type !== 'pixel') return app.ui.toast('Rasterize the layer first');
    const m = l.mask, b = l.bounds(), n = cloneCanvas(l.canvas), x = ctx(n), mm = canvas(b.w, b.h), mx = ctx(mm);
    mx.fillStyle = m.bg ? '#fff' : '#000'; mx.fillRect(0, 0, b.w, b.h); mx.drawImage(m.canvas, m.x - b.x, m.y - b.y);
    const md = getData(mm), nd = getData(n); for (let i = 0; i < nd.data.length; i += 4) nd.data[i + 3] = nd.data[i + 3] * md.data[i] / 255; x.putImageData(nd, 0, 0);
    const o = { c: l.canvas, mask: l.mask };
    d.edit('Apply Layer Mask', () => { l.canvas = n; l.mask = null; l.maskEdit = false; l.touch(); }, () => { l.canvas = o.c; l.mask = o.mask; l.touch(); });
  }, { enabled: a => !!(a.doc && a.doc.active && a.doc.active.mask) });
  C_('layer.clip.toggle', () => { const d = app.doc, l = d.active; if (!l) return; const sib = l.parent.children; if (!l.clip && sib.indexOf(l) === 0) return app.ui.toast('There is no layer below to clip to'); d.setProps(l, { clip: !l.clip }, l.clip ? 'Release Clipping Mask' : 'Create Clipping Mask'); }, { enabled: hasLayer });
  const arrange = (k) => () => {
    const d = app.doc, l = d.active; if (!l) return; const sib = l.parent.children, i = sib.indexOf(l);
    const j = { front: sib.length - 1, forward: Math.min(sib.length - 1, i + 1), backward: Math.max(0, i - 1), back: 0 }[k];
    if (j === i) return;
    if (sib[0] && sib[0].isBackground && j === 0 && !l.isBackground) return app.ui.toast('Nothing can go below the background');
    d.moveLayer(l, l.parent, j > i ? j + 1 : j, 'Arrange');
  };
  for (const k of ['front', 'forward', 'backward', 'back']) C_('layer.arrange.' + k, arrange(k), { enabled: hasLayer });
  C_('layer.mergeDown', () => topSelected(app.doc).length > 1 ? mergeSelected(app) : mergeDown(app), { enabled: hasLayer });   // ⌘E with several selected merges them
  C_('layer.mergeSelected', () => mergeSelected(app), { enabled: a => !!(a.doc && a.doc.selected.size > 1) });
  C_('layer.mergeVisible', () => mergeVisible(app, false), { enabled: hasDoc });
  C_('layer.flatten', () => mergeVisible(app, true), { enabled: hasDoc });
  C_('layer.rasterize', () => { const l = app.doc.active; if (!l) return; if (l.type === 'pixel' && !l.style.gradOverlay && !l.filters.length) return app.ui.toast('Already pixels'); if (l.type === 'adjust' || l.isGroup) return app.ui.toast('Adjustment layers and groups can’t be rasterized'); rasterizeLayer(app, l); }, { enabled: hasLayer });
  // the lock badge on a layer row: clear every lock (a background also becomes a normal layer)
  C_('layer.unlockAll', (_, l) => {
    const d = app.doc; l = l || d.active; if (!l) return;
    const was = { lock: { ...l.lock }, bg: l.isBackground, name: l.name };
    d.edit(l.isBackground ? 'Layer From Background' : 'Unlock Layer',
      () => { l.lock = { ...l.lock, all: false, px: false, pos: false, alpha: false }; if (was.bg) { l.isBackground = false; if (l.name === 'Background') l.name = 'Layer 0'; } l.touch(); },
      () => { l.lock = { ...was.lock }; l.isBackground = was.bg; l.name = was.name; l.touch(); });
  }, { enabled: hasLayer });
  C_('layer.unlockBackground', () => { const d = app.doc, l = d.active; if (!l || !l.isBackground) return; d.edit('Layer From Background', () => { l.isBackground = false; l.lock.pos = false; l.name = l.name === 'Background' ? 'Layer 0' : l.name; }, () => { l.isBackground = true; l.lock.pos = true; l.name = 'Background'; }); });
  C_('layer.nudge', (a, dx, dy, layer) => {
    const d = app.doc; if (!d) return;
    if (app.tool && app.tool.id === 'move' && d.selection.active && d.active && d.active.type === 'pixel' && !layer) { /* nudge the selected pixels: same as a tiny move */ }
    const layers = layer ? [layer] : topSelected(d).filter(l => !l.lock.pos && !l.lock.all); if (!layers.length) return;
    d.edit('Nudge', () => moveLayers(d, layers, dx, dy), () => moveLayers(d, layers, -dx, -dy));   // deltas: never merge steps
  });
  C_('layer.align', (a, k) => align(app, k), { enabled: hasLayer });
  C_('layer.solo', (a, l) => { const d = app.doc; const others = d.all().filter(x => x !== l && !x.isGroup); const anyOn = others.some(x => x.visible); const old = others.map(x => x.visible); d.edit('Solo', () => { others.forEach(x => x.visible = !anyOn); l.visible = true; }, () => { others.forEach((x, i) => x.visible = old[i]); }); });
  C_('layer.next', () => { const d = app.doc, list = d.displayList().map(e => e.layer), i = list.indexOf(d.active); if (i > 0) d.setActive(list[i - 1]); }, { enabled: hasLayer });
  C_('layer.prev', () => { const d = app.doc, list = d.displayList().map(e => e.layer), i = list.indexOf(d.active); if (i < list.length - 1) d.setActive(list[i + 1]); }, { enabled: hasLayer });

  // select
  C_('select.all', () => app.doc.selection.edit('Select All', () => app.doc.selection.all()), { enabled: hasDoc });
  C_('select.none', () => app.doc.selection.edit('Deselect', () => app.doc.selection.clear()), { enabled: hasSel });
  C_('select.reselect', () => { const s = app.doc.selection; if (s.saved) s.edit('Reselect', () => { s.mask = cloneCanvas(s.saved); s.active = true; }); }, { enabled: a => !!(a.doc && a.doc.selection.saved && !a.doc.selection.active) });
  C_('select.inverse', () => app.doc.selection.edit('Inverse', () => app.doc.selection.invert()), { enabled: hasDoc });
  C_('select.layerPixels', (a, layer) => {
    const d = app.doc, l = layer || d.active; if (!l) return;
    let px = l.type === 'pixel' ? { canvas: l.canvas, x: l.x, y: l.y } : layerPixels(app, l);
    if (!px) return app.ui.toast('The layer is empty');
    d.selection.edit('Load Selection', () => d.selection.fromAlpha(px.canvas, px.x, px.y, 'new'));
  }, { enabled: hasLayer });
  const modify = (k, label, fieldLabel, max) => async () => {
    const r = await numberPrompt(label, [{ key: 'v', label: fieldLabel, value: k === 'feather' ? 4 : 4, min: k === 'feather' ? 0.1 : 1, max, step: 1, digits: 1, unit: ' px' }]); if (!r) return;
    const s = app.doc.selection;
    await app.ui.busy(label + '…', async () => { await sleep(10); s.edit(label, () => s[k](r.v)); });
  };
  C_('select.feather', modify('feather', 'Feather Selection', 'Feather radius', 1000), { enabled: hasSel });
  C_('select.expand', modify('expand', 'Expand Selection', 'Expand by', 500), { enabled: hasSel });
  C_('select.contract', modify('contract', 'Contract Selection', 'Contract by', 500), { enabled: hasSel });
  C_('select.smooth', modify('smooth', 'Smooth Selection', 'Sample radius', 500), { enabled: hasSel });
  C_('select.border', modify('border', 'Border Selection', 'Width', 200), { enabled: hasSel });

  // filters
  for (const k of Object.keys(FILTERS)) C_('filter.' + k, () => fxStart(app, k), { enabled: hasLayer });
  C_('filter.last', () => { if (app.lastFilter) { fxStart(app, app.lastFilter.type); fxEnd(app, true); } }, { enabled: a => !!(a.lastFilter && a.doc && a.doc.active) });
  C_('filter.bake', async (a, l, i) => {
    const d = app.doc; if (!l || l.type !== 'pixel') { if (l && l.type === 'text') return app.ui.toast('Rasterize the text to bake its filters'); return; }
    const f = l.filters[i]; if (!f) return;
    const out = await app.ui.busy('Applying…', async () => { await sleep(10); return bakeFilter(f.type, f.params, l, null); });
    const old = { c: l.canvas, x: l.x, y: l.y, f: clone(l.filters) }, nf = l.filters.filter((_, j) => j !== i);
    d.edit('Apply Filter', () => { l.canvas = out.canvas; l.x = out.x; l.y = out.y; l.filters = clone(nf); l.touch(); }, () => { l.canvas = old.c; l.x = old.x; l.y = old.y; l.filters = clone(old.f); l.touch(); });
    app.panels.props.focus = null;
  });
  app.fxStart = t => fxStart(app, t); app.fxPreview = i => fxPreview(app, i); app.fxSwitch = t => fxSwitch(app, t); app.fxEnd = ok => fxEnd(app, ok);

  // view
  C_('view.zoomIn', () => app.view.zoomStep(1), { enabled: hasDoc });
  C_('view.zoomOut', () => app.view.zoomStep(-1), { enabled: hasDoc });
  C_('view.fit', () => app.view.fit(), { enabled: hasDoc });
  C_('view.fill', () => app.view.fit(true), { enabled: hasDoc });
  C_('view.actual', () => app.view.actual(), { enabled: hasDoc });
  const toggle = (k) => () => app.setPref(k, app.prefs[k] === false ? true : !app.prefs[k]);
  C_('view.rulers', toggle('rulers'), { checked: a => a.prefs.rulers !== false });
  C_('view.guides', toggle('guides'), { checked: a => a.prefs.guides !== false });
  C_('view.snap', toggle('snap'), { checked: a => a.prefs.snap !== false });
  for (const k of ['guides', 'canvas', 'layers']) C_('view.snapTo.' + k, () => app.setPref('snapTo', { ...app.prefs.snapTo, [k]: !(app.prefs.snapTo[k] ?? k !== 'layers') }), { checked: a => !!(a.prefs.snapTo[k] ?? k !== 'layers') });
  C_('view.grid', toggle('grid'), { checked: a => !!a.prefs.grid });
  C_('view.pixelGrid', () => app.setPref('pixelGrid', !(app.prefs.pixelGrid !== false)), { checked: a => a.prefs.pixelGrid !== false });
  C_('view.lockGuides', () => { const d = app.doc; d.guidesLocked = !d.guidesLocked; app.menus.sync(); }, { enabled: hasDoc, checked: a => !!(a.doc && a.doc.guidesLocked) });
  C_('view.clearGuides', () => { const d = app.doc, old = d.guides.map(g => ({ ...g })); d.edit('Clear Guides', () => { d.guides = []; }, () => { d.guides = old.map(g => ({ ...g })); }, { kind: 'guides' }); }, { enabled: a => !!(a.doc && a.doc.guides.length) });
  C_('view.newGuide', async () => { const r = await newGuideDialog(app); if (!r) return; const d = app.doc, g = { ...r }; d.edit('New Guide', () => d.guides.push(g), () => d.guides.splice(d.guides.indexOf(g), 1), { kind: 'guides' }); }, { enabled: hasDoc });
  C_('view.guideLayout', async () => {
    const r = await guideLayoutDialog(app); if (!r) return; const d = app.doc, old = d.guides.map(g => ({ ...g })), add = [];
    const lay = (n, len, axis) => { if (!n) return; const m = r.margin, inner = len - 2 * m, cw = (inner - r.gutter * (n - 1)) / n; if (m) add.push({ axis, pos: m }, { axis, pos: len - m }); for (let i = 1; i < n; i++) { const p = m + i * cw + (i - 1) * r.gutter; add.push({ axis, pos: Math.round(p) }); if (r.gutter) add.push({ axis, pos: Math.round(p + r.gutter) }); } };
    lay(r.cols, d.width, 'v'); lay(r.rows, d.height, 'h');
    if (r.center) add.push({ axis: 'v', pos: Math.round(d.width / 2) }, { axis: 'h', pos: Math.round(d.height / 2) });
    d.edit('New Guide Layout', () => { d.guides = [...(r.clear ? [] : old.map(g => ({ ...g }))), ...add.map(g => ({ ...g }))]; }, () => { d.guides = old.map(g => ({ ...g })); }, { kind: 'guides' });
  }, { enabled: hasDoc });
  for (const u of ['px', 'in', 'cm', 'mm', 'pt', 'pct']) C_('view.units.' + u, () => app.setPref('units', u), { checked: a => a.prefs.units === u });
  for (const k of ['mono', 'violet', 'paper', 'terminal', 'ember', 'ice', 'wyrm']) C_('window.skin.' + k, () => app.setPref('skin', k), { checked: a => a.prefs.skin === k });
  C_('window.next', () => { const i = app.docs.indexOf(app.doc); if (app.docs.length > 1) app.activate(app.docs[(i + 1) % app.docs.length]); });
}
export { uid, round, toPx, blobBytes, shiftLayer, layerBox };
