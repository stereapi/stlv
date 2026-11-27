// Text tool: click for point text, drag for a text box, click a text layer to
// edit it. Typing happens in a transparent textarea laid over the canvas; the
// real (warped / transformed) text renders underneath as you type.

import { h, $, C, R, dist, clamp } from '../util.js';
import { og, lbl, select, num, seg, swatch, btn, icon, fontPick } from '../ui/widgets.js';
import { TextLayer } from '../doc.js';
import { fonts, layoutText, textQuad, fontString, styleFor } from '../text.js';

export const textTool = {
  id: 'text', name: 'Text', shortcut: 't', icon: 'text', cursor: 'text',
  defaults: { font: 'Helvetica Neue', fontStyle: 'Regular', size: 48, align: 'left', tracking: 0, leading: 0, color: null /* last text color picked; null = foreground */ },
  /** what the options bar edits: the text being typed, else every selected text layer (null = defaults for new text) */
  targets(app) {
    if (this.editing) return [this.editing];
    const d = app.doc; if (!d || !d.active || d.active.type !== 'text') return null;
    const sel = d.selectedLayers().filter(x => x.type === 'text');
    return sel.includes(d.active) ? sel : [d.active];
  },
  options(app) {
    const o = this.opts, l = this.editing, T = this.targets(app), r = T && (T.includes(app.doc.active) ? app.doc.active : T[0]);   // r: the layer whose values are shown
    const P = app.panels.props, many = T && T.length > 1;
    const set = (k, v) => {
      app.toolOpt(this, k, v);
      if (T && k === 'size' && T.length > 1) P.groupSize(T, r, v, true);   // several: scale as one block, layout kept
      else if (T) P.live(T, k, k === 'fontStyle' ? x => x.font === r.font || (fonts.family(x.font)?.styles || []).some(s => s.style === v) ? v : x.fontStyle : v, true, 'Text');
      this.place(app);
    };
    const fam = fonts.family(r ? r.font : o.font);
    // previews land on the target text (or nothing); a pick also becomes the default for new text
    const famSel = fontPick((fonts.list || []).map(f => f.family), r ? r.font : o.font, {
      preview: v => { if (T) { P.font(T, v, 'preview'); this.place(app); } },
      cancel: () => { if (T) { P.font(T, null, 'cancel'); this.place(app); } },
      commit: v => {
        app.toolOpt(this, 'font', v); app.toolOpt(this, 'fontStyle', styleFor(v, r ? r.fontStyle : o.fontStyle));
        if (T) P.font(T, v, 'commit');
        app.ui.buildOptions(); this.place(app);
      },
      ...fonts.flyerPick(app),
    });
    famSel.style.maxWidth = '200px';
    const stSel = select(fam ? fam.styles.map(s => s.style) : [r ? r.fontStyle : o.fontStyle], r ? r.fontStyle : o.fontStyle, v => set('fontStyle', v));
    const col = swatch(r ? r.color : o.color || app.fg, (c, f) => { if (T) P.live(T, 'color', c, f, 'Text Color'); else if (f) app.toolOpt(this, 'color', { ...c }); }, 'Text color');
    const size = r ? r.size : o.size;
    const out = [og(famSel, stSel), og(num({ value: size, min: 0.5, max: 2000, unit: ' pt', width: 72, digits: 1, onChange: (v, f) => f && set('size', v) }), lbl(`≈ ${Math.round(size * (app.doc ? app.doc.ppi : 72) / 72)} px`)),
      og(seg([['left', 'alL', 'Left'], ['center', 'alC', 'Center'], ['right', 'alR', 'Right']], r ? r.align : o.align, v => set('align', v))),
      og(col), og(btn('warp', () => { if (app.doc && app.doc.active && app.doc.active.type === 'text') { P.focus = null; app.ui.toast('Warp settings are in the Properties panel'); } }, '', 'Warp text (see Properties)'))];
    if (many) out.push(og(lbl(`${T.length} text layers`)));
    if (l) out.push(og(btn('x', () => this.commit(app, true), 'ghost icon', 'Cancel (⌘⌫)'), btn('check', () => this.commit(app), 'pri icon', 'Commit (Esc / ⌘↩)')));
    return out;
  },
  down(e, app) {
    const d = app.doc;
    if (this.editing) {
      const q = textQuad(this.editing, d);
      if (inside(q, e)) return;    // clicks inside go to the textarea
      this.commit(app); return;
    }
    const hit = d.all().reverse().find(l => l.type === 'text' && !d.hiddenChain(l) && inside(textQuad(l, d), e));   // collapsed groups too
    if (hit && !e.shift) { d.setActive(hit); this.edit(hit, app); return; }
    this.drag = { p0: { x: e.x, y: e.y }, p1: { x: e.x, y: e.y } };
  },
  move(e, app) { if (this.drag) { this.drag.p1 = { x: e.x, y: e.y }; app.view.redraw(); } },
  up(e, app) {
    const s = this.drag; this.drag = null; if (!s) return;
    const d = app.doc, o = this.opts, isBox = dist(s.p0, s.p1) * app.view.z > 8;
    const l = new TextLayer('Text', { text: '', font: o.font, fontStyle: o.fontStyle, size: o.size, color: { ...(o.color || app.fg) }, align: o.align, tracking: o.tracking, leading: o.leading });
    if (isBox) { const r = R.fromPts([s.p0, s.p1]); l.x = Math.round(r.x); l.y = Math.round(r.y); l.box = { w: Math.max(10, r.w), h: Math.max(10, r.h) }; }
    else { l.x = Math.round(s.p0.x); l.y = Math.round(s.p0.y); }
    // add without history; the commit records "New Text Layer". New text is always its own
    // top-level layer: above the active layer's outermost group, never inside a group
    // (sb flyer files keep every name in a collapsed group, where new text would vanish)
    let top = d.active; while (top && top.parent && top.parent !== d.root) top = top.parent;
    const parent = d.root, idx = top && top.parent === d.root ? parent.children.indexOf(top) + 1 : parent.children.length;
    d.insert(l, parent, idx); d.setActive(l); l.isNew = true;
    this.edit(l, app);
  },
  edit(l, app) {
    if (this.editing && this.editing !== l) this.commit(app);
    this.editing = l; this.before = l.text;
    let ta = $('#textedit');
    if (!ta) {
      ta = h('textarea#textedit', { spellcheck: false, autocomplete: 'off' });
      ta.addEventListener('input', () => { const t = this.editing; if (!t) return; t.text = ta.value; t.name = (ta.value.split('\n')[0] || 'Text').slice(0, 40); t.raster = null; t.touch(); app.view.invalidate(); this.place(app); });
      ta.addEventListener('keydown', e => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); this.commit(app); }
        else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && !ta.value) { e.preventDefault(); this.commit(app, true); }
        e.stopPropagation();
      });
      $('#viewport').append(ta);
      // an empty box never lingers: a click anywhere but the canvas (handled in down) or the
      // text settings (font, size, colour, so you can set those before typing) closes it
      window.addEventListener('pointerdown', e => {
        const t = this.editing; if (!t || t.text.trim()) return;
        if (e.target.closest && e.target.closest('#viewport, #options, #propsPnl, #colorPnl, .fpop, .cpop, .scrim')) return;
        this.commit(app);
      }, true);
    }
    ta.value = l.text; ta.style.display = 'block';
    this.ta = ta;
    app.ui.buildOptions();
    this.place(app);
    const focus = () => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); };
    focus(); setTimeout(focus, 0);   // now, and again after the click finishes
    app.emit('change', 'active');
  },
  /** position the textarea over the layer at the current zoom */
  place(app) {
    const l = this.editing, ta = this.ta; if (!l || !ta) return;
    const d = app.doc, z = app.view.z, lay = layoutText(l, d);
    const font = fontString(l, lay.px * z);
    const anchor = app.view.toScreen(Math.round(l.x), Math.round(l.y));
    const longest = Math.max(40, ...lay.lines.map(x => x.w)) * z + lay.px * z;
    Object.assign(ta.style, { font, letterSpacing: lay.track * z + 'px', lineHeight: lay.lead * z + 'px', color: 'transparent', textAlign: l.align, whiteSpace: l.box ? 'pre-wrap' : 'pre' });
    let left, top, width, height;
    const lines = Math.max(1, ta.value.split('\n').length + (l.box ? 0 : 0));
    // CSS puts the first baseline at (lineHeight - (ascent + descent)) / 2 + ascent below the top
    const half = (lay.lead - lay.asc - lay.desc) * z / 2;
    if (l.box) { left = anchor.x; top = anchor.y - half; width = l.box.w * z; height = l.box.h * z + half * 2; }
    else {
      width = longest + 4; height = lines * lay.lead * z + 4;
      left = l.align === 'center' ? anchor.x - width / 2 : l.align === 'right' ? anchor.x - width : anchor.x;
      top = anchor.y - half - lay.asc * z;
    }
    Object.assign(ta.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
    const M = l.xform;
    if (M) { ta.style.transformOrigin = `${anchor.x - left}px ${anchor.y - top}px`; ta.style.transform = `matrix(${M[0]},${M[1]},${M[2]},${M[3]},0,0)`; }
    else ta.style.transform = '';
  },
  commit(app, cancel) {
    const l = this.editing; if (!l) return;
    const d = app.doc, ta = this.ta;
    this.editing = null; if (ta) { ta.style.display = 'none'; ta.blur(); }
    const before = this.before, after = cancel ? before : l.text;
    l.text = after; l.raster = null; l.touch();
    if (l.isNew) {
      delete l.isNew;
      const where = { parent: l.parent, index: l.parent.children.indexOf(l) };
      if (!after.trim() || cancel) { d.detach(l); const all = d.all(); d.setActive(all[all.length - 1] || null); d.changed('all'); app.ui.buildOptions(); return; }
      d.history.push({ label: 'New Text Layer', undo: () => { d.detach(l); d.changed('all'); }, redo: () => { d.insert(l, where.parent, where.index); d.setActive(l); d.changed('all'); } });
    } else if (!after.trim()) {
      // emptied an existing text layer: it goes, and undo brings it back as it was
      l.text = before; l.raster = null; l.touch();
      const where = { parent: l.parent, index: l.parent.children.indexOf(l) };
      const del = () => { d.detach(l); const sib = where.parent.children[Math.max(0, where.index - 1)]; d.setActive(sib || d.all().pop() || null); d.changed('all'); };
      del();
      d.history.push({ label: 'Delete Empty Text', undo: () => { d.insert(l, where.parent, where.index); d.setActive(l); d.changed('all'); }, redo: del });
    } else if (after !== before) {
      d.history.push({ label: 'Edit Text', undo: () => { l.text = before; l.raster = null; l.touch(); d.changed('all'); }, redo: () => { l.text = after; l.raster = null; l.touch(); d.changed('all'); } });
    }
    d.changed('all'); app.ui.buildOptions();
  },
  deactivate(app) { this.commit(app); },
  leaveDoc(app) { this.commit(app); },
  key(e, app) { return false; },
  overlay(c, view) {
    const d = view.doc;
    if (this.drag) { const r = R.fromPts([this.drag.p0, this.drag.p1]), a = view.toScreen(r.x, r.y); c.setLineDash([4, 3]); c.strokeStyle = '#fff'; c.strokeRect(a.x + 0.5, a.y + 0.5, r.w * view.z, r.h * view.z); c.setLineDash([]); }
    const l = this.editing; if (!l) return;
    const q = textQuad(l, d).map(p => view.toScreen(p.x, p.y));
    c.save(); c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent'); c.setLineDash([3, 3]); c.beginPath(); q.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.stroke(); c.restore();
  },
};
function inside(q, p) {
  let ins = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) { if ((q[i].y > p.y) !== (q[j].y > p.y) && p.x < (q[j].x - q[i].x) * (p.y - q[i].y) / (q[j].y - q[i].y) + q[i].x) ins = !ins; }
  return ins;
}
export { icon, C, clamp };
