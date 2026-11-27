// Properties panel: shows what the active layer can do. Sliders change the
// layer live; letting go records one undo step.

import { h, $, C, clamp, round, R } from '../util.js';
import { num, select, seg, chk, swatch, sliderRow, lbl, icon, btn, fontPick } from './widgets.js';
import { ADJUSTMENTS, curveLut } from '../adjust.js';
import { FILTERS, FILTER_GROUPS, defaultFilterParams } from '../filters.js';
import { gradientCSS, GRAD_TYPES, cloneGradient, defaultGradient } from '../gradient.js';
import { fonts, styleFor } from '../text.js';
import { WARP_STYLES } from '../transform.js';
import { SB_PALETTE, sbColourPair, SB_GROUPS, SB_NAMES, sbLayerTitle } from '../sbfx.js';
import { blendSelect } from './dialogs.js';
import { clone } from '../doc.js';
import { gradientEditor } from './gradedit.js';
import { scaleSnap, restoreSnap, applyScale, unionBox } from '../tools/basic.js';

const sect = t => h('div.sect', t);

export class PropsPanel {
  constructor(app, el) {
    this.app = app; this.el = el; this.focus = null;
    this.body = this.panelBody = h('div.pb');
    el.append(h('div.ph', h('span.on', 'Properties')), this.body);
    this.buildWin();
    app.on('change', k => { if (k === 'active') this.focus = this.focus && this.lastActive === app.doc?.active ? this.focus : null; });
  }
  /** live change: set now, record undo when final */
  /** layer may be an array (several selected text layers: one undo step for all);
   *  value may be a function of the layer when each gets its own */
  live(layer, key, value, final, label) {
    const d = this.app.doc, Ls = Array.isArray(layer) ? layer : [layer];
    const vals = Ls.map(x => clone(typeof value === 'function' ? value(x) : value));
    const put = vs => Ls.forEach((x, i) => { x[key] = clone(vs[i]); x.touch(); if (x.type === 'text') x.raster = null; });
    if (Ls[0]._temp) { put(vals); this.app.view.invalidate(); return; }   // previews (Image > Adjustments) don't touch history
    const p = this.pending;
    if (!p || p.key !== key || p.layers.length !== Ls.length || p.layers.some((x, i) => x !== Ls[i])) this.pending = { layers: Ls, key, old: Ls.map(x => clone(x[key])) };
    put(vals);
    this.app.fxInteractive = !final;
    this.app.view.invalidate();
    if (final && Ls[0].type === 'text' && key === 'color') this.app.toolOpt(this.app.tools.text, 'color', { ...vals[0] });   // next new text gets it
    if (final) {
      const old = this.pending.old; this.pending = null;
      d.edit(label || 'Properties', () => put(vals), () => put(old), { kind: 'props' });
    }
  }
  /** a new size for several text layers: they scale as one block around its top-left,
   *  so their gaps and line-up grow with them (ref = the layer whose size was typed) */
  groupSize(Ls, ref, v, final) {
    const d = this.app.doc; let g = this.gsize;
    if (!g || g.ref !== ref || g.layers.length !== Ls.length || g.layers.some((x, i) => x !== Ls[i])) {
      const b = unionBox(Ls, d);
      g = this.gsize = { layers: Ls, ref, snaps: scaleSnap(Ls), size0: ref.size, ox: b.x, oy: b.y };
    }
    applyScale(g.snaps, v / g.size0, g.ox, g.oy);
    this.app.fxInteractive = !final; this.app.view.invalidate();
    if (final) {
      this.gsize = null; const before = g.snaps, after = scaleSnap(Ls);
      d.edit('Font Size', () => restoreSnap(after), () => restoreSnap(before), { kind: 'props' });
    }
  }
  /** family + style as one change, so one undo restores both. how: 'preview' | 'commit' | 'cancel' */
  font(l, family, how) {
    const Ls = Array.isArray(l) ? l : [l];
    const put = fs => Ls.forEach((x, i) => { x.font = fs[i][0]; x.fontStyle = fs[i][1]; x.raster = null; x.touch(); });
    if (!this.fontWas || this.fontWas.layers[0] !== Ls[0] || this.fontWas.layers.length !== Ls.length) this.fontWas = { layers: Ls, old: Ls.map(x => [x.font, x.fontStyle]) };
    const old = this.fontWas.old, next = old.map(([, s]) => [family, styleFor(family, s)]);
    if (how === 'preview') { put(next); this.app.view.invalidate(); return; }
    this.fontWas = null; put(old);
    if (how === 'commit' && old.some(([f]) => f !== family)) this.app.doc.edit('Font', () => put(next), () => put(old), { kind: 'props' });
    else this.app.view.invalidate();
  }
  /* ---------- Effects window: filters, styles, adjustments get room of their own ---------- */
  buildWin() {
    const app = this.app;
    this.winTitle = h('b'); this.winBody = h('div.pb');
    const x = h('button.fxx', { title: 'Close' }, '✕');
    x.onclick = () => this.closeWin();
    const head = h('div.fxhead', this.winTitle, x);
    this.win = h('div.fxwin', { style: { display: 'none' } }, head, this.winBody);
    document.body.append(this.win);
    // drag by the title bar; position and size are remembered
    head.onpointerdown = e => {
      if (e.target === x) return;
      const r = this.win.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      const mv = ev => this.placeWin(ev.clientX - ox, ev.clientY - oy);
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); this.saveWin(); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    };
    new ResizeObserver(() => { if (this.win.style.display !== 'none') this.saveWinSoon(); }).observe(this.win);
    window.addEventListener('resize', () => { if (this.win.style.display !== 'none') { const r = this.win.getBoundingClientRect(); this.placeWin(r.left, r.top); } });
  }
  placeWin(x, y) {
    const r = this.win.getBoundingClientRect();
    this.win.style.left = Math.round(clamp(x, 0, Math.max(0, window.innerWidth - Math.min(r.width, 120)))) + 'px';
    this.win.style.top = Math.round(clamp(y, 0, Math.max(0, window.innerHeight - 40))) + 'px';
  }
  saveWin() { const r = this.win.getBoundingClientRect(); if (r.width) this.app.setPref('fxWin', { x: r.left, y: r.top, w: r.width, h: this.win.style.height ? r.height : null }); }
  saveWinSoon() { clearTimeout(this.winT); this.winT = setTimeout(() => this.saveWin(), 300); }
  showWin(title) {
    this.winTitle.textContent = title;
    if (this.win.style.display !== 'none') return;
    this.win.style.display = '';
    const p = this.app.prefs.fxWin, panels = document.getElementById('panels'), pr = panels ? panels.getBoundingClientRect() : { left: window.innerWidth };
    this.win.style.width = (p && p.w ? p.w : 300) + 'px';
    if (p && p.h) this.win.style.height = p.h + 'px';
    if (p) this.placeWin(p.x, p.y); else this.placeWin(pr.left - 316, 110);   // first time: just left of the panels
  }
  hideWin() { this.win.style.display = 'none'; }
  /** what the window edits right now: its title, or null */
  fxKind() {
    const app = this.app, d = app.doc, l = d && d.active;
    if (app.fxSession) return FILTERS[app.fxSession.type].name;
    if (app.adjSession) return ADJUSTMENTS[app.adjSession.A.adj].name;
    if (!l) return null;
    if (this.focus === 'style' && l.style.gradOverlay) return 'Gradient overlay';
    if (this.focus === 'textbox' && l.style.textBox) return 'Text box';
    if (this.focus && this.focus.startsWith('filter:')) { const f = l.filters[+this.focus.split(':')[1]]; if (f) return (FILTERS[f.type] || { name: f.type }).name; }
    if (this.winClosedFor === l) return null;   // closed by hand: back in the panel until another layer is picked
    if (l.type === 'adjust') return l.adj === 'sbfx' ? sbLayerTitle(l.params) : ADJUSTMENTS[l.adj].name;
    if (l.type === 'fill' && l.kind !== 'solid') return 'Gradient fill';
    return null;
  }
  closeWin() {
    const app = this.app, l = app.doc && app.doc.active;
    if (app.fxSession) return app.fxEnd(false);
    if (app.adjSession) return app.adjEnd(false);
    if (this.focus) { this.focus = null; app.fxCenterEdit = null; }
    else this.winClosedFor = l;
    this.render();
  }

  render() {
    if (this.dragging) return;   // never rebuild under a dragged slider
    const app = this.app, d = app.doc;
    if (this.winClosedFor && this.winClosedFor !== (d && d.active)) this.winClosedFor = null;
    const fx = this.fxKind();
    this.panelBody.innerHTML = ''; this.winBody.innerHTML = '';
    if (fx) {
      this.body = this.winBody; this.showWin(fx);
      this.panelBody.append(h('div.row', h('span.lbl', { style: { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${fx}: open in its own window`), btn('Close', () => this.closeWin(), 'ghost')));
    } else { this.body = this.panelBody; this.hideWin(); }
    const b = this.body;
    document.body.classList.toggle('fxmode', false);
    if (app.fxSession) return this.filterSession(app.fxSession);
    if (app.adjSession) { this.adjust(app.adjSession.A); b.append(h('div.row', { style: { justifyContent: 'flex-end', marginTop: '8px' } }, btn('Cancel', () => app.adjEnd(false)), btn('Apply', () => app.adjEnd(true), 'pri'))); return; }
    const l = d && d.active;
    this.lastActive = l;
    if (!l) { b.append(h('div.lbl', d ? 'No layer selected' : 'No document')); return; }
    if (this.focus === 'style' && l.style.gradOverlay) return this.styleEditor(l);
    if (this.focus === 'textbox' && l.style.textBox) return this.textBoxEditor(l);
    if (this.focus && this.focus.startsWith('filter:')) { const i = +this.focus.split(':')[1]; if (l.filters[i]) return this.liveFilterEditor(l, i); }
    if (app.tool && app.tool.props) { const x = app.tool.props(app); if (x) { b.append(x); return; } }
    if (l.type === 'pixel') this.pixel(l);
    else if (l.type === 'text') this.text(l);
    else if (l.type === 'fill') this.fill(l);
    else if (l.type === 'adjust') this.adjust(l);
    else if (l.isGroup) b.append(h('div.row', h('b', 'Group'), h('span.lbl', { style: { marginLeft: 'auto' } }, `${l.children.length} layer${l.children.length === 1 ? '' : 's'}`)), h('div.lbl', 'Blend mode and opacity are in the Layers panel. Pass Through lets the layers inside blend with everything below.'));
    if (l.mask) this.maskSection(l);
    if (l.style.textBox) { const tb = l.style.textBox; b.append(sect('Text box')); b.append(h('div.row', h('span', { style: { width: '22px', height: '12px', borderRadius: '3px', background: tb.fill === 'gradient' && tb.gradient ? gradientCSS(tb.gradient) : C.hex(tb.color), backgroundSize: 'auto,6px 6px' } }), tb.invert ? 'Inverted box' : 'Box behind the text', btn('Edit', () => { this.focus = 'textbox'; this.render(); }, 'ghost'))); }
    else if (l.type === 'text' || l.isGroup) b.append(h('div.row', btn('Add text box', () => this.app.run('layer.style.textBox'), 'ghost')));
    if (l.style.gradOverlay) { b.append(sect('Layer style')); b.append(h('div.row', h('span', { style: { width: '22px', height: '12px', borderRadius: '3px', background: gradientCSS(l.style.gradOverlay), backgroundSize: 'auto,6px 6px' } }), 'Gradient overlay', btn('Edit', () => { this.focus = 'style'; this.render(); }, 'ghost'))); }
    if (l.filters.length) { b.append(sect('Live filters')); l.filters.forEach((f, i) => b.append(h('div.row', h('span.badge.fx', 'live'), (FILTERS[f.type] || {}).name || f.type, btn('Edit', () => { this.focus = 'filter:' + i; this.render(); }, 'ghost')))); }
  }
  boundsRow(l) {
    const d = this.app.doc, bb = l.bounds();
    const mv = (k, v) => { const dx = k === 'x' ? v - bb.x : 0, dy = k === 'y' ? v - bb.y : 0; if (!dx && !dy) return; this.app.run('layer.nudge', dx, dy, l); };
    return h('div.grid2', h('span.kv', lbl('X'), num({ value: bb.x, onChange: (v, f) => f && mv('x', v), scrub: false })), h('span.kv', lbl('Y'), num({ value: bb.y, onChange: (v, f) => f && mv('y', v), scrub: false })),
      h('span.kv', lbl('W'), num({ value: bb.w, scrub: false, onChange: () => { } })), h('span.kv', lbl('H'), num({ value: bb.h, scrub: false, onChange: () => { } })));
  }
  pixel(l) {
    const b = this.body;
    b.append(h('div.row', h('b', l.isBackground ? 'Background' : 'Pixel layer'), h('span.lbl', { style: { marginLeft: 'auto' } }, l.name)), this.boundsRow(l));
    if (l.isBackground) b.append(h('div.row', btn('Make it a normal layer', () => this.app.run('layer.unlockBackground'), 'ghost')));
  }
  maskSection(l) {
    const app = this.app, b = this.body, m = l.mask;
    b.append(sect('Layer mask'));
    b.append(h('div.row', chk('Enabled', m.enabled, v => app.doc.edit('Mask', () => { m.enabled = v; l.touch(); }, () => { m.enabled = !v; l.touch(); })), chk('Linked', m.linked, v => { m.linked = v; app.emit('change', 'layers'); }), chk('Paint on mask', !!l.maskEdit, v => { l.maskEdit = v; app.emit('change', 'active'); })));
    b.append(h('div.row', btn('Invert', () => app.run('layer.mask.invert')), btn('Apply', () => app.run('layer.mask.apply')), btn('Delete', () => app.run('layer.mask.delete'))));
  }

  /* ---------- text ---------- */
  text(l) {
    const app = this.app, b = this.body;
    // several text layers selected: every setting below goes to all of them (showing the active one's values)
    const sel = app.doc.selectedLayers().filter(x => x.type === 'text'), T = sel.length > 1 && sel.includes(l) ? sel : l;
    b.append(h('div.row', h('b', T === l ? 'Text layer' : `${sel.length} text layers`), h('span.lbl', { style: { marginLeft: 'auto' } }, T === l ? l.name : 'edited together')));
    const famSel = fontPick((fonts.list || []).map(f => f.family), l.font, { preview: v => this.font(T, v, 'preview'), commit: v => { this.font(T, v, 'commit'); this.render(); }, cancel: () => this.font(T, null, 'cancel'), ...fonts.flyerPick(app) });
    famSel.style.maxWidth = '100%'; famSel.style.flex = '1';
    const fam = fonts.family(l.font);
    const stSel = select((fam ? fam.styles.map(s => s.style) : [l.fontStyle]), l.fontStyle, v => this.live(T, 'fontStyle', x => x.font === l.font || (fonts.family(x.font)?.styles || []).some(s => s.style === v) ? v : x.fontStyle, true, 'Font Style'));
    b.append(h('div.row', famSel), h('div.row', stSel, num({ value: l.size, min: 0.5, max: 2000, step: 1, unit: ' pt', width: 76, digits: 1, onChange: (v, f) => T === l ? this.live(T, 'size', v, f, 'Font Size') : this.groupSize(T, l, v, f) })));
    b.append(h('div.grid2', h('span.kv', lbl('Track'), num({ value: l.tracking, min: -1000, max: 5000, step: 5, onChange: (v, f) => this.live(T, 'tracking', v, f, 'Tracking') })),
      h('span.kv', lbl('Lead'), num({ value: l.leading, min: 0, max: 5000, step: 1, fmt: v => v ? round(v, 1) + ' pt' : 'Auto', onChange: (v, f) => this.live(T, 'leading', v, f, 'Leading') }))));
    const pt2px = round(l.size * app.doc.ppi / 72, 1);
    b.append(h('div.row', swatch(l.color, (c, f) => this.live(T, 'color', c, f, 'Text Color'), 'Text color'),
      seg([['left', 'alL', 'Left'], ['center', 'alC', 'Center'], ['right', 'alR', 'Right']], l.align, v => this.live(T, 'align', v, true, 'Align')),
      chk('Caps', !!l.caps, v => this.live(T, 'caps', v, true, 'All Caps')), h('span.lbl', { style: { marginLeft: 'auto' } }, `${pt2px} px`)));
    b.append(sect('Warp'));
    const w = l.warp || { style: 'none', bend: 0.5, hd: 0, vd: 0 };
    const setW = (k, v, f) => { const nw = { ...w, [k]: v }; if (nw.style === 'none') this.live(T, 'warp', null, f, 'Warp Text'); else this.live(T, 'warp', nw, f, 'Warp Text'); if (k === 'style') this.render(); };
    b.append(h('div.row', select(WARP_STYLES.filter(s => s[0] !== 'custom'), w.style, v => setW('style', v, true))));
    if (w.style !== 'none') {
      b.append(sliderRow('Bend %', { value: Math.round(w.bend * 100), min: -100, max: 100, onChange: (v, f) => { this.dragging = !f; setW('bend', v / 100, f); } }));
      b.append(sliderRow('Horizontal %', { value: Math.round((w.hd || 0) * 100), min: -100, max: 100, onChange: (v, f) => { this.dragging = !f; setW('hd', v / 100, f); } }));
      b.append(sliderRow('Vertical %', { value: Math.round((w.vd || 0) * 100), min: -100, max: 100, onChange: (v, f) => { this.dragging = !f; setW('vd', v / 100, f); } }));
    }
    b.append(h('div.row', btn('Edit text', () => { app.setTool('text'); app.tools.text.edit(l, app); }), l.box ? btn('Point text', () => this.live(l, 'box', null, true, 'Convert to Point Text')) : null, btn('Rasterize', () => app.run('layer.rasterize'), 'ghost')));
  }

  /* ---------- fill layers ---------- */
  fill(l) {
    const app = this.app, b = this.body;
    if (l.kind === 'solid') {
      b.append(h('div.row', h('b', 'Color fill')), h('div.row', swatch(l.color, (c, f) => this.live(l, 'color', c, f, 'Fill Color')), h('span.lbl', C.hex(l.color).toUpperCase())));
      return;
    }
    b.append(h('div.row', h('b', 'Gradient fill')));
    this.gradientControls(l.gradient, (g, f) => this.live(l, 'gradient', g, f, 'Gradient Fill'), true);
  }
  /** shared by gradient fill layers and the overlay style */
  gradientControls(g, set, withOffset) {
    const b = this.body, app = this.app;
    const chip = h('div.gchip', { style: { width: '100%', height: '22px', background: gradientCSS(g), backgroundSize: 'auto,8px 8px' }, title: 'Edit gradient' });
    chip.onclick = async () => { const ng = await gradientEditor(app, g, x => set(x, false)); set(ng || g, true); this.render(); };
    b.append(h('div.row', chip));
    b.append(h('div.row', seg(GRAD_TYPES.map((t, i) => [t, ['gLin', 'gRad', 'gAng', 'gRef', 'gDia'][i], t]), g.type, v => { set({ ...g, type: v }, true); this.render(); })));
    if (g.p0 && g.p1) {
      // drawn with the Gradient tool: angle / length / offset move its two end points
      const mid = { x: (g.p0.x + g.p1.x) / 2, y: (g.p0.y + g.p1.y) / 2 }, L = Math.hypot(g.p1.x - g.p0.x, g.p1.y - g.p0.y);
      const ang = Math.round(Math.atan2(-(g.p1.y - g.p0.y), g.p1.x - g.p0.x) * 180 / Math.PI);
      const at = (a, len, m) => { const r = a * Math.PI / 180, dx = Math.cos(r) * len / 2, dy = -Math.sin(r) * len / 2; return { p0: { x: m.x - dx, y: m.y - dy }, p1: { x: m.x + dx, y: m.y + dy } }; };
      b.append(sliderRow('Angle °', { value: ang, min: -180, max: 180, onChange: (v, f) => { this.dragging = !f; g = { ...g, ...at(v, L, mid) }; set(g, f); } }));
      b.append(sliderRow('Length px', { value: Math.round(L), min: 1, max: 20000, onChange: (v, f) => { this.dragging = !f; g = { ...g, ...at(ang, v, mid) }; set(g, f); } }));
      b.append(h('div.grid2', h('span.kv', lbl('X'), num({ value: Math.round(mid.x), onChange: (v, f) => { g = { ...g, ...at(ang, L, { x: v, y: mid.y }) }; set(g, f); } })), h('span.kv', lbl('Y'), num({ value: Math.round(mid.y), onChange: (v, f) => { g = { ...g, ...at(ang, L, { x: mid.x, y: v }) }; set(g, f); } }))));
    } else {
    b.append(sliderRow('Angle °', { value: Math.round(g.angle ?? 90), min: -180, max: 180, onChange: (v, f) => { this.dragging = !f; g = { ...g, angle: v }; set(g, f); } }));
    b.append(sliderRow('Scale %', { value: Math.round((g.scale ?? 1) * 100), min: 10, max: 1000, onChange: (v, f) => { this.dragging = !f; g = { ...g, scale: v / 100 }; set(g, f); } }));
    if (withOffset) b.append(h('div.grid2', h('span.kv', lbl('dX'), num({ value: Math.round(g.ox || 0), onChange: (v, f) => { g = { ...g, ox: v }; set(g, f); } })), h('span.kv', lbl('dY'), num({ value: Math.round(g.oy || 0), onChange: (v, f) => { g = { ...g, oy: v }; set(g, f); } }))));
    }
    b.append(h('div.row', chk('Reverse', !!g.reverse, v => { g = { ...g, reverse: v }; set(g, true); this.render(); }), chk('Dither', g.dither !== false, v => { g = { ...g, dither: v }; set(g, true); })));
  }
  styleEditor(l) {
    const b = this.body, ov = l.style.gradOverlay;
    const setOv = (o, f) => this.live(l, 'style', { ...l.style, gradOverlay: o }, f, 'Gradient Overlay');
    b.append(h('div.row', h('b', 'Gradient overlay'), h('span', { style: { marginLeft: 'auto' } }, btn('Done', () => { this.focus = null; this.render(); }, 'ghost'))));
    b.append(h('div.row', lbl('Mode'), blendSelect(ov.blend || 'normal', v => setOv({ ...l.style.gradOverlay, blend: v }, true), false, '', v => {
      const o = l.style; l.style = v == null ? this.styleOrig || o : { ...o, gradOverlay: { ...o.gradOverlay, blend: v } };
      this.styleOrig = v == null ? null : this.styleOrig || o; l.touch(); this.app.view.invalidate();
    })));
    b.append(sliderRow('Opacity %', { value: Math.round((ov.opacity ?? 1) * 100), min: 0, max: 100, onChange: (v, f) => { this.dragging = !f; setOv({ ...l.style.gradOverlay, opacity: v / 100 }, f); } }));
    this.gradientControls(ov, (g, f) => setOv({ ...l.style.gradOverlay, ...g }, f), false);
    b.append(h('div.row', chk('Align with layer', ov.align !== false, v => setOv({ ...l.style.gradOverlay, align: v }, true)), btn('Remove style', () => { this.focus = null; this.live(l, 'style', { ...l.style, gradOverlay: undefined }, true, 'Clear Layer Style'); }, 'ghost')));
  }

  /** text box: colour or gradient behind each line (or one box), padding, inverted = text cut out of the box.
   *  Edits every selected layer that has one. */
  textBoxEditor(l) {
    const b = this.body, d = this.app.doc, tb = l.style.textBox;
    const Ls = [l, ...d.selectedLayers().filter(x => x !== l && x.style.textBox)];
    const set = (patch, f) => { this.dragging = !f; this.live(Ls, 'style', x => ({ ...x.style, textBox: { ...(x.style.textBox || tb), ...patch } }), f, 'Text Box'); };
    const now = () => l.style.textBox;
    b.append(h('div.row', h('b', 'Text box'), Ls.length > 1 ? h('span.lbl', `${Ls.length} layers`) : '', h('span', { style: { marginLeft: 'auto' } }, btn('Done', () => { this.focus = null; this.render(); }, 'ghost'))));
    if (l.isGroup) b.append(h('div.lbl', { style: { fontSize: '11px', marginBottom: '6px' } }, 'Boxes go behind every text layer in the group.'));
    b.append(h('div.slrow', lbl('Shape'), h('div', { style: { gridColumn: '2/4' } }, seg([['lines', 'Per line'], ['block', 'One box']], tb.shape || 'lines', v => { set({ shape: v }, true); this.render(); }))));
    b.append(h('div.slrow', lbl('Fill'), h('div', { style: { gridColumn: '2/4' } }, seg([['solid', 'Colour'], ['gradient', 'Gradient']], tb.fill || 'solid', v => {
      const c = now().color, dark = { r: c.r * 0.45 | 0, g: c.g * 0.45 | 0, b: c.b * 0.45 | 0 };
      set(v === 'gradient' && !now().gradient ? { fill: v, gradient: defaultGradient(c, dark) } : { fill: v }, true); this.render();
    }))));
    if ((tb.fill || 'solid') === 'solid') b.append(h('div.row', swatch(tb.color, (c, f) => set({ color: c }, f), 'Box colour'), h('span.lbl', 'box colour')));
    else this.gradientControls(tb.gradient, (g, f) => set({ gradient: g }, f), false);
    b.append(sliderRow('Padding X (% of size)', { value: tb.padX ?? 18, min: 0, max: 100, onChange: (v, f) => set({ padX: v }, f) }));
    b.append(sliderRow('Padding Y (% of size)', { value: tb.padY ?? 12, min: 0, max: 100, onChange: (v, f) => set({ padY: v }, f) }));
    b.append(sliderRow('Opacity %', { value: Math.round((tb.opacity ?? 1) * 100), min: 0, max: 100, onChange: (v, f) => set({ opacity: v / 100 }, f) }));
    b.append(h('div.row', chk('Invert: cut the text out of the box', !!tb.invert, v => { set({ invert: v }, true); this.render(); })));
    b.append(h('div.row', btn('Remove text box', () => { this.focus = null; this.live(Ls, 'style', x => ({ ...x.style, textBox: undefined }), true, 'Remove Text Box'); this.render(); }, 'ghost')));
  }

  /* ---------- adjustment layers ---------- */
  /** SB FX layer: one look, run on the composite of everything below */
  sbLayer(l) {
    const app = this.app, b = this.body, d = app.doc, p = l.params, def = FILTERS['sb_' + p.mode];
    b.append(h('div.row', h('b', sbLayerTitle(p)), h('span.lbl', { style: { marginLeft: 'auto' } }, 'effect layer')));
    b.append(h('div.lbl', { style: { marginBottom: '8px', fontSize: '11px' } }, 'Changes everything below it. Paint its mask, or clip it (⌥-click in Layers) to limit it.'));
    const auto = l.name.startsWith('SB ' + SB_NAMES[p.mode] + ' ') && /^SB [A-Za-z ]+ \d+$/.test(l.name);   // still the automatic name: follow the look
    const pick = m => {
      if (m === p.mode) return;
      const props = { params: { ...p, mode: m } };
      if (auto) props.name = d.layerName('SB ' + SB_NAMES[m]);
      d.setProps(l, props, 'SB FX look'); this.render();
    };
    for (const [sub, modes] of SB_GROUPS) b.append(h('div.chips.sbsub', h('span.lbl', sub), ...modes.map(m => h('button.chip' + (m === p.mode ? '.on' : ''), { on: { click: () => pick(m) } }, SB_NAMES[m]))));
    const set = (k, v, f) => { this.dragging = !f; this.live(l, 'params', { ...l.params, [k]: v }, f, sbLayerTitle(l.params)); };
    if (def) this.paramRows(def, p, set);
  }
  adjust(l) {
    if (l.adj === 'sbfx') return this.sbLayer(l);
    const app = this.app, b = this.body, def = ADJUSTMENTS[l.adj];
    b.append(h('div.row', h('b', def.name), h('span.lbl', { style: { marginLeft: 'auto' } }, 'adjustment layer')));
    b.append(h('div.lbl', { style: { marginBottom: '8px', fontSize: '11px' } }, 'Changes everything below it. Paint its mask, or clip it (⌥-click in Layers) to limit it.'));
    const set = (k, v, f) => { this.dragging = !f; this.live(l, 'params', { ...l.params, [k]: v }, f, def.name); };
    if (def.hist) { const cv = h('canvas.histo', { width: 256, height: 56 }); b.append(cv); this.drawHist(cv, l); }
    if (def.curve) this.curves(l);
    for (const [k, label, min, max, dflt, step] of def.params) {
      if (min === 'bool') { b.append(h('div.row', chk(label, !!l.params[k], v => { set(k, v, true); this.render(); }))); continue; }
      b.append(sliderRow(label, { value: l.params[k], min, max, step: step || 1, digits: step && step < 1 ? 2 : 0, onChange: (v, f) => set(k, v, f) }));
    }
    if (l.adj === 'levels') b.append(h('div.row', btn('Auto', () => this.autoLevels(l), 'ghost'), btn('Reset', () => this.live(l, 'params', { ...l.params, inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 }, true, 'Levels'), 'ghost')));
  }
  histogram() {
    const d = this.app.doc, comp = this.app.view.comp, key = d.id + ':' + d.history.index;
    if (this._hist && this._hist.key === key) return this._hist.H;
    const s = Math.max(1, Math.round(Math.sqrt(d.width * d.height / 400000)));
    comp.render(d);
    const id = comp.g.read(comp.result, { x: 0, y: 0, w: d.width, h: d.height });
    const H = new Float32Array(256), px = id.data;
    for (let i = 0; i < px.length; i += 4 * s) if (px[i + 3]) H[(px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722) | 0]++;
    this._hist = { key, H }; return H;
  }
  drawHist(cv, l) {
    const H = this.histogram(), c = cv.getContext('2d'), mx = Math.max(...H) || 1, cs = getComputedStyle(document.documentElement);
    c.clearRect(0, 0, 256, 56); c.fillStyle = cs.getPropertyValue('--muted');
    for (let v = 0; v < 256; v++) { const bh = Math.sqrt(H[v] / mx) * 52; c.fillRect(v, 56 - bh, 1, bh); }
    if (l && l.adj === 'levels') { const p = l.params; c.fillStyle = cs.getPropertyValue('--accent'); const mid = p.inBlack + (p.inWhite - p.inBlack) * Math.pow(0.5, p.gamma); [p.inBlack, mid, p.inWhite].forEach(x => c.fillRect(Math.round(x) - 0.5, 0, 1.5, 56)); }
  }
  autoLevels(l) {
    const H = this.histogram(), tot = H.reduce((a, b) => a + b, 0); let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += H[v]; if (acc > tot * 0.001) { lo = v; break; } }
    acc = 0; for (let v = 255; v >= 0; v--) { acc += H[v]; if (acc > tot * 0.001) { hi = v; break; } }
    this.live(l, 'params', { ...l.params, inBlack: lo, inWhite: Math.max(lo + 2, hi), gamma: 1 }, true, 'Auto Levels'); this.render();
  }
  curves(l) {
    const b = this.body, cv = h('canvas.curve', { width: 256, height: 256 });
    let ch = this.curveCh || 'rgb';
    const chSeg = seg([['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], ch, v => { this.curveCh = ch = v; draw(); });
    b.append(h('div.row', chSeg), cv, h('div.lbl', { style: { fontSize: '10.5px', marginBottom: '6px' } }, 'Click to add a point and drag it. Drag a point off the graph to remove it.'));
    const H = this.histogram();
    const pts = () => l.params.curves[ch];
    const draw = () => {
      const c = cv.getContext('2d'), cs = getComputedStyle(document.documentElement), V = k => cs.getPropertyValue(k).trim();
      c.clearRect(0, 0, 256, 256); c.strokeStyle = V('--line2'); c.lineWidth = 1;
      for (let i = 64; i < 256; i += 64) { c.beginPath(); c.moveTo(i + 0.5, 0); c.lineTo(i + 0.5, 256); c.moveTo(0, i + 0.5); c.lineTo(256, i + 0.5); c.stroke(); }
      const mx = Math.max(...H) || 1; c.fillStyle = V('--line2'); for (let v = 0; v < 256; v++) { const bh = Math.sqrt(H[v] / mx) * 120; c.fillRect(v, 256 - bh, 1, bh); }
      c.setLineDash([3, 3]); c.beginPath(); c.moveTo(0, 256); c.lineTo(256, 0); c.stroke(); c.setLineDash([]);
      const lut = curveLut(pts()); c.strokeStyle = { rgb: V('--accent'), r: '#ff5a5a', g: '#5ad15a', b: '#5a8cff' }[ch]; c.lineWidth = 2; c.beginPath();
      for (let x = 0; x < 256; x++) c[x ? 'lineTo' : 'moveTo'](x, 255 - lut[x]); c.stroke();
      c.fillStyle = V('--text'); pts().forEach(([x, y]) => c.fillRect(x - 4, 251 - y, 8, 8));
    };
    const at = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * 255, 255 - (e.clientY - r.top) / r.height * 255]; };
    cv.addEventListener('pointerdown', e => {
      e.preventDefault();
      const cur = clone(l.params.curves), P = cur[ch], [x, y] = at(e);
      let i = P.findIndex(q => Math.hypot(q[0] - x, q[1] - y) < 12);
      if (i < 0) { const lut = curveLut(P); i = P.findIndex(q => q[0] > x); if (i < 0) i = P.length; P.splice(i, 0, [x, lut[Math.round(clamp(x, 0, 255))]]); }
      let idx = i; this.dragging = true;
      const apply = f => this.live(l, 'params', { ...l.params, curves: clone(cur) }, f, 'Curves');
      const mv = ev => {
        if (idx === null) return; const [mx, my] = at(ev);
        if ((my < -25 || my > 280 || mx < -25 || mx > 280) && idx > 0 && idx < P.length - 1) { P.splice(idx, 1); idx = null; }
        else { const lo = idx > 0 ? P[idx - 1][0] + 1 : 0, hi = idx < P.length - 1 ? P[idx + 1][0] - 1 : 255; P[idx] = [clamp(mx, lo, hi), clamp(my, 0, 255)]; }
        apply(false); draw();
      };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); this.dragging = false; apply(true); draw(); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      apply(false); draw();
    });
    draw();
  }

  /* ---------- filters ---------- */
  paramRows(def, params, set) {
    const b = this.body;
    for (const q of def.params) {
      const [k, label, min, max, , unit, step] = q;
      if (Array.isArray(min)) { b.append(h('div.slrow', lbl(label), h('div', { style: { gridColumn: '2/4' } }, seg(min.map((o, i) => [i, o]), params[k], v => set(k, +v, true))))); continue; }
      b.append(sliderRow(label + (unit ? ' (' + unit.trim() + ')' : ''), { value: params[k], min, max, step: step || 1, digits: step && step < 1 ? 1 : 0, onChange: (v, f) => { this.dragging = !f; set(k, v, f); } }));
    }
    if (def.center) b.append(h('div.lbl', { style: { fontSize: '11px' } }, 'Drag on the canvas to move the center.'));
    if (def.sb && !def.ownColour) {
      const col = params.col || 'blood', rgb = sbColourPair(col)[0], toC = a => ({ r: Math.round(a[0] * 255), g: Math.round(a[1] * 255), b: Math.round(a[2] * 255) });
      const pal = h('div.sbpal', ...Object.keys(SB_PALETTE).map(k => h('button.sbc' + (k === col ? '.on' : ''), { title: k, style: { background: '#' + SB_PALETTE[k][0] }, on: { click: () => { set('col', k, true); this.render(); } } })));
      b.append(h('div.slrow', lbl('Colour'), h('div', { style: { gridColumn: '2/4' } }, pal)),
        h('div.row', swatch(toC(rgb), (c, f) => set('col', C.hex(c), f), 'Own colour'), h('span.lbl', SB_PALETTE[col] ? col : 'own colour')));
    }
    if (def.inkPaper) b.append(h('div.row', swatch(params.fg || { r: 20, g: 20, b: 20 }, (c, f) => set('fg', c, f), 'Ink'), swatch(params.bgc || { r: 239, g: 233, b: 223 }, (c, f) => set('bgc', c, f), 'Paper'), h('span.lbl', 'ink / paper')));
    if (def.group === 'Code' || def.group === 'Generative') b.append(h('div.row', swatch(params.fg || { r: 255, g: 61, b: 139 }, (c, f) => set('fg', c, f), 'Main color'), swatch(params.bgc || { r: 243, g: 239, b: 230 }, (c, f) => set('bgc', c, f), 'Bright color'), h('span.lbl', 'colors')));
  }
  liveFilterEditor(l, i) {
    const b = this.body, f = l.filters[i], def = FILTERS[f.type];
    const set = (k, v, fin) => { const fl = l.filters.map((x, j) => j === i ? { ...x, params: { ...x.params, [k]: v } } : x); this.live(l, 'filters', fl, fin, def.name); };
    b.append(h('div.row', h('b', def.name), h('span.badge.fx', 'live'), h('span', { style: { marginLeft: 'auto' } }, btn('Done', () => { this.focus = null; this.app.fxCenterEdit = null; this.render(); }, 'ghost'))));
    this.paramRows(def, f.params, set);
    if (def.center) this.app.fxCenterEdit = { layer: l, index: i };
    b.append(h('div.row', btn('Apply to pixels', () => this.app.run('filter.bake', l, i), 'ghost'), btn('Remove', () => { this.focus = null; this.live(l, 'filters', l.filters.filter((_, j) => j !== i), true, 'Delete Live Filter'); this.render(); }, 'ghost')));
  }
  /** Filter menu: choose + tune with a live preview, then OK (live or baked) / Cancel */
  filterSession(s) {
    const app = this.app, b = this.body, l = s.layer;
    const chips = h('div');
    const chip = ([k, f]) => { const c = h('button.chip' + (k === s.type ? '.on' : ''), f.short || f.name); c.onclick = () => { app.fxSwitch(k); }; return c; };
    for (const g of FILTER_GROUPS) {
      const list = Object.entries(FILTERS).filter(([, f]) => f.group === g);
      chips.append(h('div.sect', g));
      if (g !== 'SB FX') { chips.append(h('div.chips', ...list.map(chip))); continue; }
      for (const sub of [...new Set(list.map(([, f]) => f.sub))]) chips.append(h('div.chips.sbsub', h('span.lbl', sub), ...list.filter(([, f]) => f.sub === sub).map(chip)));
    }
    b.append(chips, h('div.sect', FILTERS[s.type].name), h('div.row', h('span.lbl', 'on'), h('b', l.name)));
    const set = (k, v, fin) => { s.params = { ...s.params, [k]: v }; app.fxPreview(!fin); };
    this.paramRows(FILTERS[s.type], s.params, set);
    b.append(h('div.row', chk('Keep editable (live filter)', s.keepLive, v => { s.keepLive = v; }), h('span.lbl', { style: { marginLeft: 'auto', fontSize: '10.5px' } }, s.ms != null ? `${s.ms} ms` : '')));
    if (!s.canLive) b.append(h('div.lbl', { style: { fontSize: '11px' } }, 'A selection is active: the filter is applied to the selected pixels.'));
    b.append(h('div.row', { style: { justifyContent: 'flex-end' } }, btn('Cancel', () => app.fxEnd(false)), btn('OK', () => app.fxEnd(true), 'pri')));
  }
}
export { defaultFilterParams, R, cloneGradient, icon };
