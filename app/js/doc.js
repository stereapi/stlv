// The document: a tree of layers (bottom -> top in each group), guides, the
// selection, ppi, and its undo history. Every change goes through history so
// undo always works; the compositor watches layer.rev / layer.dirty.

import { uid, canvas, ctx, cloneCanvas, getData, putData, R, Emitter, clamp } from './util.js';
import { Selection } from './selection.js';

export const BLEND_MODES = [
  ['normal', 'Normal'], ['dissolve', 'Dissolve'], null,
  ['darken', 'Darken'], ['multiply', 'Multiply'], ['colorBurn', 'Color Burn'], ['linearBurn', 'Linear Burn'], ['darkerColor', 'Darker Color'], null,
  ['lighten', 'Lighten'], ['screen', 'Screen'], ['colorDodge', 'Color Dodge'], ['linearDodge', 'Linear Dodge (Add)'], ['lighterColor', 'Lighter Color'], null,
  ['overlay', 'Overlay'], ['softLight', 'Soft Light'], ['hardLight', 'Hard Light'], ['vividLight', 'Vivid Light'], ['linearLight', 'Linear Light'], ['pinLight', 'Pin Light'], ['hardMix', 'Hard Mix'], null,
  ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['subtract', 'Subtract'], ['divide', 'Divide'], null,
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'],
];
export const BLEND_IDS = Object.fromEntries(BLEND_MODES.filter(Boolean).map(([k], i) => [k, i]));
export const blendName = k => k === 'pass' ? 'Pass Through' : (BLEND_MODES.find(m => m && m[0] === k) || [0, k])[1];

/* ---------- layers ---------- */
export class Layer {
  constructor(type, name) {
    this.id = uid('L'); this.type = type; this.name = name;
    this.visible = true; this.opacity = 1; this.fill = 1; this.blend = 'normal';
    this.lock = { px: false, pos: false, all: false, alpha: false };
    this.clip = false;
    this.mask = null;          // {canvas, x, y, bg:0|255, enabled, linked, rev}
    this.style = {};           // {gradOverlay: {...}}
    this.filters = [];         // live filters [{type, params, visible}]
    this.rev = 1;              // bumped on any visual change
    this.dirty = null;         // layer-local rect changed since last upload (null = all)
    this.parent = null;
  }
  /** content changed: rect (layer-local) for a partial upload, nothing for all of it */
  touch(rect) {
    this.rev++; this.fxRev = (this.fxRev || 0) + 1;
    if (!rect) this.dirtyFull = true; else this.dirty = this.dirty ? R.union(this.dirty, rect) : { ...rect };
  }
  get isGroup() { return this.type === 'group'; }
  get hasPixels() { return this.type === 'pixel'; }
  /** doc-space bounds of its content */
  bounds(doc) { return { x: 0, y: 0, w: doc.width, h: doc.height }; }
}

export class PixelLayer extends Layer {
  constructor(name, w, h, x = 0, y = 0) { super('pixel', name); this.canvas = canvas(w, h); this.x = x; this.y = y; }
  bounds() { return { x: this.x, y: this.y, w: this.canvas.width, h: this.canvas.height }; }
  /** grow the canvas so it covers doc rect r (keeps content) */
  ensure(r) {
    const b = this.bounds(), u = R.union(b, R.out(r));
    if (R.eq(u, b)) return false;
    const c = canvas(u.w, u.h); ctx(c).drawImage(this.canvas, b.x - u.x, b.y - u.y);
    this.canvas = c; this.x = u.x; this.y = u.y; this.touch(); return true;
  }
}

export class TextLayer extends Layer {
  constructor(name, props) {
    super('text', name);
    Object.assign(this, {
      text: 'Text', font: 'Helvetica Neue', fontStyle: 'Regular', weight: 400, italic: false, size: 36 /* pt */,
      color: { r: 0, g: 0, b: 0 }, tracking: 0, leading: 0 /* 0 = auto */, align: 'left',
      x: 0, y: 0 /* anchor: baseline of first line (point text) or box top-left */,
      box: null /* {w,h} for paragraph text */, aa: 'smooth', xform: null /* affine [a,b,c,d,e,f] about anchor */,
      warp: null /* {style, bend, hd, vd} */, caps: false,
    }, props);
    this.raster = null; // {canvas, x, y, key}
  }
}

export class FillLayer extends Layer {
  constructor(name, kind, props) {
    super('fill', name); this.kind = kind;     // 'solid' | 'gradient'
    this.color = { r: 0, g: 0, b: 0 };
    this.gradient = null;                      // {stops, type, angle, scale, reverse, dither, ox, oy}
    Object.assign(this, props);
  }
}

export class AdjustLayer extends Layer {
  constructor(name, adj, params) { super('adjust', name); this.adj = adj; this.params = params; }
}

export class GroupLayer extends Layer {
  constructor(name) { super('group', name); this.blend = 'pass'; this.children = []; this.open = true; }
}

/* ---------- history ---------- */
export class History {
  constructor(doc) { this.doc = doc; this.list = []; this.index = 0; this.limit = 100; this.saved = 0; }
  /** entry {label, undo, redo, merge?}. merge collapses repeats (slider drags): only safe when
   *  redo sets absolute values and undo restores the first state, never for deltas */
  push(e) {
    this.list.length = this.index;
    const last = this.list[this.index - 1];
    if (e.merge && last && last.merge === e.merge && Date.now() - last.t < 1500) { last.redo = e.redo; last.t = Date.now(); this.doc.changed('history'); return; }
    e.t = Date.now(); this.list.push(e); this.index++;
    if (this.list.length > this.limit) { this.list.shift(); this.index--; this.saved--; }
    this.doc.changed('history');
  }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.list.length; }
  undo() { if (!this.canUndo) return; const e = this.list[--this.index]; e.undo(); this.doc.changed('history'); this.doc.changed('all'); }
  redo() { if (!this.canRedo) return; const e = this.list[this.index++]; e.redo(); this.doc.changed('history'); this.doc.changed('all'); }
  goto(i) { while (this.index > i) this.undo(); while (this.index < i) this.redo(); }
  get dirty() { return this.saved !== this.index; }
  markSaved() { this.saved = this.index; this.doc.changed('title'); }
}

/* ---------- document ---------- */
export class Doc extends Emitter {
  constructor({ name = 'Untitled', width, height, ppi = 72, background = 'white', bgColor } = {}) {
    super();
    this.id = uid('D'); this.name = name; this.width = width; this.height = height; this.ppi = ppi;
    this.root = new GroupLayer('root'); this.root.blend = 'pass';
    this.guides = [];                 // {axis:'h'|'v', pos}
    this.selection = new Selection(this);
    this.history = new History(this);
    this.active = null; this.selected = new Set();
    this.path = null; this.token = null; this.format = null;
    this.view = null;                 // zoom/pan, set by the view
    this.guidesLocked = false;
    this.meta = {};
    if (background !== 'none') {
      const bg = new PixelLayer('Background', width, height);
      const col = background === 'white' ? '#ffffff' : background === 'black' ? '#000000' : background === 'transparent' ? null : bgColor;
      if (col) { const x = ctx(bg.canvas); x.fillStyle = col; x.fillRect(0, 0, width, height); }
      if (background !== 'transparent') bg.lock.pos = true;
      bg.isBackground = background !== 'transparent';
      if (background === 'transparent') bg.name = 'Layer 1';
      this.insert(bg, this.root, 0);
      this.active = bg; this.selected = new Set([bg.id]);
    }
  }
  /** kind: 'layers'|'pixels'|'props'|'selection'|'guides'|'size'|'history'|'title'|'all'; rect in doc px */
  changed(kind, info) { this.emit('change', kind, info); }

  /* tree */
  walk(fn, node = this.root, depth = 0) { for (const c of node.children) { if (fn(c, depth) === false) return false; if (c.isGroup && this.walk(fn, c, depth + 1) === false) return false; } }
  all() { const a = []; this.walk(l => { a.push(l); }); return a; }
  find(id) { let r = null; this.walk(l => { if (l.id === id) { r = l; return false; } }); return r; }
  /** top-to-bottom display list with depth (for the layers panel) */
  displayList() {
    const out = [];
    const rec = (g, depth) => { for (let i = g.children.length - 1; i >= 0; i--) { const l = g.children[i]; out.push({ layer: l, depth }); if (l.isGroup && l.open) rec(l, depth + 1); } };
    rec(this.root, 0); return out;
  }
  insert(layer, parent = this.root, index = parent.children.length) { layer.parent = parent; parent.children.splice(index, 0, layer); }
  detach(layer) { const p = layer.parent, i = p.children.indexOf(layer); p.children.splice(i, 1); layer.parent = null; return { parent: p, index: i }; }
  indexOf(layer) { return layer.parent.children.indexOf(layer); }
  setActive(layer, additive = false) {
    this.active = layer;
    if (additive && layer) { this.selected.has(layer.id) ? this.selected.delete(layer.id) : this.selected.add(layer.id); if (!this.selected.size) this.selected.add(layer.id); }
    else this.selected = new Set(layer ? [layer.id] : []);
    this.changed('active');
  }
  selectedLayers() { return this.all().filter(l => this.selected.has(l.id)); }
  /** is l (or an ancestor) hidden */
  hiddenChain(l) { for (let p = l; p && p !== this.root; p = p.parent) if (!p.visible) return true; return false; }
  /** the layer whose alpha clips `l`, or null */
  clipBase(l) { if (!l.clip) return null; const sib = l.parent.children; for (let i = sib.indexOf(l) - 1; i >= 0; i--) if (!sib[i].clip) return sib[i]; return null; }
  layerName(prefix = 'Layer') { let n = 1; const names = new Set(this.all().map(l => l.name)); while (names.has(`${prefix} ${n}`)) n++; return `${prefix} ${n}`; }

  /* ---------- undoable edits ---------- */
  /** do/undo closures; runs `apply` now */
  edit(label, apply, revert, opts = {}) {
    apply();
    this.history.push({ label, undo: () => { revert(); this.changed(opts.kind || 'all'); }, redo: () => { apply(); this.changed(opts.kind || 'all'); }, merge: opts.merge });
    this.changed(opts.kind || 'all');
  }
  /** change layer properties: props {key: value}; merge key lets slider drags collapse */
  setProps(layer, props, label = 'Layer properties', merge) {
    const old = {}; for (const k in props) old[k] = clone(layer[k]);
    const apply = v => () => { for (const k in v) layer[k] = clone(v[k]); layer.touch(); if (layer.type === 'text') layer.raster = null; };
    this.edit(label, apply(props), apply(old), { merge: merge ? merge + layer.id : null });
  }
  addLayer(layer, { above = this.active, parent, index, label } = {}) {
    let p = parent, i = index;
    if (!p) {
      if (above && above.isGroup && above.open && above.children.length === 0) { p = above; i = 0; }
      else if (above) { p = above.parent; i = p.children.indexOf(above) + 1; }
      else { p = this.root; i = p.children.length; }
    }
    if (i == null) i = p.children.length;
    const prevActive = this.active, prevSel = new Set(this.selected);
    this.edit(label || 'New Layer', () => { this.insert(layer, p, i); this.active = layer; this.selected = new Set([layer.id]); },
      () => { this.detach(layer); this.active = prevActive; this.selected = prevSel; });
    return layer;
  }
  removeLayers(layers, label = 'Delete Layer') {
    layers = layers.filter(l => l.parent);
    if (!layers.length) return;
    const spots = []; const prevActive = this.active, prevSel = new Set(this.selected);
    this.edit(label, () => {
      spots.length = 0;
      for (const l of layers) spots.push({ l, ...this.detach(l) });
      const left = this.all(); this.active = left[left.length - 1] || null; this.selected = new Set(this.active ? [this.active.id] : []);
    }, () => {
      for (const s of [...spots].reverse()) this.insert(s.l, s.parent, s.index);
      this.active = prevActive; this.selected = prevSel;
    });
  }
  moveLayer(layer, parent, index, label = 'Move Layer') {
    let from;
    this.edit(label, () => { from = this.detach(layer); const i = Math.min(index - (from.parent === parent && from.index < index ? 1 : 0), parent.children.length); this.insert(layer, parent, Math.max(0, i)); },
      () => { this.detach(layer); this.insert(layer, from.parent, from.index); });
  }
  /** move several layers into parent at index (a slot in parent.children, bottom->top), keeping their order. One undo step */
  moveLayers(Ls, parent, index, label = 'Move Layers') {
    let from;
    this.edit(label, () => {
      from = Ls.map(l => ({ l, p: l.parent, i: l.parent.children.indexOf(l) }));
      let anchor = null;
      for (let k = index; k < parent.children.length; k++) if (!Ls.includes(parent.children[k])) { anchor = parent.children[k]; break; }
      for (const l of Ls) this.detach(l);
      const at = anchor ? parent.children.indexOf(anchor) : parent.children.length;
      Ls.forEach((l, j) => this.insert(l, parent, at + j));
    }, () => {
      for (const l of Ls) this.detach(l);
      [...from].sort((a, b) => a.i - b.i).forEach(f => this.insert(f.l, f.p, f.i));
    });
  }
  /** record a pixel change on `layer`; grow: doc rect the layer must cover (growth is part of the step).
   *  rec.base = the layer's pixels before the change, in the (possibly grown) canvas's coordinates */
  pixelEdit(layer, label, grow) {
    const c0 = layer.canvas, x0 = layer.x, y0 = layer.y;
    const before = cloneCanvas(c0);
    if (grow) layer.ensure(grow);
    const base = layer.canvas === c0 ? before : cloneCanvas(layer.canvas);
    return {
      commit: (rect) => {
        const c1 = layer.canvas, x1 = layer.x, y1 = layer.y;
        if (c1 === c0 && x1 === x0 && y1 === y0 && rect) {
          // same canvas: keep only the changed region
          const r = R.inter(R.out(rect), { x: 0, y: 0, w: c0.width, h: c0.height });
          if (!r) return;
          const b = getData(before, r), a = getData(c1, r);
          this.history.push({ label, undo: () => { putData(layer.canvas, b, r.x, r.y); layer.touch(r); this.changed('pixels', { layer }); }, redo: () => { putData(layer.canvas, a, r.x, r.y); layer.touch(r); this.changed('pixels', { layer }); } });
        } else {
          const after = c1;
          this.history.push({ label, undo: () => { layer.canvas = before; layer.x = x0; layer.y = y0; layer.touch(); this.changed('pixels', { layer }); }, redo: () => { layer.canvas = after; layer.x = x1; layer.y = y1; layer.touch(); this.changed('pixels', { layer }); } });
        }
        this.changed('pixels', { layer });
      },
      cancel: () => { layer.canvas = before; layer.x = x0; layer.y = y0; layer.touch(); this.changed('pixels', { layer }); },
      before, base,
    };
  }
  /** replace a canvas wholesale (filters, transforms) as one undo step */
  replaceCanvas(layer, c, x, y, label) {
    const o = { c: layer.canvas, x: layer.x, y: layer.y }, n = { c, x, y };
    const set = s => () => { layer.canvas = s.c; layer.x = s.x; layer.y = s.y; layer.touch(); };
    this.edit(label, set(n), set(o), { kind: 'pixels' });
  }
  /** same for a layer mask */
  replaceMask(layer, mask, label) {
    const o = layer.mask, n = mask;
    this.edit(label, () => { layer.mask = n; layer.touch(); }, () => { layer.mask = o; layer.touch(); });
  }
  maskEdit(layer, label) {
    const m = layer.mask, before = cloneCanvas(m.canvas), x0 = m.x, y0 = m.y, c0 = m.canvas;
    return {
      commit: (rect) => {
        const c1 = m.canvas, x1 = m.x, y1 = m.y;
        if (c1 === c0 && rect) {
          const r = R.inter(R.out(rect), { x: 0, y: 0, w: c0.width, h: c0.height }); if (!r) return;
          const b = getData(before, r), a = getData(c1, r);
          this.history.push({ label, undo: () => { putData(m.canvas, b, r.x, r.y); m.rev = (m.rev || 0) + 1; layer.touch(); this.changed('pixels', { layer }); }, redo: () => { putData(m.canvas, a, r.x, r.y); m.rev = (m.rev || 0) + 1; layer.touch(); this.changed('pixels', { layer }); } });
        } else {
          const after = c1;
          this.history.push({ label, undo: () => { m.canvas = before; m.x = x0; m.y = y0; m.rev = (m.rev || 0) + 1; layer.touch(); this.changed('pixels', { layer }); }, redo: () => { m.canvas = after; m.x = x1; m.y = y1; m.rev = (m.rev || 0) + 1; layer.touch(); this.changed('pixels', { layer }); } });
        }
        this.changed('pixels', { layer });
      },
    };
  }
  /** change canvas size: offsets every layer, keeps pixels beyond the edge */
  resizeCanvas(w, h, dx, dy, label = 'Canvas Size', fillBg) {
    const old = { w: this.width, h: this.height }, layers = this.all();
    const shift = (sx, sy) => { for (const l of layers) shiftLayer(l, sx, sy); this.guides.forEach(g => g.pos += g.axis === 'v' ? sx : sy); this.selection.shift(sx, sy); };
    this.edit(label, () => { this.width = w; this.height = h; shift(dx, dy); }, () => { shift(-dx, -dy); this.width = old.w; this.height = old.h; }, { kind: 'size' });
    void fillBg;
  }
  get pixelCount() { return this.width * this.height; }
}

/** move one layer's content (not a group's children: callers expand groups) */
export function shiftLayer(l, dx, dy) {
  if (l.type === 'pixel') { l.x += dx; l.y += dy; }
  else if (l.type === 'text') { l.x += dx; l.y += dy; l.raster = null; }
  else if (l.type === 'fill' && l.gradient) { l.gradient.ox = (l.gradient.ox || 0) + dx; l.gradient.oy = (l.gradient.oy || 0) + dy; }
  if (l.mask && (l.mask.linked || l.type !== 'pixel')) { l.mask.x += dx; l.mask.y += dy; }
  l.touch();
}

export function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (v instanceof HTMLCanvasElement) return v;
  if (Array.isArray(v)) return v.map(clone);
  const o = {}; for (const k in v) o[k] = clone(v[k]); return o;
}

/** a new empty pixel layer the size of the document */
export function newPixelLayer(doc, name) { return new PixelLayer(name || doc.layerName(), doc.width, doc.height, 0, 0); }

/** new mask: 'reveal' | 'hide' | 'selection' | 'inverse' */
export function makeMask(doc, layer, how) {
  const c = canvas(doc.width, doc.height), x = ctx(c);
  const bg = how === 'hide' || how === 'selection' ? 0 : 255;
  x.fillStyle = bg ? '#fff' : '#000'; x.fillRect(0, 0, c.width, c.height);
  if ((how === 'selection' || how === 'inverse') && doc.selection.active) {
    const m = doc.selection.maskCanvas();
    if (how === 'selection') { x.globalCompositeOperation = 'source-over'; drawMaskAsWhite(x, m); }
    else { x.globalCompositeOperation = 'destination-out'; x.drawImage(m, 0, 0); x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); }
  }
  return { canvas: c, x: 0, y: 0, bg, enabled: true, linked: true, rev: 1 };
}
function drawMaskAsWhite(x, m) {
  // m is an alpha mask (white with alpha); draw it as white over black
  x.drawImage(m, 0, 0);
}
export { clamp };
