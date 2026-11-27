// The app: open documents, the active tool, colours, settings, commands.
// Everything the UI and tools touch goes through here.

import { Emitter, C, fmtUnit, debounce, native, R } from './util.js';
import { Doc } from './doc.js';
import { bridge } from './bridge.js';

export const DEFAULT_PREFS = {
  skin: 'mono', units: 'px', rulers: true, guides: true, snap: true, snapTo: { guides: true, canvas: true, layers: false },
  grid: false, gridSize: 0, pixelGrid: true, toolOpts: {}, recent: [], swatches: null, history: 100,
  panels: { color: true, props: true, layers: true }, lastNew: null, exportOpts: null, autosave: true, flyerFonts: false, fxWin: null,
};

export class App extends Emitter {
  constructor() {
    super();
    this.docs = []; this.doc = null;
    this.fg = { r: 0, g: 0, b: 0 }; this.bg = { r: 255, g: 255, b: 255 };
    this.prefs = structuredClone(DEFAULT_PREFS);
    this.tools = {}; this.tool = null; this.prevTool = null;
    this.commands = {};
    this.lastFilter = null;
    this.savePrefs = debounce(() => bridge.setData('settings.json', this.prefs), 400);
  }

  /* ---------- documents ---------- */
  newDoc(opts) { const d = new Doc(opts); this.addDoc(d); return d; }
  addDoc(doc) {
    this.docs.push(doc);
    doc.on('change', (kind, info) => this.onDocChange(doc, kind, info));
    this.activate(doc);
    return doc;
  }
  activate(doc) {
    if (this.doc === doc) return;
    if (this.tool && this.tool.leaveDoc) this.tool.leaveDoc(this);
    this.doc = doc;
    if (doc && !doc.view && this.view) this.view.fit();
    this.view && this.view.invalidate();
    this.emit('doc', doc);
    this.updateTitle();
  }
  async closeDoc(doc, force = false) {
    if (!force && doc.history.dirty) {
      const r = await this.ui.confirm(`Save changes to “${doc.name}” before closing?`, 'Your changes will be lost if you don’t save them.', ['Save', "Don't Save", 'Cancel']);
      if (r === 2 || r === null) return false;
      if (r === 0 && !(await this.run('file.save'))) return false;
    }
    if (this.tool && this.tool.leaveDoc && this.doc === doc) this.tool.leaveDoc(this);
    const i = this.docs.indexOf(doc); this.docs.splice(i, 1);
    this.autosave && this.autosave.drop(doc);
    if (this.doc === doc) { this.doc = null; this.activate(this.docs[Math.min(i, this.docs.length - 1)] || null); if (!this.doc) { this.view.invalidate(); this.emit('doc', null); this.updateTitle(); } }
    else this.emit('doc', this.doc);
    if (this.view && this.view.compDoc === doc) { this.view.comp.dispose(); this.view.compDoc = null; this.view.invalidate(); }
    return true;
  }
  onDocChange(doc, kind, info) {
    if (doc !== this.doc) { if (kind === 'history' || kind === 'title') this.emit('tabs'); return; }
    const v = this.view;
    switch (kind) {
      case 'pixels': v.invalidate(info && info.rect ? info.rect : null); break;
      case 'selection': case 'guides': v.redraw(); break;
      case 'history': this.updateTitle(); this.emit('tabs'); break;
      case 'title': this.updateTitle(); this.emit('tabs'); break;
      case 'active': break;
      case 'size': v.comp.dispose(); v.compDoc = null; v.invalidate(); doc.selection.resize && 0; break;
      default: v.invalidate();
    }
    this.emit('change', kind, info);
  }
  updateTitle() {
    const d = this.doc;
    bridge.title(d ? d.name : 'stlv', d ? d.history.dirty : false, d && d.path);
  }

  /* ---------- tools ---------- */
  register(tool) { this.tools[tool.id] = tool; tool.opts = { ...(tool.defaults || {}), ...(this.prefs.toolOpts[tool.id] || {}) }; }
  setTool(id, temp = false) {
    const t = this.tools[id]; if (!t || t === this.tool) return;
    if (this.tool && this.tool.deactivate) this.tool.deactivate(this);
    if (!temp) this.prevTool = null;
    this.tool = t;
    if (t.activate) t.activate(this);
    this.emit('tool', t);
    this.view && this.view.redraw();
  }
  toolOpt(tool, key, value) {
    tool.opts[key] = value;
    this.prefs.toolOpts[tool.id] = { ...tool.opts }; this.savePrefs();
    this.emit('toolopts', tool);
    this.view.redraw();
  }

  /* ---------- colours ---------- */
  setFg(c) { this.fg = { r: c.r, g: c.g, b: c.b }; this.emit('colors'); }
  setBg(c) { this.bg = { r: c.r, g: c.g, b: c.b }; this.emit('colors'); }
  swapColors() { [this.fg, this.bg] = [this.bg, this.fg]; this.emit('colors'); }
  defaultColors() { this.fg = { r: 0, g: 0, b: 0 }; this.bg = { r: 255, g: 255, b: 255 }; this.emit('colors'); }

  /* ---------- commands ---------- */
  command(id, def) { this.commands[id] = def; }
  async run(id, ...args) {
    const c = this.commands[id]; if (!c) { console.warn('no command', id); return; }
    if (c.enabled && !c.enabled(this)) { bridge.beep(); return; }
    try { return await c.run(this, ...args); }
    catch (e) { console.error(e); this.ui.alert('Something went wrong', String(e && e.message || e)); }
  }
  enabled(id) { const c = this.commands[id]; return !!c && (!c.enabled || !!c.enabled(this)); }

  /* ---------- helpers ---------- */
  fmtLen(px) { const d = this.doc, u = this.prefs.units; return fmtUnit(px, u, d ? d.ppi : 72, d ? d.width : 0) + ' ' + (u === 'pct' ? '%' : u); }
  setPref(k, v) { this.prefs[k] = v; this.savePrefs(); this.emit('prefs', k); this.view && (this.view.redraw(), this.view.drawRulers()); }
  /** the active layer, if it can take pixel edits; otherwise explains why */
  editableLayer(kind = 'pixels') {
    const d = this.doc, l = d && d.active;
    if (!l) { this.ui.toast('Select a layer first'); return null; }
    if (kind === 'pixels' && l.type !== 'pixel') { this.ui.toast(l.type === 'text' ? 'Text layers need rasterizing first (Layer > Rasterize)' : l.isGroup ? 'Select a layer inside the group' : 'This layer has no pixels to edit'); return null; }
    if (l.lock.all || (kind === 'pixels' && l.lock.px)) { this.ui.toast('The layer is locked'); return null; }
    if (d.hiddenChain(l)) { this.ui.toast('The layer is hidden'); return null; }
    return l;
  }
  /** what painting tools draw into: the layer, or its mask when the mask is targeted */
  paintTarget() {
    const d = this.doc, l = d && d.active;
    if (l && l.mask && l.maskEdit) {
      if (l.lock.all) { this.ui.toast('The layer is locked'); return null; }
      return { layer: l, mask: true };
    }
    const p = this.editableLayer('pixels');
    return p ? { layer: p, mask: false } : null;
  }
}
export { R, C, native };
