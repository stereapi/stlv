// The window's UI: toolbar, options bar, tabs, status bar, skins, plus
// pointer/keyboard routing to the active tool and small popups (toast, tip,
// busy, confirm).

import { $, h, C, native, clamp, round, fmtBytes, throttleFrame } from '../util.js';
import { icon, num, colorPop } from './widgets.js';
import { bridge } from '../bridge.js';
import { modal } from './dialogs.js';
import { popMenu } from './panels.js';

export const SKINS = { mono: '#c8a0b4', violet: '#a082c8', paper: '#cc2828', terminal: '#22cc44', ember: '#e09010', ice: '#64b4f0', wyrm: '#d6282a' };
// toolbar order; null = separator
export const TOOL_ORDER = ['move', null, 'marquee', 'ellipse', 'lasso', 'selbrush', null, 'crop', 'eyedropper', null, 'brush', 'eraser', 'fill', 'gradient', null, 'text', null, 'hand', 'zoom'];

export class UI {
  constructor(app) {
    this.app = app; app.ui = this;
    if (native) document.body.classList.add('native');
    this.refreshSoon = throttleFrame(kind => this.refresh(kind));
    this.tabsSoon = throttleFrame(() => this.buildTabs());
  }
  build() {
    const app = this.app;
    this.buildSkins(); this.setSkin(app.prefs.skin);
    this.buildTools();
    app.on('tool', () => { this.buildTools(); this.buildOptions(); this.updateCursor(); });
    app.on('toolopts', () => this.updateCursor());
    // the text options bar edits the selected text layers, so it follows the selection (and undo)
    const optsSoon = throttleFrame(() => this.buildOptions());
    app.on('change', kind => { const t = app.tool; if (t && t.id === 'text' && !t.editing && (kind === 'active' || kind === 'all')) optsSoon(); });   // option widgets update themselves; rebuild explicitly when needed
    app.on('colors', () => this.paintColors());
    app.on('doc', () => { this.buildTabs(); this.status(); this.emptyState(); this.buildOptions(); });
    app.on('tabs', () => this.buildTabs());
    app.on('zoom', () => { this.status(); this.tabsSoon(); });
    app.on('change', kind => { if (kind === 'selection' || kind === 'size' || kind === 'all' || kind === 'layers') this.status(); });
    app.on('prefs', k => { if (k === 'rulers') this.rulers(); if (k === 'skin') this.setSkin(app.prefs.skin); this.status(); });
    this.bindViewport(); this.bindKeys(); this.rulers(); this.emptyState(); this.status();
    $('#emptyBtns').append(h('button.btn.pri', { on: { click: () => app.run('file.new') } }, 'New…'), h('button.btn', { on: { click: () => app.run('file.open') } }, 'Open…'));
  }

  /* ---------- skins ---------- */
  buildSkins() {
    const el = $('#skins');
    el.innerHTML = '';
    for (const [k, c] of Object.entries(SKINS)) el.append(h('i', { title: k, style: { background: c }, on: { click: () => this.app.setPref('skin', k) } }));
  }
  setSkin(k) {
    document.documentElement.dataset.skin = k;
    [...$('#skins').children].forEach(i => i.classList.toggle('on', i.title === k));
    this.app.view && (this.app.view.redraw(), this.app.view.drawRulers());
  }
  rulers() { $('#stage').classList.toggle('norulers', this.app.prefs.rulers === false); this.app.view && this.app.view.resize(); }

  /* ---------- toolbar ---------- */
  buildTools() {
    const el = $('#tools'), app = this.app; el.innerHTML = '';
    for (const id of TOOL_ORDER) {
      if (!id) { el.append(h('div.tsep')); continue; }
      const t = app.tools[id]; if (!t) continue;
      const b = h('button.tool' + (app.tool === t ? '.on' : ''), { on: { click: () => app.setTool(id) } }, icon(t.icon));
      this.hoverTip(b, () => `${t.name}<em>${t.shortcut ? t.shortcut.toUpperCase() : ''}</em>`);
      el.append(b);
    }
    const fg = h('div.fgc', { title: 'Foreground color' }), bg = h('div.bgc', { title: 'Background color' });
    const swap = h('span.swap', { title: 'Swap colors (X)' }, '⇄'), def = h('span.deflt', { title: 'Default colors (D)' }, '◩');
    fg.onclick = () => colorPop(fg, app.fg, c => app.setFg(c));
    bg.onclick = () => colorPop(bg, app.bg, c => app.setBg(c));
    swap.onclick = () => app.swapColors(); def.onclick = () => app.defaultColors();
    el.append(h('div.fgbg', fg, bg, swap, def));
    this.paintColors();
  }
  paintColors() {
    const f = $('#tools .fgc'), b = $('#tools .bgc');
    if (f) f.style.background = C.hex(this.app.fg);
    if (b) b.style.background = C.hex(this.app.bg);
  }
  hoverTip(el, html) {
    let t;
    el.addEventListener('mouseenter', () => { t = setTimeout(() => { const r = el.getBoundingClientRect(); this.tip(html(), r.right + 8, r.top + 6, true); }, 450); });
    el.addEventListener('mouseleave', () => { clearTimeout(t); this.tip(null); });
  }

  /* ---------- options bar ---------- */
  buildOptions() {
    const el = $('#options'), t = this.app.tool; el.innerHTML = '';
    if (!t) return;
    el.append(h('span.ob-tool', icon(t.icon), t.title || t.name));
    if (t.options) { const o = t.options(this.app); if (o) el.append(...(Array.isArray(o) ? o : [o])); }
  }

  /* ---------- tabs ---------- */
  buildTabs() {
    const el = $('#tabs'), app = this.app; el.innerHTML = '';
    for (const d of app.docs) {
      const z = d.view ? round(d.view.zoom * 100, 1) : 100;
      const name = h('span', `${d.history.dirty ? '• ' : ''}${d.name} @ ${z}%`);
      const x = h('span.x', { title: 'Close (⌘W)' }, '×');
      x.onclick = e => { e.stopPropagation(); app.closeDoc(d); };
      const tab = h('div.dtab' + (d === app.doc ? '.on' : ''), { on: { click: () => app.activate(d) }, title: d.path || d.name }, name, x);
      // a layer dragged here from the Layers panel is copied into this document
      tab.addEventListener('dragover', e => { if (app.panels.layers.dragId && d !== app.doc) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; tab.classList.add('droptab'); } });
      tab.addEventListener('dragleave', () => tab.classList.remove('droptab'));
      tab.addEventListener('drop', e => {
        tab.classList.remove('droptab');
        const id = app.panels.layers.dragId; if (!id) return;
        e.preventDefault(); e.stopPropagation(); app.panels.layers.dragId = null; app.run('layer.copyToDoc', d, id);
      });
      el.append(tab);
    }
  }
  emptyState() { $('#empty').classList.toggle('hide', !!this.app.doc); }

  /* ---------- status ---------- */
  status() {
    const el = $('#status'), app = this.app, d = app.doc; el.innerHTML = '';
    if (!d) { el.append(h('span', 'No document')); return; }
    const z = num({ value: d.view ? d.view.zoom * 100 : 100, min: 1, max: 3200, width: 52, unit: '%', digits: 1, scrub: false, onChange: (v, f) => { if (f) app.view.zoomAt(v / 100, app.view.w / 2, app.view.h / 2); } });
    el.append(h('span', z));
    const inch = u => round(u, 2);
    el.append(h('span', `${d.name} · `, h('b', `${d.width} × ${d.height} px`), ` · ${inch(d.width / d.ppi)} × ${inch(d.height / d.ppi)} in @ `, h('b', `${round(d.ppi, 1)} ppi`), ' · RGB/8 · sRGB'));
    const n = d.all().length, mem = d.all().reduce((s, l) => s + (l.canvas ? l.canvas.width * l.canvas.height * 4 : 0) + (l.mask ? l.mask.canvas.width * l.mask.canvas.height * 4 : 0), 0);
    el.append(h('span', `${n} layer${n === 1 ? '' : 's'} · ${fmtBytes(mem)}`));
    this.cursorEl = h('span', 'X — Y —'); el.append(this.cursorEl);
    const sb = d.selection.bounds();
    if (sb) el.append(h('span', `Selection ${app.fmtLen(sb.w)} × ${app.fmtLen(sb.h)}`));
    this.infoEl = h('span'); el.append(this.infoEl);
    el.append(h('span.r', h('span', app.prefs.snap ? 'Snap on' : 'Snap off'), h('span', h('span.ok', '●'), ' GPU')));
  }
  cursorInfo(p) { if (this.cursorEl) this.cursorEl.textContent = p ? `X ${this.app.fmtLen(Math.floor(p.x))}  Y ${this.app.fmtLen(Math.floor(p.y))}` : 'X — Y —'; }
  info(t) { if (this.infoEl) this.infoEl.textContent = t || ''; }

  /* ---------- small popups ---------- */
  toast(msg, ms = 2400) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(this._tt); this._tt = setTimeout(() => t.style.display = 'none', ms); }
  tip(html, x, y, isHtml) {
    if (!this._tip) { this._tip = h('div.tip'); document.body.append(this._tip); }
    if (html == null) { this._tip.style.display = 'none'; return; }
    this._tip.style.display = 'block'; if (isHtml) this._tip.innerHTML = html; else this._tip.textContent = html;
    this._tip.style.left = Math.min(window.innerWidth - 160, x) + 'px'; this._tip.style.top = y + 'px';
  }
  /** run an async job behind a progress overlay; job(progress(0..1)) */
  async busy(label, job) {
    const b = $('#busy'); $('#busyLabel').textContent = label; $('#busyBar').style.width = '0%';
    const show = setTimeout(() => b.classList.add('on'), 120);
    await new Promise(r => setTimeout(r, 30));
    try { return await job(p => { $('#busyBar').style.width = Math.round(clamp(p, 0, 1) * 100) + '%'; }); }
    finally { clearTimeout(show); b.classList.remove('on'); }
  }
  /** buttons -> index of the chosen one (null if dismissed) */
  confirm(title, msg, buttons = ['OK', 'Cancel']) {
    return new Promise(res => {
      const m = modal(title, h('div', { style: { maxWidth: '420px', lineHeight: '1.5', whiteSpace: 'pre-line' } }, msg),
        buttons.map((b, i) => ({ label: b, primary: i === 0, value: i })), { width: 460, onClose: v => res(v ?? null) });
      void m;
    });
  }
  alert(title, msg) { return this.confirm(title, msg, ['OK']); }

  /* ---------- the viewport ---------- */
  updateCursor() {
    const t = this.app.tool, vp = $('#viewport');
    if (this.spaceHeld) { vp.style.cursor = this.panning ? 'grabbing' : 'grab'; return; }
    vp.style.cursor = !this.app.doc ? 'default' : t && t.cursor ? (typeof t.cursor === 'function' ? t.cursor(this.app) : t.cursor) : 'default';
  }
  bindViewport() {
    const vp = $('#viewport'), app = this.app;
    const ev = (e) => {
      const v = app.view, p = v.local(e), d = v.toDoc(p.x, p.y);
      return { x: d.x, y: d.y, sx: p.x, sy: p.y, shift: e.shiftKey, alt: e.altKey, cmd: e.metaKey || e.ctrlKey, button: e.button, pressure: e.pointerType === 'pen' ? (e.pressure || 0.5) : 1, pen: e.pointerType === 'pen', raw: e, time: e.timeStamp };
    };
    let active = null;  // {kind:'tool'|'pan', ...}
    vp.addEventListener('pointerdown', e => {
      if (!app.doc) return;
      if (document.activeElement && document.activeElement !== document.body && !document.activeElement.closest('#textedit')) document.activeElement.blur();
      if (e.button === 2) return;
      vp.setPointerCapture(e.pointerId);
      const p = app.view.local(e);
      if (e.button === 1 || this.spaceHeld || (app.tool && app.tool.id === 'hand')) {
        if (this.spaceHeld && (e.metaKey || e.ctrlKey)) { app.view.zoomStep(e.altKey ? -1 : 1, p.x, p.y); return; }
        if (app.tool.id !== 'hand' || this.spaceHeld || e.button === 1) { active = { kind: 'pan', x: e.clientX, y: e.clientY }; this.panning = true; this.updateCursor(); return; }
      }
      // the Move tool takes the object over a guide under it (sb flyers have a centre guide through every name)
      const g = (app.tool.id === 'move' || e.metaKey) && app.view.guideAt(p.x, p.y);
      if (g && !(app.tool.id === 'move' && !e.metaKey && app.tool.grabsAt(ev(e), app))) { app.view.dragGuide(g, e, false); return; }
      active = { kind: 'tool' };
      app.tool.down && app.tool.down(ev(e), app);
    });
    vp.addEventListener('pointermove', e => {
      if (!app.doc) return;
      const E = ev(e);
      app.view.setCursor({ x: E.x, y: E.y }); this.cursorInfo(E);
      if (active && active.kind === 'pan') { app.view.pan(e.clientX - active.x, e.clientY - active.y); active.x = e.clientX; active.y = e.clientY; return; }
      if (active && active.kind === 'tool') {
        const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        if (list.length > 1 && app.tool.coalesce) for (const ce of list) app.tool.move && app.tool.move(ev(ce), app);
        else app.tool.move && app.tool.move(E, app);
        return;
      }
      // hover
      const p = app.view.local(e), g = (app.tool.id === 'move' || e.metaKey) && app.view.guideAt(p.x, p.y) && !(app.tool.id === 'move' && !e.metaKey && app.tool.grabsAt(E, app));
      if (g) { vp.style.cursor = g.axis === 'v' ? 'ew-resize' : 'ns-resize'; this._guideHover = true; }
      else { if (this._guideHover) { this._guideHover = false; this.updateCursor(); } app.tool.hover && app.tool.hover(E, app); }
    });
    const end = e => {
      if (!active) return;
      const a = active; active = null;
      if (a.kind === 'pan') { this.panning = false; this.updateCursor(); return; }
      app.tool.up && app.tool.up(ev(e), app);
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
    vp.addEventListener('pointerleave', () => { if (!active) { app.view.setCursor(null); this.cursorInfo(null); app.tool && app.tool.leave && app.tool.leave(app); } });
    vp.addEventListener('dblclick', e => app.doc && app.tool.dblclick && app.tool.dblclick(ev(e), app));
    // right-click with a selection: the selection's layer actions
    vp.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!app.doc || !app.doc.selection.active) return;
      popMenu(vp, [['layer.viaCopy', 'Layer via Copy  ⌘J'], ['layer.viaCut', 'Layer via Cut  ⇧⌘J'], null, ['select.inverse', 'Select Inverse'], ['select.none', 'Deselect']], id => app.run(id), { x: e.clientX, y: e.clientY });
    });
    // scroll pans, pinch / alt-scroll zooms (Photoshop on a Mac)
    vp.addEventListener('wheel', e => {
      if (!app.doc) return; e.preventDefault();
      const p = app.view.local(e);
      if (e.ctrlKey || e.altKey || e.metaKey) { const k = Math.exp(-e.deltaY * (e.ctrlKey && !e.altKey ? 0.01 : 0.003)); app.view.zoomAt(app.view.z * k, p.x, p.y); }
      else app.view.pan(-e.deltaX, -e.deltaY);
    }, { passive: false });
    let gz = 1;
    vp.addEventListener('gesturestart', e => { e.preventDefault(); gz = app.view.z; });
    vp.addEventListener('gesturechange', e => { e.preventDefault(); if (!app.doc) return; const p = app.view.local(e); app.view.zoomAt(gz * e.scale, p.x, p.y); });
    vp.addEventListener('gestureend', e => e.preventDefault());
    // files dropped on the canvas of an open document go into it (images where you drop them, .stlv
    // projects as a group); ⌥, the tab bar or no document open them in their own tabs instead
    vp.addEventListener('dragover', e => { e.preventDefault(); });
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => {
      e.preventDefault();
      const files = [...(e.dataTransfer && e.dataTransfer.files || [])]; if (!files.length) return;
      const place = app.doc && vp.contains(e.target) && !e.altKey && !app.prefs.dropOpens;
      const p = place ? app.view.toDoc(app.view.local(e).x, app.view.local(e).y) : null;
      for (const [i, f] of files.entries()) app.run(place ? 'file.placeFile' : 'file.openFile', { name: f.name, file: f }, place ? { cx: Math.round(p.x + i * 20), cy: Math.round(p.y + i * 20) } : undefined);
    });
  }

  /* ---------- keyboard ---------- */
  bindKeys() {
    const app = this.app;
    window.addEventListener('keydown', e => {
      const tgt = e.target, typing = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable);
      if (document.querySelector('.scrim')) { if (!typing && e.key === 'Escape') { const s = [...document.querySelectorAll('.scrim')].pop(); s && s.close && s.close(null); } return; }
      if (typing) return;
      // the active tool first (Enter / Escape / arrows / tool shortcuts)
      if (app.tool && app.tool.key && app.tool.key(e, app)) { e.preventDefault(); return; }
      if (e.code === 'Space' && !e.repeat) { this.spaceHeld = true; this.updateCursor(); e.preventDefault(); return; }
      const cmd = e.metaKey || e.ctrlKey;
      // menu shortcuts
      const id = this.app.menus && this.app.menus.match(e);
      if (id) { e.preventDefault(); this.lastKeyCmd = { id, t: performance.now() }; app.run(id); return; }
      if (cmd) return;
      // single keys
      const k = e.key.toLowerCase();
      if (k === 'x') { app.swapColors(); return; }
      if (k === 'd') { app.defaultColors(); return; }
      if (k === 'q' && app.doc && app.doc.active && app.doc.active.mask) { app.run('layer.mask.target'); return; }
      const order = Object.values(app.tools).filter(t => t.shortcut === k);
      if (order.length) {
        e.preventDefault();
        // Shift cycles tools that share a key (M, G...)
        const i = order.indexOf(app.tool);
        app.setTool((e.shiftKey && i >= 0 ? order[(i + 1) % order.length] : order.find(t => t === app.tool) || order[0]).id);
        return;
      }
      if (/^[0-9]$/.test(e.key) && app.tool && app.tool.opts && 'opacity' in app.tool.opts) {
        const v = e.key === '0' ? 100 : +e.key * 10; app.toolOpt(app.tool, 'opacity', v); this.buildOptions(); this.toast(`Opacity ${v}%`, 900); return;
      }
    });
    window.addEventListener('keyup', e => { if (e.code === 'Space') { this.spaceHeld = false; this.updateCursor(); } });
    window.addEventListener('blur', () => { this.spaceHeld = false; });
  }
  refresh() { }
}
