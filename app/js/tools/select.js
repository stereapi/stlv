// Selection tools: rectangle + ellipse marquee, lasso (freehand / polygonal),
// selection brush. Modes: new, add (⇧), subtract (⌥), intersect (⇧⌥).

import { R, h, canvas, ctx, clamp, dist } from '../util.js';
import { og, lbl, chk, seg, select, num } from '../ui/widgets.js';
import { featherCanvas } from '../selection.js';

export function modeSeg(app, tool) {
  return seg([['new', 'modeNew', 'New selection'], ['add', 'modeAdd', 'Add to selection (⇧)'], ['sub', 'modeSub', 'Subtract from selection (⌥)'], ['int', 'modeInt', 'Intersect with selection (⇧⌥)']], tool.opts.mode, v => app.toolOpt(tool, 'mode', v));
}
export function pickMode(e, tool) {
  if (e.shift && e.alt) return 'int';
  if (e.shift) return 'add';
  if (e.alt) return 'sub';
  return tool.opts.mode || 'new';
}
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
function dashed(c, draw) {
  c.save(); c.lineWidth = 1; c.strokeStyle = '#fff'; draw(); c.stroke(); c.setLineDash([4, 4]); c.strokeStyle = '#000'; draw(); c.stroke(); c.restore();
}

/* ---------- marquee ---------- */
function marquee(id, name, key, icon, shape) {
  return {
    id, name, shortcut: key, icon, cursor: 'crosshair', hideAnts: false,
    defaults: { mode: 'new', feather: 0, aa: true, style: 'normal', fw: 1, fh: 1 },
    options(app) {
      const o = this.opts;
      return [og(modeSeg(app, this)), og(lbl('Feather'), num({ value: o.feather, min: 0, max: 1000, unit: ' px', width: 64, onChange: (v, f) => f && app.toolOpt(this, 'feather', v) })),
        shape === 'ellipse' ? og(chk('Anti-alias', o.aa, v => app.toolOpt(this, 'aa', v))) : null,
        og(lbl('Style'), select([['normal', 'Normal'], ['ratio', 'Fixed ratio'], ['size', 'Fixed size']], o.style, v => app.toolOpt(this, 'style', v)),
          lbl('W'), num({ value: o.fw, min: 0.001, max: 12000, digits: 3, width: 56, onChange: (v, f) => f && app.toolOpt(this, 'fw', v) }),
          lbl('H'), num({ value: o.fh, min: 0.001, max: 12000, digits: 3, width: 56, onChange: (v, f) => f && app.toolOpt(this, 'fh', v) }))].filter(Boolean);
    },
    down(e, app) {
      const d = app.doc, mode = pickMode(e, this);
      // drag inside the selection in New mode moves the outline
      if (mode === 'new' && d.selection.active && d.selection.at(e.x, e.y) > 0.5 && !e.shift && !e.alt) { this.moveSel = { x0: e.x, y0: e.y, dx: 0, dy: 0, before: d.selection.snapshot() }; return; }
      const p = app.view.snapPt({ x: e.x, y: e.y });
      this.d = { p0: p, p1: p, mode };
      if (this.opts.style === 'size') { this.d.p1 = { x: p.x + this.opts.fw, y: p.y + this.opts.fh }; }
    },
    rect(e, app) {
      const s = this.d; let p0 = s.p0, p1 = app.view.snapPt({ x: e.x, y: e.y });
      if (this.opts.style === 'size') { const w = this.opts.fw, hh = this.opts.fh; return e.alt ? { x: p1.x - w / 2, y: p1.y - hh / 2, w, h: hh } : { x: p1.x, y: p1.y, w, h: hh }; }
      let w = p1.x - p0.x, hh = p1.y - p0.y;
      if (this.opts.style === 'ratio') { const k = this.opts.fh / this.opts.fw; hh = Math.sign(hh || 1) * Math.abs(w) * k; }
      else if (e.shift) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
      let r = e.alt && s.mode !== 'sub' && s.mode !== 'int' ? { x: p0.x - w, y: p0.y - hh, w: 2 * w, h: 2 * hh } : { x: p0.x, y: p0.y, w, h: hh };
      if (r.w < 0) { r.x += r.w; r.w = -r.w; } if (r.h < 0) { r.y += r.h; r.h = -r.h; }
      return r;
    },
    move(e, app) {
      if (this.moveSel) { const m = this.moveSel, dx = Math.round(e.x - m.x0), dy = Math.round(e.y - m.y0); app.doc.selection.shift(dx - m.dx, dy - m.dy); m.dx = dx; m.dy = dy; return; }
      if (!this.d) return; this.d.r = this.rect(e, app); this.d.moved = true; app.view.redraw();
      app.ui.info(`${Math.round(this.d.r.w)} × ${Math.round(this.d.r.h)} px`);
    },
    up(e, app) {
      const d = app.doc; app.ui.info('');
      if (this.moveSel) { const m = this.moveSel; this.moveSel = null; if (m.dx || m.dy) { const after = d.selection.snapshot(); d.history.push({ label: 'Move Selection', undo: () => d.selection.restore(m.before), redo: () => d.selection.restore(after) }); } return; }
      const s = this.d; if (!s) return;
      const r = s.moved || this.opts.style === 'size' ? this.rect(e, app) : null;
      this.d = null;
      if (!r || r.w < 1 || r.h < 1) { if (s.mode === 'new' && d.selection.active) app.run('select.none'); app.view.redraw(); return; }
      d.selection.edit(shape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee', () => shape === 'ellipse' ? d.selection.ellipse(r, s.mode, this.opts.feather, this.opts.aa) : d.selection.rect(r, s.mode, this.opts.feather));
    },
    overlay(c, view) {
      const s = this.d; if (!s || !s.r) return;
      const a = view.toScreen(s.r.x, s.r.y), z = view.z;
      dashed(c, () => { c.beginPath(); if (shape === 'ellipse') c.ellipse(a.x + s.r.w * z / 2, a.y + s.r.h * z / 2, s.r.w * z / 2, s.r.h * z / 2, 0, 0, 7); else c.rect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(s.r.w * z), Math.round(s.r.h * z)); });
    },
    key(e, app) { if (e.key === 'Escape' && this.d) { this.d = null; app.view.redraw(); return true; } return false; },
  };
}
export const marqueeTool = marquee('marquee', 'Rectangular Marquee', 'm', 'rect', 'rect');
export const ellipseTool = marquee('ellipse', 'Elliptical Marquee', 'm', 'ellipse', 'ellipse');

/* ---------- lasso ---------- */
export const lassoTool = {
  id: 'lasso', name: 'Lasso', shortcut: 'l', icon: 'lasso', cursor: 'crosshair',
  defaults: { mode: 'new', feather: 0, aa: true, kind: 'free' },
  options(app) {
    const o = this.opts;
    return [og(modeSeg(app, this)), og(lbl('Type'), seg([['free', 'Freehand'], ['poly', 'Polygonal']], o.kind, v => { this.pts = null; app.toolOpt(this, 'kind', v); app.ui.buildOptions(); })),
      og(lbl('Feather'), num({ value: o.feather, min: 0, max: 1000, unit: ' px', width: 64, onChange: (v, f) => f && app.toolOpt(this, 'feather', v) })), og(chk('Anti-alias', o.aa, v => app.toolOpt(this, 'aa', v))),
      og(lbl(o.kind === 'poly' ? 'Click to add points · double-click or ↩ to close · ⌫ removes the last point' : 'Drag around an area · ⌥ while dragging: straight segments'))];
  },
  down(e, app) {
    const p = { x: e.x, y: e.y };
    if (this.opts.kind === 'poly') {
      if (!this.pts) { this.pts = [p]; this.mode = pickMode(e, this); this.hoverPt = p; }
      else {
        const s = app.view.toScreen(this.pts[0].x, this.pts[0].y);
        if (this.pts.length > 2 && Math.hypot(s.x - e.sx, s.y - e.sy) < 8) return this.close(app);
        this.pts.push(e.shift ? constrain45(this.pts[this.pts.length - 1], p) : p);
      }
      app.view.redraw(); return;
    }
    this.pts = [p]; this.mode = pickMode(e, this); this.drawing = true;
  },
  move(e, app) {
    if (!this.drawing) return;
    const p = { x: e.x, y: e.y }, last = this.pts[this.pts.length - 1];
    if (dist(p, last) * app.view.z >= 1.5) { this.pts.push(p); app.view.redraw(); }
  },
  hover(e, app) { if (this.opts.kind === 'poly' && this.pts) { this.hoverPt = e.shift ? constrain45(this.pts[this.pts.length - 1], { x: e.x, y: e.y }) : { x: e.x, y: e.y }; app.view.redraw(); } },
  up(e, app) { if (this.drawing) { this.drawing = false; this.close(app); } },
  dblclick(e, app) { if (this.opts.kind === 'poly' && this.pts) this.close(app); },
  close(app) {
    const pts = this.pts, d = app.doc; this.pts = null;
    if (!pts || pts.length < 3) { if (this.mode === 'new' && d.selection.active) app.run('select.none'); app.view.redraw(); return; }
    d.selection.edit(this.opts.kind === 'poly' ? 'Polygonal Lasso' : 'Lasso', () => d.selection.polygon(pts, this.mode, this.opts.feather, this.opts.aa));
  },
  key(e, app) {
    if (!this.pts) return false;
    if (e.key === 'Enter') { this.close(app); return true; }
    if (e.key === 'Escape') { this.pts = null; app.view.redraw(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { this.pts.pop(); if (!this.pts.length) this.pts = null; app.view.redraw(); return true; }
    return false;
  },
  deactivate(app) { this.pts = null; },
  overlay(c, view) {
    if (!this.pts) return;
    const pts = this.opts.kind === 'poly' && this.hoverPt ? [...this.pts, this.hoverPt] : this.pts;
    dashed(c, () => { c.beginPath(); pts.forEach((p, i) => { const s = view.toScreen(p.x, p.y); i ? c.lineTo(s.x, s.y) : c.moveTo(s.x, s.y); }); });
    if (this.opts.kind === 'poly') { const s = view.toScreen(this.pts[0].x, this.pts[0].y); c.strokeStyle = accent(); c.strokeRect(s.x - 4, s.y - 4, 8, 8); }
  },
};
function constrain45(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * l, y: a.y + Math.sin(ang) * l };
}

/* ---------- selection brush ---------- */
export const selBrushTool = {
  id: 'selbrush', name: 'Selection Brush', shortcut: 'w', icon: 'selbrush', cursor: 'none', coalesce: true,
  defaults: { size: 80, hardness: 60, sub: false },
  options(app) {
    const o = this.opts;
    return [og(seg([['add', 'Add'], ['sub', 'Subtract']], o.sub ? 'sub' : 'add', v => app.toolOpt(this, 'sub', v === 'sub'))),
      og(lbl('Size'), num({ value: o.size, min: 1, max: 2000, unit: ' px', width: 66, onChange: (v, f) => app.toolOpt(this, 'size', v) }), lbl('Hardness'), num({ value: o.hardness, min: 0, max: 100, unit: '%', width: 54, onChange: (v, f) => app.toolOpt(this, 'hardness', v) })),
      og(lbl('⌥ subtracts · [ ] size · shown in red while painting'))];
  },
  down(e, app) {
    const d = app.doc;
    this.s = { sub: this.opts.sub !== e.alt, last: { x: e.x, y: e.y }, canvas: canvas(d.width, d.height), before: d.selection.snapshot() };
    this.dab(e, app);
  },
  dab(e, app) {
    const s = this.s, x = ctx(s.canvas), r = this.opts.size / 2, hard = this.opts.hardness / 100;
    const step = Math.max(1, r * 0.15), from = s.last, to = { x: e.x, y: e.y }, n = Math.max(1, Math.ceil(dist(from, to) / step));
    for (let i = 1; i <= n || i === 1; i++) {
      const t = n ? i / n : 1, px = from.x + (to.x - from.x) * t, py = from.y + (to.y - from.y) * t;
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(Math.min(0.999, hard), 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill();
      if (i >= n) break;
    }
    s.last = to; app.view.redraw();
  },
  move(e, app) { this.cur = { x: e.x, y: e.y }; if (this.s) this.dab(e, app); else app.view.redraw(); },
  hover(e, app) { this.cur = { x: e.x, y: e.y }; app.view.redraw(); },
  leave(app) { this.cur = null; app.view.redraw(); },
  up(e, app) {
    const s = this.s; this.s = null; if (!s) return;
    const d = app.doc, sel = d.selection;
    const m = sel.maskCanvas(), mx = ctx(m);
    if (!sel.active) mx.clearRect(0, 0, m.width, m.height);
    mx.globalCompositeOperation = s.sub ? 'destination-out' : 'source-over'; mx.drawImage(s.canvas, 0, 0); mx.globalCompositeOperation = 'source-over';
    sel.active = true;
    if (!sel.bounds()) sel.active = false;
    sel.changed();
    const after = sel.snapshot();
    d.history.push({ label: 'Selection Brush', undo: () => sel.restore(s.before), redo: () => sel.restore(after) });
  },
  key(e, app) { return brushSizeKeys(e, app, this); },
  underlay(c, view) {
    // quick-mask style: the stroke in red while painting
    if (!this.s) return;
    const v = view.doc.view;
    c.save(); c.globalAlpha = 0.45; c.imageSmoothingEnabled = view.z < 1;
    const tint = this._tint || (this._tint = canvas(1, 1));
    if (tint.width !== this.s.canvas.width || tint.height !== this.s.canvas.height) { tint.width = this.s.canvas.width; tint.height = this.s.canvas.height; }
    const tc = ctx(tint); tc.clearRect(0, 0, tint.width, tint.height); tc.drawImage(this.s.canvas, 0, 0); tc.globalCompositeOperation = 'source-in'; tc.fillStyle = this.s.sub ? '#3b82f6' : '#ff2a4d'; tc.fillRect(0, 0, tint.width, tint.height); tc.globalCompositeOperation = 'source-over';
    c.drawImage(tint, v.panX, v.panY, view.doc.width * v.zoom, view.doc.height * v.zoom);
    c.restore();
  },
  overlay(c, view) { if (this.cur) brushCursor(c, view, this.cur, this.opts.size); },
};

export function brushCursor(c, view, p, size) {
  const s = view.toScreen(p.x, p.y), r = size / 2 * view.z;
  c.save(); c.lineWidth = 1;
  if (r > 3) { c.strokeStyle = 'rgba(0,0,0,.7)'; c.beginPath(); c.arc(s.x, s.y, r + 0.5, 0, 7); c.stroke(); c.strokeStyle = 'rgba(255,255,255,.9)'; c.beginPath(); c.arc(s.x, s.y, r - 0.5, 0, 7); c.stroke(); }
  c.strokeStyle = 'rgba(255,255,255,.9)'; c.beginPath(); c.moveTo(s.x - 4, s.y); c.lineTo(s.x + 4, s.y); c.moveTo(s.x, s.y - 4); c.lineTo(s.x, s.y + 4); c.stroke();
  c.restore();
}
export function brushSizeKeys(e, app, tool) {
  if (e.key === '[' || e.key === ']') {
    const o = tool.opts;
    if (e.shiftKey && 'hardness' in o) app.toolOpt(tool, 'hardness', clamp(o.hardness + (e.key === ']' ? 25 : -25), 0, 100));
    else { const s = o.size, k = s < 10 ? 1 : s < 50 ? 5 : s < 100 ? 10 : s < 300 ? 25 : 50; app.toolOpt(tool, 'size', clamp(s + (e.key === ']' ? k : -k), 1, 5000)); }
    app.ui.buildOptions();
    return true;
  }
  return false;
}
export { featherCanvas, h, R };
