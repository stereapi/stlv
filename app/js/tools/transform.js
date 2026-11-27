// Free transform session: scale / rotate / skew (affine), distort,
// perspective, warp (Bézier grid or preset). Previews live through the
// compositor's mesh hook; commit resamples once at the chosen quality.
// Text layers stay editable for affine transforms and warp presets.

import { M3, R, canvas, ctx, cloneCanvas, clamp, dist, h, C } from '../util.js';
import { og, lbl, seg, select, num, btn, chk } from '../ui/widgets.js';
import { mapperFor, buildMesh, gridFromQuad, gridFromPreset, renderMapped, bezierPatch, WARP_STYLES } from '../transform.js';
import { PixelLayer } from '../doc.js';
import { textQuad } from '../text.js';
import { contentBox } from './basic.js';

const quadOf = r => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
const apply = (A, p) => M3.apply(A, p.x, p.y);
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

export const transformTool = {
  id: 'transform', name: 'Free Transform', shortcut: null, icon: 'warp', cursor: 'default', hidden: true,
  get title() { const s = this.s; return s ? ({ free: 'Free Transform', distort: 'Distort', perspective: 'Perspective', warp: 'Warp' })[s.mode] : 'Free Transform'; },

  /** begin on the active layer. mode: free | distort | perspective | warp */
  start(app, mode = 'free', opts = {}) {
    const d = app.doc, l = d.active;
    if (this.s) { this.s.mode = mode; this.setMode(app, mode); return; }
    if (!l) return app.ui.toast('Select a layer first');
    if (l.lock.all || l.lock.pos) return app.ui.toast('The layer is locked');
    if (l.isGroup || l.type === 'adjust' || l.type === 'fill') return app.ui.toast('Transform works on pixel and text layers');
    const s = { layer: l, mode, interp: 2, warp: { style: 'custom', bend: 0.5, hd: 0, vd: 0 }, prevTool: app.tool && app.tool.id !== 'transform' ? app.tool.id : 'move' };
    if (l.maskEdit && l.mask) {
      s.kind = 'mask'; s.src = l.mask.canvas; s.S = { x: l.mask.x, y: l.mask.y, w: s.src.width, h: s.src.height };
    } else if (l.type === 'text') {
      if (!l.raster) return;
      s.kind = 'text'; const r = l.raster; s.src = r.canvas; s.S = { x: r.x, y: r.y, w: r.canvas.width, h: r.canvas.height };
      s.text = { xform: l.xform ? [...l.xform] : null, warp: l.warp ? { ...l.warp } : null };
      if (l.warp && l.warp.style !== 'none') s.warp = { ...l.warp };
      s.handleQuad = textQuad(l, d);
    } else {
      if (l.lock.px) return app.ui.toast('The layer’s pixels are locked');
      if (d.selection.active) {
        // lift the selected pixels onto a temporary layer
        s.before = cloneCanvas(l.canvas); s.bx = l.x; s.by = l.y;   // before growing, so undo is exact
        l.ensure({ x: 0, y: 0, w: d.width, h: d.height });
        const m = d.selection.maskCanvas(), fl = canvas(l.canvas.width, l.canvas.height), fx = ctx(fl);
        fx.drawImage(l.canvas, 0, 0); fx.globalCompositeOperation = 'destination-in'; fx.drawImage(m, -l.x, -l.y);
        const lc = ctx(l.canvas); lc.globalCompositeOperation = 'destination-out'; lc.drawImage(m, -l.x, -l.y); lc.globalCompositeOperation = 'source-over';
        if (l.isBackground) { lc.globalCompositeOperation = 'destination-over'; lc.fillStyle = C.hex(app.bg); lc.fillRect(0, 0, l.canvas.width, l.canvas.height); lc.globalCompositeOperation = 'source-over'; }
        l.touch();
        const sb = d.selection.bounds(), crop = R.inter({ x: sb.x - l.x, y: sb.y - l.y, w: sb.w, h: sb.h }, { x: 0, y: 0, w: fl.width, h: fl.height });
        const src = canvas(crop.w, crop.h); ctx(src).drawImage(fl, -crop.x, -crop.y);
        const tmp = new PixelLayer('floating', src.width, src.height, crop.x + l.x, crop.y + l.y); tmp.canvas = src; tmp.blend = l.blend; tmp.opacity = l.opacity;
        d.insert(tmp, l.parent, l.parent.children.indexOf(l) + 1);
        s.kind = 'float'; s.tmp = tmp; s.src = src; s.S = tmp.bounds(); s.selBefore = d.selection.snapshot();
      } else {
        const b = contentBox(l, d); if (!b) return app.ui.toast('The layer is empty');
        s.kind = 'pixel';
        s.src = canvas(b.w, b.h); ctx(s.src).drawImage(l.canvas, l.x - b.x, l.y - b.y);
        s.S = b;
      }
    }
    s.A = M3.id(); s.quad = quadOf(s.S); s.grid = gridFromQuad(s.quad); s.rev = 1;
    this.s = s;
    app.transformSession = this;
    app.setTool('transform', true);
    this.setMode(app, mode);
    if (opts.grab) this.down(opts.grab, app);
    app.view.invalidate();
  },
  setMode(app, mode) {
    const s = this.s; if (!s) return;
    s.quad = this.currentQuad();
    if (mode === 'warp' && s.mode !== 'warp') s.grid = gridFromQuad(s.quad);
    if (mode !== 'free') s.A = null;
    if (mode === 'free' && !s.A) { s.A = M3.quadToQuad(quadOf(s.S), s.quad); }
    s.mode = mode; s.rev++;
    app.ui.buildOptions(); app.view.invalidate();
  },
  currentQuad() { const s = this.s; return s.mode === 'free' && s.A ? quadOf(s.S).map(p => apply(s.A, p)) : s.quad.map(p => ({ ...p })); },
  state() { const s = this.s; return { mode: s.mode === 'free' ? 'distort' : s.mode, quad: this.currentQuad(), grid: s.grid, warp: s.warp }; },
  /** mesh for the compositor while the session runs */
  meshFor(layer) {
    const s = this.s; if (!s) return null;
    const target = s.kind === 'float' ? s.tmp : s.layer;
    if (layer !== target || s.kind === 'mask') return null;
    if (s._meshRev !== s.rev) { s._mesh = buildMesh(mapperFor(this.state()), s.mode === 'warp' ? 32 : 2); s._meshRev = s.rev; }
    return { verts: s._mesh, interp: 1, canvas: s.src, rev: 1 };
  },

  options(app) {
    const s = this.s; if (!s) return [];
    const out = [og(seg([['free', 'Free'], ['distort', 'Distort'], ['perspective', 'Perspective'], ['warp', 'Warp']], s.mode, v => this.setMode(app, v)))];
    if (s.mode === 'free' && s.A) {
      const dec = decompose(s.A);
      out.push(og(lbl('W'), num({ value: dec.sx * 100, unit: '%', width: 64, digits: 1, onChange: (v, f) => f && this.setScale(app, v / 100, null) }), lbl('H'), num({ value: dec.sy * 100, unit: '%', width: 64, digits: 1, onChange: (v, f) => f && this.setScale(app, null, v / 100) }),
        lbl('∠'), num({ value: dec.rot, unit: '°', width: 58, digits: 1, onChange: (v, f) => f && this.setRot(app, v) })));
    }
    if (s.mode === 'warp') {
      const w = s.warp;
      out.push(og(lbl('Warp'), select(WARP_STYLES.filter(x => x[0] !== 'none'), w.style, v => { s.warp = { ...w, style: v }; if (v === 'custom') s.grid = gridFromQuad(s.quad); s.rev++; app.ui.buildOptions(); app.view.invalidate(); })));
      if (w.style !== 'custom') out.push(og(lbl('Bend'), num({ value: Math.round(w.bend * 100), min: -100, max: 100, unit: '%', width: 58, onChange: (v) => { s.warp = { ...s.warp, bend: v / 100 }; s.rev++; app.view.invalidate(); } }),
        lbl('H'), num({ value: Math.round((w.hd || 0) * 100), min: -100, max: 100, unit: '%', width: 54, onChange: v => { s.warp = { ...s.warp, hd: v / 100 }; s.rev++; app.view.invalidate(); } }),
        lbl('V'), num({ value: Math.round((w.vd || 0) * 100), min: -100, max: 100, unit: '%', width: 54, onChange: v => { s.warp = { ...s.warp, vd: v / 100 }; s.rev++; app.view.invalidate(); } })));
    }
    if (s.kind !== 'text' || s.mode === 'distort' || s.mode === 'perspective' || (s.mode === 'warp' && s.warp.style === 'custom'))
      out.push(og(lbl('Interpolation'), select([[0, 'Nearest neighbor'], [1, 'Bilinear'], [2, 'Bicubic']], s.interp, v => s.interp = +v)));
    out.push(og(lbl(s.mode === 'free' ? 'Corner: scale · ⇧ free ratio · ⌥ from center · ⌘ distort / skew · outside: rotate' : s.mode === 'warp' ? 'Drag the grid points and handles' : 'Drag the corners')));
    out.push(og(btn('x', () => this.end(app, false), 'ghost icon', 'Cancel (Esc)'), btn('check', () => this.end(app, true), 'pri icon', 'Commit (↩)')));
    return out;
  },
  setScale(app, sx, sy) {
    const s = this.s, dec = decompose(s.A), c = apply(s.A, { x: s.S.x + s.S.w / 2, y: s.S.y + s.S.h / 2 });
    s.A = compose(dec.rot, sx ?? dec.sx, sy ?? dec.sy, dec.skew, s.S, c); s.rev++; app.view.invalidate(); app.ui.buildOptions();
  },
  setRot(app, deg) {
    const s = this.s, dec = decompose(s.A), c = apply(s.A, { x: s.S.x + s.S.w / 2, y: s.S.y + s.S.h / 2 });
    s.A = compose(deg, dec.sx, dec.sy, dec.skew, s.S, c); s.rev++; app.view.invalidate(); app.ui.buildOptions();
  },

  /* ---------- hit testing ---------- */
  hit(app, e) {
    const s = this.s, v = app.view, q = this.currentQuad().map(p => v.toScreen(p.x, p.y)), P = { x: e.sx, y: e.sy };
    if (s.mode === 'warp') {
      const g = s.grid.map(p => v.toScreen(p.x, p.y));
      for (let i = 0; i < 16; i++) if (dist(g[i], P) < 7) return { kind: 'grid', i };
      if (s.warp.style !== 'custom') { if (inQuad(q, P)) return { kind: 'move' }; return null; }
      return inQuad(q, P) ? { kind: 'move' } : null;
    }
    for (let i = 0; i < 4; i++) if (dist(q[i], P) < 7) return { kind: 'corner', i };
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; if (dist(m, P) < 7) return { kind: 'edge', i }; }
    if (inQuad(q, P)) return { kind: 'move' };
    for (let i = 0; i < 4; i++) if (dist(q[i], P) < 28) return { kind: 'rotate' };
    return null;
  },
  hover(e, app) {
    const h = this.s && this.hit(app, e), vp = document.getElementById('viewport');
    vp.style.cursor = !h ? 'default' : h.kind === 'move' ? 'move' : h.kind === 'rotate' ? 'alias' : h.kind === 'grid' ? 'pointer' : 'crosshair';
  },
  down(e, app) {
    const s = this.s; if (!s) return;
    const hit = this.hit(app, e);
    if (!hit) { return; }
    if (hit.kind === 'corner' && e.cmd && s.mode === 'free') this.setMode(app, 'distort');
    s.drag = { hit, x0: e.x, y0: e.y, A0: s.A ? [...s.A] : null, quad0: this.currentQuad(), grid0: s.grid.map(p => ({ ...p })), cmd: e.cmd };
    if (s.mode === 'warp' && s.warp.style !== 'custom' && hit.kind === 'grid') {
      // refine a preset by hand: turn it into an editable grid first
      const unit = gridFromPreset(s.warp.style, s.warp.bend, s.warp.hd || 0, s.warp.vd || 0, { x: 0, y: 0, w: 1, h: 1 }), H = M3.squareToQuad(s.quad);
      s.grid = unit.map(p => M3.apply(H, p.x, p.y)); s.warp = { ...s.warp, style: 'custom' }; s.drag.grid0 = s.grid.map(p => ({ ...p })); app.ui.buildOptions();
    }
  },
  move(e, app) {
    const s = this.s; if (!s || !s.drag) return;
    const g = s.drag, hit = g.hit, dx = e.x - g.x0, dy = e.y - g.y0;
    if (hit.kind === 'move') {
      let ddx = dx, ddy = dy;
      if (e.shift) { if (Math.abs(dx) > Math.abs(dy)) ddy = 0; else ddx = 0; }
      const bb = R.fromPts(g.quad0), sn = app.view.snapRect({ x: bb.x + ddx, y: bb.y + ddy, w: bb.w, h: bb.h }); ddx += sn.dx; ddy += sn.dy;
      if (s.mode === 'free') s.A = M3.mul(M3.translate(ddx, ddy), g.A0);
      else { s.quad = g.quad0.map(p => ({ x: p.x + ddx, y: p.y + ddy })); if (s.mode === 'warp') s.grid = g.grid0.map(p => ({ x: p.x + ddx, y: p.y + ddy })); }
    } else if (hit.kind === 'rotate' && s.mode === 'free') {
      const c = apply(g.A0, { x: s.S.x + s.S.w / 2, y: s.S.y + s.S.h / 2 });
      let a = Math.atan2(e.y - c.y, e.x - c.x) - Math.atan2(g.y0 - c.y, g.x0 - c.x);
      if (e.shift) { const tot = decompose(g.A0).rot * Math.PI / 180 + a; a = Math.round(tot / (Math.PI / 12)) * (Math.PI / 12) - decompose(g.A0).rot * Math.PI / 180; }
      s.A = M3.mul(M3.translate(c.x, c.y), M3.mul(M3.rotate(a), M3.mul(M3.translate(-c.x, -c.y), g.A0)));
      app.ui.info(`${Math.round(decompose(s.A).rot * 10) / 10}°`);
    } else if (s.mode === 'free' && (hit.kind === 'corner' || hit.kind === 'edge')) {
      const inv = M3.inv(g.A0), p = M3.apply(inv, e.x, e.y), S = s.S, loc = quadOf(S);
      const center = { x: S.x + S.w / 2, y: S.y + S.h / 2 };
      if (hit.kind === 'corner') {
        const c = loc[hit.i], a = e.alt ? center : loc[(hit.i + 2) % 4];
        let sx = (p.x - a.x) / ((c.x - a.x) || 1), sy = (p.y - a.y) / ((c.y - a.y) || 1);
        if (!e.shift) { const k = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = k; sy = k; }
        s.A = M3.mul(g.A0, M3.mul(M3.translate(a.x, a.y), M3.mul(M3.scale(sx, sy), M3.translate(-a.x, -a.y))));
      } else {
        // edges: 0 top, 1 right, 2 bottom, 3 left
        const m = (i) => { const a = loc[i], b = loc[(i + 1) % 4]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
        const em = m(hit.i), a = e.alt ? center : m((hit.i + 2) % 4), horiz = hit.i === 0 || hit.i === 2;
        if (g.cmd) {
          const p0 = M3.apply(inv, g.x0, g.y0);
          const k = horiz ? (p.x - p0.x) / ((em.y - a.y) || 1) : (p.y - p0.y) / ((em.x - a.x) || 1);
          const sh = horiz ? [1, k, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, k, 1, 0, 0, 0, 1];
          s.A = M3.mul(g.A0, M3.mul(M3.translate(a.x, a.y), M3.mul(sh, M3.translate(-a.x, -a.y))));
        } else {
          let sx = 1, sy = 1;
          if (horiz) sy = (p.y - a.y) / ((em.y - a.y) || 1); else sx = (p.x - a.x) / ((em.x - a.x) || 1);
          if (e.shift) { if (horiz) sx = Math.abs(sy); else sy = Math.abs(sx); }
          s.A = M3.mul(g.A0, M3.mul(M3.translate(a.x, a.y), M3.mul(M3.scale(sx, sy), M3.translate(-a.x, -a.y))));
        }
      }
      const dec = decompose(s.A); app.ui.info(`W ${Math.round(dec.sx * 100)}%  H ${Math.round(dec.sy * 100)}%`);
    } else if ((s.mode === 'distort' || s.mode === 'perspective') && (hit.kind === 'corner' || hit.kind === 'edge')) {
      const q = g.quad0.map(p => ({ ...p }));
      if (hit.kind === 'corner') {
        q[hit.i] = { x: q[hit.i].x + dx, y: q[hit.i].y + dy };
        if (s.mode === 'perspective') {
          const horiz = Math.abs(dx) > Math.abs(dy);
          const partner = horiz ? [1, 0, 3, 2][hit.i] : [3, 2, 1, 0][hit.i];
          if (horiz) q[partner] = { ...q[partner], x: g.quad0[partner].x - dx }; else q[partner] = { ...q[partner], y: g.quad0[partner].y - dy };
          q[hit.i] = horiz ? { x: g.quad0[hit.i].x + dx, y: g.quad0[hit.i].y } : { x: g.quad0[hit.i].x, y: g.quad0[hit.i].y + dy };
        }
      } else { const i = hit.i, j = (i + 1) % 4; q[i] = { x: q[i].x + dx, y: q[i].y + dy }; q[j] = { x: q[j].x + dx, y: q[j].y + dy }; }
      s.quad = q;
    } else if (hit.kind === 'grid') {
      const i = hit.i, G = g.grid0.map(p => ({ ...p }));
      G[i] = { x: G[i].x + dx, y: G[i].y + dy };
      // dragging a corner anchor carries its two handles
      const corners = { 0: [1, 4], 3: [2, 7], 12: [8, 13], 15: [11, 14] };
      if (corners[i]) for (const k of corners[i]) G[k] = { x: g.grid0[k].x + dx, y: g.grid0[k].y + dy };
      s.grid = G;
      s.quad = [G[0], G[3], G[15], G[12]].map(p => ({ ...p }));
    }
    s.rev++; app.view.invalidate();
  },
  up(e, app) { const s = this.s; if (s) { s.drag = null; app.ui.info(''); app.ui.buildOptions(); } },
  dblclick(e, app) { const s = this.s; if (s && this.hit(app, e)?.kind === 'move') this.end(app, true); },
  key(e, app) {
    if (!this.s) return false;
    if (e.key === 'Enter') { this.end(app, true); return true; }
    if (e.key === 'Escape') { this.end(app, false); return true; }
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (k) { const n = e.shiftKey ? 10 : 1, s = this.s; if (s.mode === 'free') s.A = M3.mul(M3.translate(k[0] * n, k[1] * n), s.A); else { s.quad = s.quad.map(p => ({ x: p.x + k[0] * n, y: p.y + k[1] * n })); s.grid = s.grid.map(p => ({ x: p.x + k[0] * n, y: p.y + k[1] * n })); } s.rev++; app.view.invalidate(); return true; }
    return false;
  },
  deactivate(app) { if (this.s && !this.ending) this.end(app, true, true); },
  leaveDoc(app) { if (this.s) this.end(app, true, true); },

  /** finish: ok = commit */
  async end(app, ok, keepTool) {
    const s = this.s; if (!s || this.ending) return;
    this.ending = true;
    const d = app.doc, l = s.layer;
    try {
      const st = this.state();
      const identity = s.mode === 'free' ? isIdentity(s.A) : false;
      if (ok && !identity) {
        if (s.kind === 'text' && (s.mode === 'free' || (s.mode === 'warp' && s.warp.style !== 'custom'))) {
          if (s.mode === 'free') {
            // keep it text: fold the matrix into the layer's xform about its anchor
            const ax = Math.round(l.x), ay = Math.round(l.y), X = s.text.xform || [1, 0, 0, 1, 0, 0];
            const X3 = [X[0], X[2], X[4], X[1], X[3], X[5], 0, 0, 1];
            const N = M3.mul(M3.translate(-ax, -ay), M3.mul(s.A, M3.mul(M3.translate(ax, ay), X3)));
            d.setProps(l, { xform: [N[0], N[3], N[1], N[4], N[2], N[5]] }, 'Transform Text');
          } else d.setProps(l, { warp: { ...s.warp } }, 'Warp Text');
        } else {
          if (s.kind === 'text') {
            const r = await app.ui.confirm('Rasterize the text layer?', 'This transform can’t keep the text editable. The layer becomes pixels.', ['Rasterize', 'Cancel']);
            if (r !== 0) { ok = false; }
          }
          if (ok) {
            const out = renderMapped(app.view.comp, s.src, mapperFor(st), s.interp, s.mode === 'warp' ? 48 : 2);
            if (s.kind === 'pixel') d.replaceCanvas(l, out.canvas, out.x, out.y, s.mode === 'warp' ? 'Warp' : 'Free Transform');
            else if (s.kind === 'mask') {
              const m = l.mask, n = canvas(m.canvas.width, m.canvas.height), x = ctx(n); x.fillStyle = m.bg ? '#fff' : '#000'; x.fillRect(0, 0, n.width, n.height); x.drawImage(out.canvas, out.x - m.x, out.y - m.y);
              d.replaceMask(l, { ...m, canvas: n, rev: (m.rev || 0) + 1 }, 'Transform Mask');
            } else if (s.kind === 'text') {
              const { rasterizeLayer } = await import('../commands.js');
              rasterizeLayer(app, l, out);
            } else if (s.kind === 'float') {
              d.detach(s.tmp);
              const merged = l.canvas, b = R.union(l.bounds(), { x: out.x, y: out.y, w: out.canvas.width, h: out.canvas.height });
              l.ensure(b); ctx(l.canvas).drawImage(out.canvas, out.x - l.x, out.y - l.y); l.touch();
              const after = l.canvas, ax = l.x, ay = l.y;
              d.selection.fromAlpha(out.canvas, out.x, out.y, 'new'); d.selection.changed();
              const selAfter = d.selection.snapshot(), selBefore = s.selBefore, before = s.before, bx = s.bx, by = s.by;
              d.history.push({ label: 'Free Transform', undo: () => { l.canvas = before; l.x = bx; l.y = by; l.touch(); d.selection.restore(selBefore); }, redo: () => { l.canvas = after; l.x = ax; l.y = ay; l.touch(); d.selection.restore(selAfter); } });
              void merged;
            }
          }
        }
      }
      if ((!ok || identity) && s.kind === 'float') {
        d.detach(s.tmp); l.canvas = s.before; l.x = s.bx; l.y = s.by; l.touch();
      }
    } finally {
      this.s = null; app.transformSession = null; this.ending = false;
      d.changed('all');
      if (!keepTool) app.setTool(s.prevTool || 'move');
      app.ui.info('');
    }
  },

  overlay(c, view) {
    const s = this.s; if (!s) return;
    const q = this.currentQuad().map(p => view.toScreen(p.x, p.y)), col = accent();
    c.save(); c.strokeStyle = col; c.lineWidth = 1;
    if (s.mode === 'warp') {
      const map = mapperFor(this.state());
      c.beginPath();
      for (let k = 0; k <= 3; k++) for (const along of [0, 1]) { for (let t = 0; t <= 24; t++) { const u = along ? k / 3 : t / 24, v = along ? t / 24 : k / 3, p = map(u, v), sp = view.toScreen(p.x, p.y); t ? c.lineTo(sp.x, sp.y) : c.moveTo(sp.x, sp.y); } }
      c.stroke();
      if (s.warp.style === 'custom') {
        const g = s.grid.map(p => view.toScreen(p.x, p.y));
        c.strokeStyle = 'rgba(255,255,255,.7)'; c.beginPath();
        for (const [a, b] of [[0, 1], [0, 4], [3, 2], [3, 7], [12, 13], [12, 8], [15, 14], [15, 11]]) { c.moveTo(g[a].x, g[a].y); c.lineTo(g[b].x, g[b].y); }
        c.stroke();
        g.forEach((p, i) => { const corner = i === 0 || i === 3 || i === 12 || i === 15; c.fillStyle = corner ? '#fff' : col; c.beginPath(); if (corner) c.rect(p.x - 4, p.y - 4, 8, 8); else c.arc(p.x, p.y, 3.5, 0, 7); c.fill(); c.strokeStyle = '#000'; c.stroke(); });
      }
    } else {
      c.beginPath(); q.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.stroke();
      const pts = [...q, ...q.map((p, i) => { const b = q[(i + 1) % 4]; return { x: (p.x + b.x) / 2, y: (p.y + b.y) / 2 }; })];
      for (const p of pts) { c.fillStyle = '#fff'; c.fillRect(Math.round(p.x) - 4, Math.round(p.y) - 4, 8, 8); c.strokeStyle = '#000'; c.strokeRect(Math.round(p.x) - 4.5, Math.round(p.y) - 4.5, 8, 8); }
      const ctr = { x: q.reduce((a, p) => a + p.x, 0) / 4, y: q.reduce((a, p) => a + p.y, 0) / 4 };
      c.strokeStyle = col; c.beginPath(); c.arc(ctr.x, ctr.y, 4, 0, 7); c.moveTo(ctr.x - 7, ctr.y); c.lineTo(ctr.x + 7, ctr.y); c.moveTo(ctr.x, ctr.y - 7); c.lineTo(ctr.x, ctr.y + 7); c.stroke();
    }
    c.restore();
  },
};

/* ---------- affine helpers ---------- */
function isIdentity(A) { return !A || (Math.abs(A[0] - 1) < 1e-9 && Math.abs(A[1]) < 1e-9 && Math.abs(A[2]) < 1e-6 && Math.abs(A[3]) < 1e-9 && Math.abs(A[4] - 1) < 1e-9 && Math.abs(A[5]) < 1e-6); }
/** A = T * R(rot) * Shear(skew) * S(sx, sy)  -> parts (degrees) */
export function decompose(A) {
  const a = A[0], b = A[3], c = A[1], d = A[4];
  const sx = Math.hypot(a, b), rot = Math.atan2(b, a), det = a * d - b * c;
  const skew = Math.atan2(a * c + b * d, det);
  const sy = det / sx;
  return { sx, sy, rot: rot * 180 / Math.PI, skew };
}
function compose(rotDeg, sx, sy, skew, S, center) {
  const r = rotDeg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r), k = Math.tan(skew);
  // linear part = R * [[1, k], [0, 1]] * diag(sx, sy)
  const L = [cs * sx, (cs * k - sn) * sy, 0, sn * sx, (sn * k + cs) * sy, 0, 0, 0, 1];
  const sc = { x: S.x + S.w / 2, y: S.y + S.h / 2 };
  return M3.mul(M3.translate(center.x, center.y), M3.mul(L, M3.translate(-sc.x, -sc.y)));
}
function inQuad(q, p) {
  let ins = false;
  for (let i = 0, j = 3; i < 4; j = i++) if ((q[i].y > p.y) !== (q[j].y > p.y) && p.x < (q[j].x - q[i].x) * (p.y - q[i].y) / (q[j].y - q[i].y) + q[i].x) ins = !ins;
  return ins;
}
export { bezierPatch, chk, h };
