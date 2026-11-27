// The selection: a document-size 8-bit mask (stored as the alpha of a white
// canvas, so Canvas2D can draw shapes into it anti-aliased and use it to clip
// with 'destination-in'). Edges for the marching ants are pixel-boundary runs.

import { canvas, ctx, R, getData, opaqueBounds, clamp } from './util.js';
import { blurAlpha, edt } from './blur.js';

export class Selection {
  constructor(doc) { this.doc = doc; this.mask = null; this.active = false; this.rev = 0; this._edges = null; this._bounds = undefined; this.saved = null; }

  maskCanvas() {
    const { width: w, height: h } = this.doc;
    if (!this.mask || this.mask.width !== w || this.mask.height !== h) { this.mask = canvas(w, h); }
    return this.mask;
  }
  /** drop cached bounds / edges after the mask changes */
  dirty() { this._edges = null; this._bounds = undefined; }
  changed() { this.rev++; this.dirty(); this.doc.changed('selection'); }
  snapshot() { return this.active ? { mask: cloneMask(this.mask), active: true } : { mask: null, active: false }; }
  restore(s) { this.mask = s.mask ? cloneMask(s.mask) : null; this.active = s.active; this.changed(); }

  /** undoable wrapper: fn mutates the selection */
  edit(label, fn) {
    const before = this.snapshot();
    fn();
    this.dirty();
    if (this.active && !this.bounds()) { this.active = false; }
    const after = this.snapshot();
    this.changed();
    this.doc.history.push({ label, undo: () => this.restore(before), redo: () => this.restore(after) });
  }

  /** combine a drawn shape: draw(ctx) paints white into a blank doc-size canvas */
  combine(mode, draw, feather = 0) {
    const shape = canvas(this.doc.width, this.doc.height), x = ctx(shape);
    x.fillStyle = '#fff'; x.strokeStyle = '#fff';
    draw(x);
    if (feather > 0) featherCanvas(shape, feather);
    const m = this.maskCanvas(), mx = ctx(m);
    if (mode === 'new' || !this.active) {
      if (mode === 'sub') return; // subtracting from nothing
      if (mode === 'int') { this.active = false; return; }
      mx.clearRect(0, 0, m.width, m.height); mx.globalCompositeOperation = 'source-over'; mx.drawImage(shape, 0, 0);
    } else if (mode === 'add') { mx.globalCompositeOperation = 'source-over'; mx.drawImage(shape, 0, 0); }
    else if (mode === 'sub') { mx.globalCompositeOperation = 'destination-out'; mx.drawImage(shape, 0, 0); }
    else if (mode === 'int') { mx.globalCompositeOperation = 'destination-in'; mx.drawImage(shape, 0, 0); }
    mx.globalCompositeOperation = 'source-over';
    this.active = true; this.dirty();
  }
  rect(r, mode, feather, aa = true) { this.combine(mode, x => { x.imageSmoothingEnabled = aa; x.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)); }, feather); }
  ellipse(r, mode, feather, aa = true) {
    this.combine(mode, x => { x.beginPath(); x.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2); x.fill(); }, feather);
    if (!aa) this.threshold();
  }
  polygon(pts, mode, feather, aa = true) {
    if (pts.length < 3) return;
    this.combine(mode, x => { x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.closePath(); x.fill(); }, feather);
    if (!aa) this.threshold();
  }
  /** from any canvas's alpha placed at (ox, oy) */
  fromAlpha(src, ox, oy, mode = 'new') { this.combine(mode, x => x.drawImage(src, ox, oy)); }
  all() { const m = this.maskCanvas(), x = ctx(m); x.globalCompositeOperation = 'source-over'; x.fillStyle = '#fff'; x.fillRect(0, 0, m.width, m.height); this.active = true; }
  clear() { if (this.active) this.saved = cloneMask(this.mask); this.active = false; }
  invert() {
    const m = this.maskCanvas(), x = ctx(m);
    if (!this.active) { x.clearRect(0, 0, m.width, m.height); }
    const d = getData(m); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = d.data[i + 1] = d.data[i + 2] = 255; d.data[i + 3] = 255 - d.data[i + 3]; }
    x.putImageData(d, 0, 0); this.active = true;
  }
  /** alpha channel as Uint8 (copy) */
  alpha() {
    const m = this.maskCanvas(), d = getData(m).data, a = new Uint8ClampedArray(m.width * m.height);
    if (!this.active) return a.fill(255);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  }
  setAlpha(a) {
    const m = this.maskCanvas(), id = ctx(m).createImageData(m.width, m.height), d = id.data;
    for (let i = 0; i < a.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = a[i]; }
    ctx(m).putImageData(id, 0, 0); this.active = true; this.dirty();
  }
  threshold(t = 128) { const a = this.alpha(); for (let i = 0; i < a.length; i++) a[i] = a[i] >= t ? 255 : 0; this.setAlpha(a); }
  feather(r) { if (!this.active || r <= 0) return; const a = this.alpha(); blurAlpha(a, this.doc.width, this.doc.height, r); this.setAlpha(a); }
  expand(px) {
    if (!this.active) return; const { width: w, height: h } = this.doc, a = this.alpha(), inside = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) inside[i] = a[i] >= 128;
    const d = edt(inside, w, h);
    for (let i = 0; i < a.length; i++) if (!inside[i]) a[i] = Math.max(a[i], clamp(px + 0.5 - Math.sqrt(d[i]), 0, 1) * 255);
    this.setAlpha(a);
  }
  contract(px) {
    if (!this.active) return; const { width: w, height: h } = this.doc, a = this.alpha(), outside = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) outside[i] = a[i] < 128;
    // pixels at the document edge count as touching the outside, as in Photoshop
    const d = edt(outside, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (outside[i]) { a[i] = 0; continue; }   // the old soft fringe is outside the new edge
      const edge = Math.min(x + 1, y + 1, w - x, h - y), dd = Math.min(Math.sqrt(d[i]), edge);
      a[i] = Math.min(a[i], clamp(dd - px + 0.5, 0, 1) * 255);
    }
    this.setAlpha(a);
  }
  smooth(r) {
    if (!this.active || r <= 0) return; const a = this.alpha(); blurAlpha(a, this.doc.width, this.doc.height, r);
    for (let i = 0; i < a.length; i++) a[i] = clamp((a[i] - 128) * 4 + 128, 0, 255);
    this.setAlpha(a);
  }
  border(px) {
    if (!this.active) return; const { width: w, height: h } = this.doc, a = this.alpha(), inside = new Uint8Array(w * h), outside = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) { inside[i] = a[i] >= 128; outside[i] = !inside[i]; }
    const di = edt(inside, w, h), dout = edt(outside, w, h), half = px / 2;
    for (let i = 0; i < a.length; i++) { const dist = inside[i] ? Math.sqrt(dout[i]) : Math.sqrt(di[i]); a[i] = clamp(half + 0.5 - dist, 0, 1) * 255; }
    this.setAlpha(a);
  }
  shift(dx, dy) {
    if (!this.mask) return; const old = this.mask, n = canvas(this.doc.width, this.doc.height); ctx(n).drawImage(old, dx, dy); this.mask = n; this.changed();
  }
  /** after the document size changes */
  resize(w, h, dx = 0, dy = 0) { if (!this.mask) return; const n = canvas(w, h); ctx(n).drawImage(this.mask, dx, dy); this.mask = n; this.changed(); }
  bounds() {
    if (!this.active) return null;
    if (this._bounds === undefined) this._bounds = opaqueBounds(this.mask, 0);
    return this._bounds;
  }
  /** coverage 0..1 at doc point */
  at(x, y) { if (!this.active) return 1; x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return 0; return ctx(this.mask).getImageData(x, y, 1, 1).data[3] / 255; }

  /** pixel-boundary edge runs at 50% coverage: Float32Array [x0,y0,x1,y1, ...] in doc px */
  edges() {
    if (!this.active) return null;
    if (this._edges) return this._edges;
    const { width: w, height: h } = this.doc, a = this.alpha(), segs = [];
    const inS = (x, y) => x >= 0 && y >= 0 && x < w && y < h && a[y * w + x] >= 128;
    // horizontal edges: between row y-1 and y
    for (let y = 0; y <= h; y++) {
      let run = -1, dir = 0;
      for (let x = 0; x <= w; x++) {
        const d = x < w ? (inS(x, y - 1) !== inS(x, y) ? (inS(x, y) ? 1 : 2) : 0) : 0;
        if (d !== dir) { if (dir) segs.push(run, y, x, y); run = x; dir = d; }
      }
    }
    for (let x = 0; x <= w; x++) {
      let run = -1, dir = 0;
      for (let y = 0; y <= h; y++) {
        const d = y < h ? (inS(x - 1, y) !== inS(x, y) ? (inS(x, y) ? 1 : 2) : 0) : 0;
        if (d !== dir) { if (dir) segs.push(x, run, x, y); run = y; dir = d; }
      }
    }
    this._edges = new Float32Array(segs);
    return this._edges;
  }
  /** a canvas whose alpha is the selection restricted to rect r (for clipping), or null if none */
  clipFor(r) {
    if (!this.active) return null;
    const c = canvas(r.w, r.h); ctx(c).drawImage(this.mask, -r.x, -r.y); return c;
  }
}

export function cloneMask(m) { if (!m) return null; const c = canvas(m.width, m.height); ctx(c).drawImage(m, 0, 0); return c; }

/** feather (gaussian) the alpha of a canvas in place */
export function featherCanvas(c, r) {
  const id = getData(c), d = id.data, a = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  blurAlpha(a, c.width, c.height, r);
  for (let i = 0; i < a.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = a[i]; }
  ctx(c).putImageData(id, 0, 0);
}
export { R };
