// Brush, eraser, fill bucket, gradient.
// A stroke builds up in its own buffer at the brush's flow, then lands on the
// layer at the brush's opacity (so one stroke never exceeds its opacity),
// through the selection, re-composited per frame only where it changed.

import { R, canvas, ctx, clamp, dist, C, cloneCanvas, getData } from '../util.js';
import { og, lbl, chk, seg, select, num, btn, icon } from '../ui/widgets.js';
import { brushCursor, brushSizeKeys } from './select.js';
import { sampleColor } from './basic.js';
import { FillLayer, makeMask } from '../doc.js';
import { gradientCSS, gradientUniforms, defaultGradient, cloneGradient, GRAD_TYPES } from '../gradient.js';
import { gradientEditor } from '../ui/gradedit.js';
import { FS_GRADIENT, VS_RECT } from '../gl.js';

export const PAINT_MODES = [['normal', 'Normal', 'source-over'], ['behind', 'Behind', 'destination-over'], ['clear', 'Clear', 'destination-out'], null,
  ['darken', 'Darken', 'darken'], ['multiply', 'Multiply', 'multiply'], ['colorBurn', 'Color Burn', 'color-burn'], null,
  ['lighten', 'Lighten', 'lighten'], ['screen', 'Screen', 'screen'], ['colorDodge', 'Color Dodge', 'color-dodge'], ['linearDodge', 'Linear Dodge (Add)', 'lighter'], null,
  ['overlay', 'Overlay', 'overlay'], ['softLight', 'Soft Light', 'soft-light'], ['hardLight', 'Hard Light', 'hard-light'], null,
  ['difference', 'Difference', 'difference'], ['exclusion', 'Exclusion', 'exclusion'], null,
  ['hue', 'Hue', 'hue'], ['saturation', 'Saturation', 'saturation'], ['color', 'Color', 'color'], ['luminosity', 'Luminosity', 'luminosity']];
export const paintOp = m => (PAINT_MODES.find(x => x && x[0] === m) || [0, 0, 'source-over'])[2];
const modeSelect = (value, onChange) => select(PAINT_MODES.map(m => m ? [m[0], m[1]] : null), value, onChange);
export const TIPS = [['round', 'Round'], ['soft', 'Soft round'], ['air', 'Airbrush'], ['chalk', 'Chalk'], ['square', 'Square']];

/* ---------- brush tips ---------- */
const stamps = new Map();
function stamp(tip, hard, rgb) {
  const key = tip + '|' + Math.round(hard * 100) + '|' + rgb.r + ',' + rgb.g + ',' + rgb.b;
  let s = stamps.get(key); if (s) return s;
  const N = 256, c = canvas(N, N), x = ctx(c), id = x.createImageData(N, N), d = id.data, r0 = N / 2;
  const hardness = tip === 'soft' ? 0 : tip === 'air' ? 0 : hard;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) {
    const dx = (xx + 0.5 - r0) / r0, dy = (y + 0.5 - r0) / r0;
    let a;
    if (tip === 'square') a = Math.max(Math.abs(dx), Math.abs(dy)) <= 1 ? 1 : 0;
    else {
      const rr = Math.hypot(dx, dy);
      if (rr >= 1) a = 0;
      else if (tip === 'air') a = Math.exp(-rr * rr * 4.5) * (1 - rr);
      else if (rr <= hardness) a = 1;
      else { const t = (rr - hardness) / Math.max(1e-3, 1 - hardness); a = 1 - t * t * (3 - 2 * t); }
      // anti-alias the hard edge
      if (hardness >= 0.98 && tip === 'round') a = clamp((1 - rr) * r0, 0, 1);
    }
    if (tip === 'chalk') a *= rnd() < 0.55 ? 0.15 + rnd() * 0.5 : 1;
    const i = (y * N + xx) * 4; d[i] = rgb.r; d[i + 1] = rgb.g; d[i + 2] = rgb.b; d[i + 3] = a * 255;
  }
  x.putImageData(id, 0, 0);
  if (stamps.size > 40) stamps.delete(stamps.keys().next().value);
  stamps.set(key, c); return c;
}

/* ---------- brush / eraser ---------- */
function makeBrush(id, name, key, icn, erase) {
  return {
    id, name, shortcut: key, icon: icn, coalesce: true,
    cursor: () => 'none',
    defaults: { size: erase ? 60 : 30, hardness: erase ? 50 : 80, opacity: 100, flow: 100, mode: 'normal', smoothing: 10, spacing: 15, pressure: 'size', tip: 'round' },
    options(app) {
      const o = this.opts, set = (k, v) => app.toolOpt(this, k, v);
      return [og(select(TIPS, o.tip, v => set('tip', v)), lbl('Size'), num({ value: o.size, min: 1, max: 5000, unit: ' px', width: 66, onChange: v => set('size', v) }),
        lbl('Hardness'), num({ value: o.hardness, min: 0, max: 100, unit: '%', width: 54, onChange: v => set('hardness', v) })),
        erase ? null : og(lbl('Mode'), modeSelect(o.mode, v => set('mode', v))),
        og(lbl('Opacity'), num({ value: o.opacity, min: 1, max: 100, unit: '%', width: 54, onChange: v => set('opacity', v) }), lbl('Flow'), num({ value: o.flow, min: 1, max: 100, unit: '%', width: 54, onChange: v => set('flow', v) })),
        og(lbl('Smoothing'), num({ value: o.smoothing, min: 0, max: 100, unit: '%', width: 54, onChange: v => set('smoothing', v) }), lbl('Spacing'), num({ value: o.spacing, min: 1, max: 200, unit: '%', width: 54, onChange: v => set('spacing', v) })),
        og(lbl('Pressure'), seg([['size', 'Size'], ['opacity', 'Opacity'], ['both', 'Both'], ['off', 'Off']], o.pressure, v => set('pressure', v)))].filter(Boolean);
    },
    down(e, app) {
      if (!erase && e.alt) { const c = sampleColor(app, e.x, e.y, 1, 'all'); if (c) app.setFg(c); return; }
      const t = app.paintTarget(); if (!t) return;
      const d = app.doc, l = t.layer;
      let C0, ox, oy, rec;
      if (t.mask) { const m = l.mask; C0 = m.canvas; ox = m.x; oy = m.y; rec = d.maskEdit(l, erase ? 'Eraser' : 'Brush Tool'); }
      else { rec = d.pixelEdit(l, erase ? 'Eraser' : 'Brush Tool', { x: 0, y: 0, w: d.width, h: d.height }); C0 = l.canvas; ox = l.x; oy = l.y; }
      const col = t.mask ? gray(erase ? app.bg : app.fg) : erase && l.isBackground ? app.bg : app.fg;
      this.s = {
        layer: l, mask: t.mask, target: C0, ox, oy, rec, base: t.mask ? cloneCanvas(C0) : rec.base, stroke: canvas(C0.width, C0.height),
        col, eraseMode: erase && !(l.isBackground && !t.mask) && !t.mask, dirty: null, pending: null, sel: d.selection.active ? d.selection.maskCanvas() : null,
        sm: { x: e.x, y: e.y }, last: null, pressure: e.pressure, scratch: canvas(1, 1),
      };
      const start = e.shift && this.lastEnd && this.lastEnd.layer === l ? this.lastEnd : null;
      if (start) { this.s.last = { x: start.x, y: start.y, p: e.pressure }; this.segment(this.s.last, { x: e.x, y: e.y, p: e.pressure }); }
      else { this.dab(e.x, e.y, e.pressure); this.s.last = { x: e.x, y: e.y, p: e.pressure }; }
      this.flush(app);
    },
    move(e, app) {
      this.cur = { x: e.x, y: e.y };
      const s = this.s; if (!s) { app.view.redraw(); return; }
      const k = 1 - clamp(this.opts.smoothing / 100, 0, 0.95) * 0.9;
      s.sm = { x: s.sm.x + (e.x - s.sm.x) * k, y: s.sm.y + (e.y - s.sm.y) * k };
      const to = { x: s.sm.x, y: s.sm.y, p: e.pressure };
      this.segment(s.last, to); s.last = to;
      this.flush(app);
    },
    hover(e, app) { this.cur = { x: e.x, y: e.y }; app.view.redraw(); },
    leave(app) { this.cur = null; app.view.redraw(); },
    up(e, app) {
      const s = this.s; if (!s) return;
      if (this.opts.smoothing > 0) { const to = { x: e.x, y: e.y, p: e.pressure }; this.segment(s.last, to); s.last = to; }
      this.flush(app, true);
      this.s = null;
      this.lastEnd = { layer: s.layer, x: s.last.x, y: s.last.y };
      if (!s.dirtyAll) return;
      s.rec.commit(s.dirtyAll);
    },
    size(p) { const o = this.opts; return Math.max(1, o.size * (o.pressure === 'size' || o.pressure === 'both' ? clamp(p, 0.05, 1) : 1)); },
    /** dabs every `spacing` along a -> b; s.acc carries the distance since the last dab */
    segment(a, b) {
      const s = this.s, L = dist(a, b); if (!L) return;
      const step = Math.max(0.5, this.size(b.p) * this.opts.spacing / 100);
      let d = step - (s.acc || 0);
      while (d <= L) { const u = d / L; this.dab(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.p + (b.p - a.p) * u); d += step; }
      s.acc = L - (d - step);
    },
    dab(x, y, p) {
      const s = this.s, o = this.opts, sz = this.size(p);
      const flow = o.flow / 100 * (o.pressure === 'opacity' || o.pressure === 'both' ? clamp(p, 0.05, 1) : 1);
      const st = stamp(o.tip, o.hardness / 100, s.col), c = ctx(s.stroke);
      const lx = x - s.ox, ly = y - s.oy;
      c.globalAlpha = flow; c.drawImage(st, lx - sz / 2, ly - sz / 2, sz, sz);
      const r = R.out({ x: lx - sz / 2 - 1, y: ly - sz / 2 - 1, w: sz + 2, h: sz + 2 });
      s.pending = R.union(s.pending, r);
    },
    /** recomposite the changed area: base + stroke at opacity (through selection) */
    flush(app, final) {
      const s = this.s, r0 = s.pending; if (!r0) return;
      s.pending = null;
      const r = R.inter(r0, { x: 0, y: 0, w: s.target.width, h: s.target.height }); if (!r) return;
      s.dirtyAll = R.union(s.dirtyAll, r);
      const t = ctx(s.target), o = this.opts;
      // the stroke for this rect, clipped by the selection
      const sc = s.scratch; if (sc.width < r.w || sc.height < r.h) { sc.width = Math.max(sc.width, r.w); sc.height = Math.max(sc.height, r.h); }
      const x = ctx(sc); x.globalCompositeOperation = 'copy'; x.globalAlpha = 1; x.drawImage(s.stroke, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      if (s.sel) { x.globalCompositeOperation = 'destination-in'; x.drawImage(s.sel, -(r.x + s.ox), -(r.y + s.oy)); }
      x.globalCompositeOperation = 'source-over';
      t.save(); t.beginPath(); t.rect(r.x, r.y, r.w, r.h); t.clip();
      t.globalCompositeOperation = 'copy'; t.drawImage(s.base, 0, 0);
      t.globalAlpha = o.opacity / 100;
      const lockAlpha = !s.mask && s.layer.lock.alpha;
      t.globalCompositeOperation = s.eraseMode ? 'destination-out' : s.mask ? 'source-over' : lockAlpha ? 'source-atop' : erase ? 'source-over' : paintOp(o.mode);
      t.drawImage(sc, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
      t.restore();
      if (s.mask) { const m = s.layer.mask; m.rev = (m.rev || 0) + 1; m.dirty = R.union(m.dirty, r); s.layer.rev++; }
      else s.layer.touch(r);
      app.view.invalidate({ x: r.x + s.ox, y: r.y + s.oy, w: r.w, h: r.h });
    },
    key(e, app) { return brushSizeKeys(e, app, this); },
    overlay(c, view) { if (this.cur) brushCursor(c, view, this.cur, this.opts.size); },
  };
}
const gray = c => { const v = Math.round(C.lum(c) * 255); return { r: v, g: v, b: v }; };
export const brushTool = makeBrush('brush', 'Brush', 'b', 'brush', false);
export const eraserTool = makeBrush('eraser', 'Eraser', 'e', 'eraser', true);

/* ---------- flood fill ---------- */
export function floodMask(data, w, h, sx, sy, tol, contiguous) {
  const m = new Uint8Array(w * h), i0 = (sy * w + sx) * 4;
  const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
  const match = i => { const k = i * 4; return Math.abs(data[k + 3] - a0) <= tol && (a0 === 0 && data[k + 3] === 0 || (Math.abs(data[k] - r0) <= tol && Math.abs(data[k + 1] - g0) <= tol && Math.abs(data[k + 2] - b0) <= tol)); };
  if (!contiguous) { for (let i = 0; i < w * h; i++) if (match(i)) m[i] = 255; return m; }
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop(), x0 = stack.pop();
    let x = x0; while (x >= 0 && !m[y * w + x] && match(y * w + x)) x--;
    x++;
    let up = false, dn = false;
    while (x < w && !m[y * w + x] && match(y * w + x)) {
      m[y * w + x] = 255;
      if (y > 0) { const ok = !m[(y - 1) * w + x] && match((y - 1) * w + x); if (ok && !up) { stack.push(x, y - 1); up = true; } else if (!ok) up = false; }
      if (y < h - 1) { const ok = !m[(y + 1) * w + x] && match((y + 1) * w + x); if (ok && !dn) { stack.push(x, y + 1); dn = true; } else if (!ok) dn = false; }
      x++;
    }
  }
  return m;
}
export const fillTool = {
  id: 'fill', name: 'Fill', shortcut: 'g', icon: 'fill', cursor: 'crosshair',
  defaults: { source: 'fg', mode: 'normal', opacity: 100, tolerance: 32, aa: true, contiguous: true, all: false },
  options(app) {
    const o = this.opts, set = (k, v) => app.toolOpt(this, k, v);
    return [og(lbl('Source'), select([['fg', 'Foreground'], ['bg', 'Background']], o.source, v => set('source', v))),
      og(lbl('Mode'), modeSelect(o.mode, v => set('mode', v)), lbl('Opacity'), num({ value: o.opacity, min: 1, max: 100, unit: '%', width: 54, onChange: v => set('opacity', v) })),
      og(lbl('Tolerance'), num({ value: o.tolerance, min: 0, max: 255, width: 50, onChange: v => set('tolerance', v) })),
      og(chk('Anti-alias', o.aa, v => set('aa', v)), chk('Contiguous', o.contiguous, v => set('contiguous', v)), chk('All layers', o.all, v => set('all', v)))];
  },
  down(e, app) {
    const t = app.paintTarget(); if (!t) return;
    const d = app.doc, l = t.layer, x = Math.floor(e.x), y = Math.floor(e.y);
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return;
    const o = this.opts, W = d.width, H = d.height;
    // what we look at: the composite, or this layer placed in document space
    let data;
    if (o.all) data = app.view.comp.readComposite(d).data;
    else { const src = t.mask ? l.mask.canvas : l.canvas, sx = t.mask ? l.mask.x : l.x, sy = t.mask ? l.mask.y : l.y, c = canvas(W, H); ctx(c).drawImage(src, sx, sy); data = getData(c).data; }
    const m = floodMask(data, W, H, x, y, o.tolerance, o.contiguous);
    const mc = canvas(W, H), mx = ctx(mc), id = mx.createImageData(W, H);
    for (let i = 0; i < m.length; i++) { id.data[i * 4 + 3] = m[i]; }
    if (o.aa) { // soften the edge by a pixel
      const a = new Uint8ClampedArray(m.length);
      for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) { const i = yy * W + xx; if (m[i]) { a[i] = 255; continue; } let n = 0; if (xx > 0 && m[i - 1]) n++; if (xx < W - 1 && m[i + 1]) n++; if (yy > 0 && m[i - W]) n++; if (yy < H - 1 && m[i + W]) n++; a[i] = n * 48; }
      for (let i = 0; i < m.length; i++) id.data[i * 4 + 3] = a[i];
    }
    mx.putImageData(id, 0, 0);
    const col = o.source === 'bg' ? app.bg : app.fg;
    mx.globalCompositeOperation = 'source-in'; mx.fillStyle = C.hex(t.mask ? gray(col) : col); mx.fillRect(0, 0, W, H);
    if (d.selection.active) { mx.globalCompositeOperation = 'destination-in'; mx.drawImage(d.selection.maskCanvas(), 0, 0); }
    const label = 'Paint Bucket';
    if (t.mask) {
      const rec = d.maskEdit(l, label), mk = l.mask, tc = ctx(mk.canvas);
      tc.globalAlpha = o.opacity / 100; tc.drawImage(mc, -mk.x, -mk.y); tc.globalAlpha = 1;
      mk.rev++; l.touch(); rec.commit({ x: 0, y: 0, w: mk.canvas.width, h: mk.canvas.height }); return;
    }
    const rec = d.pixelEdit(l, label, { x: 0, y: 0, w: W, h: H }), tc = ctx(l.canvas);
    tc.globalAlpha = o.opacity / 100; tc.globalCompositeOperation = l.lock.alpha ? 'source-atop' : paintOp(o.mode);
    tc.drawImage(mc, -l.x, -l.y); tc.globalAlpha = 1; tc.globalCompositeOperation = 'source-over';
    l.touch(); rec.commit({ x: -l.x, y: -l.y, w: W, h: H });
  },
};

/* ---------- gradient tool ---------- */
export function renderGradientCanvas(comp, grad, rect) {
  const g = comp.g, t = g.texture(rect.w, rect.h, 'rgba8');
  const shifted = { ...grad, p0: { x: grad.p0.x - rect.x, y: grad.p0.y - rect.y }, p1: { x: grad.p1.x - rect.x, y: grad.p1.y - rect.y } };
  g.rect(g.program('grad', VS_RECT, FS_GRADIENT), t, { x: 0, y: 0, w: rect.w, h: rect.h }, gradientUniforms(shifted, shifted));
  const id = g.read(t, { x: 0, y: 0, w: rect.w, h: rect.h }); g.free(t);
  const c = canvas(rect.w, rect.h); ctx(c).putImageData(id, 0, 0); return c;
}
export const gradientTool = {
  id: 'gradient', name: 'Gradient', shortcut: 'g', icon: 'gradient', cursor: 'crosshair',
  defaults: { type: 'linear', mode: 'normal', opacity: 100, reverse: false, dither: true, creates: 'pixels', grad: null },
  grad(app) { return this.opts.grad || defaultGradient(app.fg, app.bg); },
  options(app) {
    const o = this.opts, set = (k, v) => app.toolOpt(this, k, v), g = this.grad(app);
    const chip = h('span.gchip', { title: 'Click to edit the gradient', style: { background: gradientCSS(g), backgroundSize: 'auto,8px 8px' } });
    chip.onclick = async () => { const ng = await gradientEditor(app, g); if (ng) { set('grad', ng); app.ui.buildOptions(); } };
    return [og(chip), og(seg(GRAD_TYPES.map((t, i) => [t, ['gLin', 'gRad', 'gAng', 'gRef', 'gDia'][i], t[0].toUpperCase() + t.slice(1)]), o.type, v => set('type', v))),
      og(lbl('Creates'), seg([['pixels', 'Pixels'], ['layer', 'Fill layer']], o.creates, v => set('creates', v))),
      og(lbl('Mode'), modeSelect(o.mode, v => set('mode', v)), lbl('Opacity'), num({ value: o.opacity, min: 1, max: 100, unit: '%', width: 54, onChange: v => set('opacity', v) })),
      og(chk('Reverse', o.reverse, v => set('reverse', v)), chk('Dither', o.dither, v => set('dither', v)))];
  },
  down(e, app) { const p = app.view.snapPt({ x: e.x, y: e.y }); this.d = { p0: p, p1: p }; },
  move(e, app) {
    if (!this.d) return; let p1 = { x: e.x, y: e.y };
    if (e.shift) { const dx = p1.x - this.d.p0.x, dy = p1.y - this.d.p0.y, a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, L = Math.hypot(dx, dy); p1 = { x: this.d.p0.x + Math.cos(a) * L, y: this.d.p0.y + Math.sin(a) * L }; }
    else p1 = app.view.snapPt(p1);
    this.d.p1 = p1; app.view.redraw();
  },
  up(e, app) {
    const s = this.d; this.d = null; app.view.redraw();
    if (!s || dist(s.p0, s.p1) < 2) return;
    const d = app.doc, o = this.opts, grad = { ...cloneGradient(this.grad(app)), type: o.type, reverse: o.reverse, dither: o.dither, p0: s.p0, p1: s.p1 };
    if (o.creates === 'layer') {
      const L = new FillLayer(d.layerName('Gradient Fill'), 'gradient', { gradient: grad });
      L.blend = o.mode in { normal: 1 } ? 'normal' : o.mode; L.opacity = o.opacity / 100;
      if (d.selection.active) L.mask = makeMask(d, L, 'selection');
      d.addLayer(L, { label: 'New Gradient Fill Layer' });
      return;
    }
    const t = app.paintTarget(); if (!t) return;
    const l = t.layer, W = d.width, H = d.height;
    const gc = renderGradientCanvas(app.view.comp, grad, { x: 0, y: 0, w: W, h: H });
    if (d.selection.active) { const x = ctx(gc); x.globalCompositeOperation = 'destination-in'; x.drawImage(d.selection.maskCanvas(), 0, 0); }
    if (t.mask) {
      const rec = d.maskEdit(l, 'Gradient'), m = l.mask, x = ctx(gc), id = x.getImageData(0, 0, W, H);
      for (let i = 0; i < id.data.length; i += 4) { const v = (id.data[i] * 0.2126 + id.data[i + 1] * 0.7152 + id.data[i + 2] * 0.0722); id.data[i] = id.data[i + 1] = id.data[i + 2] = v; }
      x.putImageData(id, 0, 0);
      const mc = ctx(m.canvas); mc.globalAlpha = o.opacity / 100; mc.drawImage(gc, -m.x, -m.y); mc.globalAlpha = 1; m.rev++; l.touch();
      rec.commit({ x: 0, y: 0, w: m.canvas.width, h: m.canvas.height }); return;
    }
    const rec = d.pixelEdit(l, 'Gradient', { x: 0, y: 0, w: W, h: H }), tc = ctx(l.canvas);
    tc.globalAlpha = o.opacity / 100; tc.globalCompositeOperation = l.lock.alpha ? 'source-atop' : paintOp(o.mode);
    tc.drawImage(gc, -l.x, -l.y); tc.globalAlpha = 1; tc.globalCompositeOperation = 'source-over';
    l.touch(); rec.commit({ x: -l.x, y: -l.y, w: W, h: H });
  },
  overlay(c, view) {
    const s = this.d; if (!s) return;
    const a = view.toScreen(s.p0.x, s.p0.y), b = view.toScreen(s.p1.x, s.p1.y);
    c.save(); c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.6)'; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    c.lineWidth = 1; c.strokeStyle = '#fff'; c.stroke();
    for (const p of [a, b]) { c.fillStyle = '#fff'; c.beginPath(); c.arc(p.x, p.y, 4, 0, 7); c.fill(); c.strokeStyle = '#000'; c.stroke(); }
    c.restore();
  },
  key(e, app) { if (e.key === 'Escape' && this.d) { this.d = null; app.view.redraw(); return true; } return false; },
};
import { h } from '../util.js';
export { icon, btn };
