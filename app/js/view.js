// The canvas view: zoom/pan, drawing the composite (GPU), the overlay (2D:
// guides, marching ants, tool handles), rulers, guide dragging, snapping.
// Draws only when something changed: idle CPU is zero.

import { Compositor } from './compositor.js';
import { VS_VIEW, FS_VIEW } from './gl.js';
import { $, R, clamp, fromPx, round, C } from './util.js';
import { rasterizeText } from './text.js';

const ZOOMS = [0.01, 0.02, 0.03, 0.05, 0.0667, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32];

export class View {
  constructor(app) {
    this.app = app;
    this.el = $('#viewport');
    this.glc = $('#glc'); this.ovc = $('#ovc');
    this.rulerT = $('#rulerT'); this.rulerL = $('#rulerL');
    this.comp = new Compositor(this.glc);
    this.viewProg = this.comp.g.program('view', VS_VIEW, FS_VIEW);
    this.dirtyRect = null; this.needComp = false; this.needDraw = false; this.queued = false;
    this.cursor = null; this.antsPhase = 0;
    this.w = 1; this.h = 1; this.dpr = 1;
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.resize();
    setInterval(() => { const d = this.doc; if (d && d.selection.active && document.hasFocus()) { this.antsPhase = (this.antsPhase + 1) % 8; this.redraw(); } }, 110);
    this.bindRulers();
  }
  get doc() { return this.app.doc; }

  resize() {
    const r = this.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height); this.dpr = dpr;
    for (const c of [this.glc, this.ovc]) { c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr); c.style.width = this.w + 'px'; c.style.height = this.h + 'px'; }
    for (const c of [this.rulerT, this.rulerL]) { const b = c.getBoundingClientRect(); c.width = Math.max(1, Math.round(b.width * dpr)); c.height = Math.max(1, Math.round(b.height * dpr)); }
    if (this.doc && !this.doc.view) this.fit();
    this.redraw();
  }

  /* ---------- zoom / pan (per document) ---------- */
  get z() { return this.doc && this.doc.view ? this.doc.view.zoom : 1; }
  fit(fill = false) {
    const d = this.doc; if (!d) return;
    const pad = 40, zx = (this.w - pad * 2) / d.width, zy = (this.h - pad * 2) / d.height;
    const z = fill ? Math.max(zx, zy) : Math.min(zx, zy, d.view ? Infinity : Infinity);
    this.setView(z, (this.w - d.width * z) / 2, (this.h - d.height * z) / 2);
  }
  actual() { const d = this.doc; if (!d) return; this.zoomAt(1, this.w / 2, this.h / 2); }
  setView(zoom, panX, panY) {
    const d = this.doc; if (!d) return;
    zoom = clamp(zoom, 0.01, 32);
    d.view = { zoom, panX, panY };
    this.redraw(); this.app.emit('zoom');
  }
  zoomAt(z, sx, sy) {
    const v = this.doc.view, p = this.toDoc(sx, sy);
    z = clamp(z, 0.01, 32);
    this.setView(z, sx - p.x * z, sy - p.y * z);
  }
  zoomStep(dir, sx = this.w / 2, sy = this.h / 2) {
    const z = this.z;
    const next = dir > 0 ? ZOOMS.find(v => v > z * 1.001) || 32 : [...ZOOMS].reverse().find(v => v < z / 1.001) || 0.01;
    this.zoomAt(next, sx, sy);
  }
  pan(dx, dy) { const v = this.doc.view; this.setView(v.zoom, v.panX + dx, v.panY + dy); }
  toDoc(sx, sy) { const v = this.doc.view; return { x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom }; }
  toScreen(x, y) { const v = this.doc.view; return { x: x * v.zoom + v.panX, y: y * v.zoom + v.panY }; }
  /** event -> viewport CSS px */
  local(e) { const r = this.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  /* ---------- invalidation ---------- */
  invalidate(rect) {
    if (!this.doc) return;
    this.needComp = true;
    if (!rect || this.dirtyRect === 'all') this.dirtyRect = 'all';
    else this.dirtyRect = this.dirtyRect ? R.union(this.dirtyRect, rect) : { ...rect };
    this.schedule();
  }
  redraw() { this.needDraw = true; this.schedule(); }
  schedule() { if (this.queued) return; this.queued = true; requestAnimationFrame(() => { this.queued = false; this.frame(); }); }

  /** make sure text rasters exist before compositing */
  prepare(doc) {
    doc.walk(l => { if (l.type === 'text' && !l.raster) rasterizeText(l, doc); });
  }
  frame() {
    const d = this.doc, gl = this.comp.gl;
    if (!d) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.glc.width, this.glc.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); this.drawOverlay(); this.drawRulers(); return; }
    if (!d.view) this.fit();
    const t0 = performance.now();
    if (this.needComp || this.compDoc !== d) {
      this.prepare(d);
      const rect = this.compDoc !== d || this.dirtyRect === 'all' ? null : this.dirtyRect;
      if (this.compDoc !== d) { this.comp.dispose(); this.compDoc = d; }
      try { this.comp.render(d, rect); } catch (err) { console.error(err); }
      this.needComp = false; this.dirtyRect = null;
    }
    this.drawGL();
    this.drawOverlay();
    this.drawRulers();
    this.lastFrameMs = performance.now() - t0;
  }
  drawGL() {
    const d = this.doc, g = this.comp.g, gl = g.gl, z = this.z, res = this.comp.result;
    if (!res) return;
    if (z < 1 && !res.mip) { g.filter(res, 'mip'); gl.bindTexture(gl.TEXTURE_2D, res.t); gl.generateMipmap(gl.TEXTURE_2D); res.mip = true; }
    else if (z >= 1) g.filter(res, z >= 2 ? 'nearest' : 'linear');
    else g.filter(res, 'mip');
    g.target(null); gl.viewport(0, 0, this.glc.width, this.glc.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const v = d.view, dpr = this.dpr;
    const cs = getComputedStyle(document.documentElement);
    const ck1 = hexToVec(cs.getPropertyValue('--ck1').trim() || '#ffffff'), ck2 = hexToVec(cs.getPropertyValue('--ck2').trim() || '#cccccc');
    const p = this.viewProg;
    gl.useProgram(p.p); gl.bindVertexArray(g.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(p.u.uRect, Math.round(v.panX * dpr), Math.round(v.panY * dpr), d.width * z * dpr, d.height * z * dpr);
    gl.uniform2f(p.u.uScreen, this.glc.width, this.glc.height);
    gl.uniform1f(p.u.uChecker, 8 * dpr); gl.uniform3f(p.u.uCk1, ...ck1); gl.uniform3f(p.u.uCk2, ...ck2);
    gl.uniform1i(p.u.uNearest, z >= 2 ? 1 : 0); gl.uniform2f(p.u.uDocSize, d.width, d.height); gl.uniform1f(p.u.uZoom, z);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, res.t); gl.uniform1i(p.u.uSrc, 0);
    // the shader samples v (0 = top of doc); our textures already have row 0 = top, so no flip
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /* ---------- overlay ---------- */
  drawOverlay() {
    const c = this.ovc.getContext('2d'), dpr = this.dpr, d = this.doc;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.ovc.width, this.ovc.height);
    if (!d) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = d.view, z = v.zoom;
    // document edge
    c.strokeStyle = 'rgba(255,255,255,.08)'; c.lineWidth = 1;
    c.strokeRect(Math.round(v.panX) - 0.5, Math.round(v.panY) - 0.5, Math.round(d.width * z) + 1, Math.round(d.height * z) + 1);
    // pixel grid when zoomed far in
    if (z >= 8 && this.app.prefs.pixelGrid !== false) this.pixelGrid(c);
    if (this.app.prefs.grid) this.grid(c);
    const tool = this.app.tool;
    if (tool && tool.underlay) tool.underlay(c, this);
    // selection
    if (d.selection.active && !(tool && tool.hideAnts)) this.ants(c);
    // guides
    if (this.app.prefs.guides !== false) {
      c.lineWidth = 1;
      const col = getComputedStyle(document.documentElement).getPropertyValue('--guide').trim() || '#5bc8e8';
      c.strokeStyle = col;
      for (const g of d.guides) {
        c.beginPath();
        if (g.axis === 'v') { const x = Math.round(g.pos * z + v.panX) + 0.5; c.moveTo(x, 0); c.lineTo(x, this.h); }
        else { const y = Math.round(g.pos * z + v.panY) + 0.5; c.moveTo(0, y); c.lineTo(this.w, y); }
        c.stroke();
      }
    }
    if (tool && tool.overlay) tool.overlay(c, this);
  }
  pixelGrid(c) {
    const d = this.doc, v = d.view, z = v.zoom;
    const x0 = Math.max(0, Math.floor(-v.panX / z)), x1 = Math.min(d.width, Math.ceil((this.w - v.panX) / z));
    const y0 = Math.max(0, Math.floor(-v.panY / z)), y1 = Math.min(d.height, Math.ceil((this.h - v.panY) / z));
    c.strokeStyle = 'rgba(128,128,128,.25)'; c.lineWidth = 1; c.beginPath();
    for (let x = x0; x <= x1; x++) { const sx = Math.round(x * z + v.panX) + 0.5; c.moveTo(sx, Math.max(0, v.panY)); c.lineTo(sx, Math.min(this.h, v.panY + d.height * z)); }
    for (let y = y0; y <= y1; y++) { const sy = Math.round(y * z + v.panY) + 0.5; c.moveTo(Math.max(0, v.panX), sy); c.lineTo(Math.min(this.w, v.panX + d.width * z), sy); }
    c.stroke();
  }
  grid(c) {
    const d = this.doc, v = d.view, z = v.zoom, step = this.app.prefs.gridSize || Math.round(d.width / 12) || 50;
    if (step * z < 6) return;
    c.strokeStyle = 'rgba(160,160,160,.28)'; c.lineWidth = 1; c.beginPath();
    for (let x = 0; x <= d.width; x += step) { const sx = Math.round(x * z + v.panX) + 0.5; c.moveTo(sx, v.panY); c.lineTo(sx, v.panY + d.height * z); }
    for (let y = 0; y <= d.height; y += step) { const sy = Math.round(y * z + v.panY) + 0.5; c.moveTo(v.panX, sy); c.lineTo(v.panX + d.width * z, sy); }
    c.stroke();
  }
  ants(c) {
    const e = this.doc.selection.edges(); if (!e || !e.length) return;
    const v = this.doc.view, z = v.zoom;
    c.save(); c.lineWidth = 1;
    const path = new Path2D();
    for (let i = 0; i < e.length; i += 4) {
      path.moveTo(Math.round(e[i] * z + v.panX) + 0.5, Math.round(e[i + 1] * z + v.panY) + 0.5);
      path.lineTo(Math.round(e[i + 2] * z + v.panX) + 0.5, Math.round(e[i + 3] * z + v.panY) + 0.5);
    }
    c.strokeStyle = '#fff'; c.setLineDash([]); c.stroke(path);
    c.strokeStyle = '#000'; c.setLineDash([4, 4]); c.lineDashOffset = -this.antsPhase; c.stroke(path);
    c.restore();
  }

  /* ---------- rulers ---------- */
  drawRulers() {
    if (this.app.prefs.rulers === false) return;
    const d = this.doc;
    for (const [cv, horiz] of [[this.rulerT, true], [this.rulerL, false]]) {
      const c = cv.getContext('2d'), dpr = this.dpr, b = { w: cv.width / dpr, h: cv.height / dpr };
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cs = getComputedStyle(document.documentElement), V = k => cs.getPropertyValue(k).trim();
      c.fillStyle = V('--panel'); c.fillRect(0, 0, b.w, b.h);
      if (!d || !d.view) continue;
      const v = d.view, z = v.zoom, unit = this.app.prefs.units || 'px';
      const off = horiz ? v.panX : v.panY, len = horiz ? b.w : b.h;
      // step in doc px so labelled ticks land ~80 screen px apart, on nice unit values
      const uPerPx = fromPx(1, unit, d.ppi, d.width);
      const target = 80 / z * uPerPx;   // units per label
      const mag = Math.pow(10, Math.floor(Math.log10(target)));
      const nice = [1, 2, 5, 10].map(k => k * mag).find(k => k >= target) || 10 * mag;
      const labelPx = nice / uPerPx, minor = labelPx / 10;
      c.strokeStyle = V('--dim'); c.fillStyle = V('--muted'); c.font = '9px -apple-system, Inter, sans-serif'; c.lineWidth = 1;
      const start = Math.floor(-off / z / labelPx) * labelPx;
      c.beginPath();
      for (let dd = start; dd * z + off < len; dd += minor) {
        const s = Math.round(dd * z + off) + 0.5; if (s < 0) continue;
        const k = Math.round((dd - start) / minor) % 10, t = k === 0 ? 20 : k === 5 ? 8 : 4;
        if (horiz) { c.moveTo(s, 20); c.lineTo(s, 20 - t); } else { c.moveTo(20, s); c.lineTo(20 - t, s); }
        if (k === 0) {
          const label = String(round(dd * uPerPx, 2));
          if (horiz) c.fillText(label, s + 3, 9); else { c.save(); c.translate(9, s + 3); c.rotate(-Math.PI / 2); c.textAlign = 'right'; c.fillText(label, 0, 0); c.restore(); }
        }
      }
      c.stroke();
      if (this.cursor) {
        c.strokeStyle = V('--accent'); const s = Math.round((horiz ? this.cursor.x : this.cursor.y) * z + off) + 0.5;
        c.beginPath(); if (horiz) { c.moveTo(s, 0); c.lineTo(s, 20); } else { c.moveTo(0, s); c.lineTo(20, s); } c.stroke();
      }
    }
  }
  setCursor(p) { this.cursor = p; this.drawRulersSoon(); }
  drawRulersSoon() { if (this._rq) return; this._rq = true; requestAnimationFrame(() => { this._rq = false; this.drawRulers(); }); }

  /* ---------- guides ---------- */
  bindRulers() {
    const start = (axis, e) => {
      const d = this.doc; if (!d || d.guidesLocked) return;
      e.preventDefault();
      const g = { axis, pos: 0 }; d.guides.push(g);
      this.dragGuide(g, e, true);
    };
    this.rulerT.addEventListener('pointerdown', e => start('h', e));
    this.rulerL.addEventListener('pointerdown', e => start('v', e));
  }
  guideAt(sx, sy) {
    const d = this.doc; if (!d || d.guidesLocked || this.app.prefs.guides === false) return null;
    const v = d.view;
    for (const g of d.guides) {
      const s = g.axis === 'v' ? g.pos * v.zoom + v.panX : g.pos * v.zoom + v.panY;
      if (Math.abs((g.axis === 'v' ? sx : sy) - s) <= 3) return g;
    }
    return null;
  }
  /** drag a guide with the pointer; dropping it outside the canvas area deletes it */
  dragGuide(g, e, isNew) {
    const d = this.doc, old = g.pos, el = this.el;
    const move = ev => {
      const p = this.local(ev), dp = this.toDoc(p.x, p.y);
      let v = Math.round(g.axis === 'h' ? dp.y : dp.x);
      if (!ev.shiftKey) v = this.snap1(v, g.axis, g);
      g.pos = v; this.redraw();
      this.app.ui.tip(`${g.axis === 'h' ? 'Y' : 'X'}: ${this.app.fmtLen(v)}`, ev.clientX + 14, ev.clientY + 14);
    };
    const up = ev => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      this.app.ui.tip(null);
      const r = el.getBoundingClientRect(), outside = ev.clientX < r.left || ev.clientY < r.top || ev.clientX > r.right || ev.clientY > r.bottom;
      const i = d.guides.indexOf(g);
      if (outside) {
        d.guides.splice(i, 1);
        if (!isNew) d.history.push({ label: 'Delete Guide', undo: () => { d.guides.splice(i, 0, g); g.pos = old; d.changed('guides'); }, redo: () => { d.guides.splice(d.guides.indexOf(g), 1); d.changed('guides'); } });
      } else {
        const nv = g.pos;
        if (isNew) d.history.push({ label: 'New Guide', undo: () => { d.guides.splice(d.guides.indexOf(g), 1); d.changed('guides'); }, redo: () => { d.guides.push(g); g.pos = nv; d.changed('guides'); } });
        else if (nv !== old) d.history.push({ label: 'Move Guide', undo: () => { g.pos = old; d.changed('guides'); }, redo: () => { g.pos = nv; d.changed('guides'); } });
      }
      d.changed('guides'); this.redraw();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    move(e);
  }

  /* ---------- snapping ---------- */
  /** candidates along an axis ('v' = x positions, 'h' = y positions) */
  snapTargets(axis, exclude) {
    const d = this.doc, t = [], P = this.app.prefs.snapTo || {};
    if (P.guides !== false && this.app.prefs.guides !== false) for (const g of d.guides) if (g !== exclude && g.axis === axis) t.push(g.pos);
    if (P.canvas !== false) { const L = axis === 'v' ? d.width : d.height; t.push(0, L / 2, L); }
    if (P.layers) for (const l of d.all()) if (l.type === 'pixel' && l.visible && l !== this.snapIgnore) { const b = l.bounds(); if (axis === 'v') t.push(b.x, b.x + b.w); else t.push(b.y, b.y + b.h); }
    return t;
  }
  snap1(v, axis, exclude) {
    if (this.app.prefs.snap === false) return v;
    const tol = 6 / this.z; let best = v, bd = tol;
    for (const s of this.snapTargets(axis === 'h' ? 'h' : 'v', exclude)) { const dd = Math.abs(s - v); if (dd < bd) { bd = dd; best = s; } }
    return best;
  }
  snapPt(p) { return { x: this.snap1(p.x, 'v'), y: this.snap1(p.y, 'h') }; }
  /** snap a moving rect: returns {dx, dy} correction */
  snapRect(r) {
    if (this.app.prefs.snap === false) return { dx: 0, dy: 0 };
    const tol = 6 / this.z, fx = [r.x, r.x + r.w / 2, r.x + r.w], fy = [r.y, r.y + r.h / 2, r.y + r.h];
    let dx = 0, dy = 0, bx = tol, by = tol;
    for (const s of this.snapTargets('v')) for (const f of fx) { const dd = s - f; if (Math.abs(dd) < bx) { bx = Math.abs(dd); dx = dd; } }
    for (const s of this.snapTargets('h')) for (const f of fy) { const dd = s - f; if (Math.abs(dd) < by) { by = Math.abs(dd); dy = dd; } }
    return { dx, dy };
  }
}
function hexToVec(s) { const c = C.parse(s) || { r: 255, g: 255, b: 255 }; return [c.r / 255, c.g / 255, c.b / 255]; }
