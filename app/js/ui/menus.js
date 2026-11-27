// The menu model: one definition drives the native macOS menu bar (in the
// app) and the in-app menus (in a browser), plus keyboard shortcut matching.

import { h, $, native, isMac, debounce } from '../util.js';
import { bridge } from '../bridge.js';
import { ADJUSTMENTS } from '../adjust.js';
import { SB_GROUPS, SB_NAMES } from '../sbfx.js';
const sbLayerItems = () => SB_GROUPS.flatMap(([, modes], i) => [...(i ? [SEP] : []), ...modes.map(m => S(SB_NAMES[m], 'layer.new.sbfx.' + m))]);
import { FILTERS, FILTER_GROUPS } from '../filters.js';

const S = (title, id, key, extra) => ({ title, id, key, ...extra });
const SUB = (title, items) => ({ title, items });
const SEP = { sep: true };

function model(app) {
  const recent = (app.prefs.recent || []).map(p => S(p.split('/').pop(), 'file.openRecent', null, { arg: p }));
  return [
    { title: 'File', items: [S('New…', 'file.new', '⌘N'), S('Open…', 'file.open', '⌘O'),
      SUB('Open Recent', recent.length ? [...recent, SEP, S('Clear Menu', 'file.clearRecent')] : [S('No recent files', null)]), SEP,
      SUB('Place Image', [S('Fit to Canvas…', 'file.place.fit'), S('Fill Canvas…', 'file.place.fill'), S('Stretch to Canvas…', 'file.place.stretch'), S('Original Size…', 'file.place.original')]), SEP,
      S('Close', 'file.close', '⌘W'), S('Close All', 'file.closeAll', '⌥⌘W'), S('Save', 'file.save', '⌘S'), S('Save As…', 'file.saveAs', '⇧⌘S'), S('Revert', 'file.revert'), SEP,
      S('Export As…', 'file.export', '⌥⇧⌘W'), S('Quick Export as PNG', 'file.quickExport', "⇧⌘'"),
      ...(native ? [] : [SEP, S('Settings…', 'app.settings', '⌘,')])] },
    { title: 'Edit', items: [S('Undo', 'edit.undo', '⌘Z'), S('Redo', 'edit.redo', '⇧⌘Z'), SEP,
      S('Cut', 'edit.cut', '⌘X'), S('Copy', 'edit.copy', '⌘C'), S('Copy Merged', 'edit.copyMerged', '⇧⌘C'), S('Paste', 'edit.paste', '⌘V'), S('Paste in Place', 'edit.pasteInPlace', '⇧⌘V'), S('Clear', 'edit.clear'), SEP,
      S('Fill…', 'edit.fill', '⇧F5'), S('Stroke…', 'edit.stroke'), SEP,
      S('Free Transform', 'edit.transform', '⌘T'),
      SUB('Transform', [S('Scale / Rotate / Skew', 'edit.transform.free'), S('Distort', 'edit.transform.distort'), S('Perspective', 'edit.transform.perspective'), S('Warp', 'edit.transform.warp'), SEP,
        S('Rotate 180°', 'edit.rot180'), S('Rotate 90° Clockwise', 'edit.rotcw'), S('Rotate 90° Counter Clockwise', 'edit.rotccw'), SEP, S('Flip Horizontal', 'edit.flipH'), S('Flip Vertical', 'edit.flipV')]),
      S('Content-Aware Scale', 'edit.cas', '⌥⇧⌘C')] },
    { title: 'Image', items: [SUB('Adjustments', [S('Brightness / Contrast…', 'image.adjust.bc'), S('Levels…', 'image.adjust.levels', '⌘L'), S('Curves…', 'image.adjust.curves', '⌘M'), S('Hue / Saturation…', 'image.adjust.hs', '⌘U'), S('Vibrance…', 'image.adjust.vibrance'), S('Black & White…', 'image.adjust.bw', '⌥⇧⌘B'), S('Invert', 'image.adjust.invert', '⌘I'), S('Threshold…', 'image.adjust.threshold'), S('Dehaze…', 'image.adjust.dehaze')]), SEP,
      S('Image Size…', 'image.size', '⌥⌘I'), S('Canvas Size…', 'image.canvasSize', '⌥⌘C'), S('Content-Aware Resize…', 'image.cas'),
      SUB('Image Rotation', [S('180°', 'image.rot180'), S('90° Clockwise', 'image.rotcw'), S('90° Counter Clockwise', 'image.rotccw'), SEP, S('Flip Canvas Horizontal', 'image.flipH'), S('Flip Canvas Vertical', 'image.flipV')]), SEP,
      S('Crop to Selection', 'image.cropToSelection'), S('Trim Transparent Pixels', 'image.trim')] },
    { title: 'Layer', items: [S('New Layer', 'layer.new', '⇧⌘N'), S('New Group', 'layer.newGroup'), S('Duplicate Layer', 'layer.duplicate', '⌘J'), S('Layer via Copy', 'layer.viaCopy'), S('Layer via Cut', 'layer.viaCut', '⇧⌘J'), S('Delete Layer', 'layer.delete'), SEP,
      SUB('New Fill Layer', [S('Solid Color', 'layer.new.fill.solid'), S('Gradient', 'layer.new.fill.gradient')]),
      SUB('New Adjustment Layer', Object.keys(ADJUSTMENTS).map(k => S(ADJUSTMENTS[k].name, 'layer.new.adj.' + k))), SUB('New SB FX Layer', sbLayerItems()), SEP,
      SUB('Layer Style', [S('Gradient Overlay…', 'layer.style.gradOverlay'), S('Text Box…', 'layer.style.textBox'), SEP, S('Clear Layer Style', 'layer.style.clear')]),
      SUB('Layer Mask', [S('Reveal All', 'layer.mask.reveal'), S('Hide All', 'layer.mask.hide'), S('Reveal Selection', 'layer.mask.revealSel'), S('Hide Selection', 'layer.mask.hideSel'), SEP, S('Invert Mask', 'layer.mask.invert'), S('Disable / Enable Mask', 'layer.mask.toggle'), S('Apply Mask', 'layer.mask.apply'), S('Delete Mask', 'layer.mask.delete'), SEP, S('Paint on Mask / Layer', 'layer.mask.target', 'Q')]),
      S('Create / Release Clipping Mask', 'layer.clip.toggle', '⌥⌘G'), SEP,
      S('Group Layers', 'layer.group', '⌘G'), S('Ungroup Layers', 'layer.ungroup', '⇧⌘G'),
      SUB('Arrange', [S('Bring to Front', 'layer.arrange.front', '⇧⌘]'), S('Bring Forward', 'layer.arrange.forward', '⌘]'), S('Send Backward', 'layer.arrange.backward', '⌘['), S('Send to Back', 'layer.arrange.back', '⇧⌘[')]), SEP,
      S('Rasterize', 'layer.rasterize'), S('Layer from Background', 'layer.unlockBackground'), SEP,
      S('Merge Down', 'layer.mergeDown', '⌘E'), S('Merge Selected', 'layer.mergeSelected'), S('Merge Visible', 'layer.mergeVisible', '⇧⌘E'), S('Flatten Image', 'layer.flatten')] },
    { title: 'Select', items: [S('All', 'select.all', '⌘A'), S('Deselect', 'select.none', '⌘D'), S('Reselect', 'select.reselect', '⇧⌘D'), S('Inverse', 'select.inverse', '⇧⌘I'), SEP,
      S('Load Layer Pixels', 'select.layerPixels'), SEP,
      SUB('Modify', [S('Border…', 'select.border'), S('Smooth…', 'select.smooth'), S('Expand…', 'select.expand'), S('Contract…', 'select.contract'), S('Feather…', 'select.feather', '⇧F6')])] },
    { title: 'Filter', items: [S('Last Filter', 'filter.last', '⌃⌘F'), SEP, ...FILTER_GROUPS.map(g => SUB(g, Object.entries(FILTERS).filter(([, f]) => f.group === g).flatMap(([k, f], i, all) => [...(i && f.sub !== all[i - 1][1].sub ? [SEP] : []), S((f.short || f.name) + '…', 'filter.' + k)]).concat(g === 'SB FX' ? [SEP, SUB('As a Layer (everything below)', sbLayerItems())] : [])))] },
    { title: 'View', items: [S('Zoom In', 'view.zoomIn', '⌘='), S('Zoom Out', 'view.zoomOut', '⌘-'), S('Fit on Screen', 'view.fit', '⌘0'), S('Fill Screen', 'view.fill'), S('100%', 'view.actual', '⌘1'), SEP,
      S('Rulers', 'view.rulers', '⌘R'), S('Guides', 'view.guides', '⌘;'), S('Grid', 'view.grid', "⌘'"), S('Pixel Grid', 'view.pixelGrid'), SEP,
      S('Snap', 'view.snap', '⇧⌘;'), SUB('Snap To', [S('Guides', 'view.snapTo.guides'), S('Canvas Edges', 'view.snapTo.canvas'), S('Layers', 'view.snapTo.layers')]), SEP,
      S('New Guide…', 'view.newGuide'), S('New Guide Layout…', 'view.guideLayout'), S('Lock Guides', 'view.lockGuides', '⌥⌘;'), S('Clear Guides', 'view.clearGuides'), SEP,
      SUB('Ruler Units', [['px', 'Pixels'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters'], ['pt', 'Points'], ['pct', 'Percent']].map(([u, n]) => S(n, 'view.units.' + u)))] },
    { title: 'Window', items: [S('Next Document', 'window.next', '⌃⇥'), SEP, SUB('Skin', ['mono', 'violet', 'paper', 'terminal', 'ember', 'ice', 'wyrm'].map(k => S(k[0].toUpperCase() + k.slice(1), 'window.skin.' + k))),
      ...(native ? [] : [SEP, S('About stlv', 'app.about')])] },
  ];
}
// shortcuts that aren't in a menu
const HIDDEN = [['⌘+', 'view.zoomIn'], ['⇧⌘=', 'view.zoomIn'], ['⌥[', 'layer.prev'], ['⌥]', 'layer.next'], ['F5', 'edit.fill']];

function parse(spec) {
  if (!spec) return null;
  const m = { cmd: spec.includes('⌘'), shift: spec.includes('⇧'), alt: spec.includes('⌥'), ctrl: spec.includes('⌃') };
  let key = spec.replace(/[⌘⇧⌥⌃]/g, '');
  if (key === '⇥') key = 'Tab';
  return { ...m, key: key.length === 1 ? key.toLowerCase() : key };
}
const CODE_KEYS = { Semicolon: ';', Quote: "'", Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`' };
function eventKey(e) {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (CODE_KEYS[e.code]) return CODE_KEYS[e.code];
  if (e.key === '+') return '+';
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}
const NS_F = { F1: '', F2: '', F3: '', F4: '', F5: '', F6: '', F7: '', F8: '', Tab: '\t' };

export class Menus {
  constructor(app) {
    this.app = app; app.menus = this;
    this.build();
    const stateSoon = debounce(() => this.pushState(), 120);
    for (const ev of ['doc', 'change', 'prefs', 'tool', 'zoom']) app.on(ev, stateSoon);
    if (!native) this.bindInApp();
  }
  build() {
    this.model = model(this.app);
    this.keys = [];
    const walk = items => { for (const it of items) { if (it.items) walk(it.items); else if (it.key && it.id) this.keys.push({ ...parse(it.key), id: it.id, arg: it.arg }); } };
    for (const m of this.model) walk(m.items);
    for (const [k, id] of HIDDEN) this.keys.push({ ...parse(k), id });
    if (native) bridge.menu(this.model.map(m => this.nativeMenu(m)));
    else this.renderInApp();
  }
  sync() { this.build(); }
  nativeMenu(m) {
    const conv = it => {
      if (it.sep) return { sep: true };
      if (it.items) return { title: it.title, items: it.items.map(conv) };
      const k = parse(it.key), c = it.id && this.app.commands[it.id];
      const mods = k ? [k.cmd && 'cmd', k.shift && 'shift', k.alt && 'alt', k.ctrl && 'ctrl'].filter(Boolean) : [];
      // single letters without ⌘ are tool-style keys: show them, but let the page handle them
      const key = k && (k.cmd || k.ctrl) ? (NS_F[k.key] || k.key) : k && NS_F[k.key] && (k.shift || k.alt) ? NS_F[k.key] : '';
      return { title: it.title, id: it.id ? (it.arg ? it.id + '|' + it.arg : it.id) : '', key, mods, enabled: !!it.id && (!c || !c.enabled || !!c.enabled(this.app)), checked: c && c.checked ? !!c.checked(this.app) : undefined };
    };
    return { title: m.title, items: m.items.map(conv) };
  }
  pushState() {
    if (native) {
      const items = [];
      const walk = list => { for (const it of list) { if (it.items) walk(it.items); else if (it.id) { const c = this.app.commands[it.id]; if (!c) continue; items.push({ id: it.arg ? it.id + '|' + it.arg : it.id, enabled: !c.enabled || !!c.enabled(this.app), ...(c.checked ? { checked: !!c.checked(this.app) } : {}) }); } } };
      for (const m of this.model) walk(m.items);
      bridge.menuState(items);
    }
  }
  /** a keydown -> command id (or null) */
  match(e) {
    const k = eventKey(e), cmd = isMac ? e.metaKey : e.ctrlKey, ctrl = isMac ? e.ctrlKey : false;
    for (const s of this.keys) {
      if (s.key !== k && !(s.key.length > 1 && s.key === e.key)) continue;
      if (!!s.cmd !== cmd || !!s.shift !== e.shiftKey || !!s.alt !== e.altKey || !!s.ctrl !== ctrl) continue;
      if (s.arg) return null;
      return s.id;
    }
    return null;
  }
  /* ---------- in-app menus (browser) ---------- */
  renderInApp() {
    const el = $('#menus'); if (!el) return; el.innerHTML = '';
    for (const m of this.model) {
      const drop = h('div.drop');
      const menu = h('div.menu', h('button', m.title), drop);
      menu.firstChild.onclick = () => { const open = menu.classList.contains('open'); this.closeAll(); if (!open) { this.fill(drop, m.items); menu.classList.add('open'); } };
      menu.addEventListener('mouseenter', () => { if (document.querySelector('.menu.open') && !menu.classList.contains('open')) { this.closeAll(); this.fill(drop, m.items); menu.classList.add('open'); } });
      el.append(menu);
    }
  }
  fill(drop, items) {
    drop.innerHTML = '';
    for (const it of items) {
      if (it.sep) { drop.append(h('div.sep')); continue; }
      if (it.items) { const sub = h('div.sub'); this.fill(sub, it.items); drop.append(h('div.mi', h('span', it.title), h('span.k', '▸'), sub)); continue; }
      const c = it.id && this.app.commands[it.id], en = !!it.id && (!c || !c.enabled || c.enabled(this.app)), ch = c && c.checked && c.checked(this.app);
      const mi = h('div.mi' + (en ? '' : '.dis') + (ch ? '.chk' : ''), h('span', it.title), h('span.k', it.key || ''));
      if (en) mi.onclick = e => { e.stopPropagation(); this.closeAll(); this.app.run(it.id, it.arg); };
      drop.append(mi);
    }
  }
  closeAll() { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }
  bindInApp() { document.addEventListener('pointerdown', e => { if (!e.target.closest('.menu')) this.closeAll(); }); }
}
