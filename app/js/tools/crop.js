// Crop tool, and the content-aware scale session (layer or whole canvas).

import { R, canvas, ctx, clamp, dist, getData, toPx, round, M3 } from '../util.js';
import { og, lbl, select, num, chk, btn, seg } from '../ui/widgets.js';
import { shiftLayer, PixelLayer } from '../doc.js';
import { contentBox } from './basic.js';
import { carve, replay } from '../seamcarve.js';
import { resampleCanvas, buildMesh } from '../transform.js';

const RATIOS = [['free', 'Ratio: free'], ['orig', 'Original ratio'], ['1:1', '1 : 1 (square)'], ['4:5', '4 : 5'], ['5:4', '5 : 4'], ['2:3', '2 : 3'], ['3:2', '3 : 2'], ['9:16', '9 : 16'], ['16:9', '16 : 9'], ['custom', 'Custom W : H'], ['size', 'W × H @ ppi']];
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

function handles(r) { return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [r.x + r.w / 2, r.y], [r.x + r.w, r.y + r.h / 2], [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h / 2]]; }
/** resize rect r by dragging handle i to p, with an optional fixed ratio (w/h) */
function dragHandle(r0, i, p, ratio, fromCenter) {
  let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
  const L = [0, 3, 7].includes(i), Rt = [1, 2, 5].includes(i), T = [0, 1, 4].includes(i), B = [2, 3, 6].includes(i);
  if (L) x0 = p.x; if (Rt) x1 = p.x; if (T) y0 = p.y; if (B) y1 = p.y;
  if (fromCenter) { const cx = r0.x + r0.w / 2, cy = r0.y + r0.h / 2; if (L) x1 = 2 * cx - x0; if (Rt) x0 = 2 * cx - x1; if (T) y1 = 2 * cy - y0; if (B) y0 = 2 * cy - y1; }
  let r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  if (ratio) {
    if (i >= 4) { if (i === 4 || i === 6) { const w = r.h * ratio; r.x = r0.x + r0.w / 2 - w / 2; r.w = w; } else { const hh = r.w / ratio; r.y = r0.y + r0.h / 2 - hh / 2; r.h = hh; } }
    else { if (r.w / r.h > ratio) r.w = r.h * ratio; else r.h = r.w / ratio; if (L) r.x = (fromCenter ? r0.x + r0.w / 2 - r.w / 2 : x1 - r.w); if (T) r.y = (fromCenter ? r0.y + r0.h / 2 - r.h / 2 : y1 - r.h); }
  }
  return r;
}

export const cropTool = {
  id: 'crop', name: 'Crop', shortcut: 'c', icon: 'crop', cursor: 'crosshair',
  defaults: { ratio: 'free', rw: 1, rh: 1, pw: 1080, ph: 1350, ppi: 72, del: true, overlay: 'thirds' },
  activate(app) { this.reset(app); },
  leaveDoc(app) { this.r = null; },
  reset(app) { const d = app.doc; this.r = d ? (d.selection.bounds() ? { ...d.selection.bounds() } : { x: 0, y: 0, w: d.width, h: d.height }) : null; app.view && app.view.redraw(); },
  ratio(app) {
    const o = this.opts, d = app.doc;
    if (o.ratio === 'free') return null;
    if (o.ratio === 'orig') return d.width / d.height;
    if (o.ratio === 'custom') return o.rw / o.rh;
    if (o.ratio === 'size') return o.pw / o.ph;
    const [a, b] = o.ratio.split(':').map(Number); return a / b;
  },
  options(app) {
    const o = this.opts, set = (k, v) => { app.toolOpt(this, k, v); if (k === 'ratio') { this.fitRatio(app); app.ui.buildOptions(); } else if (k !== 'del' && k !== 'overlay') this.fitRatio(app); };
    const out = [og(select(RATIOS, o.ratio, v => set('ratio', v)))];
    if (o.ratio === 'custom') out.push(og(num({ value: o.rw, min: 0.01, digits: 2, width: 52, onChange: (v, f) => f && set('rw', v) }), lbl(':'), num({ value: o.rh, min: 0.01, digits: 2, width: 52, onChange: (v, f) => f && set('rh', v) })));
    if (o.ratio === 'size') out.push(og(num({ value: o.pw, min: 1, max: 12000, unit: ' px', width: 76, onChange: (v, f) => f && set('pw', v) }), lbl('×'), num({ value: o.ph, min: 1, max: 12000, unit: ' px', width: 76, onChange: (v, f) => f && set('ph', v) }), lbl('@'), num({ value: o.ppi, min: 1, max: 4800, unit: ' ppi', width: 70, onChange: (v, f) => f && set('ppi', v) })));
    out.push(og(btn('Clear', () => this.reset(app), 'ghost')), og(chk('Delete cropped pixels', o.del, v => set('del', v))), og(lbl('Overlay'), select([['thirds', 'Rule of thirds'], ['grid', 'Grid'], ['none', 'None']], o.overlay, v => set('overlay', v))));
    out.push(og(btn('x', () => this.reset(app), 'ghost icon', 'Reset (Esc)'), btn('check', () => this.commit(app), 'pri icon', 'Crop (↩)')));
    return out;
  },
  fitRatio(app) {
    const k = this.ratio(app); if (!k || !this.r) { app.view.redraw(); return; }
    const r = this.r, c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    let w = r.w, hh = r.w / k; if (hh > r.h) { hh = r.h; w = hh * k; }
    this.r = { x: c.x - w / 2, y: c.y - hh / 2, w, h: hh }; app.view.redraw();
  },
  hit(app, e) {
    if (!this.r) return null;
    const v = app.view, hs = handles(this.r);
    for (let i = 0; i < 8; i++) { const s = v.toScreen(hs[i][0], hs[i][1]); if (Math.abs(s.x - e.sx) < 8 && Math.abs(s.y - e.sy) < 8) return { kind: 'h', i }; }
    if (R.contains(this.r, e.x, e.y)) return { kind: 'move' };
    return { kind: 'new' };
  },
  hover(e, app) { const hit = this.hit(app, e), vp = document.getElementById('viewport'); vp.style.cursor = !hit ? 'crosshair' : hit.kind === 'move' ? 'move' : hit.kind === 'h' ? ([0, 2].includes(hit.i) ? 'nwse-resize' : [1, 3].includes(hit.i) ? 'nesw-resize' : [4, 6].includes(hit.i) ? 'ns-resize' : 'ew-resize') : 'crosshair'; },
  down(e, app) { if (!this.r) this.reset(app); const hit = this.hit(app, e); this.drag = { hit, x0: e.x, y0: e.y, r0: { ...this.r } }; },
  move(e, app) {
    const g = this.drag; if (!g) return;
    const p = app.view.snapPt({ x: e.x, y: e.y }), k = this.ratio(app) || (e.shift ? g.r0.w / g.r0.h : null);
    if (g.hit.kind === 'move') { let dx = e.x - g.x0, dy = e.y - g.y0; const s = app.view.snapRect({ ...g.r0, x: g.r0.x + dx, y: g.r0.y + dy }); this.r = { ...g.r0, x: g.r0.x + dx + s.dx, y: g.r0.y + dy + s.dy }; }
    else if (g.hit.kind === 'h') this.r = dragHandle(g.r0, g.hit.i, p, k, e.alt);
    else { const a = app.view.snapPt({ x: g.x0, y: g.y0 }); this.r = dragHandle({ x: a.x, y: a.y, w: 0, h: 0 }, 2, p, k, e.alt); }
    app.ui.info(`${Math.round(this.r.w)} × ${Math.round(this.r.h)} px`);
    app.view.redraw();
  },
  up(e, app) { this.drag = null; app.ui.info(''); },
  dblclick(e, app) { if (this.r && R.contains(this.r, e.x, e.y)) this.commit(app); },
  key(e, app) { if (e.key === 'Enter') { this.commit(app); return true; } if (e.key === 'Escape') { this.reset(app); return true; } return false; },
  commit(app) {
    const d = app.doc, r = this.r && R.out({ x: round(this.r.x), y: round(this.r.y), w: round(this.r.w), h: round(this.r.h) });
    if (!r || r.w < 1 || r.h < 1) return;
    if (r.x === 0 && r.y === 0 && r.w === d.width && r.h === d.height && this.opts.ratio !== 'size') return;
    cropDoc(app, r, this.opts.del);
    if (this.opts.ratio === 'size') app.run('image.resizeTo', this.opts.pw, this.opts.ph, this.opts.ppi);
    this.reset(app);
  },
  overlay(c, view) {
    const r = this.r; if (!r) return;
    const a = view.toScreen(r.x, r.y), z = view.z, W = r.w * z, H = r.h * z;
    c.save(); c.fillStyle = 'rgba(0,0,0,.55)';
    c.beginPath(); c.rect(0, 0, view.w, view.h); c.rect(a.x, a.y, W, H); c.fill('evenodd');
    c.strokeStyle = '#fff'; c.lineWidth = 1; c.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(W), Math.round(H));
    if (this.opts.overlay !== 'none') {
      const n = this.opts.overlay === 'grid' ? 6 : 3; c.strokeStyle = 'rgba(255,255,255,.45)'; c.beginPath();
      for (let i = 1; i < n; i++) { c.moveTo(a.x + W * i / n, a.y); c.lineTo(a.x + W * i / n, a.y + H); c.moveTo(a.x, a.y + H * i / n); c.lineTo(a.x + W, a.y + H * i / n); }
      c.stroke();
    }
    c.fillStyle = accent();
    for (const [x, y] of handles(r)) { const s = view.toScreen(x, y); c.fillRect(Math.round(s.x) - 4, Math.round(s.y) - 4, 8, 8); }
    c.restore();
  },
};

/** crop the document to r (doc px); del = delete the pixels outside */
export function cropDoc(app, r, del) {
  const d = app.doc, layers = d.all();
  const saved = layers.map(l => ({ l, c: l.canvas, x: l.x, y: l.y, mask: l.mask ? { ...l.mask } : null }));
  const old = { w: d.width, h: d.height, guides: d.guides.map(g => ({ ...g })), sel: d.selection.snapshot() };
  const apply = () => {
    for (const l of layers) shiftLayer(l, -r.x, -r.y);
    d.guides.forEach(g => g.pos -= g.axis === 'v' ? r.x : r.y);
    d.width = r.w; d.height = r.h;
    d.selection.resize(r.w, r.h, -r.x, -r.y); d.selection.active = false;
    if (del) for (const l of layers) {
      if (l.type === 'pixel') { const n = canvas(r.w, r.h); ctx(n).drawImage(l.canvas, l.x, l.y); l.canvas = n; l.x = 0; l.y = 0; l.touch(); }
      if (l.mask) { const m = l.mask, n = canvas(r.w, r.h), x = ctx(n); x.fillStyle = m.bg ? '#fff' : '#000'; x.fillRect(0, 0, r.w, r.h); x.drawImage(m.canvas, m.x, m.y); l.mask = { ...m, canvas: n, x: 0, y: 0, rev: (m.rev || 0) + 1 }; }
    }
  };
  const revert = () => {
    for (const l of layers) shiftLayer(l, r.x, r.y);           // undo the shift (text, fills, masks...)
    for (const sv of saved) { if (sv.l.type === 'pixel') { sv.l.canvas = sv.c; sv.l.x = sv.x; sv.l.y = sv.y; } sv.l.mask = sv.mask ? { ...sv.mask } : null; sv.l.touch(); }
    d.width = old.w; d.height = old.h; d.guides = old.guides.map(g => ({ ...g })); d.selection.restore(old.sel);
  };
  d.edit('Crop', apply, revert, { kind: 'size' });
}

/* ---------- content-aware scale ---------- */
export const casTool = {
  id: 'cas', name: 'Content-Aware Scale', icon: 'cas', hidden: true, cursor: 'default',
  start(app, scope = 'layer') {
    const d = app.doc;
    let box, layer = null;
    if (scope === 'layer') {
      layer = app.editableLayer('pixels'); if (!layer) return;
      box = contentBox(layer, d); if (!box) return app.ui.toast('The layer is empty');
    } else box = { x: 0, y: 0, w: d.width, h: d.height };
    this.s = { scope, layer, box0: { ...box }, box: { ...box }, amount: 100, protect: d.selection.active ? 'selection' : 'none', prev: app.tool ? app.tool.id : 'move' };
    // a flat snapshot to preview with
    const src = scope === 'layer' ? (() => { const c = canvas(box.w, box.h); ctx(c).drawImage(layer.canvas, layer.x - box.x, layer.y - box.y); return c; })() : (() => { const id = app.view.comp.readComposite(d); const c = canvas(d.width, d.height); ctx(c).putImageData(id, 0, 0); return c; })();
    this.s.src = src;
    app.casSession = this;
    app.setTool('cas', true);
    this.preview(app);
  },
  options(app) {
    const s = this.s; if (!s) return [];
    return [og(lbl('Applies to'), h0(s.scope === 'layer' ? 'Layer' : 'Whole canvas')),
      og(lbl('W'), num({ value: Math.round(s.box.w), min: 1, max: 12000, unit: ' px', width: 76, onChange: (v, f) => { if (f) { s.box.w = v; this.preview(app); } } }), lbl('H'), num({ value: Math.round(s.box.h), min: 1, max: 12000, unit: ' px', width: 76, onChange: (v, f) => { if (f) { s.box.h = v; this.preview(app); } } })),
      og(lbl('Amount'), num({ value: s.amount, min: 0, max: 100, unit: '%', width: 56, onChange: (v, f) => { if (f) { s.amount = v; this.preview(app); } } })),
      og(lbl('Protect'), select([['none', 'None'], ['selection', 'Selection'], ['alpha', 'Opaque areas']], s.protect, v => { s.protect = v; this.preview(app); })),
      og(btn('x', () => this.end(app, false), 'ghost icon', 'Cancel (Esc)'), btn('check', () => this.end(app, true), 'pri icon', 'Commit (↩)'))];
  },
  /** protect mask (Uint8 per pixel of the source) */
  protectMask(app, w, hh) {
    const s = this.s, d = app.doc; if (s.protect === 'none') return null;
    const c = canvas(w, hh), x = ctx(c);
    if (s.protect === 'selection' && d.selection.active) x.drawImage(d.selection.maskCanvas(), s.box0.x - 0, s.box0.y - 0, s.box0.w, s.box0.h, 0, 0, w, hh);
    else if (s.protect === 'alpha') x.drawImage(s.src, 0, 0, w, hh);
    const dd = getData(c).data, m = new Uint8Array(w * hh); for (let i = 0; i < m.length; i++) m[i] = dd[i * 4 + 3];
    return m;
  },
  /** quick preview: carve a 1/4-size copy, show it stretched into the new box */
  preview(app) {
    const s = this.s; if (!s) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      const k = Math.min(1, Math.sqrt(500000 / (s.box0.w * s.box0.h)));
      const w = Math.max(2, Math.round(s.box0.w * k)), hh = Math.max(2, Math.round(s.box0.h * k));
      const sm = canvas(w, hh); const x = ctx(sm); x.imageSmoothingQuality = 'high'; x.drawImage(s.src, 0, 0, w, hh);
      const t0 = performance.now();
      const r = carve(getData(sm), Math.max(2, Math.round(s.box.w * k)), Math.max(2, Math.round(s.box.h * k)), this.protectMask(app, w, hh));
      const out = canvas(r.width, r.height); ctx(out).putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
      s.preview = this.mix(out, sm, r.width, r.height, s.amount / 100);
      s.ms = Math.round(performance.now() - t0);
      s.rev = (s.rev || 0) + 1;
      app.view.invalidate(); app.ui.info(`preview ${s.ms} ms`);
      app.ui.buildOptions();
    }, 60);
  },
  mix(carved, plainSrc, w, hh, amt) {
    if (amt >= 1) return carved;
    const out = canvas(w, hh), x = ctx(out); x.imageSmoothingQuality = 'high'; x.drawImage(plainSrc, 0, 0, w, hh); x.globalAlpha = amt; x.drawImage(carved, 0, 0); return out;
  },
  /** compositor hook: show the preview in place of the layer (or over everything) */
  meshFor(layer) {
    const s = this.s; if (!s || !s.preview) return null;
    const target = s.scope === 'layer' ? s.layer : null;
    if (layer !== target) return null;
    const b = s.box;
    return { verts: buildMesh((u, v) => ({ x: b.x + u * b.w, y: b.y + v * b.h }), 1), interp: 1, canvas: s.preview, rev: s.rev };
  },
  hidden(layer) { const s = this.s; return s && s.scope === 'canvas'; },
  overlay(c, view) {
    const s = this.s; if (!s) return;
    const b = s.box, a = view.toScreen(b.x, b.y), z = view.z;
    if (s.scope === 'canvas' && s.preview) { c.save(); c.imageSmoothingQuality = 'high'; c.drawImage(s.preview, a.x, a.y, b.w * z, b.h * z); c.restore(); }
    c.save(); c.strokeStyle = accent(); c.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.w * z), Math.round(b.h * z));
    c.fillStyle = '#fff';
    for (const [x, y] of handles(b)) { const p = view.toScreen(x, y); c.fillRect(Math.round(p.x) - 4, Math.round(p.y) - 4, 8, 8); }
    c.fillStyle = 'rgba(0,0,0,.75)'; c.fillRect(a.x + 6, a.y + 6, 150, 20); c.fillStyle = '#fff'; c.font = '11px -apple-system,sans-serif';
    c.fillText(`${Math.round(b.w / s.box0.w * 100)}% × ${Math.round(b.h / s.box0.h * 100)}%`, a.x + 12, a.y + 20);
    c.restore();
  },
  hit(app, e) { const s = this.s, hs = handles(s.box); for (let i = 0; i < 8; i++) { const p = app.view.toScreen(hs[i][0], hs[i][1]); if (Math.abs(p.x - e.sx) < 8 && Math.abs(p.y - e.sy) < 8) return i; } return -1; },
  hover(e, app) { const i = this.s ? this.hit(app, e) : -1; document.getElementById('viewport').style.cursor = i < 0 ? 'default' : [4, 6].includes(i) ? 'ns-resize' : [5, 7].includes(i) ? 'ew-resize' : 'nwse-resize'; },
  down(e, app) { const s = this.s; if (!s) return; const i = this.hit(app, e); if (i >= 0) this.drag = { i, r0: { ...s.box } }; },
  move(e, app) {
    const s = this.s, g = this.drag; if (!g) return;
    s.box = dragHandle(g.r0, g.i, { x: e.x, y: e.y }, e.shift ? g.r0.w / g.r0.h : null, e.alt);
    s.preview = null; app.view.invalidate(); app.ui.info(`${Math.round(s.box.w)} × ${Math.round(s.box.h)} px`);
  },
  up(e, app) { if (this.drag) { this.drag = null; this.s.box = R.out(this.s.box); this.preview(app); } },
  key(e, app) { if (!this.s) return false; if (e.key === 'Enter') { this.end(app, true); return true; } if (e.key === 'Escape') { this.end(app, false); return true; } return false; },
  deactivate(app) { if (this.s && !this.ending) this.end(app, false, true); },
  leaveDoc(app) { if (this.s) this.end(app, false, true); },
  async end(app, ok, keepTool) {
    const s = this.s; if (!s || this.ending) return;
    this.ending = true;
    try {
      const b = R.out(s.box);
      if (ok && (b.w !== s.box0.w || b.h !== s.box0.h || b.x !== s.box0.x || b.y !== s.box0.y)) await this.commit(app, s, b);
    } finally {
      this.s = null; app.casSession = null; this.ending = false; app.doc.changed('all');
      if (!keepTool) app.setTool(s.prev || 'move');
      app.ui.info('');
    }
  },
  async commit(app, s, b) {
    const d = app.doc;
    const run = (img, protect, progress) => new Promise((res) => {
      // a worker keeps the UI alive; fall back to this thread if workers aren't available
      try {
        const w = new Worker(new URL('../seamcarve.js', import.meta.url), { type: 'module' });
        w.onmessage = e => { if (e.data.progress != null) progress(e.data.progress); if (e.data.done) { w.terminate(); res(e.data); } };
        w.onerror = () => { w.terminate(); res(carve(img, b.w, b.h, protect, progress)); };
        w.postMessage({ img: { data: img.data, width: img.width, height: img.height }, tw: b.w, th: b.h, protect });
      } catch { res(carve(img, b.w, b.h, protect, progress)); }
    });
    if (s.scope === 'layer') {
      const l = s.layer, img = getData(s.src);
      const r = await app.ui.busy('Content-aware scale…', p => run(img, this.protectMask(app, s.box0.w, s.box0.h), p));
      let out = canvas(r.width, r.height); ctx(out).putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
      out = this.mix(out, s.src, r.width, r.height, s.amount / 100);
      d.replaceCanvas(l, out, b.x, b.y, 'Content-Aware Scale');
      return;
    }
    // whole canvas: seams from the composite, applied to every pixel layer and mask
    const img = getData(s.src);
    const r = await app.ui.busy('Content-aware resize…', p => run(img, this.protectMask(app, d.width, d.height), p));
    const ops = r.ops, W0 = d.width, H0 = d.height, layers = d.all();
    const saved = layers.map(l => ({ l, c: l.canvas, x: l.x, y: l.y, mask: l.mask, tx: l.x, ty: l.y }));
    const results = new Map();
    for (const l of layers) {
      const scaleX = b.w / W0, scaleY = b.h / H0;
      if (l.type === 'pixel') {
        const full = canvas(W0, H0); ctx(full).drawImage(l.canvas, l.x, l.y);
        const rr = replay(ops, getData(full).data, W0, H0);
        let c = canvas(rr.width, rr.height); ctx(c).putImageData(new ImageData(new Uint8ClampedArray(rr.data), rr.width, rr.height), 0, 0);
        if (s.amount < 100) c = this.mix(c, full, rr.width, rr.height, s.amount / 100);
        results.set(l, { canvas: c });
      }
      if (l.mask) {
        const m = l.mask, full = canvas(W0, H0), x = ctx(full); x.fillStyle = m.bg ? '#fff' : '#000'; x.fillRect(0, 0, W0, H0); x.drawImage(m.canvas, m.x, m.y);
        const rr = replay(ops, getData(full).data, W0, H0), c = canvas(rr.width, rr.height); ctx(c).putImageData(new ImageData(new Uint8ClampedArray(rr.data), rr.width, rr.height), 0, 0);
        results.set(l, { ...(results.get(l) || {}), mask: { ...m, canvas: c, x: 0, y: 0, rev: (m.rev || 0) + 1 } });
      }
      if (l.type === 'text') results.set(l, { ...(results.get(l) || {}), tx: l.x * scaleX, ty: l.y * scaleY });
    }
    const oldGuides = d.guides.map(g => ({ ...g }));
    d.edit('Content-Aware Resize', () => {
      for (const [l, v] of results) { if (v.canvas) { l.canvas = v.canvas; l.x = 0; l.y = 0; } if (v.mask) l.mask = v.mask; if (v.tx != null) { l.x = v.tx; l.y = v.ty; l.raster = null; } l.touch(); }
      d.guides.forEach(g => g.pos = Math.round(g.pos * (g.axis === 'v' ? b.w / W0 : b.h / H0)));
      d.width = b.w; d.height = b.h; d.selection.resize(b.w, b.h); d.selection.active = false;
    }, () => {
      for (const sv of saved) { sv.l.canvas = sv.c; sv.l.x = sv.x; sv.l.y = sv.y; sv.l.mask = sv.mask; sv.l.raster = null; sv.l.touch(); }
      d.guides = oldGuides.map(g => ({ ...g })); d.width = W0; d.height = H0; d.selection.resize(W0, H0);
    }, { kind: 'size' });
  },
};
const h0 = t => { const s = document.createElement('b'); s.textContent = t; return s; };
export { toPx, clamp, dist, M3, resampleCanvas, seg, PixelLayer };
