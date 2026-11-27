// stlv test suite. Runs inside the real app: index.html?test=1 in a browser,
// or headless in WebKit with `stlv --test` (mac/build.sh --test).
// Every test makes its own document.

import { canvas, ctx, getData, C, sleep, R } from '../js/util.js';
import { BLEND_MODES, PixelLayer, GroupLayer, FillLayer, AdjustLayer, TextLayer, makeMask } from '../js/doc.js';
import { defaultGradient } from '../js/gradient.js';
import { defaultParams, curveLut } from '../js/adjust.js';
import { FILTERS, defaultFilterParams, runFilter, bakeFilter, liveSource } from '../js/filters.js';
import { jpegCrunch, sbRun, sbLayerParams } from '../js/sbfx.js';
import { saveStlv, loadStlv } from '../js/io/stlvfile.js';
import { writePSD, readPSD } from '../js/io/psd.js';
import { encodeWebPLossless } from '../js/io/webp.js';
import { pngMeta, pngPPI, jpegMeta, jpegPPI, zip, unzip, crc32 } from '../js/io/binary.js';
import { writePDF } from '../js/io/pdf.js';
import { carve } from '../js/seamcarve.js';
import { layerPixels } from '../js/commands.js';
import { encode } from '../js/ui/export.js';
import { cropDoc } from '../js/tools/crop.js';
import { textQuad } from '../js/text.js';
window.__crop = { cropDoc };

const app = window.stlvApp;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ev = (x, y, extra = {}) => ({ x, y, sx: 0, sy: 0, shift: false, alt: false, cmd: false, button: 0, pressure: 1, ...extra });
function drag(tool, pts, mods = {}) { const t = app.tools[tool]; app.setTool(tool); t.down(ev(pts[0][0], pts[0][1], mods), app); for (const p of pts.slice(1)) t.move(ev(p[0], p[1], mods), app); const l = pts[pts.length - 1]; t.up(ev(l[0], l[1], mods), app); }
const px = (x, y, doc = app.doc) => [...app.view.comp.readComposite(doc, { x, y, w: 1, h: 1 }).data];
const comp = (doc = app.doc) => app.view.comp.readComposite(doc).data;
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
const near = (a, b, tol = 2) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
function eqAll(a, b, tol = 0) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) return false; return true; }
function fresh(w = 200, h = 150, bg = 'white') { while (app.docs.length) app.closeDoc(app.docs[0], true); return app.newDoc({ name: 'test', width: w, height: h, ppi: 72, background: bg }); }
function solidLayer(doc, color, rect, name = 'L') {
  const l = new PixelLayer(name, doc.width, doc.height); const x = ctx(l.canvas); x.fillStyle = color; const r = rect || { x: 0, y: 0, w: doc.width, h: doc.height }; x.fillRect(r.x, r.y, r.w, r.h);
  doc.addLayer(l); return l;
}

/* ---------- blend modes: GPU vs reference formulas ---------- */
const ref = {
  normal: (b, s) => s, multiply: (b, s) => b * s, screen: (b, s) => b + s - b * s, darken: Math.min, lighten: Math.max,
  overlay: (b, s) => b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s), hardLight: (b, s) => s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s),
  difference: (b, s) => Math.abs(b - s), exclusion: (b, s) => b + s - 2 * b * s, linearBurn: (b, s) => Math.max(0, b + s - 1), linearDodge: (b, s) => Math.min(1, b + s),
  colorDodge: (b, s) => b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)), colorBurn: (b, s) => b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s),
  subtract: (b, s) => Math.max(0, b - s), divide: (b, s) => s > 0 ? Math.min(1, b / s) : 1, linearLight: (b, s) => Math.min(1, Math.max(0, b + 2 * s - 1)),
  softLight: (b, s) => { const D = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b); return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (D - b); },
};
test('blend modes match the reference formulas (opaque sweep)', async () => {
  const vals = [0, 32, 64, 96, 128, 160, 192, 224, 255];
  const d = fresh(vals.length, vals.length, 'none');
  const B = new PixelLayer('b', d.width, d.height), S = new PixelLayer('s', d.width, d.height);
  const bi = ctx(B.canvas).createImageData(d.width, d.height), si = ctx(S.canvas).createImageData(d.width, d.height);
  for (let y = 0; y < vals.length; y++) for (let x = 0; x < vals.length; x++) { const i = (y * d.width + x) * 4; bi.data.set([vals[x], vals[y], 255 - vals[x], 255], i); si.data.set([vals[y], vals[x], vals[(x + y) % vals.length], 255], i); }
  ctx(B.canvas).putImageData(bi, 0, 0); ctx(S.canvas).putImageData(si, 0, 0);
  d.insert(B, d.root); d.insert(S, d.root);
  const bad = [];
  for (const [mode, f] of Object.entries(ref)) {
    S.blend = mode; S.touch();
    const out = comp(d);
    for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) {
      const want = Math.round(f(bi.data[i + c] / 255, si.data[i + c] / 255) * 255);
      if (Math.abs(out[i + c] - want) > 2) { bad.push(`${mode}: got ${out[i + c]} want ${want}`); break; }
    }
  }
  assert(!bad.length, bad.slice(0, 4).join('; '));
});
test('normal blend with alpha (W3C source-over)', () => {
  const d = fresh(4, 4); const l = solidLayer(d, 'rgba(255,0,0,0.5)');
  assert(near(px(1, 1), [255, 128, 128, 255], 2), 'half red over white = ' + px(1, 1));
  l.opacity = 0.5; l.touch();
  assert(near(px(1, 1), [255, 191, 191, 255], 2), 'quarter red = ' + px(1, 1));
});

/* ---------- painting ---------- */
test('brush stroke, undo and redo are exact', () => {
  const d = fresh(300, 200); app.run('layer.new');
  const before = comp(d).slice();
  app.setFg({ r: 255, g: 0, b: 0 }); app.tools.brush.opts.size = 30; app.tools.brush.opts.opacity = 100;
  drag('brush', [[20, 20], [150, 100], [280, 30]]);
  const after = comp(d).slice();
  assert(near(px(150, 100), [255, 0, 0, 255], 1), 'stroke centre ' + px(150, 100));
  app.run('edit.undo'); assert(eqAll(comp(d), before), 'undo restores');
  app.run('edit.redo'); assert(eqAll(comp(d), after), 'redo replays');
});
test('stroke opacity caps at the brush opacity (flow builds up)', () => {
  const d = fresh(300, 100); app.run('layer.new');
  app.setFg({ r: 0, g: 0, b: 0 }); Object.assign(app.tools.brush.opts, { size: 40, opacity: 50, flow: 30, hardness: 100, tip: 'round', spacing: 10 });
  drag('brush', [[20, 50], [280, 50], [20, 52], [280, 48]]);
  const v = px(150, 50)[0];
  Object.assign(app.tools.brush.opts, { opacity: 100, flow: 100 });
  assert(Math.abs(v - 128) <= 3, 'gray ' + v);
});
test('eraser, and painting respects the selection', () => {
  const d = fresh(200, 100); const l = solidLayer(d, '#000');
  d.selection.edit('sel', () => d.selection.rect({ x: 0, y: 0, w: 100, h: 100 }, 'new'));
  app.tools.eraser.opts.size = 60;
  drag('eraser', [[20, 50], [180, 50]]);
  assert(px(150, 50)[0] === 0, 'outside the selection untouched');
  assert(px(50, 50)[0] === 255, 'inside erased to white bg');
  void l;
});
test('flood fill: contiguous vs global, tolerance', () => {
  const d = fresh(100, 50); const l = solidLayer(d, '#fff');
  const x = ctx(l.canvas); x.fillStyle = '#000'; x.fillRect(49, 0, 2, 50); l.touch();
  app.setFg({ r: 0, g: 200, b: 0 }); app.tools.fill.opts.contiguous = true; app.tools.fill.opts.all = false; app.tools.fill.opts.aa = false;
  app.setTool('fill'); app.tools.fill.down(ev(10, 10), app);
  assert(near(px(10, 10), [0, 200, 0, 255]), 'left filled'); assert(px(80, 10)[1] === 255, 'right not');
  app.run('edit.undo'); app.tools.fill.opts.contiguous = false; app.tools.fill.down(ev(10, 10), app);
  assert(near(px(80, 10), [0, 200, 0, 255]), 'global fills both');
  app.tools.fill.opts.contiguous = true; app.tools.fill.opts.aa = true;
});

/* ---------- selections ---------- */
test('selection: rect, ellipse add, subtract, intersect, inverse', () => {
  const d = fresh(200, 200); const s = d.selection;
  drag('marquee', [[10, 10], [110, 110]]); assert(R.eq(s.bounds(), { x: 10, y: 10, w: 100, h: 100 }), 'rect ' + JSON.stringify(s.bounds()));
  drag('ellipse', [[100, 100], [190, 190]], { shift: true }); assert(s.bounds().w > 170, 'add grows');
  drag('marquee', [[0, 0], [60, 200]], { alt: true }); assert(s.bounds().x >= 60, 'subtract trims ' + JSON.stringify(s.bounds()));
  drag('marquee', [[0, 0], [150, 150]], { shift: true, alt: true }); assert(s.bounds().y + s.bounds().h <= 150, 'intersect');
  app.run('select.inverse'); assert(s.at(5, 5) > 0.9 && s.at(100, 100) < 0.1, 'inverse');
  app.run('select.none'); assert(!s.active, 'deselect');
  app.run('select.reselect'); assert(s.active, 'reselect');
});
test('selection: lasso polygon, feather, expand, contract', () => {
  const d = fresh(200, 200); const s = d.selection;
  app.tools.lasso.opts.kind = 'poly'; app.setTool('lasso');
  for (const [x, y] of [[20, 20], [180, 20], [180, 180]]) app.tools.lasso.down(ev(x, y), app);
  app.tools.lasso.key({ key: 'Enter' }, app);
  assert(s.active && s.at(170, 100) > 0.9 && s.at(30, 150) < 0.1, 'triangle');
  app.tools.lasso.opts.kind = 'free';
  s.edit('rect', () => s.rect({ x: 50, y: 50, w: 100, h: 100 }, 'new'));
  s.edit('exp', () => s.expand(10)); assert(R.eq(s.bounds(), { x: 40, y: 40, w: 120, h: 120 }), 'expand ' + JSON.stringify(s.bounds()));
  s.edit('con', () => s.contract(20)); assert(s.bounds().x >= 59 && s.bounds().x <= 61, 'contract ' + JSON.stringify(s.bounds()));
  s.edit('f', () => s.feather(5)); assert(s.at(60, 100) > 0.2 && s.at(60, 100) < 0.8, 'feathered edge ' + s.at(60, 100));
});

/* ---------- gradients ---------- */
test('gradient to transparent has no grey fringe', () => {
  const d = fresh(256, 10, 'transparent');
  app.setFg({ r: 255, g: 0, b: 0 });
  app.tools.gradient.opts = { ...app.tools.gradient.defaults, creates: 'pixels', dither: false, grad: { ...defaultGradient({ r: 255, g: 0, b: 0 }, { r: 255, g: 0, b: 0 }), alphas: [{ pos: 0, a: 1, mid: 0.5 }, { pos: 1, a: 0, mid: 0.5 }], dither: false } };
  drag('gradient', [[0, 5], [256, 5]]);
  const l = d.active, c = ctx(l.canvas).getImageData(128 - l.x, 5 - l.y, 1, 1).data;
  assert(c[0] > 250 && c[1] < 5 && c[2] < 5, 'mid colour stays red: ' + [...c]);
  assert(Math.abs(c[3] - 128) < 6, 'alpha ~50%: ' + c[3]);
  app.tools.gradient.opts.grad = null; app.tools.gradient.opts.dither = true;
});
test('gradient fill layer + gradient overlay style', () => {
  const d = fresh(100, 100);
  const g = new FillLayer('g', 'gradient', { gradient: { ...defaultGradient({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), angle: 0, dither: false } }); d.addLayer(g);
  assert(px(2, 50)[0] < 10 && px(97, 50)[0] > 245, 'horizontal black→white ' + px(2, 50) + ' ' + px(97, 50));
  const l = solidLayer(d, '#f00', { x: 20, y: 20, w: 60, h: 60 });
  l.style = { gradOverlay: { ...defaultGradient({ r: 0, g: 0, b: 255 }, { r: 0, g: 255, b: 0 }), angle: 90, blend: 'normal', opacity: 1, align: true, dither: false } }; l.touch();
  const top = px(50, 21), bot = px(50, 78);
  assert(top[1] > 150 && top[2] < 100 && bot[2] > 150 && bot[1] < 100, 'overlay goes blue (bottom) → green (top): ' + top + ' / ' + bot);
  assert(px(10, 10)[0] < 40, 'overlay stays inside the layer');
});

/* ---------- layers ---------- */
test('groups: pass-through, isolated, opacity; clipping; masks', () => {
  const d = fresh(100, 100);
  const a = solidLayer(d, '#ff0000', { x: 0, y: 0, w: 60, h: 100 }, 'a');
  const b = solidLayer(d, '#0000ff', { x: 40, y: 0, w: 60, h: 100 }, 'b'); b.blend = 'multiply'; b.touch();
  const multiplied = px(50, 50);
  assert(near(multiplied, [0, 0, 0, 255]), 'red × blue = black');
  app.doc.selected = new Set([a.id, b.id]); app.run('layer.group');
  const g = d.active; assert(g.isGroup, 'grouped');
  assert(near(px(50, 50), multiplied), 'pass-through keeps the result');
  g.opacity = 0.5; g.touch(); const half = px(50, 50); assert(half[0] > 100 && half[0] < 160, 'group opacity mixes with white ' + half);
  g.opacity = 1; g.blend = 'normal'; g.touch(); assert(near(px(50, 50), multiplied), 'isolated normal group same here');
  app.run('layer.ungroup');
  // clipping: c clips to a
  d.setActive(a); const c = solidLayer(d, '#00ff00', null, 'c'); c.clip = true; c.touch();
  assert(near(px(10, 50), [0, 255, 0, 255]), 'clipped shows inside a'); assert(px(90, 50)[1] === 0, 'not outside a');
  // mask: hide the left half of b
  b.mask = makeMask(d, b, 'reveal'); const mx = ctx(b.mask.canvas); mx.fillStyle = '#000'; mx.fillRect(0, 0, 70, 100); b.mask.rev++; b.touch();
  assert(near(px(50, 50), [0, 255, 0, 255]), 'masked part of b hidden: ' + px(50, 50));
  assert(near(px(80, 50), [0, 0, 255, 255]), 'unmasked part of b shows: ' + px(80, 50));
});
test('merge down and flatten keep the look', () => {
  const d = fresh(100, 100);
  // (merging a non-normal layer onto transparent pixels can't keep its look, in Photoshop too: keep b over a)
  solidLayer(d, '#ff8000', { x: 10, y: 10, w: 80, h: 80 }, 'a');
  const b = solidLayer(d, '#0080ff', { x: 30, y: 30, w: 50, h: 50 }, 'b'); b.blend = 'screen'; b.opacity = 0.7; b.touch();
  const before = comp(d).slice();
  app.run('layer.mergeDown'); assert(eqAll(comp(d), before, 2), 'merge down');
  app.run('layer.flatten'); assert(eqAll(comp(d), before, 2), 'flatten'); assert(d.all().length === 1, 'one layer');
});
test('duplicate, delete, arrange, undo', () => {
  const d = fresh(50, 50); solidLayer(d, '#f00', null, 'a');
  app.run('layer.duplicate'); assert(d.all().length === 3, 'dup');
  app.run('layer.arrange.back'); assert(d.root.children[0].isBackground, 'background stays at the bottom');
  app.run('layer.delete'); assert(d.all().length === 2, 'delete');
  app.run('edit.undo'); assert(d.all().length === 3, 'undo delete');
});

/* ---------- adjustments ---------- */
test('adjustment layers: invert, threshold, levels identity, curves, hue', () => {
  const d = fresh(10, 10); solidLayer(d, 'rgb(200,100,50)');
  const A = new AdjustLayer('a', 'invert', defaultParams('invert')); d.addLayer(A);
  assert(near(px(5, 5), [55, 155, 205, 255], 1), 'invert ' + px(5, 5));
  A.adj = 'levels'; A.params = defaultParams('levels'); A.touch(); assert(near(px(5, 5), [200, 100, 50, 255], 1), 'levels default = identity');
  A.adj = 'threshold'; A.params = { level: 128 }; A.touch(); assert(near(px(5, 5), [0, 0, 0, 255]) || near(px(5, 5), [255, 255, 255, 255]), 'threshold b/w');
  A.adj = 'curves'; A.params = defaultParams('curves'); A.params.curves.rgb = [[0, 255], [255, 0]]; A.touch(); assert(near(px(5, 5), [55, 155, 205, 255], 2), 'curve inverted = invert ' + px(5, 5));
  A.adj = 'hs'; A.params = { ...defaultParams('hs'), hue: 180 }; A.touch(); const v = px(5, 5); assert(v[2] > v[0], 'hue 180 turns orange blue ' + v);
  A.adj = 'bw'; A.params = defaultParams('bw'); A.touch(); const g = px(5, 5); assert(g[0] === g[1] && g[1] === g[2], 'b&w gray');
  A.adj = 'dehaze'; A.params = { amount: 50 }; A.touch(); px(5, 5);
});
test('curve LUT is monotone and hits its points', () => {
  const l = curveLut([[0, 0], [64, 40], [192, 220], [255, 255]]);
  assert(Math.abs(l[64] - 40) < 0.5 && Math.abs(l[192] - 220) < 0.5, 'passes through');
  for (let i = 1; i < 256; i++) assert(l[i] >= l[i - 1] - 1e-6, 'monotone at ' + i);
});

/* ---------- text ---------- */
test('text: points → pixels at the document ppi, editable after save', async () => {
  const d = fresh(600, 300); d.ppi = 300;
  const t = new TextLayer('t', { text: 'Hg', size: 24, x: 20, y: 200, color: { r: 0, g: 0, b: 0 } }); d.addLayer(t);
  app.view.prepare(d);
  const px100 = 24 * 300 / 72;   // 100 px
  assert(Math.abs(t.raster.layout.px - px100) < 0.01, 'pt→px');
  assert(t.raster.bounds.h > 60, 'glyph height ~ size ' + t.raster.bounds.h);
  const bytes = await saveStlv(d); const d2 = await loadStlv(bytes);
  const t2 = d2.all().find(l => l.type === 'text'); assert(t2 && t2.text === 'Hg' && t2.size === 24, 'still text after reopening');
});
test('new text is its own top-level layer, even with a layer inside a group active', () => {
  const d = fresh(400, 200);
  const g = new GroupLayer('NAME'); g.open = false; d.addLayer(g);
  const inner = new TextLayer('NAME', { text: 'NAME', size: 30, x: 20, y: 60, color: { r: 0, g: 0, b: 0 } }); d.insert(inner, g); d.setActive(inner);
  const after = new GroupLayer('ABOVE'); d.insert(after, d.root);
  const tool = app.tools.text;
  tool.down({ x: 200, y: 160 }, app); tool.up({ x: 200, y: 160 }, app);
  const l = tool.editing; assert(l && l.type === 'text', 'editing a new text layer');
  assert(l.parent === d.root, 'not inside the group');
  assert(d.root.children.indexOf(l) === d.root.children.indexOf(g) + 1, 'right above the active layer\'s group');
  assert(g.children.length === 1, 'group untouched');
  tool.ta.value = 'NEW'; tool.ta.dispatchEvent(new Event('input')); tool.commit(app);
  assert(d.root.children.includes(l) && l.text === 'NEW', 'committed');
  app.run('edit.undo'); assert(!d.all().includes(l), 'undo removes it');
  app.run('edit.redo'); assert(l.parent === d.root, 'redo puts it back at the top level');
});
test('move: grabs text beside its letters, in a collapsed group, over a locked background', () => {
  const d = fresh(400, 200);   // white Background, position-locked
  const g = new GroupLayer('NAME'); g.open = false; d.addLayer(g);
  const glow = new PixelLayer('Glow', 120, 50, 90, 60); ctx(glow.canvas).fillRect(10, 10, 100, 30); d.insert(glow, g);
  const t = new TextLayer('NAME', { text: 'N  E', size: 30, x: 100, y: 90, color: { r: 0, g: 0, b: 0 } }); d.insert(t, g);
  app.view.prepare(d); app.view.zoomAt(1, 0, 0); d.setActive(d.root.children[0]);
  const mv = app.tools.move, far = { sx: -1e4, sy: -1e4 };
  mv.opts.autoSelect = false;
  const q = R.fromPts(textQuad(t, d));
  const z = app.view.z, gx = q.x + q.w / 2, gy = q.y + q.h / 2;   // the gap between the letters
  assert(mv.grabsAt(ev(gx, gy, far), app), 'a guide here would stay put');
  drag('move', [[gx, gy], [gx + 20, gy + 10]], far);
  assert(d.active === g, 'picked the closed group, not the background');
  assert(Math.round(t.x) === 120 && t.y === 100 && glow.x === 110 && glow.y === 70, 'text and glow moved together');
  const ex = q.x + 20 + q.w + 4 / z;   // 4 screen px right of the box: still grabs it
  drag('move', [[ex, gy + 10], [ex - 10, gy + 10]], far);
  assert(Math.round(t.x) === 110, 'near miss still grabs it');
  drag('move', [[ex - 10, gy + 10], [ex - 10 + 2 / z, gy + 10]], far);
  assert(Math.round(t.x) === 110, 'a 2 px wobble is a click, not a move');
  d.setActive(d.root.children[0]); drag('move', [[5, 5], [30, 30]], far);
  assert(d.root.children[0].x === 0 && Math.round(t.x) === 110, 'empty spot: the locked background stays, nothing moves');
});
test('several selected layers: one box scales them as a block, and a new text size keeps their layout', () => {
  const d = fresh(800, 400, 'black');
  const a = new TextLayer('A', { text: '2BAK', size: 40, x: 40, y: 150 }), b = new TextLayer('B', { text: 'BYEPASS', size: 40, x: 390, y: 200 }); d.addLayer(a); d.addLayer(b);
  const p = new PixelLayer('P', 50, 20, 300, 50); ctx(p.canvas).fillRect(0, 0, 50, 20); d.addLayer(p);
  app.view.prepare(d); app.view.zoomAt(1, 0, 0);
  d.setActive(a); d.setActive(b, true);
  app.panels.props.groupSize([a, b], b, 60, true);
  app.setTool('move');
  assert(a.size === 60 && b.size === 60, 'both 1.5×');
  assert(a.x === 40 && Math.abs((b.x - a.x) - 525) < 1e-6 && Math.abs((b.y - a.y) - 75) < 1e-6, 'gaps grow with them');
  app.run('edit.undo'); assert(a.size === 40 && b.x === 390 && b.y === 200, 'one undo');
  d.setActive(p, true);
  const mv = app.tools.move, B = mv.boxFor(app); assert(B.multi && B.layers.length === 3, 'one box around all three');
  const bb = B.box, z = app.view.z, at = (x, y) => { const s = app.view.toScreen(x, y); return ev(x, y, { sx: s.x, sy: s.y }); };
  mv.down(at(bb.x + bb.w, bb.y + bb.h), app); mv.move(at(bb.x + bb.w * 2, bb.y + bb.h * 2), app); mv.up(at(bb.x + bb.w * 2, bb.y + bb.h * 2), app);
  assert(p.canvas.width === 100 && p.x === bb.x + (300 - bb.x) * 2 && a.size === 80 && a.type === 'text', 'pixels resample, text stays text');
  app.run('edit.undo'); assert(p.canvas.width === 50 && p.x === 300 && a.size === 40, 'undo restores all');
});
test('move: a plain click on empty canvas beside the selection deselects it', () => {
  const d = fresh(400, 200);
  const t = new TextLayer('NAME', { text: 'NAME', size: 30, x: 100, y: 90, color: { r: 0, g: 0, b: 0 } }); d.addLayer(t);
  app.view.prepare(d); app.view.zoomAt(1, 0, 0); d.setActive(t);
  app.tools.move.opts.autoSelect = false;
  const far = { sx: -1e4, sy: -1e4 }, q = R.fromPts(textQuad(t, d));
  drag('move', [[q.x + q.w / 2, q.y + q.h / 2]], far);
  assert(d.active === t, 'a click on the text keeps it selected');
  drag('move', [[q.x + q.w + 60, q.y + q.h / 2]], far);
  assert(d.active === null && d.selectedLayers().length === 0, 'a click beside it lets go');
  d.setActive(t); drag('move', [[q.x + q.w + 60, q.y + 5], [q.x + q.w + 90, q.y + 5]], far);
  assert(d.active === t, 'a drag from empty canvas still moves the selected layer');
});
test('text warp keeps it text, rasterize turns it into pixels', () => {
  const d = fresh(400, 200);
  const t = new TextLayer('t', { text: 'WARP', size: 60, x: 50, y: 120, color: { r: 0, g: 0, b: 0 }, warp: { style: 'arc', bend: 0.5, hd: 0, vd: 0 } }); d.addLayer(t);
  const c = comp(d); let dark = 0; for (let i = 0; i < c.length; i += 4) if (c[i] < 128) dark++;
  assert(dark > 500, 'warped text renders');
  app.run('layer.rasterize'); assert(d.active.type === 'pixel', 'rasterized');
});

/* ---------- transforms ---------- */
test('flip twice and rotate 4 × 90° are exact', () => {
  const d = fresh(60, 40); const l = solidLayer(d, '#000', { x: 5, y: 5, w: 20, h: 10 });
  const c0 = comp(d).slice();
  app.run('image.flipH'); app.run('image.flipH'); assert(eqAll(comp(d), c0), 'flip');
  for (let i = 0; i < 4; i++) app.run('image.rotcw');
  assert(d.width === 60 && eqAll(comp(d), c0), 'rotate');
  app.run('edit.flipH'); app.run('edit.flipH'); assert(eqAll(comp(d), c0), 'layer flip');
  void l;
});
test('free transform: scale 2× around the corner, then warp commit', async () => {
  const d = fresh(300, 300); const l = solidLayer(d, '#00f', { x: 10, y: 10, w: 50, h: 50 });
  app.tools.transform.start(app, 'free');
  const s = app.tools.transform.s;
  const { M3 } = await import('../js/util.js');
  s.A = M3.mul(M3.translate(10, 10), M3.mul(M3.scale(2, 2), M3.translate(-10, -10))); s.rev++;
  await app.tools.transform.end(app, true);
  const b = l.bounds(); assert(Math.abs(b.w - 100) <= 2 && Math.abs(b.h - 100) <= 2, 'scaled ' + JSON.stringify(b));
  app.tools.transform.start(app, 'warp'); app.tools.transform.s.warp = { style: 'bulge', bend: 0.5, hd: 0, vd: 0 }; app.tools.transform.s.rev++;
  await app.tools.transform.end(app, true);
  assert(l.bounds().h > 105, 'bulge grew the height ' + JSON.stringify(l.bounds()));
});
test('image size halves, canvas size, crop', () => {
  const d = fresh(200, 100); solidLayer(d, '#f00', { x: 100, y: 0, w: 100, h: 100 });
  app.run('image.resizeTo', 100, 50, 72); assert(d.width === 100 && d.height === 50, 'size');
  assert(near(px(75, 25), [255, 0, 0, 255], 3) && px(25, 25)[1] > 250, 'content scaled ' + px(75, 25));
  d.resizeCanvas(120, 60, 10, 5); assert(d.width === 120 && near(px(85, 30), [255, 0, 0, 255], 3), 'canvas grew and shifted');
  app.run('edit.undo'); assert(d.width === 100, 'undo canvas size');
});

/* ---------- filters ---------- */
test('every filter runs and changes the pixels', () => {
  const src = canvas(80, 60), x = ctx(src); const g = x.createLinearGradient(0, 0, 80, 60); g.addColorStop(0, '#f00'); g.addColorStop(1, '#00f'); x.fillStyle = g; x.fillRect(0, 0, 80, 60); x.fillStyle = '#fff'; x.fillRect(30, 20, 20, 20);
  const d0 = getData(src).data; const bad = [];
  for (const k of Object.keys(FILTERS)) {
    try {
      const p = defaultFilterParams(k, app, { width: 80, height: 60 });
      if (k === 'mosaic' || k === 'crystal') p.cell = 8; if (k === 'halftone') p.rad = 4; if (k === 'ascii') p.cells = 20; if (k === 'cloud') p.dens = 20;
      const r = runFilter(k, p, src, 0, 0); const d1 = getData(r.canvas).data;
      let diff = 0; for (let i = 0; i < Math.min(d0.length, d1.length); i++) diff += Math.abs(d0[i] - d1[i]);
      if (diff === 0 && r.canvas.width === 80) bad.push(k + ' unchanged');
    } catch (e) { bad.push(k + ': ' + e.message); }
  }
  assert(!bad.length, bad.join('; '));
});
test('live filter = baked filter', () => {
  const d = fresh(80, 60, 'transparent'); const l = d.active; const x = ctx(l.canvas); x.fillStyle = '#000'; x.fillRect(20, 20, 40, 20); l.touch();
  const p = { radius: 4 };
  const live = liveSource({ ...l, filters: [{ type: 'gauss', params: p }] }, { canvas: l.canvas, x: 0, y: 0, rev: 1 }, false);
  const baked = bakeFilter('gauss', p, l, null);
  assert(live.canvas.width === baked.canvas.width, 'same size');
  assert(eqAll(getData(live.canvas).data, getData(baked.canvas).data, 0), 'same pixels');
});

/* ---------- content-aware ---------- */
test('content-aware shrink keeps a protected block intact', () => {
  const w = 60, h = 30, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([20, 30, 40, 255], i * 4);
  const protect = new Uint8Array(w * h);
  for (let y = 10; y < 20; y++) for (let x = 25; x < 35; x++) { data.set([255, 255, 0, 255], (y * w + x) * 4); protect[y * w + x] = 255; }
  const r = carve({ data, width: w, height: h }, 40, 30, protect);
  assert(r.width === 40 && r.height === 30, 'size');
  let yellow = 0; for (let i = 0; i < r.width * r.height; i++) if (r.data[i * 4] === 255 && r.data[i * 4 + 1] === 255) yellow++;
  assert(yellow === 100, 'protected pixels kept: ' + yellow);
  const g = carve({ data, width: w, height: h }, 90, 45, protect); assert(g.width === 90 && g.height === 45, 'grow');
});

/* ---------- files ---------- */
test('.stlv save → open is lossless', async () => {
  const d = fresh(120, 80);
  const a = solidLayer(d, 'rgba(255,0,0,0.6)', { x: 10, y: 10, w: 50, h: 30 }, 'a'); a.blend = 'multiply'; a.opacity = 0.8;
  a.mask = makeMask(d, a, 'reveal'); a.filters = [{ type: 'gauss', params: { radius: 2 }, visible: true }];
  d.addLayer(new AdjustLayer('lv', 'levels', { ...defaultParams('levels'), gamma: 1.4 }));
  d.guides.push({ axis: 'v', pos: 33 });
  d.selection.rect({ x: 5, y: 5, w: 20, h: 20 }, 'new');
  const c0 = comp(d).slice();
  const bytes = await saveStlv(d); const d2 = await loadStlv(bytes);
  app.addDoc(d2);
  assert(eqAll(comp(d2), c0, 1), 'same composite');
  const a2 = d2.all().find(l => l.name === 'a');
  assert(a2.blend === 'multiply' && Math.abs(a2.opacity - 0.8) < 1e-9 && a2.mask && a2.filters.length === 1, 'props');
  assert(d2.guides[0].pos === 33 && d2.selection.active, 'guides + selection');
  assert(eqAll(getData(a2.canvas).data, getData(a.canvas).data), 'pixels identical');
});
test('PSD write → read keeps layers, modes, opacity, groups, pixels', async () => {
  const d = fresh(64, 48);
  const a = solidLayer(d, '#3366ff', { x: 4, y: 4, w: 30, h: 20 }, 'Blue ünïcode'); a.blend = 'screen'; a.opacity = 0.5;
  const g = new GroupLayer('G'); d.addLayer(g); const b = new PixelLayer('inner', 64, 48); ctx(b.canvas).fillStyle = '#f00'; ctx(b.canvas).fillRect(30, 20, 10, 10); d.insert(b, g);
  b.clip = false;
  const merged = app.view.comp.readComposite(d);
  const bytes = writePSD(d, l => ({ canvas: l.canvas, x: l.x, y: l.y }), merged);
  const d2 = await readPSD(bytes);
  const names = d2.all().map(l => l.name);
  assert(names.includes('Blue ünïcode') && names.includes('G') && names.includes('inner'), 'names ' + names);
  const a2 = d2.all().find(l => l.name === 'Blue ünïcode');
  assert(a2.blend === 'screen' && Math.abs(a2.opacity - 0.5) < 0.01, 'mode/opacity');
  assert(d2.all().find(l => l.name === 'inner').parent.name === 'G', 'group');
  app.addDoc(d2);
  assert(eqAll(comp(d2), merged.data, 2), 'same composite');
});
test('WebP lossless encodes bit-exact', async () => {
  const c = canvas(97, 61), x = ctx(c); const g = x.createRadialGradient(40, 30, 2, 40, 30, 60); g.addColorStop(0, 'rgba(255,200,0,1)'); g.addColorStop(1, 'rgba(0,60,255,0.3)'); x.fillStyle = g; x.fillRect(0, 0, 97, 61); x.fillStyle = '#fff'; x.fillRect(5, 5, 30, 8);
  const id = getData(c), bytes = encodeWebPLossless(id);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c2 = canvas(bmp.width, bmp.height); ctx(c2).drawImage(bmp, 0, 0);
  const id2 = getData(c2);
  // canvas round trips premultiply, so compare where alpha is high
  let bad = 0; for (let i = 0; i < id.data.length; i += 4) { if (id.data[i + 3] < 200) continue; for (let k = 0; k < 4; k++) if (Math.abs(id.data[i + k] - id2.data[i + k]) > 1) bad++; }
  assert(bmp.width === 97 && bmp.height === 61 && bad === 0, `decoded ${bmp.width}x${bmp.height}, ${bad} differences, ${bytes.length} bytes`);
});
test('PNG / JPEG carry the ppi; PDF and zip are well formed', async () => {
  const c = canvas(20, 10); ctx(c).fillRect(0, 0, 5, 5);
  const png = pngMeta(new Uint8Array(await (await new Promise(r => c.toBlob(r))).arrayBuffer()), 300);
  assert(Math.abs(pngPPI(png) - 300) < 0.1, 'png ppi ' + pngPPI(png));
  const jpg = jpegMeta(new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer()), 240);
  assert(jpegPPI(jpg) === 240, 'jpeg ppi');
  const pdf = await writePDF(getData(c), { ppi: 72 });
  const s = new TextDecoder('latin1').decode(pdf);
  assert(s.startsWith('%PDF-1.4') && s.includes('/MediaBox [0 0 20.000 10.000]') && s.trim().endsWith('%%EOF'), 'pdf');
  const z = await zip([{ name: 'a.txt', data: new TextEncoder().encode('hello hello hello'), compress: true }, { name: 'b', data: new Uint8Array([1, 2, 3]) }]);
  const u = await unzip(z); assert(new TextDecoder().decode(u['a.txt']) === 'hello hello hello' && u.b[2] === 3, 'zip');
  assert(crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'crc32');
});
test('export encodes every format', async () => {
  const d = fresh(40, 30); solidLayer(d, '#0a0', { x: 5, y: 5, w: 10, h: 10 });
  const c = canvas(40, 30); ctx(c).putImageData(app.view.comp.readComposite(d), 0, 0);
  for (const fmt of ['png', 'jpg', 'webp', 'pdf']) { const b = await encode(app, c, { fmt, transparent: true, srgb: true, quality: 80, matte: { r: 255, g: 255, b: 255 }, scale: 1, pdfImage: 'jpeg', bleed: 3, marks: true }); assert(b.length > 50, fmt); }
});

/* ---------- undo fuzz ---------- */
test('undo fuzz: 60 random edits, undo all = start, redo all = end', () => {
  const d = fresh(120, 90); let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const start = comp(d).slice();
  const ops = [
    () => app.run('layer.new'),
    () => { app.setFg({ r: rnd() * 255 | 0, g: rnd() * 255 | 0, b: rnd() * 255 | 0 }); if (d.active && d.active.type === 'pixel') drag('brush', [[rnd() * 120, rnd() * 90], [rnd() * 120, rnd() * 90]]); },
    () => drag('marquee', [[rnd() * 60, rnd() * 45], [60 + rnd() * 60, 45 + rnd() * 45]]),
    () => { if (d.selection.active && d.active && d.active.type === 'pixel' && !d.active.lock.px) { app.setTool('fill'); app.tools.fill.down(ev(rnd() * 120, rnd() * 90), app); } },
    () => app.run('select.none'),
    () => { if (d.active && !d.active.isBackground) d.setProps(d.active, { opacity: rnd(), blend: ['normal', 'multiply', 'screen', 'overlay', 'difference'][rnd() * 5 | 0] }); },
    () => { if (d.active && !d.active.isBackground) app.run('layer.nudge', (rnd() * 10 | 0) - 5, (rnd() * 10 | 0) - 5); },
    () => app.run('layer.new.adj.' + ['invert', 'hs', 'levels'][rnd() * 3 | 0]),
    () => { if (d.all().length > 2) app.run('layer.delete'); },
    () => app.run('layer.duplicate'),
    () => app.run('image.flipH'),
  ];
  for (let i = 0; i < 60; i++) ops[rnd() * ops.length | 0]();
  const end = comp(d).slice(), n = d.history.index;
  for (let i = 0; i < n; i++) d.history.undo();
  assert(eqAll(comp(d), start, 0), 'undo all differs from the start');
  for (let i = 0; i < n; i++) d.history.redo();
  assert(eqAll(comp(d), end, 0), 'redo all differs from the end');
});

test('undo fuzz, wide: 3 seeds × 120 edits across groups, masks, text, crop, rotate, resize, filters, merges', () => {
  for (const seed0 of [7, 99, 4242]) {
    const d = fresh(100, 80); let seed = seed0; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pix = () => d.active && d.active.type === 'pixel' && !d.active.lock.px && !d.active.lock.all;
    const start = comp(d).slice();
    const ops = [
      () => app.run('layer.new'),
      () => { app.setFg({ r: rnd() * 255 | 0, g: rnd() * 255 | 0, b: rnd() * 255 | 0 }); if (pix()) drag('brush', [[rnd() * 100, rnd() * 80], [rnd() * 100, rnd() * 80]]); },
      () => drag(rnd() < 0.5 ? 'marquee' : 'ellipse', [[rnd() * 50, rnd() * 40], [50 + rnd() * 50, 40 + rnd() * 40]]),
      () => { if (d.selection.active && pix()) { app.setTool('fill'); app.tools.fill.down(ev(rnd() * 100, rnd() * 80), app); } },
      () => app.run('select.none'),
      () => { if (d.active && !d.active.isBackground) d.setProps(d.active, { opacity: rnd(), blend: ['normal', 'multiply', 'screen', 'overlay', 'difference', 'hue'][rnd() * 6 | 0] }); },
      () => { if (d.active && !d.active.isBackground && !d.active.lock.pos) app.run('layer.nudge', (rnd() * 10 | 0) - 5, (rnd() * 10 | 0) - 5); },
      () => app.run('layer.new.adj.' + ['invert', 'hs', 'levels', 'curves', 'bw'][rnd() * 5 | 0]),
      () => { if (d.all().length > 2) app.run('layer.delete'); },
      () => app.run('layer.duplicate'),
      () => app.run(['image.flipH', 'image.rotcw', 'image.rot180'][rnd() * 3 | 0]),
      () => { if (d.active && !d.active.isBackground) app.run('layer.group'); },
      () => { if (d.active && d.active.isGroup) app.run('layer.ungroup'); },
      () => { if (d.active && !d.active.mask && !d.active.isBackground) app.run(['layer.mask.reveal', 'layer.mask.hide'][rnd() * 2 | 0]); },
      () => { if (d.active && d.active.mask) app.run(['layer.mask.invert', 'layer.mask.toggle', 'layer.mask.delete'][rnd() * 3 | 0]); },
      () => { if (d.active && !d.active.isBackground) app.run('layer.clip.toggle'); },
      () => { const t = new TextLayer('t', { text: 'Ab', size: 20 + rnd() * 20, x: rnd() * 80, y: 20 + rnd() * 60, color: { r: 0, g: 0, b: 0 } }); d.addLayer(t); },
      () => { if (d.width > 40 && d.height > 30) { const { cropDoc } = window.__crop; cropDoc(app, { x: 2, y: 1, w: d.width - 5, h: d.height - 3 }, rnd() < 0.5); } },
      () => app.run('image.resizeTo', Math.max(20, Math.round(d.width * 0.95)), Math.max(16, Math.round(d.height * 0.95)), d.ppi),
      () => { if (d.active && (d.active.type === 'pixel' || d.active.type === 'text') && !d.active.isBackground) d.setProps(d.active, { filters: [...d.active.filters, { type: 'gauss', params: { radius: 1 + rnd() * 3 }, visible: true }] }, 'Gaussian Blur'); },
      () => { if (d.active && d.active.parent.children.indexOf(d.active) > 0 && d.active.type !== 'adjust') app.run('layer.mergeDown'); },
      () => { if (pix()) { app.tools.gradient.opts.creates = 'pixels'; drag('gradient', [[rnd() * 100, 0], [rnd() * 100, 80]]); } },
      () => { const all = d.all(); if (all.length) d.setActive(all[rnd() * all.length | 0]); },
      () => { if (d.selection.active) app.doc.selection.edit('f', () => d.selection.feather(2)); },
    ];
    for (let i = 0; i < 120; i++) ops[rnd() * ops.length | 0]();
    const end = comp(d).slice(), n = d.history.index, W = d.width, H = d.height;
    for (let i = 0; i < n; i++) d.history.undo();
    assert(d.width === 100 && d.height === 80 && eqAll(comp(d), start, 0), `seed ${seed0}: undo all differs from the start`);
    for (let i = 0; i < n; i++) d.history.redo();
    assert(d.width === W && d.height === H && eqAll(comp(d), end, 1), `seed ${seed0}: redo all differs from the end`);
  }
});

test('SB FX: every look runs, keeps the layer alpha, and the colour matters', () => {
  const src = canvas(64, 48), c = ctx(src);
  const g = c.createLinearGradient(0, 0, 64, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); c.fillStyle = g; c.fillRect(0, 0, 64, 40);   // 8 clear rows at the bottom
  const sb = Object.keys(FILTERS).filter(k => FILTERS[k].sb);
  assert(sb.length === 19, `19 SB looks, got ${sb.length}`);
  for (const k of sb) {
    const p = { ...defaultFilterParams(k, null, { width: 640, height: 480 }) }, r = runFilter(k, p, src, 0, 0);
    assert(r.canvas.width === 64 && r.canvas.height === 48, `${k}: size kept`);
    const d = getData(r.canvas).data;
    assert(d[(10 * 64 + 30) * 4 + 3] === 255 && d[(45 * 64 + 30) * 4 + 3] === 0, `${k}: alpha kept`);
  }
  const red = getData(runFilter('sb_sil', { ...defaultFilterParams('sb_sil', null, null), col: 'blood' }, src, 0, 0).canvas).data;
  const blue = getData(runFilter('sb_sil', { ...defaultFilterParams('sb_sil', null, null), col: 'cobalt' }, src, 0, 0).canvas).data;
  const i = (20 * 64 + 60) * 4;
  assert(red[i] > red[i + 2] && blue[i + 2] > blue[i], 'silhouette takes the colour');
  const px = new Uint8ClampedArray(16 * 16 * 4).map((_, j) => j % 4 === 3 ? 255 : (j * 37) % 256), out = jpegCrunch(px, 16, 16, 0.9);
  let err = 0; for (let j = 0; j < px.length; j += 4) err += Math.abs(px[j] - out[j]);
  assert(err / 256 < 60 && out[3] === 255, `jpeg round trip stays close (${(err / 256).toFixed(1)})`);
});

test('Lines: contour, waves and strips draw ink on paper and keep the layer alpha', () => {
  const src = canvas(80, 60), c = ctx(src), g = c.createRadialGradient(40, 28, 2, 40, 28, 30);
  g.addColorStop(0, '#fff'); g.addColorStop(1, '#000'); c.fillStyle = g; c.fillRect(0, 0, 80, 52);   // 8 clear rows at the bottom
  for (const k of ['contour', 'waves', 'strips']) {
    const p = { ...defaultFilterParams(k, null, { width: 80, height: 60 }), smooth: 1, thick: k === 'contour' ? 2 : 60, spacing: 6 }, d = getData(runFilter(k, p, src, 0, 0).canvas).data;
    let ink = 0, paper = 0;
    for (let i = 0; i < 80 * 52 * 4; i += 4) { if (d[i] < 60) ink++; else if (d[i] > 220) paper++; }
    assert(ink > 80 && paper > 80, `${k}: draws lines (${ink} ink, ${paper} paper px)`);
    assert(d[(55 * 80 + 40) * 4 + 3] === 0 && d[(20 * 80 + 40) * 4 + 3] === 255, `${k}: alpha kept`);
    const t = getData(runFilter(k, { ...p, paper: 1 }, src, 0, 0).canvas).data;
    let clear = 0; for (let i = 3; i < 80 * 52 * 4; i += 4) if (t[i] === 0) clear++;
    assert(clear > 80, `${k}: transparent paper leaves gaps`);
  }
});

test('SB FX layer: runs the look on everything below, mixes by opacity, saves', async () => {
  const d = fresh(64, 48), bg = d.displayList().map(e => e.layer).find(l => l.type === 'pixel'), c = ctx(bg.canvas), g = c.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); c.fillStyle = g; c.fillRect(0, 0, 64, 48); bg.touch();
  const before = comp(d).slice();
  const A = new AdjustLayer('SB Silhouette 1', 'sbfx', { ...sbLayerParams('sil'), col: 'cobalt' }); d.addLayer(A);
  const want = getData(sbRun('sil', bg.canvas, { ...A.params, ref: 64 })).data, got = comp(d);
  let diff = 0; for (let i = 0; i < got.length; i++) diff = Math.max(diff, Math.abs(got[i] - want[i]));
  assert(diff <= 2, `composite = the look on the backdrop (max diff ${diff})`);
  A.opacity = 0.5; d.changed('all'); const half = comp(d), i = (20 * 64 + 50) * 4;
  assert(Math.abs(half[i + 2] - (before[i + 2] + want[i + 2]) / 2) <= 3, 'opacity mixes');
  A.visible = false; d.changed('all'); assert(eqAll(comp(d), before, 0), 'hidden: no effect');
  A.visible = true; A.opacity = 1;
  const d2 = await loadStlv(await saveStlv(d)), A2 = d2.all().find(l => l.adj === 'sbfx');
  assert(A2 && A2.params.mode === 'sil' && A2.params.col === 'cobalt', 'saved and loaded');
});

test('text box: a box behind each line, inverted cuts the text out, groups box every text inside', async () => {
  const { defaultTextBox, textBoxPolys } = await import('../js/text.js');
  const d = fresh(400, 300, 'white');
  const T = new TextLayer('A', { text: 'IIII\nII', font: 'Helvetica', fontStyle: 'Bold', size: 60, x: 40, y: 100, align: 'left', color: { r: 0, g: 0, b: 0 } }); d.addLayer(T);
  T.style = { textBox: { ...defaultTextBox(), color: { r: 255, g: 0, b: 0 }, padX: 20, padY: 20 } }; T.touch(); d.changed('all');
  const polys = textBoxPolys(T, d, T.style.textBox);
  assert(polys.length === 2 && polys[0][1][0] - polys[0][0][0] > polys[1][1][0] - polys[1][0][0], 'one box per line, each as wide as its line');
  const px = (a, x, y) => Array.from(a.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 3));
  // a point inside the first box but left of the ink (padding), and the top-right corner of the doc
  const bx = Math.round(polys[0][0][0] + 3), by = Math.round((polys[0][0][1] + polys[0][2][1]) / 2);
  let a = comp(d); assert(px(a, bx, by).join() === '255,0,0' && px(a, 395, 5).join() === '255,255,255', 'box colour in the padding, nothing outside');
  const ink = (() => { T.style = {}; T.touch(); d.changed('all'); const c = comp(d); for (let x = bx; x < 300; x++) if (c[(by * 400 + x) * 4] < 40) return x; return -1; })();
  assert(ink > 0, 'found a letter');
  T.style = { textBox: { ...defaultTextBox(), color: { r: 255, g: 0, b: 0 }, padX: 20, padY: 20 } }; T.touch(); d.changed('all');
  a = comp(d); assert(px(a, ink + 1, by).join() === '0,0,0', 'text over the box');
  T.style.textBox.invert = true; T.touch(); d.changed('all');
  a = comp(d); assert(px(a, ink + 1, by).join() === '255,255,255' && px(a, bx, by).join() === '255,0,0', 'inverted: the letters are holes in the box');
  T.style = {}; T.touch();
  const G = new GroupLayer('G'); d.insert(G, d.root, d.root.children.length); d.detach(T); d.insert(T, G, 0);
  G.style = { textBox: { ...defaultTextBox(), color: { r: 0, g: 0, b: 255 }, padX: 20, padY: 20 } }; d.changed('all');
  a = comp(d); assert(px(a, bx, by).join() === '0,0,255', 'a group boxes the text inside it');
  const d2 = await loadStlv(await saveStlv(d)), G2 = d2.all().find(l => l.isGroup);
  assert(G2 && G2.style.textBox && G2.style.textBox.color.b === 255, 'saved and loaded');
});

test('several selected layers move together in the stack, in order, with one undo', () => {
  const d = fresh(40, 40), mk = n => { const l = new PixelLayer(n, 40, 40); d.addLayer(l); return l; };
  const [a, b, c, e] = ['a', 'b', 'c', 'e'].map(mk), G = new GroupLayer('G'); d.insert(G, d.root, d.root.children.length);
  const names = p => p.children.map(l => l.name).join(',');
  const start = names(d.root), n0 = d.history.index;
  d.moveLayers([a, c], d.root, d.root.children.indexOf(e) + 1);   // above e
  assert(names(d.root) === 'Background,b,e,a,c,G', 'moved above e, a still under c: ' + names(d.root));
  d.moveLayers([a, c], G, 0);
  assert(names(G) === 'a,c' && names(d.root) === 'Background,b,e,G', 'moved into the group');
  d.history.undo(); d.history.undo();
  assert(names(d.root) === start && d.history.index === n0, 'two undos put them back: ' + names(d.root));
});

/* ---------- runner ---------- */
export async function run() {
  const out = [], t0 = performance.now(); let failed = 0;
  const box = document.createElement('pre'); box.style.cssText = 'position:fixed;inset:40px;z-index:9999;background:#000d;color:#ddd;padding:16px;overflow:auto;font:12px Menlo,monospace;white-space:pre-wrap';
  document.body.append(box);
  for (const t of tests) {
    const s = performance.now();
    try { await t.fn(); out.push(`ok   ${t.name} (${Math.round(performance.now() - s)} ms)`); }
    catch (e) { failed++; out.push(`FAIL ${t.name}\n     ${e.message}`); console.error(t.name, e); }
    box.textContent = out.join('\n');
    await sleep(0);
  }
  out.push(`\n${tests.length - failed}/${tests.length} passed in ${Math.round(performance.now() - t0)} ms`);
  box.textContent = out.join('\n');
  while (app.docs.length) app.closeDoc(app.docs[0], true);
  window.stlvTestReport = { report: out.join('\n'), failed };
  if (window.stlvNative && window.stlvNative.test) window.webkit.messageHandlers.stlv.postMessage({ cmd: 'testDone', report: out.join('\n'), failed });
  return { failed, report: out.join('\n') };
}
