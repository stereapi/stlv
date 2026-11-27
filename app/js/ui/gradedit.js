// Gradient editor: colour stops (below the bar) and opacity stops (above).
// Click the bar to add a stop, drag to move, drag off the bar to remove.
// Any stop can be transparent. Used by the Gradient tool, gradient fill
// layers and the gradient overlay style.

import { h, clamp, C, round } from '../util.js';
import { num, swatch, colorPop, btn } from './widgets.js';
import { modal } from './dialogs.js';
import { gradientCSS, gradientPresets, sampleGradient, cloneGradient } from '../gradient.js';

export function gradientEditor(app, grad, onLive) {
  let g = cloneGradient(grad);
  let sel = { kind: 'colors', i: 0 };
  const presets = h('div.gpre');
  const bar = h('div.gbar'), wrap = h('div.gbarwrap', bar);
  const nameIn = h('input.in', { value: g.name || 'Custom', spellcheck: false, on: { input: e => g.name = e.target.value } });
  const fields = h('div', { style: { background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px', minHeight: '86px' } });
  const changed = () => { draw(); onLive && onLive(cloneGradient(g)); };

  function drawPresets() {
    presets.innerHTML = '';
    for (const p of [...gradientPresets(app.fg, app.bg), ...(app.prefs.gradients || [])]) {
      const full = { ...g, ...cloneGradient(p), type: g.type, angle: g.angle, scale: g.scale, reverse: false };
      const i = h('i', { title: p.name, style: { background: gradientCSS(full), backgroundSize: 'auto, 8px 8px' } });
      i.onclick = () => { g = full; sel = { kind: 'colors', i: 0 }; nameIn.value = p.name; changed(); };
      presets.append(i);
    }
  }
  function draw() {
    bar.style.background = gradientCSS({ ...g, reverse: false });
    bar.style.backgroundSize = 'auto, 10px 10px';
    wrap.querySelectorAll('.gstop').forEach(e => e.remove());
    for (const kind of ['alphas', 'colors']) g[kind].forEach((s, i) => {
      const on = sel.kind === kind && sel.i === i;
      const inner = h('i', { style: { background: kind === 'colors' ? C.hex(s.color) : `rgba(255,255,255,${s.a})` } });
      const el = h('div.gstop.' + (kind === 'colors' ? 'bot' : 'top') + (on ? '.on' : ''), { style: { left: `calc(8px + ${s.pos} * (100% - 16px))` } }, inner);
      el.addEventListener('pointerdown', e => dragStop(e, kind, i));
      wrap.append(el);
    });
    drawFields();
  }
  function drawFields() {
    fields.innerHTML = '';
    const list = g[sel.kind], s = list[sel.i]; if (!s) return;
    const loc = num({ value: round(s.pos * 100, 1), min: 0, max: 100, unit: ' %', digits: 1, width: 70, onChange: v => { s.pos = v / 100; changed(); } });
    const mid = num({ value: round((s.mid ?? 0.5) * 100), min: 5, max: 95, unit: ' %', width: 64, onChange: v => { s.mid = v / 100; changed(); } });
    const del = btn('Delete', () => { if (list.length > 2) { list.splice(sel.i, 1); sel.i = 0; changed(); } }, 'ghost');
    if (sel.kind === 'colors') {
      const sw = swatch(s.color, c => { s.color = c; changed(); }, 'Stop color');
      fields.append(h('div.sect', 'Color stop'), h('div.row', h('span.lbl', 'Color'), sw, btn('Foreground', () => { s.color = { ...app.fg }; changed(); }, 'ghost'), btn('Background', () => { s.color = { ...app.bg }; changed(); }, 'ghost')),
        h('div.row', h('span.lbl', 'Location'), loc, h('span.lbl', 'Midpoint'), mid, del));
    } else {
      const op = num({ value: Math.round(s.a * 100), min: 0, max: 100, unit: ' %', width: 64, onChange: v => { s.a = v / 100; changed(); } });
      fields.append(h('div.sect', 'Opacity stop'), h('div.row', h('span.lbl', 'Opacity'), op, h('span.lbl', '0% = transparent')),
        h('div.row', h('span.lbl', 'Location'), loc, h('span.lbl', 'Midpoint'), mid, del));
    }
  }
  function dragStop(e, kind, i) {
    e.preventDefault(); e.stopPropagation();
    sel = { kind, i }; draw();
    const r = bar.getBoundingClientRect(), list = g[kind], s = list[i], x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    const mv = ev => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;   // a click, not a drag (yet)
      moved = true;
      const off = Math.abs(ev.clientY - (r.top + r.height / 2)) > 60 && list.length > 2;
      s.pos = clamp((ev.clientX - r.left) / r.width, 0, 1);
      s._remove = off; draw();
      const el = [...wrap.querySelectorAll('.gstop.' + (kind === 'colors' ? 'bot' : 'top'))][list.indexOf(s)];
      if (el) el.style.opacity = off ? 0.3 : 1;
      onLive && onLive(cloneGradient(g));
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      if (s._remove) { list.splice(list.indexOf(s), 1); sel = { kind, i: 0 }; }
      delete s._remove;
      list.sort((a, b) => a.pos - b.pos); sel.i = Math.max(0, list.indexOf(s)); changed();
      // a click on a colour stop opens the colour picker on it
      if (!moved && kind === 'colors') { const el = wrap.querySelectorAll('.gstop.bot')[sel.i]; if (el) colorPop(el, s.color, c => { s.color = c; changed(); }); }
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  // click the bar: upper half adds an opacity stop, lower half a colour stop
  bar.addEventListener('pointerdown', e => {
    const r = bar.getBoundingClientRect(), pos = clamp((e.clientX - r.left) / r.width, 0, 1), top = e.clientY < r.top + r.height / 2;
    const c = sampleGradient({ ...g, reverse: false }, pos);
    if (top) { g.alphas.push({ pos, a: round(c.a, 3), mid: 0.5 }); g.alphas.sort((a, b) => a.pos - b.pos); sel = { kind: 'alphas', i: g.alphas.findIndex(s => s.pos === pos) }; }
    else { g.colors.push({ pos, color: { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }, mid: 0.5 }); g.colors.sort((a, b) => a.pos - b.pos); sel = { kind: 'colors', i: g.colors.findIndex(s => s.pos === pos) }; }
    changed();
  });
  drawPresets(); draw();
  const save = btn('Save as preset', () => { const list = app.prefs.gradients || []; list.push({ ...cloneGradient(g), name: nameIn.value }); app.setPref('gradients', list); drawPresets(); }, 'ghost');
  const body = h('div', h('div.fl', h('label', 'Presets'), presets), h('div.fl', h('label', 'Name'), h('div.row', nameIn, save)),
    h('div.lbl', { style: { fontSize: '11px' } }, 'Click above the bar for an opacity stop, below for a color stop. Click a color stop to pick its color, drag it to move it, drag it off the bar to remove it.'), wrap, fields);
  return new Promise(res => modal('Gradient editor', body, [{ label: 'Cancel', ghost: true, value: null }, { label: 'OK', primary: true, run: () => res(cloneGradient(g)) }],
    { width: 640, note: 'Stops blend in premultiplied alpha: fades to transparent never pick up a grey fringe.', onClose: v => { if (v === null) { onLive && onLive(cloneGradient(grad)); res(null); } } }));
}
