// UI building blocks: icons, number fields (type, arrow keys, drag to scrub),
// selects, segmented buttons, checkboxes, slider rows, colour swatches with a
// picker popover.

import { h, clamp, C, round, $ } from '../util.js';

export const ICON = {
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  rect: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.4"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke-dasharray="3 2.4"/>',
  lasso: '<path d="M5 10c0-3.5 3.5-6 7.5-6S20 6.5 20 9.5 16.5 15 12 15c-2 0-4-.5-5.5-1.5M6.5 13.5c-1 1.5-.5 3.5 1.5 3.5M8 17c0 2-1.5 3-3 3"/>',
  selbrush: '<circle cx="9.5" cy="9.5" r="6" stroke-dasharray="2.6 2.2"/><path d="M14 14l6.5 6.5"/>',
  crop: '<path d="M7 3v14h14M3 7h14v14"/>',
  dropper: '<path d="M17 3.5a2.1 2.1 0 013 3l-2.5 2.5-3-3zM14.5 6.5L5 16l-1 4 4-1 9.5-9.5"/>',
  brush: '<path d="M20 3.5L10.5 13M10.5 13c-2-.6-4.6.6-4.6 3.4 0 1.6-.9 2.6-2.4 3.1 3.2 1.6 7.8.4 8.3-3.1.2-1.5-.4-2.8-1.3-3.4z"/>',
  eraser: '<path d="M8 20h12M5.5 14.5l8-8a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L12 18H8.5zM9 11l5 5"/>',
  fill: '<path d="M5 11l6-6 7 7-6 6a2 2 0 01-2.8 0L5 13.8a2 2 0 010-2.8zM5 12h13M20 15s1.5 2 1.5 3a1.5 1.5 0 01-3 0c0-1 1.5-3 1.5-3z"/>',
  gradient: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><rect x="5" y="5" width="4.5" height="14" fill="currentColor" stroke="none" opacity=".9"/><rect x="9.5" y="5" width="5" height="14" fill="currentColor" stroke="none" opacity=".45"/>',
  text: '<path d="M5 6.5V4.5h14v2M12 4.5v15M9 19.5h6"/>',
  hand: '<path d="M8 13V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6 7-2.5 0-4-1-5.5-3L3.5 13.5a1.5 1.5 0 012.3-1.9L8 14"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5M8 10.5h5M10.5 8v5"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  lockPx: '<path d="M5 19l9-9 3 3-9 9H5zM14 10l3-3 3 3-3 3"/>',
  lockPos: '<path d="M12 3v18M3 12h18M12 3l-2 2M12 3l2 2M12 21l-2-2M12 21l2-2M3 12l2-2M3 12l2 2M21 12l-2-2M21 12l-2 2"/>',
  lockAlpha: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="2 2"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  chain: '<path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1"/>',
  adj: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor"/>',
  mask: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.5"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  plus: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  fx: '<path d="M7 20c2 0 2.5-2 3-5l1.5-8c.5-2.5 1.5-3.5 3.5-3.5M7 11h7M15 13l5 6M20 13l-5 6"/>',
  modeNew: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  modeAdd: '<rect x="3" y="3" width="11" height="11" rx="1"/><rect x="10" y="10" width="11" height="11" rx="1" fill="currentColor" fill-opacity=".35"/>',
  modeSub: '<rect x="3" y="3" width="11" height="11" rx="1" fill="currentColor" fill-opacity=".35"/><rect x="10" y="10" width="11" height="11" rx="1"/>',
  modeInt: '<rect x="3" y="3" width="11" height="11" rx="1"/><rect x="10" y="10" width="11" height="11" rx="1"/><rect x="10" y="10" width="4" height="4" fill="currentColor"/>',
  gLin: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 20L20 4"/>',
  gRad: '<rect x="4" y="4" width="16" height="16" rx="1"/><circle cx="12" cy="12" r="4"/>',
  gAng: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 12L20 12M12 12l5-6"/>',
  gRef: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M8 4v16M16 4v16" stroke-opacity=".5"/>',
  gDia: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 7l5 5-5 5-5-5z"/>',
  alL: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>', alC: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>', alR: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  check: '<path d="M5 12l5 5 9-10"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  warp: '<path d="M4 8q8-6 16 0M4 16q8-6 16 0M4 8v8M20 8v8M12 5v8"/>',
  cas: '<path d="M3 12h18M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/><rect x="9" y="8" width="6" height="8" rx="1"/>',
  clip: '<path d="M7 4v10a4 4 0 004 4h9M15 14l5 4-5 4"/>',
  swap: '<path d="M7 4l-3 3 3 3M4 7h11a5 5 0 015 5M17 20l3-3-3-3M20 17H9a5 5 0 01-5-5"/>',
  alignL: '<path d="M4 3v18M8 7h12v4H8zM8 13h7v4H8z"/>', alignCH: '<path d="M12 3v18M6 7h12v4H6zM8.5 13h7v4h-7z"/>', alignR: '<path d="M20 3v18M4 7h12v4H4zM9 13h7v4H9z"/>',
  alignT: '<path d="M3 4h18M7 8v12h4V8zM13 8v7h4V8z"/>', alignCV: '<path d="M3 12h18M7 6v12h4V6zM13 8.5v7h4v-7z"/>', alignB: '<path d="M3 20h18M7 4v12h4V4zM13 9v7h4V9z"/>',
  refpt: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="2 2"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  pressure: '<path d="M4 20c4-1 6-6 8-10s4-6 8-6"/><circle cx="12" cy="10" r="2"/>',
  rot: '<path d="M20 12a8 8 0 11-2.3-5.6M20 4v4h-4"/>',
};
export const icon = (k, small) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'i' + (small ? ' s' : '')); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = ICON[k] || ''; return s; };

/** number field. opts {value, min, max, step, unit, width, onChange(v, final), fmt, parse, scrub} */
export function num(opts) {
  const el = h('input.num' + (opts.cls ? '.' + opts.cls : ''), { type: 'text', spellcheck: false });
  if (opts.width) el.style.width = opts.width + 'px';
  const step = opts.step ?? 1, min = opts.min ?? -1e9, max = opts.max ?? 1e9;
  const fmt = opts.fmt || (v => String(round(v, opts.digits ?? (step < 1 ? 2 : 0))) + (opts.unit || ''));
  const parse = opts.parse || (s => { const v = parseFloat(String(s).replace(/[^0-9.\-+e]/gi, '')); return isNaN(v) ? null : v; });
  let value = opts.value;
  const set = (v, final) => { v = clamp(v, min, max); value = v; el.value = fmt(v); opts.onChange && opts.onChange(v, final); };
  el.value = fmt(value);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { el.blur(); }
    else if (e.key === 'Escape') { el.value = fmt(value); el.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const k = (e.shiftKey ? 10 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1); set((parse(el.value) ?? value) + k, true); el.select(); }
    e.stopPropagation();
  });
  el.addEventListener('change', () => { const v = parse(el.value); if (v == null) { el.value = fmt(value); return; } set(v, true); });
  el.addEventListener('focus', () => setTimeout(() => el.select(), 0));
  // drag the field horizontally to scrub (like Photoshop's scrubby labels)
  if (opts.scrub !== false) {
    el.classList.add('scrub');
    el.addEventListener('pointerdown', e => {
      if (document.activeElement === el) return;
      e.preventDefault();
      const x0 = e.clientX, v0 = value; let moved = false;
      const mv = ev => { const dx = ev.clientX - x0; if (Math.abs(dx) > 2) moved = true; if (moved) set(v0 + Math.round(dx / (ev.shiftKey ? 1 : 2)) * step * (ev.shiftKey ? 10 : 1), false); };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved) set(value, true); else { el.focus(); } };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
  }
  el.setValue = v => { value = v; if (document.activeElement !== el) el.value = fmt(v); };
  el.getValue = () => value;
  return el;
}

export function select(items, value, onChange, cls = '') {
  const s = h('select.sel' + (cls ? '.' + cls : ''));
  for (const it of items) {
    if (it === null) { s.append(h('option', { disabled: true }, '──────────')); continue; }
    const [v, label] = Array.isArray(it) ? it : [it, it];
    s.append(h('option', { value: v, selected: v === value }, label));
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  s.addEventListener('keydown', e => e.stopPropagation());
  return s;
}

/** segmented buttons: items [[value, labelOrIconNode, title]] */
export function seg(items, value, onChange) {
  const el = h('div.seg');
  for (const [v, label, title] of items) {
    const b = h('button', { title: title || '', class: v === value ? 'on' : '' }, typeof label === 'string' && ICON[label] ? icon(label, true) : label);
    b.onclick = () => { for (const x of el.children) x.classList.toggle('on', x === b); onChange(v); };
    b.dataset.v = v;
    el.append(b);
  }
  el.set = v => { for (const x of el.children) x.classList.toggle('on', x.dataset.v === String(v)); };
  return el;
}

export function chk(label, on, onChange, title) {
  const el = h('span.chk' + (on ? '.on' : ''), { title: title || '' }, h('i'), label);
  el.onclick = () => { const v = !el.classList.contains('on'); el.classList.toggle('on', v); onChange(v); };
  el.set = v => el.classList.toggle('on', !!v);
  return el;
}
export const lbl = t => h('span.lbl', t);
export const og = (...k) => h('span.og', ...k);
export function btn(label, onClick, cls = '', title = '') { const b = h('button.btn' + (cls ? '.' + cls.split(' ').join('.') : ''), { title }, typeof label === 'string' && ICON[label] ? icon(label, true) : label); b.onclick = onClick; return b; }

/** slider + number in a row: [label, range, number] */
export function sliderRow(label, opts) {
  const n = num({ ...opts, onChange: (v, f) => { r.value = v; opts.onChange(v, f); } });
  const r = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step ?? 1, value: opts.value });
  r.addEventListener('input', () => { n.setValue(+r.value); opts.onChange(+r.value, false); });
  r.addEventListener('change', () => opts.onChange(+r.value, true));
  const row = h('div.slrow', lbl(label), r, n);
  row.set = v => { r.value = v; n.setValue(v); };
  return row;
}

/* ---------- colour picker popover ---------- */
let pop = null;
export function closeColorPop() { if (pop) { pop.remove(); pop = null; } }
/** opens next to anchor; onChange(rgb, final) */
export function colorPop(anchor, rgb, onChange, opts = {}) {
  closeColorPop();
  let hsv = C.toHsv(rgb);
  const sv = h('div.sv'), svDot = h('i'), hue = h('div.hue'), hueDot = h('i');
  sv.append(svDot); hue.append(hueDot);
  const hex = h('input.txt', { style: { width: '80px' }, spellcheck: false });
  const fields = ['r', 'g', 'b'].map(k => num({ value: 0, min: 0, max: 255, width: 44, onChange: (v, f) => { const c = C.fromHsv(hsv); c[k] = v; hsv = C.toHsv(c); paint(f); } }));
  const before = { ...rgb };
  const paint = (final) => {
    const c = C.fromHsv(hsv);
    sv.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h},100%,50%))`;
    svDot.style.left = hsv.s * 100 + '%'; svDot.style.top = (1 - hsv.v) * 100 + '%';
    hueDot.style.top = hsv.h / 360 * 100 + '%';
    if (document.activeElement !== hex) hex.value = C.hex(c).slice(1).toUpperCase();
    ['r', 'g', 'b'].forEach((k, i) => fields[i].setValue(c[k]));
    swNew.style.background = C.hex(c);
    onChange(c, final);
  };
  const drag = (el, f) => el.addEventListener('pointerdown', e => {
    e.preventDefault(); const r = el.getBoundingClientRect();
    const mv = ev => { f(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)); paint(false); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); paint(true); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); mv(e);
  });
  drag(sv, (x, y) => { hsv.s = x; hsv.v = 1 - y; });
  drag(hue, (x, y) => { hsv.h = Math.min(359.9, y * 360); });
  hex.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { const c = C.parse(hex.value); if (c) { hsv = C.toHsv(c); paint(true); } } });
  const swOld = h('span.swatch', { style: { background: C.hex(before), width: '28px' }, title: 'Original' });
  swOld.onclick = () => { hsv = C.toHsv(before); paint(true); };
  const swNew = h('span.swatch', { style: { width: '28px' } });
  pop = h('div.cpop', h('div.picker', sv, hue),
    h('div.row', { style: { marginTop: '8px' } }, h('span.lbl', '#'), hex, swNew, swOld),
    h('div.row', ...fields.flatMap((f, i) => [lbl('RGB'[i]), f])),
    opts.extra || null);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(window.innerWidth - 250, Math.max(8, r.left)) + 'px';
  pop.style.top = (r.bottom + 260 > window.innerHeight ? Math.max(8, r.top - 262) : r.bottom + 6) + 'px';
  paint(false);
  const off = e => { if (pop && !pop.contains(e.target) && e.target !== anchor) { closeColorPop(); window.removeEventListener('pointerdown', off, true); } };
  setTimeout(() => window.addEventListener('pointerdown', off, true), 0);
  return pop;
}
/* ---------- font list popover ----------
 * The family picker. Hovering a name or stepping with ↑↓ previews it on the text
 * (on.preview); click / Enter picks (on.commit); Esc reverts (on.cancel). ↑↓ on the
 * closed button opens the list one step on. Clicking away keeps the arrowed-to font. */
let fpop = null;
export function fontPick(families, value, on) {
  const b = h('button.sel.fpick', { title: 'Font family (↑↓ to step through)' }, value);
  const open = step => {
    if (fpop) fpop.close('away');
    const orig = value, q = h('input.txt', { placeholder: 'Search fonts', spellcheck: false }), list = h('div.flist');
    let shown = [], sel = -1, hov = -1, showing = orig;
    const show = i => {
      [...list.children].forEach((el, k) => { el.classList.toggle('on', k === sel); el.classList.toggle('hov', k === i && k !== sel); });
      const f = shown[i] ?? orig; if (f !== showing) { showing = f; on.preview(f); }
    };
    const fill = () => {
      const s = q.value.trim().toLowerCase();
      const pool = only && only.get() ? families.filter(f => only.list.includes(f)) : families;
      shown = pool.filter(f => !s || f.toLowerCase().includes(s));
      list.replaceChildren(...shown.map((f, i) => {
        const it = h('div.fi', { style: { fontFamily: `"${f}"` } }, f);
        if (on.face) on.face(f, it);
        it.onpointerenter = () => { hov = i; show(i); };
        it.onclick = () => { sel = i; close('pick'); };
        return it;
      }));
      sel = shown.indexOf(showing); hov = -1; show(sel);
      if (sel >= 0) list.children[sel].scrollIntoView({ block: 'center' });
    };
    const move = d => {
      if (!shown.length) return;
      sel = sel < 0 ? (d > 0 ? 0 : shown.length - 1) : (sel + d + shown.length) % shown.length;
      hov = -1; show(sel); list.children[sel].scrollIntoView({ block: 'nearest' });
    };
    list.onpointerleave = () => { hov = -1; show(sel); };
    q.addEventListener('input', fill);
    q.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (hov >= 0) sel = hov; close('pick'); }
      else if (e.key === 'Escape') { e.preventDefault(); close('cancel'); }
    });
    // optional tick box that narrows the list (the shipped flyer fonts)
    const only = on.only, tick = only && chk(only.label, only.get(), v => { only.set(v); fill(); q.focus(); }, 'Show only the fonts that come with stlv');
    const pop = h('div.fpop', tick ? h('div.frow', q, tick) : q, list);
    const close = how => {
      if (fpop !== pop) return;
      fpop = null; pop.remove(); window.removeEventListener('pointerdown', off, true);
      const f = shown[sel];
      if (how !== 'cancel' && f && f !== orig) { value = f; b.textContent = f; on.commit(f); }
      else on.cancel();   // also clears the caller's saved state when nothing was previewed
      b.isConnected && b.focus();
    };
    pop.close = close; pop.owner = b;
    const off = e => { if (!pop.contains(e.target) && e.target !== b) close('away'); };
    fpop = pop; document.body.append(pop);
    const r = b.getBoundingClientRect(), H = Math.min(360, window.innerHeight - 16);
    Object.assign(pop.style, { left: Math.min(window.innerWidth - 268, Math.max(8, r.left)) + 'px', height: H + 'px',
      top: (r.bottom + 4 + H > window.innerHeight ? Math.max(8, window.innerHeight - H - 8) : r.bottom + 4) + 'px' });
    fill(); if (step) move(step);
    q.focus();
    setTimeout(() => window.addEventListener('pointerdown', off, true), 0);
  };
  b.onclick = () => fpop && fpop.owner === b ? fpop.close('away') : open(0);
  b.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); open(e.key === 'ArrowDown' ? 1 : -1); }
  });
  return b;
}

export function swatch(rgb, onChange, title = 'Color') {
  const s = h('span.swatch', { title, style: { background: C.hex(rgb) } });
  let cur = { ...rgb };
  s.onclick = () => colorPop(s, cur, (c, f) => { cur = c; s.style.background = C.hex(c); onChange(c, f); });
  s.set = c => { cur = { ...c }; s.style.background = C.hex(c); };
  return s;
}
export { $ };
