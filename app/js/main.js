// Boot: build the app, wire the compositor hooks, tools, commands, menus,
// panels, the native bridge, autosave.

import { App, DEFAULT_PREFS } from './app.js';
import { View } from './view.js';
import { UI } from './ui/shell.js';
import { Panels } from './ui/panels.js';
import { Menus } from './ui/menus.js';
import { registerCommands, openEntry } from './commands.js';
import { bridge } from './bridge.js';
import { fonts } from './text.js';
import { liveSource } from './filters.js';
import { warpPreset, buildMesh } from './transform.js';
import { Autosave } from './io/autosave.js';
import { FILTERS } from './filters.js';
import { moveTool, handTool, zoomTool, eyedropperTool } from './tools/basic.js';
import { marqueeTool, ellipseTool, lassoTool, selBrushTool } from './tools/select.js';
import { brushTool, eraserTool, fillTool, gradientTool } from './tools/paint.js';
import { textTool } from './tools/text.js';
import { transformTool } from './tools/transform.js';
import { cropTool, casTool } from './tools/crop.js';
import { native } from './util.js';

/** zoom / spin blur centre: drag on the canvas while editing those filters */
const fxCenterTool = {
  id: 'fxcenter', name: 'Filter center', icon: 'zoom', cursor: 'crosshair', hidden: true,
  target(app) {
    if (app.fxSession) return { params: app.fxSession.params, set: p => { app.fxSession.params = p; app.fxPreview(true); } };
    const e = app.fxCenterEdit; if (e && e.layer.filters[e.index]) return { params: e.layer.filters[e.index].params, set: p => { const fl = e.layer.filters.map((f, i) => i === e.index ? { ...f, params: p } : f); e.layer.filters = fl; e.layer.touch(); app.fxInteractive = true; app.view.invalidate(); } };
    return null;
  },
  down(e, app) { this.on = true; this.move(e, app); },
  move(e, app) { if (!this.on) return; const t = this.target(app); if (!t) return; t.set({ ...t.params, cx: e.x, cy: e.y }); },
  up(e, app) { this.on = false; if (app.fxSession) app.fxPreview(false); else { app.fxInteractive = false; app.view.invalidate(); } },
  overlay(c, view) {
    const t = this.target(view.app); if (!t || t.params.cx == null) return;
    const s = view.toScreen(t.params.cx, t.params.cy);
    c.save(); c.strokeStyle = '#000'; c.lineWidth = 3; c.beginPath(); c.arc(s.x, s.y, 11, 0, 7); c.stroke(); c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(s.x, s.y, 11, 0, 7); c.moveTo(s.x - 5, s.y); c.lineTo(s.x + 5, s.y); c.moveTo(s.x, s.y - 5); c.lineTo(s.x, s.y + 5); c.stroke(); c.restore();
  },
  options(app) { const l = document.createElement('span'); l.className = 'lbl'; l.textContent = 'Drag on the canvas to move the blur center'; return l; },
};

async function boot() {
  const app = new App();
  window.stlvApp = app;
  try { const p = await bridge.getData('settings.json'); if (p) app.prefs = { ...structuredClone(DEFAULT_PREFS), ...p, snapTo: { ...DEFAULT_PREFS.snapTo, ...(p.snapTo || {}) } }; } catch { }
  const ui = new UI(app);
  app.view = new View(app);
  for (const t of [moveTool, marqueeTool, ellipseTool, lassoTool, selBrushTool, cropTool, eyedropperTool, brushTool, eraserTool, fillTool, gradientTool, textTool, handTool, zoomTool, transformTool, casTool, fxCenterTool]) app.register(t);
  registerCommands(app);
  app.panels = new Panels(app);
  new Menus(app);
  ui.build();
  app.setTool('move');

  // compositor hooks: live filters replace a layer's source; transforms / warped text draw through a mesh
  const comp = app.view.comp;
  comp.hooks.redraw = () => app.view.invalidate();
  comp.hooks.source = layer => {
    if (!layer.filters || !layer.filters.some(f => f.visible !== false)) return null;
    const base = layer.type === 'pixel' ? { canvas: layer.canvas, x: layer.x, y: layer.y, rev: layer.rev } : layer.type === 'text' && layer.raster ? { canvas: layer.raster.canvas, x: layer.raster.x, y: layer.raster.y, rev: layer.raster.rev } : null;
    try { return liveSource(layer, base, app.fxInteractive); } catch (e) { console.error(e); return null; }
  };
  const warpCache = new WeakMap();
  comp.hooks.mesh = layer => {
    const t = app.transformSession && app.transformSession.meshFor(layer); if (t) return t;
    const c = app.casSession && app.casSession.meshFor(layer); if (c) return c;
    if (layer.type === 'text' && layer.warp && layer.warp.style !== 'none' && layer.raster) {
      const src = comp.hooks.source(layer) || layer.raster, w = layer.warp, b = layer.raster.bounds;
      const key = `${src.x},${src.y},${src.canvas.width},${src.canvas.height},${JSON.stringify(w)},${b.x},${b.y},${b.w},${b.h}`;
      let e = warpCache.get(layer);
      if (!e || e.key !== key) {
        e = { key, verts: buildMesh((u, v) => { const px = src.x + u * src.canvas.width, py = src.y + v * src.canvas.height; return warpPreset(w.style, w.bend, w.hd || 0, w.vd || 0, (px - b.x) / b.w, (py - b.y) / b.h, b); }, 40) };
        warpCache.set(layer, e);
      }
      return { verts: e.verts, interp: 1 };
    }
    return null;
  };

  // native bridge
  let lastCmd = { id: null, t: 0 };
  bridge.on('command', raw => {
    const [id, arg] = raw.split(/\|(.*)/s);
    // the page may already have handled the same shortcut from keydown
    if (ui.lastKeyCmd && ui.lastKeyCmd.id === id && performance.now() - ui.lastKeyCmd.t < 250) return;
    if (lastCmd.id === raw && performance.now() - lastCmd.t < 80) return;
    lastCmd = { id: raw, t: performance.now() };
    app.run(id, arg);
  });
  const isTyping = el => !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && !/^(checkbox|radio|range|button|color|file)$/.test(el.type)));
  let typing = false;
  const sync = () => { const t = isTyping(document.activeElement); if (t !== typing) bridge.typing(typing = t); };
  document.addEventListener('focusin', sync); document.addEventListener('focusout', () => setTimeout(sync, 0));
  bridge.on('open', list => { for (const e of list) app.run('file.openFile', e); });
  bridge.on('quit', async () => {
    for (const d of [...app.docs]) {
      if (!d.history.dirty) continue;
      app.activate(d);
      const r = await ui.confirm(`Save changes to “${d.name}” before quitting?`, 'Your changes will be lost if you don’t save them.', ['Save', "Don't Save", 'Cancel']);
      if (r === 2 || r === null) return;
      if (r === 0 && !(await app.run('file.save'))) return;
    }
    await app.autosave.clearAll();
    bridge.terminate();
  });
  if (!native) window.addEventListener('beforeunload', e => { if (app.docs.some(d => d.history.dirty)) { e.preventDefault(); e.returnValue = ''; } });

  // delete / backspace: clear selected pixels, or delete the layer
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || document.querySelector('.scrim')) return;
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if ((e.key === 'Backspace' || e.key === 'Delete') && app.doc && !e.metaKey) { e.preventDefault(); app.run(app.doc.selection.active ? 'edit.clear' : 'layer.delete'); }
  });
  window.addEventListener('error', e => bridge.log(String(e.message) + ' @ ' + e.filename + ':' + e.lineno));
  if (window.stlvNative) { const ce = console.error.bind(console); console.error = (...a) => { ce(...a); bridge.log(a.map(x => x && x.message ? x.message + ' ' + (x.stack || '') : String(x)).join(' ')); }; }
  window.addEventListener('unhandledrejection', e => bridge.log('unhandled: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  document.getElementById('viewport').addEventListener('pointerdown', () => { app.autosave.pointerDown = true; });
  window.addEventListener('pointerup', () => { app.autosave.pointerDown = false; });

  app.autosave = new Autosave(app);
  fonts.init().then(() => { ui.buildOptions(); app.panels.props.render(); });
  const testing = /[?&]test\b/.test(location.search) || (window.stlvNative && window.stlvNative.test);
  if (!testing) await app.autosave.recover();
  app.updateTitle();
  if (testing) { const m = await import('../tests/tests.js'); await m.run(); }
  return app;
}
boot().catch(e => { console.error(e); document.body.innerHTML = `<pre style="color:#f88;padding:20px;white-space:pre-wrap">stlv failed to start:\n${e.stack || e}</pre>`; bridge.log('boot failed: ' + e.message + '\n' + (e.stack || '')); });
export { openEntry, FILTERS };
