// Right-hand panels: Color, Properties (props.js), Layers + History.

import { h, $, $$, C, clamp, canvas, ctx, throttleFrame, round } from '../util.js';
import { icon, num, select, colorPop } from './widgets.js';
import { blendName } from '../doc.js';
import { blendSelect } from './dialogs.js';
import { gradientCSS } from '../gradient.js';
import { ADJUSTMENTS } from '../adjust.js';
import { sbLayerTitle } from '../sbfx.js';
import { FILTERS } from '../filters.js';
import { PropsPanel } from './props.js';

export class Panels {
  constructor(app) {
    this.app = app;
    const root = $('#panels');
    this.colorEl = h('div.pnl#colorPnl'); this.propsEl = h('div.pnl#propsPnl'); this.layersEl = h('div.pnl#layersPnl');
    root.append(this.colorEl, this.propsEl, this.layersEl);
    this.color = new ColorPanel(app, this.colorEl);
    this.props = new PropsPanel(app, this.propsEl);
    this.layers = new LayersPanel(app, this.layersEl);
    const soon = throttleFrame(() => { this.layers.render(); this.props.render(); });
    app.on('doc', soon); app.on('change', kind => { if (kind !== 'selection' && kind !== 'guides') soon(); });
    app.on('tool', () => this.props.render());
  }
}

/* ---------- Color ---------- */
class ColorPanel {
  constructor(app, el) {
    this.app = app; this.el = el;
    const sv = h('div.sv'), svDot = h('i'), hue = h('div.hue'), hueDot = h('i');
    sv.append(svDot); hue.append(hueDot);
    this.hex = h('input.txt', { style: { width: '74px' }, spellcheck: false });
    this.fields = ['r', 'g', 'b'].map(k => num({ value: 0, min: 0, max: 255, width: 42, onChange: v => { const c = { ...app.fg }; c[k] = v; app.setFg(c); } }));
    this.sw = h('div.sw');
    el.append(h('div.ph', h('span.on', 'Color')), h('div.pb', h('div.picker', sv, hue),
      h('div.row', { style: { marginTop: '9px' } }, h('span.lbl', '#'), this.hex, ...this.fields.flatMap((f, i) => [h('span.lbl', 'RGB'[i]), f])), this.sw));
    Object.assign(this, { sv, svDot, hue, hueDot });
    this.hsv = C.toHsv(app.fg);
    const drag = (node, f) => node.addEventListener('pointerdown', e => {
      e.preventDefault(); const r = node.getBoundingClientRect();
      const mv = ev => { f(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)); this.fromHsv(); };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); mv(e);
    });
    drag(sv, (x, y) => { this.hsv.s = x; this.hsv.v = 1 - y; });
    drag(hue, (x, y) => { this.hsv.h = Math.min(359.9, y * 360); });
    this.hex.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { const c = C.parse(this.hex.value); if (c) app.setFg(c); this.hex.blur(); } });
    app.on('colors', () => this.render());
    this.render();
  }
  fromHsv() { this.lock = true; this.app.setFg(C.fromHsv(this.hsv)); this.lock = false; this.paint(); }
  render() {
    if (!this.lock) { const c = C.toHsv(this.app.fg); if (C.hex(C.fromHsv(this.hsv)) !== C.hex(this.app.fg)) this.hsv = { ...c, h: c.s ? c.h : this.hsv.h }; }
    this.paint();
    const app = this.app, list = app.prefs.swatches || DEFAULT_SWATCHES;
    this.sw.innerHTML = '';
    list.forEach((hex, i) => {
      const s = h('i', { style: { background: hex }, title: `${hex} — click: foreground, ⌥-click: background, ⌘-click: remove` });
      s.onclick = e => { const c = C.parse(hex); if (e.metaKey) { const l = [...list]; l.splice(i, 1); app.setPref('swatches', l); this.render(); } else if (e.altKey) app.setBg(c); else app.setFg(c); };
      this.sw.append(s);
    });
    const add = h('i.add', { title: 'Add the foreground color' }, '+');
    add.onclick = () => { app.setPref('swatches', [...list, C.hex(app.fg)]); this.render(); };
    this.sw.append(add);
  }
  paint() {
    const hsv = this.hsv, c = this.app.fg;
    this.sv.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h},100%,50%))`;
    this.svDot.style.left = hsv.s * 100 + '%'; this.svDot.style.top = (1 - hsv.v) * 100 + '%';
    this.hueDot.style.top = hsv.h / 360 * 100 + '%';
    if (document.activeElement !== this.hex) this.hex.value = C.hex(c).slice(1).toUpperCase();
    ['r', 'g', 'b'].forEach((k, i) => this.fields[i].setValue(c[k]));
  }
}
const DEFAULT_SWATCHES = ['#000000', '#ffffff', '#f3efe6', '#0b0d1f', '#1d2356', '#5a3cff', '#8fd3ff', '#ff4fd8', '#ff3d8b', '#ffb347', '#ffe066', '#7ee2a8'];

/* ---------- thumbnails ---------- */
const thumbs = new WeakMap();
function thumb(layer, doc) {
  let t = thumbs.get(layer);
  const key = layer.type === 'pixel' ? layer.rev + ':' + doc.width + 'x' + doc.height : layer.rev;
  if (t && t.key === key) return t.c;
  const s = 34 / Math.max(doc.width, doc.height), w = Math.max(1, Math.round(doc.width * s)), hh = Math.max(1, Math.round(doc.height * s));
  const c = t ? t.c : canvas(w, hh);
  c.width = w; c.height = hh;
  const x = ctx(c); x.clearRect(0, 0, w, hh); x.imageSmoothingQuality = 'high';
  if (layer.type === 'pixel') x.drawImage(layer.canvas, layer.x * s, layer.y * s, layer.canvas.width * s, layer.canvas.height * s);
  else if (layer.type === 'text' && layer.raster) x.drawImage(layer.raster.canvas, layer.raster.x * s, layer.raster.y * s, layer.raster.canvas.width * s, layer.raster.canvas.height * s);
  thumbs.set(layer, { c, key });
  return c;
}
const mthumbs = new WeakMap();
function maskThumb(layer, doc) {
  const m = layer.mask; let t = mthumbs.get(layer);
  if (t && t.rev === m.rev && t.src === m.canvas) return t.c;
  const s = 34 / Math.max(doc.width, doc.height), w = Math.max(1, Math.round(doc.width * s)), hh = Math.max(1, Math.round(doc.height * s));
  const c = canvas(w, hh), x = ctx(c); x.fillStyle = m.bg ? '#fff' : '#000'; x.fillRect(0, 0, w, hh);
  x.drawImage(m.canvas, m.x * s, m.y * s, m.canvas.width * s, m.canvas.height * s);
  mthumbs.set(layer, { c, rev: m.rev, src: m.canvas });
  return c;
}

/* ---------- Layers + History ---------- */
class LayersPanel {
  constructor(app, el) {
    this.app = app; this.el = el; this.tab = 'layers';
    this.tabs = h('div.ph');
    this.head = h('div.lhead'); this.list = h('div#layers'); this.foot = h('div.lfoot'); this.hist = h('div.hist.hide');
    el.append(this.tabs, this.head, this.list, this.foot, this.hist);
    this.buildFoot();
    this.render();
    this.list.addEventListener('dragover', e => this.dragOver(e));
    this.list.addEventListener('drop', e => this.drop(e));
    this.list.addEventListener('dragleave', e => { if (!this.list.contains(e.relatedTarget)) this.clearDrop(); });
  }
  buildFoot() {
    const app = this.app, f = this.foot;
    const b = (ic, title, fn) => { const x = h('button', { title }, icon(ic, true)); x.onclick = fn; return x; };
    f.append(
      b('fx', 'Gradient overlay', () => app.run('layer.style.gradOverlay')),
      b('adj', 'New fill or adjustment layer', e => this.adjMenu(e)),
      b('mask', 'Add layer mask (⌥: hide all)', e => app.run(e.altKey ? 'layer.mask.hide' : app.doc && app.doc.selection.active ? 'layer.mask.revealSel' : 'layer.mask.reveal')),
      b('folder', 'New group', () => app.run('layer.newGroup')),
      b('dup', 'Duplicate layer (⌘J, or ⌥-drag a layer)', () => app.run('layer.duplicate')),
      b('plus', 'New layer', () => app.run('layer.new')),
      b('trash', 'Delete layer', () => app.run('layer.delete')));
  }
  adjMenu(e) {
    const app = this.app, items = [['fill.solid', 'Solid Color…'], ['fill.gradient', 'Gradient…'], null, ...Object.keys(ADJUSTMENTS).map(k => ['adj.' + k, ADJUSTMENTS[k].name + '…']), null, ['sbfx.noir', 'SB FX…']];
    popMenu(e.currentTarget, items, id => app.run('layer.new.' + id));
  }
  render() {
    const app = this.app, d = app.doc;
    this.tabs.innerHTML = '';
    for (const [k, n] of [['layers', 'Layers'], ['history', 'History']]) this.tabs.append(h('span' + (this.tab === k ? '.on' : ''), { on: { click: () => { this.tab = k; this.render(); } } }, n));
    const isL = this.tab === 'layers';
    this.head.classList.toggle('hide', !isL); this.list.classList.toggle('hide', !isL); this.foot.classList.toggle('hide', !isL); this.hist.classList.toggle('hide', isL);
    if (!isL) return this.renderHistory();
    this.head.innerHTML = ''; this.list.innerHTML = '';
    if (!d) return;
    const a = d.active;
    // header: blend, opacity, locks, fill
    if (a) {
      const bs = blendSelect(a.blend, v => d.setProps(a, { blend: v }, 'Blending Change'), a.isGroup, '', v => {   // live preview while scrubbing the list
        const orig = bs.value; a.blend = v == null ? orig : v; a.touch(); app.view.invalidate();
      });
      if (a.type === 'adjust') bs.disabled = false;
      const op = num({ value: Math.round(a.opacity * 100), min: 0, max: 100, unit: '%', width: 56, onChange: (v, fin) => { a.opacity = v / 100; a.touch(); app.view.invalidate(); if (fin) d.setProps(a, { opacity: v / 100 }, 'Opacity', 'op'); } });
      const fill = num({ value: Math.round(a.fill * 100), min: 0, max: 100, unit: '%', width: 56, onChange: (v, fin) => { a.fill = v / 100; a.touch(); app.view.invalidate(); if (fin) d.setProps(a, { fill: v / 100 }, 'Fill Opacity', 'fill'); } });
      if (a.isGroup || a.type === 'adjust') fill.disabled = true;
      const lk = (k, ic, title) => { const x = h('button' + (a.lock[k] ? '.on' : ''), { title }, icon(ic, true)); x.onclick = () => d.setProps(a, { lock: { ...a.lock, [k]: !a.lock[k] } }, 'Lock'); return x; };
      this.head.append(bs, h('span.kv', h('span.lbl', 'Opacity'), op),
        h('span.locks', h('span.lbl', 'Lock'), lk('alpha', 'lockAlpha', 'Lock transparent pixels'), lk('px', 'lockPx', 'Lock image pixels'), lk('pos', 'lockPos', 'Lock position'), lk('all', 'lock', 'Lock all')),
        h('span.kv', h('span.lbl', 'Fill'), fill));
    }
    for (const { layer: l, depth } of d.displayList()) this.list.append(...this.row(l, depth));
    this.list.append(h('div', { style: { height: '20px' }, on: { click: () => { } } }));
  }
  /** select the displayed rows between the anchor and l; l becomes active */
  selectRange(l) {
    const d = this.app.doc, rows = d.displayList().map(x => x.layer);
    let i = rows.findIndex(x => x.id === this.anchor);
    if (i < 0) i = rows.indexOf(d.active);
    const j = rows.indexOf(l);
    if (i < 0) { d.setActive(l); this.anchor = l.id; return; }
    d.setActive(l);
    d.selected = new Set(rows.slice(Math.min(i, j), Math.max(i, j) + 1).map(x => x.id));
  }
  row(l, depth) {
    const app = this.app, d = app.doc, out = [];
    const sel = d.selected.has(l.id);
    const r = h('div.layer' + (sel ? '.on' : '') + (depth ? '.child' + Math.min(4, depth) : ''), { draggable: true });
    r.dataset.id = l.id;
    const eye = h('span.eye' + (l.visible ? '' : '.off'), { title: 'Show / hide (⌥-click: only this one)' }, icon('eye', true));
    eye.onclick = e => { e.stopPropagation(); if (e.altKey) return app.run('layer.solo', l); d.setProps(l, { visible: !l.visible }, l.visible ? 'Hide Layer' : 'Show Layer'); };
    const tb = h('span.thumbs');
    if (l.isGroup) {
      // arrow or folder: open / close this group; ⌥: every group the same way
      const flip = e => { e.stopPropagation(); const v = !l.open; if (e.altKey) d.walk(x => { if (x.isGroup) x.open = v; }); else l.open = v; this.render(); };
      const tw = h('span.twist' + (l.open ? '.open' : ''), { title: (l.open ? 'Close' : 'Open') + ' group (⌥: all groups)' }, h('span', { html: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M3.5 1.5 7 5l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' }));
      const fd = h('span.thumb.icon', { title: (l.open ? 'Close' : 'Open') + ' group (⌥: all groups)' }, icon('folder'));
      tw.onclick = flip; fd.onclick = flip;
      tb.append(tw, fd);
    } else tb.append(h('span.twist.none'));
    if (l.isGroup) { /* folder added above */ } else if (l.type === 'text') tb.append(h('span.thumb', { style: { fontWeight: 700, fontSize: '15px' } }, 'T'));
    else if (l.type === 'fill') tb.append(h('span.thumb', { style: { background: l.kind === 'solid' ? C.hex(l.color) : gradientCSS(l.gradient), backgroundSize: 'auto, 6px 6px' } }));
    else if (l.type === 'adjust') tb.append(h('span.thumb.icon', icon('adj')));
    else { const t = h('span.thumb' + (l.mask && !l.maskEdit ? '.sel' : '')); t.append(thumb(l, d)); tb.append(t); }
    if (l.mask) {
      const ch = h('span.mlink', { title: 'Link mask to layer' }, l.mask.linked ? icon('chain', true) : h('span', { style: { width: '14px', display: 'inline-block' } }));
      ch.onclick = e => { e.stopPropagation(); l.mask.linked = !l.mask.linked; this.render(); };
      const mt = h('span.thumb.mask' + (l.maskEdit ? '.sel' : '') + (l.mask.enabled ? '' : '.off'), { title: 'Layer mask — click: paint on the mask, ⇧-click: disable' });
      mt.append(maskThumb(l, d));
      mt.onclick = e => { e.stopPropagation(); if (e.shiftKey) { d.edit(l.mask.enabled ? 'Disable Mask' : 'Enable Mask', () => { l.mask.enabled = !l.mask.enabled; l.touch(); }, () => { l.mask.enabled = !l.mask.enabled; l.touch(); }); return; } d.setActive(l); l.maskEdit = true; app.emit('change', 'active'); };
      tb.append(ch, mt);
      if (l.type !== 'pixel' && !l.isGroup) { }
    }
    const name = h('b', l.name);
    const kind = l.isGroup ? 'Group' : l.type === 'text' ? 'Text' : l.type === 'fill' ? (l.kind === 'solid' ? 'Color fill' : 'Gradient fill') : l.type === 'adjust' ? (l.adj === 'sbfx' ? sbLayerTitle(l.params) + ' layer' : ADJUSTMENTS[l.adj].name) : 'Pixel';
    const sub = h('small', `${blendName(l.blend)}${l.opacity < 1 ? ' · ' + Math.round(l.opacity * 100) + '%' : ''} · ${kind}`);
    const ln = h('span.lname', name, sub);
    name.ondblclick = e => { e.stopPropagation(); this.rename(l, ln); };
    const badges = h('span.badges');
    if (l.clip) badges.append(h('span.clipmark', { title: 'Clipped to the layer below' }, '↳'));
    if (l.style.gradOverlay) badges.append(h('span.badge.fx', 'fx'));
    if (l.filters.length) badges.append(h('span.badge.fx', { title: 'Live filters' }, 'live'));
    if (l.lock.all || l.lock.px || l.lock.pos || l.lock.alpha) {
      const lk = h('span.lockmark', { title: l.isBackground ? 'Click to make a normal layer' : 'Click to unlock' }, icon('lock', true));
      lk.onclick = e => { e.stopPropagation(); app.run('layer.unlockAll', l); };
      badges.append(lk);
    }
    r.append(eye, tb, ln, badges);
    r.oncontextmenu = e => {
      e.preventDefault();
      if (!d.selected.has(l.id)) { d.setActive(l); app.emit('change', 'active'); }
      const many = d.selected.size > 1;
      popMenu(r, [['layer.duplicate', many ? 'Duplicate Layers' : 'Duplicate Layer'], many ? ['layer.mergeSelected', 'Merge Selected  ⌘E'] : ['layer.mergeDown', 'Merge Down  ⌘E'], null, ['layer.delete', many ? 'Delete Layers' : 'Delete Layer']], id => app.run(id), { x: e.clientX, y: e.clientY });
    };
    r.onclick = e => {
      // ⇧: every row from the anchor (last plain / ⌘ click) to this one; ⌘: toggle one
      if (e.shiftKey && !e.metaKey) this.selectRange(l);
      else { if (e.metaKey) d.setActive(l, true); else d.setActive(l); this.anchor = l.id; }
      if (l.maskEdit && !e.target.closest('.thumb.mask')) l.maskEdit = false;
      if (e.altKey && !e.shiftKey) app.run('layer.clip.toggle');
      app.emit('change', 'active');
      if (e.metaKey && e.target.closest('.thumb')) app.run('select.layerPixels', l);
    };
    r.addEventListener('dragstart', e => { this.dragId = l.id; e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', l.id); });
    r.addEventListener('dragend', () => this.clearDrop());
    out.push(r);
    // style + live filter sub rows
    const ov = l.style.gradOverlay;
    if (ov) {
      const e = h('span.eye' + (ov.enabled === false ? '.off' : ''), icon('eye', true));
      e.onclick = ev => { ev.stopPropagation(); d.setProps(l, { style: { ...l.style, gradOverlay: { ...ov, enabled: ov.enabled === false } } }, 'Layer Style'); };
      out.push(h('div.subrow', { style: { paddingLeft: 64 + depth * 16 + 'px' }, on: { click: () => { d.setActive(l); app.panels.props.focus = 'style'; app.emit('change', 'active'); } } }, e, h('span', { style: { width: '22px', height: '9px', borderRadius: '2px', background: gradientCSS(ov), backgroundSize: 'auto,6px 6px' } }), 'Gradient overlay'));
    }
    const tbx = l.style.textBox;
    if (tbx) {
      const e = h('span.eye' + (tbx.enabled === false ? '.off' : ''), icon('eye', true));
      e.onclick = ev => { ev.stopPropagation(); d.setProps(l, { style: { ...l.style, textBox: { ...tbx, enabled: tbx.enabled === false } } }, 'Text Box'); };
      const sw = tbx.fill === 'gradient' && tbx.gradient ? gradientCSS(tbx.gradient) : `rgb(${tbx.color.r},${tbx.color.g},${tbx.color.b})`;
      out.push(h('div.subrow', { style: { paddingLeft: 64 + depth * 16 + 'px' }, on: { click: () => { d.setActive(l); app.panels.props.focus = 'textbox'; app.emit('change', 'active'); } } }, e, h('span', { style: { width: '22px', height: '9px', borderRadius: '2px', background: sw, backgroundSize: 'auto,6px 6px' } }), tbx.invert ? 'Text box (inverted)' : 'Text box'));
    }
    l.filters.forEach((f, i) => {
      const e = h('span.eye' + (f.visible === false ? '.off' : ''), icon('eye', true));
      e.onclick = ev => { ev.stopPropagation(); const fl = l.filters.map((x, j) => j === i ? { ...x, visible: x.visible === false } : x); d.setProps(l, { filters: fl }, 'Live Filter'); };
      out.push(h('div.subrow', { style: { paddingLeft: 64 + depth * 16 + 'px' }, on: { click: () => { d.setActive(l); app.panels.props.focus = 'filter:' + i; app.emit('change', 'active'); } } }, e, h('span.badge.fx', 'live'), (FILTERS[f.type] || { name: f.type }).name));
    });
    return out;
  }
  rename(l, ln) {
    const d = this.app.doc, inp = h('input', { value: l.name, spellcheck: false });
    ln.firstChild.replaceWith(inp); inp.focus(); inp.select();
    const done = ok => { if (ok && inp.value.trim() && inp.value !== l.name) d.setProps(l, { name: inp.value.trim() }, 'Rename Layer'); else this.render(); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }
  clearDrop() { $$('.drop-above,.drop-below,.drop-into', this.list).forEach(x => x.classList.remove('drop-above', 'drop-below', 'drop-into')); this.dropAt = null; }
  dragOver(e) {
    if (!this.dragId) return; e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
    const row = e.target.closest('.layer'); this.clearDrop(); if (!row) return;
    const d = this.app.doc, l = d.find(row.dataset.id), r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
    let where = y < 0.5 ? 'above' : 'below';
    if (l.isGroup && y > 0.25 && y < 0.75) where = 'into';
    row.classList.add('drop-' + where); this.dropAt = { l, where };
  }
  drop(e) {
    e.preventDefault(); const t = this.dropAt, d = this.app.doc; this.clearDrop();
    const moving = d.find(this.dragId), copy = e.altKey; this.dragId = null;
    if (!t || !moving || (t.l === moving && !copy)) return;
    let parent, index;
    if (t.where === 'into') { parent = t.l; index = t.l.children.length; }
    else { parent = t.l.parent; index = parent.children.indexOf(t.l) + (t.where === 'above' ? 1 : 0); }   // children are bottom->top
    if (copy) {   // ⌥: drop copies; dragging one of several selected layers copies them all
      const sel = d.selected.has(moving.id) ? d.selectedLayers().filter(l => !l.parent || !d.selected.has(l.parent.id)) : [moving];
      for (let p = parent; p; p = p.parent) if (sel.includes(p)) return;   // not into a group being copied
      return this.app.run('layer.copyTo', sel, parent, index);
    }
    // dragging one of several selected layers moves them all, in their stacking order
    const sel = d.selected.has(moving.id) ? d.all().filter(l => d.selected.has(l.id) && !l.isBackground && !(l.parent && d.selected.has(l.parent.id))) : [moving];
    for (let p = parent; p; p = p.parent) if (sel.includes(p)) return;   // not into itself
    if (sel.length > 1) return d.moveLayers(sel, parent, index);
    for (let p = t.l; p; p = p.parent) if (p === moving) return;
    d.moveLayer(moving, parent, index);
  }
  renderHistory() {
    const d = this.app.doc, el = this.hist; el.innerHTML = '';
    if (!d) return;
    const H = d.history;
    el.append(h('div' + (H.index === 0 ? '.on' : ''), { on: { click: () => H.goto(0) } }, d.openedAs || 'Open'));
    H.list.forEach((e, i) => el.append(h('div' + (i + 1 === H.index ? '.on' : i + 1 > H.index ? '.fut' : ''), { on: { click: () => H.goto(i + 1) } }, e.label)));
    const on = el.querySelector('.on'); on && on.scrollIntoView({ block: 'nearest' });
  }
}

/** a little popup menu under anchor; items [[id, label]] or null for a separator */
export function popMenu(anchor, items, onPick, at = null) {   // at {x, y}: open there (a right-click menu)
  const m = h('div.drop', { style: { display: 'block', position: 'fixed' } });
  for (const it of items) {
    if (!it) { m.append(h('div.sep')); continue; }
    m.append(h('div.mi', { on: { click: () => { close(); onPick(it[0]); } } }, h('span', it[1])));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect(), mh = m.offsetHeight;
  m.style.left = Math.min(window.innerWidth - 250, at ? at.x : r.left) + 'px';
  m.style.top = (at ? Math.max(8, Math.min(at.y, window.innerHeight - mh - 8)) : r.top - mh - 6 > 0 ? r.top - mh - 6 : r.bottom + 6) + 'px';
  const close = () => { m.remove(); window.removeEventListener('pointerdown', off, true); };
  const off = e => { if (!m.contains(e.target)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', off, true), 0);
}
export { colorPop, select, round };
