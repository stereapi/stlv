// Move, Hand, Zoom, Eyedropper.

import { h, R, C, clamp, canvas, ctx, cloneCanvas } from '../util.js';
import { og, lbl, chk, seg, select, btn, icon } from '../ui/widgets.js';
import { shiftLayer, PixelLayer } from '../doc.js';
import { textQuad } from '../text.js';

/** doc-space bounds of anything movable */
export function layerBox(l, doc) {
  if (l.type === 'pixel') return l.bounds();
  if (l.type === 'text') { const q = textQuad(l, doc); return R.fromPts(q); }
  if (l.isGroup) { let b = null; for (const c of l.children) { const cb = layerBox(c, doc); if (cb) b = R.union(b, cb); } return b; }
  return { x: 0, y: 0, w: doc.width, h: doc.height };
}
/** opaque content bounds (pixel layers: trims transparency) */
export function contentBox(l, doc) {
  if (l.type === 'pixel') { const b = opaque(l); return b ? { x: b.x + l.x, y: b.y + l.y, w: b.w, h: b.h } : null; }
  return layerBox(l, doc);
}
const obCache = new WeakMap();
function opaque(l) {
  const c = obCache.get(l); if (c && c.rev === l.rev) return c.b;
  const w = l.canvas.width, hh = l.canvas.height, d = ctx(l.canvas).getImageData(0, 0, w, hh).data;
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) { let i = y * w * 4 + 3; for (let x = 0; x < w; x++, i += 4) if (d[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; } }
  const b = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  obCache.set(l, { rev: l.rev, b }); return b;
}
const PICK = 10;   // screen px of slack around an object: a near miss still picks it up
const movable = l => !l.lock.pos && !l.lock.all;
/** every layer, top of the stack first, inside collapsed groups too */
function stack(doc) {
  const out = [], rec = g => { for (let i = g.children.length - 1; i >= 0; i--) { const l = g.children[i]; out.push(l); if (l.isGroup) rec(l); } };
  rec(doc.root); return out;
}
/** doc-px distance from (x, y) to the layer's content: 0 = on it, Infinity = further than pad */
function hitDist(l, doc, x, y, pad) {
  if (l.type === 'text') {
    const q = textQuad(l, doc); if (inQuad(q, x, y)) return 0;
    const m = Math.min(...q.map((p, i) => segDist(p, q[(i + 1) % 4], x, y))); return m <= pad ? m : Infinity;
  }
  if (l.type !== 'pixel') return Infinity;
  const cx = Math.floor(x - l.x), cy = Math.floor(y - l.y), r = Math.min(Math.ceil(pad), 48), w = l.canvas.width, hh = l.canvas.height;
  const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r), x1 = Math.min(w, cx + r + 1), y1 = Math.min(hh, cy + r + 1);
  if (x1 <= x0 || y1 <= y0) return Infinity;
  const d = ctx(l.canvas).getImageData(x0, y0, x1 - x0, y1 - y0).data, rw = x1 - x0;
  let best = Infinity;
  for (let i = 3, k = 0; i < d.length; i += 4, k++) if (d[i] > 10) { const dd = Math.hypot(x0 + k % rw - cx, y0 + (k / rw | 0) - cy); if (dd < best) best = dd; }
  return best <= r ? best : Infinity;
}
/** is (x, y) on, or within pad of, the layer's content (a group: any of its layers) */
function touches(l, doc, x, y, pad) {
  return l.isGroup ? l.children.some(c => touches(c, doc, x, y, pad)) : hitDist(l, doc, x, y, pad) !== Infinity;
}
function inQuad(q, x, y) {
  let ins = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i].y > y) !== (q[j].y > y) && x < (q[j].x - q[i].x) * (y - q[i].y) / (q[j].y - q[i].y) + q[i].x) ins = !ins;
  return ins;
}
function segDist(a, b, x, y) {
  const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
}
/** the movable object under a doc point, within pad doc px of its content, or null.
 *  A layer inside a collapsed group picks the group (sb flyer names are a glow + text
 *  in a closed group, and should move as one); groups=true always picks the top group.
 *  Locked layers are never picked. Layers that cover the whole canvas (a photo, a
 *  vignette) lose to anything else in reach, so a click beside a word takes the word,
 *  and the nearest object wins (ties: the higher one). */
export function pickLayer(doc, x, y, groups = false, pad = 0) {
  let best = null, backdrop = null;
  for (const l of stack(doc)) {
    if (l.isGroup || !l.visible || doc.hiddenChain(l)) continue;
    let obj = l;
    for (let p = l.parent; p && p !== doc.root; p = p.parent) if (groups ? p.parent === doc.root : !p.open) obj = p;
    if (!movable(obj) || !movable(l)) continue;
    const dd = hitDist(l, doc, x, y, pad); if (dd === Infinity) continue;
    const b = layerBox(l, doc), big = b && b.w * b.h >= doc.width * doc.height * 0.9;
    if (big) { if (!backdrop) backdrop = obj; continue; }
    if (!best || dd < best.d) best = { obj, d: dd };
    if (dd === 0) break;
  }
  return best ? best.obj : backdrop;
}
/** is l, an ancestor or a descendant of l selected */
function selectedNear(doc, l) {
  for (let p = l; p && p !== doc.root; p = p.parent) if (doc.selected.has(p.id)) return true;
  for (const s of doc.selectedLayers()) for (let p = s.parent; p && p !== doc.root; p = p.parent) if (p === l) return true;
  return false;
}
export function moveLayers(doc, layers, dx, dy) {
  const all = new Set();
  const add = l => { all.add(l); if (l.isGroup) l.children.forEach(add); };
  layers.forEach(add);
  for (const l of all) shiftLayer(l, dx, dy);
}
/** selected layers minus any whose ancestor is also selected */
export function topSelected(doc) {
  const sel = doc.selectedLayers();
  return sel.filter(l => { for (let p = l.parent; p && p !== doc.root; p = p.parent) if (doc.selected.has(p.id)) return false; return true; });
}

/* ---------- group scale: several layers scale as one picture around a fixed point ---------- */
/** what a group scale changes: pixel and text layers, groups opened up */
function scaleLeaves(layers) { const out = [], add = l => { if (l.isGroup) l.children.forEach(add); else if (l.type === 'pixel' || l.type === 'text') out.push(l); }; layers.forEach(add); return out; }
/** the state a group scale starts from (and undo returns to) */
export function scaleSnap(layers) {
  return scaleLeaves(layers).map(l => ({
    l, x: l.x, y: l.y, mask: l.mask,
    ...(l.type === 'text' ? { size: l.size, leading: l.leading, box: l.box && { ...l.box }, xform: l.xform && [...l.xform] } : { canvas: l.canvas }),
  }));
}
export function restoreSnap(snaps) {
  for (const t of snaps) {
    const l = t.l; l.x = t.x; l.y = t.y; l.mask = t.mask;
    if (l.type === 'text') { l.size = t.size; l.leading = t.leading; l.box = t.box && { ...t.box }; l.xform = t.xform && [...t.xform]; l.raster = null; }
    else l.canvas = t.canvas;
    l.touch();
  }
}
function resized(src, s) {
  const c = canvas(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s))), x = ctx(c);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height); return c;
}
/** scale every snapshotted layer by s around (ox, oy): text stays text (size, leading, box grow), pixels resample */
export function applyScale(snaps, s, ox, oy) {
  const at = (v, o) => o + (v - o) * s;
  for (const t of snaps) {
    const l = t.l;
    if (l.type === 'text') {
      l.x = at(t.x, ox); l.y = at(t.y, oy); l.size = t.size * s; l.leading = t.leading ? t.leading * s : 0;
      l.box = t.box && { w: t.box.w * s, h: t.box.h * s };
      l.xform = t.xform && [t.xform[0], t.xform[1], t.xform[2], t.xform[3], t.xform[4] * s, t.xform[5] * s];
      l.raster = null;
    } else { l.canvas = resized(t.canvas, s); l.x = Math.round(at(t.x, ox)); l.y = Math.round(at(t.y, oy)); }
    const m = t.mask;
    if (m && (m.linked || l.type !== 'pixel')) l.mask = { ...m, canvas: resized(m.canvas, s), x: Math.round(at(m.x, ox)), y: Math.round(at(m.y, oy)), rev: (m.rev || 0) + 1 };
    l.touch();
  }
}
/** union box of several layers */
export function unionBox(layers, doc) { return layers.map(l => contentBox(l, doc)).reduce((a, b) => R.union(a, b), null); }
const HANDLES = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];

/* ---------- Move ---------- */
export const moveTool = {
  id: 'move', name: 'Move', shortcut: 'v', icon: 'move', cursor: 'default',
  defaults: { autoSelect: false, autoGroup: false, showBox: true },
  options(app) {
    const o = this.opts;
    const al = (k, ic, t) => btn(ic, () => app.run('layer.align', k), 'ghost icon', t);
    return [og(chk('Auto-select', o.autoSelect, v => app.toolOpt(this, 'autoSelect', v)), select([['layer', 'Layer'], ['group', 'Group']], o.autoGroup ? 'group' : 'layer', v => app.toolOpt(this, 'autoGroup', v === 'group'))),
      og(chk('Show transform controls', o.showBox, v => app.toolOpt(this, 'showBox', v))),
      og(lbl('Align'), al('left', 'alignL', 'Align left edges'), al('hcenter', 'alignCH', 'Align horizontal centers'), al('right', 'alignR', 'Align right edges'), al('top', 'alignT', 'Align top edges'), al('vcenter', 'alignCV', 'Align vertical centers'), al('bottom', 'alignB', 'Align bottom edges')),
      og(chk('Snap', app.prefs.snap, v => app.setPref('snap', v)), chk('Guides', app.prefs.snapTo.guides !== false, v => app.setPref('snapTo', { ...app.prefs.snapTo, guides: v })), chk('Canvas', app.prefs.snapTo.canvas !== false, v => app.setPref('snapTo', { ...app.prefs.snapTo, canvas: v })), chk('Layers', !!app.prefs.snapTo.layers, v => app.setPref('snapTo', { ...app.prefs.snapTo, layers: v })))];
  },
  /** what the transform box wraps: {layers, box, multi} — several selected layers get one box that drags and scales them all */
  boxFor(app) {
    const d = app.doc; if (!d) return null;
    const many = topSelected(d).filter(l => movable(l) && (l.isGroup || l.type === 'pixel' || l.type === 'text') && !l.isBackground);
    if (many.length > 1) { const box = unionBox(many, d); return box && { layers: many, box, multi: true }; }
    const l = d.active; if (!l || l.type === 'adjust' || l.type === 'fill' || l.lock.pos || l.lock.all) return null;
    const box = contentBox(l, d); return box && { layers: [l], box, multi: false };
  },
  /** index of the box handle under the pointer, or -1 */
  handleAt(app, e) {
    if (!this.opts.showBox) return -1;
    const B = this.boxFor(app); if (!B) return -1;
    const b = B.box, v = app.view;
    return HANDLES.findIndex(([fx, fy]) => { const s = v.toScreen(b.x + b.w * fx, b.y + b.h * fy); return Math.abs(s.x - e.sx) < 9 && Math.abs(s.y - e.sy) < 9; });
  },
  down(e, app) {
    const d = app.doc;
    const hi = this.handleAt(app, e);
    if (hi >= 0) {
      const B = this.boxFor(app);
      if (!B.multi) { app.run('edit.transform', 'free', { grab: e }); return; }
      // several layers: scale them together, aspect kept, around the opposite handle (⌥: the centre)
      const b = B.box, [fx, fy] = HANDLES[hi], c = e.alt ? [0.5, 0.5] : [1 - fx, 1 - fy];
      this.scale = { snaps: scaleSnap(B.layers), ax: b.x + b.w * c[0], ay: b.y + b.h * c[1], hx: b.x + b.w * fx, hy: b.y + b.h * fy, s: 1 };
      return;
    }
    // auto-select picks what's under the pointer; so does any click while nothing selected can move
    const MB = this.opts.showBox && this.boxFor(app);   // inside a several-layer box: drag them all, don't re-pick
    const inMulti = MB && MB.multi && e.x >= MB.box.x && e.x <= MB.box.x + MB.box.w && e.y >= MB.box.y && e.y <= MB.box.y + MB.box.h;
    if (!inMulti && (this.opts.autoSelect !== e.cmd || !topSelected(d).some(movable))) { const l = pickLayer(d, e.x, e.y, this.opts.autoGroup, PICK / app.view.z); if (l && !selectedNear(d, l)) d.setActive(l); }
    let layers = topSelected(d).filter(movable);
    if (!layers.length) { if (d.active && (d.active.lock.pos || d.active.lock.all)) app.ui.toast('The layer is locked'); return; }
    const l = d.active;
    // selection on a pixel layer: move the selected pixels
    if (d.selection.active && l && l.type === 'pixel' && layers.length === 1 && !l.isBackground) return this.floatStart(e, app, l);
    if (d.selection.active && l && l.isBackground) { return this.floatStart(e, app, l, true); }
    if (e.alt) { app.run('layer.duplicate'); layers = topSelected(d); }
    this.drag = { x0: e.x, y0: e.y, dx: 0, dy: 0, layers, box: layers.map(x => layerBox(x, d)).reduce((a, b) => R.union(a, b), null), still: true, inBox: inMulti };
    app.view.snapIgnore = layers.length === 1 ? layers[0] : null;
  },
  floatStart(e, app, l, isBg) {
    const d = app.doc, sel = d.selection, m = sel.maskCanvas();
    const before = cloneCanvas(l.canvas), x0 = l.x, y0 = l.y;   // before growing: undo returns the exact old canvas
    l.ensure({ x: 0, y: 0, w: d.width, h: d.height });
    const fl = canvas(l.canvas.width, l.canvas.height), fx = ctx(fl);
    fx.drawImage(l.canvas, 0, 0); fx.globalCompositeOperation = 'destination-in'; fx.drawImage(m, -l.x, -l.y);
    const lc = ctx(l.canvas); lc.globalCompositeOperation = 'destination-out'; lc.drawImage(m, -l.x, -l.y); lc.globalCompositeOperation = 'source-over';
    if (isBg) { lc.globalCompositeOperation = 'destination-over'; lc.fillStyle = C.hex(app.bg); lc.fillRect(0, 0, l.canvas.width, l.canvas.height); lc.globalCompositeOperation = 'source-over'; }
    l.touch();
    const tmp = new PixelLayer('floating', fl.width, fl.height, l.x, l.y); tmp.canvas = fl; tmp.blend = l.blend; tmp.opacity = l.opacity;
    d.insert(tmp, l.parent, l.parent.children.indexOf(l) + 1);
    this.float = { layer: l, tmp, before, x0, y0, selBefore: sel.snapshot() };
    this.drag = { x0: e.x, y0: e.y, dx: 0, dy: 0, layers: [tmp], box: sel.bounds(), float: true };
    if (e.alt) { lc.drawImage(before, x0 - l.x, y0 - l.y); l.touch(); this.float.copy = true; }   // ⌥: copy instead of cut
    app.view.invalidate();
  },
  move(e, app) {
    const k = this.scale;
    if (k) {
      const vx = k.hx - k.ax, vy = k.hy - k.ay;
      const sc = Math.max(0.01, ((e.x - k.ax) * vx + (e.y - k.ay) * vy) / (vx * vx + vy * vy || 1));
      if (Math.abs(sc - k.s) < 1e-4) return;
      k.s = sc; applyScale(k.snaps, sc, k.ax, k.ay);
      app.view.invalidate(); app.ui.info(`Scale ${Math.round(sc * 100)}%`); return;
    }
    const g = this.drag; if (!g) return;
    // a click that wobbles a pixel or two is a click, not a move
    if (g.still) { if (Math.hypot(e.x - g.x0, e.y - g.y0) * app.view.z < 4) return; g.still = false; }
    let dx = Math.round(e.x - g.x0), dy = Math.round(e.y - g.y0);
    if (e.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (g.box && !e.cmd) { const s = app.view.snapRect({ x: g.box.x + dx, y: g.box.y + dy, w: g.box.w, h: g.box.h }); dx += Math.round(s.dx); dy += Math.round(s.dy); }
    const ddx = dx - g.dx, ddy = dy - g.dy; if (!ddx && !ddy) return;
    moveLayers(app.doc, g.layers, ddx, ddy);
    if (g.float) app.doc.selection.shift(ddx, ddy);
    g.dx = dx; g.dy = dy;
    app.view.invalidate(); app.ui.info(`Δ ${dx}, ${dy} px`);
  },
  up(e, app) {
    const k = this.scale; this.scale = null;
    if (k) {
      app.ui.info(''); if (k.s === 1) return;
      const d = app.doc, before = k.snaps, after = scaleSnap(before.map(t => t.l));
      d.history.push({ label: 'Scale Layers', undo: () => { restoreSnap(before); d.changed('all'); }, redo: () => { restoreSnap(after); d.changed('all'); } });
      d.changed('all'); return;
    }
    const g = this.drag; this.drag = null; app.view.snapIgnore = null; app.ui.info('');
    if (!g) return;
    const d = app.doc;
    if (g.float) return this.floatEnd(app, g);
    // a plain click on empty canvas beside the selection lets go of it, so the box disappears
    if (g.still && !g.inBox && !e.shift && !e.cmd && !e.alt && !d.selection.active && !g.layers.some(l => touches(l, d, g.x0, g.y0, PICK / app.view.z))) { d.setActive(null); return; }
    if (!g.dx && !g.dy) return;
    const { dx, dy, layers } = g;
    d.history.push({ label: 'Move', undo: () => { moveLayers(d, layers, -dx, -dy); d.changed('all'); }, redo: () => { moveLayers(d, layers, dx, dy); d.changed('all'); } });
    d.changed('all');
  },
  floatEnd(app, g) {
    const d = app.doc, f = this.float; this.float = null;
    const l = f.layer, tmp = f.tmp;
    d.detach(tmp);
    // merge the moved pixels back
    const b = R.union(l.bounds(), tmp.bounds()); l.ensure(b);
    ctx(l.canvas).drawImage(tmp.canvas, tmp.x - l.x, tmp.y - l.y); l.touch();
    const after = l.canvas, ax = l.x, ay = l.y, selAfter = d.selection.snapshot();
    const set = (c, x, y, s) => () => { l.canvas = c; l.x = x; l.y = y; l.touch(); d.selection.restore(s); };
    d.history.push({ label: 'Move Selection', undo: set(f.before, f.x0, f.y0, f.selBefore), redo: set(after, ax, ay, selAfter) });
    d.changed('all');
  },
  key(e, app) {
    const d = app.doc; if (!d) return false;
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (k && !e.metaKey) { const n = e.shiftKey ? 10 : 1; app.run('layer.nudge', k[0] * n, k[1] * n); return true; }
    return false;
  },
  overlay(c, view) {
    const app = view.app;
    if (!this.opts.showBox || this.drag) return;
    const B = this.boxFor(app); if (!B) return;
    const b = B.box, a = view.toScreen(b.x, b.y), z = view.z;
    c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent'); c.lineWidth = 1;
    c.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.w * z), Math.round(b.h * z));
    c.fillStyle = '#fff';
    for (const [x, y] of HANDLES) { const s = view.toScreen(b.x + b.w * x, b.y + b.h * y); c.fillRect(Math.round(s.x) - 3, Math.round(s.y) - 3, 7, 7); c.strokeRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7); }
  },
  /** does a press here grab an object (a transform handle or a movable layer), so a guide under it stays put */
  grabsAt(e, app) {
    if (this.handleAt(app, e) >= 0) return true;
    const d = app.doc; return !!(d && pickLayer(d, e.x, e.y, this.opts.autoGroup, PICK / app.view.z));
  },
  hover(e, app) { const vp = document.getElementById('viewport'), i = this.handleAt(app, e); vp.style.cursor = i < 0 ? 'default' : ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'][i]; },
};

/* ---------- Hand / Zoom ---------- */
export const handTool = {
  id: 'hand', name: 'Hand', shortcut: 'h', icon: 'hand', cursor: 'grab',
  options(app) { return og(btn('100%', () => app.view.actual()), btn('Fit screen', () => app.view.fit()), btn('Fill screen', () => app.view.fit(true))); },
  dblclick(e, app) { app.view.fit(); },
};
export const zoomTool = {
  id: 'zoom', name: 'Zoom', shortcut: 'z', icon: 'zoom', cursor: 'zoom-in',
  options(app) { return og(btn('100%', () => app.view.actual()), btn('Fit screen', () => app.view.fit()), btn('Fill screen', () => app.view.fit(true)), lbl('Click: in · ⌥-click: out · drag: scrub')); },
  down(e, app) { this.s = { x: e.sx, y: e.sy, z: app.view.z, moved: false }; },
  move(e, app) { const s = this.s; if (!s) return; const dx = e.sx - s.x; if (Math.abs(dx) > 3) s.moved = true; if (s.moved) app.view.zoomAt(s.z * Math.exp(dx / 150), s.x, s.y); },
  up(e, app) { const s = this.s; this.s = null; if (s && !s.moved) app.view.zoomStep(e.alt ? -1 : 1, e.sx, e.sy); },
  dblclick(e, app) { app.view.actual(); },
};

/* ---------- Eyedropper ---------- */
export function sampleColor(app, x, y, size = 1, source = 'all') {
  const d = app.doc, r = Math.floor(size / 2), rect = R.inter({ x: Math.floor(x) - r, y: Math.floor(y) - r, w: size, h: size }, { x: 0, y: 0, w: d.width, h: d.height });
  if (!rect) return null;
  let data;
  if (source === 'layer' && d.active && d.active.type === 'pixel') {
    const l = d.active, lr = R.inter({ x: rect.x - l.x, y: rect.y - l.y, w: rect.w, h: rect.h }, { x: 0, y: 0, w: l.canvas.width, h: l.canvas.height });
    if (!lr) return null; data = ctx(l.canvas).getImageData(lr.x, lr.y, lr.w, lr.h).data;
  } else {
    const comp = app.view.comp; if (!comp.result) return null;
    data = comp.g.read(comp.result, rect).data;
  }
  let rr = 0, gg = 0, bb = 0, aa = 0;
  for (let i = 0; i < data.length; i += 4) { const a = data[i + 3] / 255; rr += data[i] * a; gg += data[i + 1] * a; bb += data[i + 2] * a; aa += a; }
  if (!aa) return null;
  return { r: Math.round(rr / aa), g: Math.round(gg / aa), b: Math.round(bb / aa) };
}
export const eyedropperTool = {
  id: 'eyedropper', name: 'Eyedropper', shortcut: 'i', icon: 'dropper', cursor: 'crosshair',
  defaults: { size: 1, source: 'all' },
  options(app) {
    return [og(lbl('Sample size'), select([[1, 'Point sample'], [3, '3 × 3 average'], [5, '5 × 5 average'], [11, '11 × 11 average'], [31, '31 × 31 average']], this.opts.size, v => app.toolOpt(this, 'size', +v))),
      og(lbl('Sample'), select([['all', 'All layers'], ['layer', 'Current layer']], this.opts.source, v => app.toolOpt(this, 'source', v))), og(lbl('⌥-click: background color'))];
  },
  pick(e, app) { const c = sampleColor(app, e.x, e.y, +this.opts.size, this.opts.source); if (c) (e.alt ? app.setBg(c) : app.setFg(c)); this.ring = c ? { c, sx: e.sx, sy: e.sy } : null; app.view.redraw(); },
  down(e, app) { this.pick(e, app); this.on = true; },
  move(e, app) { if (this.on) this.pick(e, app); },
  up(e, app) { this.on = false; this.ring = null; app.view.redraw(); },
  overlay(c, view) {
    if (!this.ring) return;
    const { c: col, sx, sy } = this.ring;
    c.lineWidth = 10; c.strokeStyle = C.hex(col); c.beginPath(); c.arc(sx, sy, 34, 0, 7); c.stroke();
    c.lineWidth = 1; c.strokeStyle = 'rgba(0,0,0,.5)'; c.beginPath(); c.arc(sx, sy, 39, 0, 7); c.stroke(); c.beginPath(); c.arc(sx, sy, 29, 0, 7); c.stroke();
  },
};
export { icon, h };
