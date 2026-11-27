// Modal dialogs: the base, New Document, Image Size, Canvas Size, Fill,
// Stroke, guides, number prompts, settings, about.

import { h, $, $$, clamp, round, toPx, fromPx, fmtBytes, C } from '../util.js';
import { num, select, seg, chk, swatch, lbl, icon } from './widgets.js';

/** modal(title, body, buttons[{label, primary, value, run}], {width, onClose}) */
export function modal(title, body, buttons = [], opts = {}) {
  const close = v => { scrim.remove(); opts.onClose && opts.onClose(v); };
  const foot = h('div.mf', opts.note ? h('span.note', opts.note) : null);
  for (const b of buttons) {
    const el = h('button.btn' + (b.primary ? '.pri' : '') + (b.ghost ? '.ghost' : ''), b.label);
    el.onclick = async () => { if (b.run) { const r = await b.run(); if (r === false) return; } close(b.value ?? b.label); };
    foot.append(el);
  }
  const m = h('div.modal', { style: { width: (opts.width || 520) + 'px' } },
    h('div.mh', h('h2', title), h('button.x', { on: { click: () => close(null) } }, '✕')),
    h('div.mbody', body), buttons.length ? foot : null);
  const scrim = h('div.scrim', m);
  scrim.close = close;
  scrim.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) { const p = buttons.find(b => b.primary); if (p) { e.preventDefault(); e.target.blur && e.target.blur(); setTimeout(() => foot.querySelector('.pri').click(), 0); } }
    if (e.key === 'Escape') { e.preventDefault(); close(null); }
    e.stopPropagation();
  });
  document.body.append(scrim);
  setTimeout(() => { const f = m.querySelector('input.in, input.num'); f ? f.focus() : m.querySelector('.btn.pri')?.focus(); }, 30);
  return { el: m, close, scrim };
}
const fl = (label, ...kids) => h('div.fl', h('label', label), ...kids);

/* ---------- New document ---------- */
export const PRESETS = {
  Photo: [['4 × 6 in', 4, 6, 'in', 300], ['5 × 7 in', 5, 7, 'in', 300], ['8 × 10 in', 8, 10, 'in', 300], ['Square 12 in', 12, 12, 'in', 300]],
  Print: [['A4', 210, 297, 'mm', 300], ['A3', 297, 420, 'mm', 300], ['A5 flyer', 148, 210, 'mm', 300], ['Letter', 8.5, 11, 'in', 300], ['Poster 18 × 24', 18, 24, 'in', 150], ['Poster 24 × 36', 24, 36, 'in', 150], ['Business card', 85, 55, 'mm', 300], ['Postcard', 6, 4, 'in', 300]],
  Screen: [['HD', 1920, 1080, 'px', 72], ['4K UHD', 3840, 2160, 'px', 72], ['Web', 1440, 900, 'px', 72], ['Retina laptop', 2880, 1800, 'px', 144], ['iPhone', 1179, 2556, 'px', 460], ['Wallpaper 5K', 5120, 2880, 'px', 218]],
  Social: [['Square post', 1080, 1080, 'px', 72], ['Portrait post', 1080, 1350, 'px', 72], ['Story / Reel', 1080, 1920, 'px', 72], ['YouTube thumbnail', 1280, 720, 'px', 72], ['Banner 3:1', 1500, 500, 'px', 72], ['Album cover', 3000, 3000, 'px', 300]],
};
export function newDocDialog(app, init = {}) {
  const last = app.prefs.lastNew || { name: 'Untitled', w: 2400, h: 3000, unit: 'px', ppi: 300, bg: 'white' };
  const st = { name: init.name || 'Untitled-' + (app.docs.length + 1), unit: init.unit || last.unit, ppi: init.ppi || last.ppi, bg: last.bg, bgColor: { ...app.bg } };
  st.w = init.w ?? fromPx(last.w, st.unit, st.ppi); st.h = init.h ?? fromPx(last.h, st.unit, st.ppi);
  let cat = init.w ? 'Recent' : 'Print';
  const recents = () => (app.prefs.recentSizes || []).map(r => [r.name || `${r.w} × ${r.h}`, r.w, r.h, 'px', r.ppi]);
  const cats = h('div.cats'), grid = h('div.presets');
  const name = h('input.in', { value: st.name, spellcheck: false, on: { input: e => st.name = e.target.value } });
  const fw = num({ value: st.w, min: 0.01, max: 1e6, step: 1, digits: 3, cls: 'in', scrub: false, onChange: v => { st.w = v; out(); } });
  const fh = num({ value: st.h, min: 0.01, max: 1e6, step: 1, digits: 3, cls: 'in', scrub: false, onChange: v => { st.h = v; out(); } });
  const fu = select([['px', 'Pixels'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters'], ['pt', 'Points']], st.unit, u => {
    const pw = toPx(st.w, st.unit, st.ppi), ph = toPx(st.h, st.unit, st.ppi); st.unit = u; st.w = fromPx(pw, u, st.ppi); st.h = fromPx(ph, u, st.ppi); fw.setValue(round(st.w, 3)); fh.setValue(round(st.h, 3)); out();
  }, 'in');
  const fr = num({ value: st.ppi, min: 1, max: 4800, digits: 2, cls: 'in', scrub: false, onChange: v => { st.ppi = v; out(); } });
  const fbg = select([['white', 'White'], ['black', 'Black'], ['transparent', 'Transparent'], ['fg', 'Foreground color'], ['bgc', 'Background color']], st.bg, v => { st.bg = v; out(); }, 'in');
  const oP = h('button', h('i', { style: { width: '10px', height: '14px' } })), oL = h('button', h('i', { style: { width: '14px', height: '10px' } }));
  const orient = want => { if ((st.w > st.h) !== want) { [st.w, st.h] = [st.h, st.w]; fw.setValue(round(st.w, 3)); fh.setValue(round(st.h, 3)); out(); } };
  oP.onclick = () => orient(false); oL.onclick = () => orient(true);
  const readout = h('div.readout');
  const px = () => ({ w: Math.round(toPx(st.w, st.unit, st.ppi)), h: Math.round(toPx(st.h, st.unit, st.ppi)) });
  function out() {
    const p = px(), bytes = p.w * p.h * 4, max = Math.min(12000, app.view.comp.g.maxTex);
    readout.innerHTML = '';
    readout.append(h('b', `${p.w} × ${p.h} px`), h('br'), `${round(p.w / st.ppi, 2)} × ${round(p.h / st.ppi, 2)} in @ ${round(st.ppi, 2)} ppi`, h('br'), `${fmtBytes(bytes)} per layer`);
    if (p.w > max || p.h > max) readout.append(h('br'), h('span.warn', `Above the ${max} px limit`));
    else if (bytes > 400e6) readout.append(h('br'), h('span.warn', 'Very large: a few layers will use several GB of memory'));
    oP.classList.toggle('on', p.h >= p.w); oL.classList.toggle('on', p.w > p.h);
  }
  function drawCats() {
    cats.innerHTML = '';
    for (const c of ['Recent', ...Object.keys(PRESETS)]) cats.append(h('button' + (c === cat ? '.on' : ''), { on: { click: () => { cat = c; drawCats(); } } }, c));
    grid.innerHTML = '';
    const list = cat === 'Recent' ? recents() : PRESETS[cat];
    if (!list.length) grid.append(h('div.lbl', { style: { gridColumn: '1/-1', padding: '20px 0' } }, 'Sizes you create show up here.'));
    for (const p of list) {
      const wpx = toPx(p[1], p[3], p[4]), hpx = toPx(p[2], p[3], p[4]), s = 46 / Math.max(wpx, hpx);
      const card = h('div.pc', h('div.shape', h('i', { style: { width: wpx * s + 'px', height: hpx * s + 'px' } })), h('b', p[0]), h('small', `${round(p[1], 2)} × ${round(p[2], 2)} ${p[3]} · ${p[4]} ppi`));
      card.onclick = () => { $$('.pc', grid).forEach(x => x.classList.toggle('on', x === card)); st.unit = p[3]; st.w = p[1]; st.h = p[2]; st.ppi = p[4]; fu.value = p[3]; fw.setValue(p[1]); fh.setValue(p[2]); fr.setValue(p[4]); out(); };
      grid.append(card);
    }
  }
  drawCats(); out();
  const body = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 290px', gap: '0', margin: '-16px -18px', minHeight: '420px' } },
    h('div', { style: { padding: '14px 18px', borderRight: '1px solid var(--line)' } }, cats, grid),
    h('div', { style: { padding: '14px 18px', background: 'var(--panel2)' } },
      fl('Name', name),
      h('div.two', fl('Width', fw), fl('Height', fh)),
      h('div.two', fl('Units', fu), fl('Orientation', h('div.orient', oP, oL))),
      h('div.two', fl('Resolution', fr), fl(' ', select([['ppi', 'Pixels/Inch']], 'ppi', () => { }, 'in'))),
      h('div.two', fl('Color mode', select([['rgb', 'RGB Color']], 'rgb', () => { }, 'in')), fl('Bit depth', select([['8', '8 bit']], '8', () => { }, 'in'))),
      fl('Background contents', fbg), readout));
  return new Promise(res => modal('New document', body, [{ label: 'Cancel', value: null, ghost: true }, {
    label: 'Create', primary: true, run: () => {
      const p = px(), max = Math.min(12000, app.view.comp.g.maxTex);
      if (p.w < 1 || p.h < 1 || p.w > max || p.h > max) { app.ui.toast(`Width and height must be 1–${max} px`); return false; }
      const bg = st.bg === 'fg' ? 'custom' : st.bg === 'bgc' ? 'custom' : st.bg, bgColor = C.hex(st.bg === 'fg' ? app.fg : app.bg);
      const d = app.newDoc({ name: st.name || 'Untitled', width: p.w, height: p.h, ppi: st.ppi, background: bg, bgColor });
      app.prefs.lastNew = { name: st.name, w: p.w, h: p.h, unit: st.unit, ppi: st.ppi, bg: st.bg };
      const rs = (app.prefs.recentSizes || []).filter(r => !(r.w === p.w && r.h === p.h && r.ppi === st.ppi));
      rs.unshift({ w: p.w, h: p.h, ppi: st.ppi, name: `${p.w} × ${p.h}` }); app.prefs.recentSizes = rs.slice(0, 8); app.savePrefs();
      res(d);
    },
  }], { width: 900, onClose: v => { if (v === null) res(null); } }));
}

/* ---------- Image size ---------- */
export const RESAMPLE = [['auto', 'Automatic', 'picks per direction'], ['nearest', 'Nearest neighbor', 'hard edges, pixel art'], ['bilinear', 'Bilinear', 'fast, slightly soft'], ['bicubic', 'Bicubic', 'smooth gradients'], ['smoother', 'Bicubic smoother', 'best for enlarging'], ['sharper', 'Bicubic sharper', 'best for reducing']];
export function imageSizeDialog(app) {
  const d = app.doc;
  const st = { w: d.width, h: d.height, ppi: d.ppi, unit: 'px', link: true, resample: true, method: 'auto' };
  const ratio = d.height / d.width;
  const out = h('div.readout', { style: { marginBottom: '14px' } });
  const conv = (px) => fromPx(px, st.unit, st.ppi, st.unit === 'pct' ? (fw === 'w' ? d.width : d.height) : 0);
  let fw;
  const W = num({ value: st.w, min: 0.01, digits: 2, cls: 'in', scrub: false, onChange: v => { fw = 'w'; st.w = Math.max(1, Math.round(st.unit === 'pct' ? v / 100 * d.width : toPx(v, st.unit, st.ppi))); if (st.link) { st.h = Math.max(1, Math.round(st.w * ratio)); } sync(); } });
  const H = num({ value: st.h, min: 0.01, digits: 2, cls: 'in', scrub: false, onChange: v => { fw = 'h'; st.h = Math.max(1, Math.round(st.unit === 'pct' ? v / 100 * d.height : toPx(v, st.unit, st.ppi))); if (st.link) { st.w = Math.max(1, Math.round(st.h / ratio)); } sync(); } });
  const U = select([['px', 'Pixels'], ['pct', 'Percent'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters']], 'px', u => { st.unit = u; sync(); }, 'in');
  const P = num({ value: st.ppi, min: 1, max: 4800, digits: 2, cls: 'in', scrub: false, onChange: v => {
    if (!st.resample) { st.ppi = v; } else { st.ppi = v; }
    sync();
  } });
  const chain = h('div', { style: { width: '14px', alignSelf: 'stretch', border: '1.5px solid var(--line2)', borderLeft: 0, borderRadius: '0 6px 6px 0', margin: '22px 0 14px', position: 'relative', cursor: 'pointer' }, title: 'Constrain proportions (off = stretch)' }, h('span', { style: { position: 'absolute', left: '2px', top: '50%', transform: 'translateY(-50%)', background: 'var(--panel)', color: 'var(--accent)' } }, icon('chain', true)));
  chain.onclick = () => { st.link = !st.link; chain.firstChild.style.color = st.link ? 'var(--accent)' : 'var(--dim)'; if (st.link) { st.h = Math.round(st.w * ratio); sync(); } };
  const cards = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } });
  for (const [k, n, s] of RESAMPLE) { const c = h('div.rsc' + (k === st.method ? '.on' : ''), h('b', n), h('small', s)); c.onclick = () => { st.method = k; $$('.rsc', cards).forEach(x => x.classList.toggle('on', x === c)); }; cards.append(c); }
  const rs = chk('Resample: rebuild pixels when the size changes', true, v => { st.resample = v; cards.style.opacity = v ? 1 : .4; cards.style.pointerEvents = v ? '' : 'none'; if (!v) { st.w = d.width; st.h = d.height; } sync(); });
  function sync() {
    if (!st.resample) {
      // fixed pixels: width/height in physical units follow the resolution
      st.w = d.width; st.h = d.height;
    }
    W.setValue(round(st.unit === 'pct' ? st.w / d.width * 100 : fromPx(st.w, st.unit, st.ppi), 2));
    H.setValue(round(st.unit === 'pct' ? st.h / d.height * 100 : fromPx(st.h, st.unit, st.ppi), 2));
    out.innerHTML = ''; out.append('Image size: ', h('b', fmtBytes(st.w * st.h * 4)), ` (was ${fmtBytes(d.width * d.height * 4)}) · Dimensions: `, h('b', `${st.w} × ${st.h} px`));
  }
  sync();
  const body = h('div', out,
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 20px', gap: '4px' } }, h('div', h('div.two', fl('Width', W), fl(' ', U)), h('div.two', fl('Height', H), h('div'))), chain),
    h('div.two', fl('Resolution (ppi)', P), h('div')), h('div.fl', rs), cards);
  return new Promise(res => modal('Image size', body, [{ label: 'Cancel', ghost: true, value: null }, { label: 'OK', primary: true, run: () => res({ w: st.w, h: st.h, ppi: st.ppi, method: st.resample ? st.method : null }) }], { width: 520, onClose: v => v === null && res(null) }));
}

/* ---------- Canvas size ---------- */
export function canvasSizeDialog(app) {
  const d = app.doc;
  const st = { w: d.width, h: d.height, unit: 'px', rel: false, ax: 1, ay: 1, ext: d.all().some(l => l.isBackground) ? 'bg' : 'transparent' };
  const W = num({ value: st.w, digits: 2, cls: 'in', scrub: false, onChange: v => { st.wv = v; } });
  const H = num({ value: st.h, digits: 2, cls: 'in', scrub: false, onChange: v => { st.hv = v; } });
  st.wv = st.w; st.hv = st.h;
  const U = select([['px', 'Pixels'], ['pct', 'Percent'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters']], 'px', u => { const pw = calc().w, ph = calc().h; st.unit = u; st.wv = st.rel ? 0 : unitOf(pw, 'w'); st.hv = st.rel ? 0 : unitOf(ph, 'h'); W.setValue(round(st.wv, 2)); H.setValue(round(st.hv, 2)); }, 'in');
  const unitOf = (px, ax) => st.unit === 'pct' ? px / (ax === 'w' ? d.width : d.height) * 100 : fromPx(px, st.unit, d.ppi);
  const toP = (v, ax) => st.unit === 'pct' ? v / 100 * (ax === 'w' ? d.width : d.height) : toPx(v, st.unit, d.ppi);
  const calc = () => ({ w: Math.max(1, Math.round(st.rel ? d.width + toP(st.wv, 'w') : toP(st.wv, 'w'))), h: Math.max(1, Math.round(st.rel ? d.height + toP(st.hv, 'h') : toP(st.hv, 'h'))) });
  const rel = chk('Relative', false, v => { st.rel = v; st.wv = v ? 0 : unitOf(d.width, 'w'); st.hv = v ? 0 : unitOf(d.height, 'h'); W.setValue(round(st.wv, 2)); H.setValue(round(st.hv, 2)); });
  const anchor = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3,26px)', gap: '3px' } });
  const drawA = () => { anchor.innerHTML = ''; for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) { const on = x === st.ax && y === st.ay; anchor.append(h('button', { style: { width: '26px', height: '26px', borderRadius: '5px', border: '1px solid var(--line2)', background: on ? 'var(--accent)' : 'var(--field)', cursor: 'pointer' }, on: { click: () => { st.ax = x; st.ay = y; drawA(); } } })); } };
  drawA();
  const ext = select([['bg', 'Background color'], ['fg', 'Foreground color'], ['white', 'White'], ['black', 'Black'], ['transparent', 'Transparent']], st.ext, v => st.ext = v, 'in');
  const body = h('div', h('div.readout', { style: { marginBottom: '14px' } }, 'Current size: ', h('b', `${d.width} × ${d.height} px`)),
    h('div.three', fl('Width', W), fl('Height', H), fl('Units', U)), h('div.fl', rel), h('div.two', fl('Anchor', anchor), fl('Canvas extension color', ext)));
  return new Promise(res => modal('Canvas size', body, [{ label: 'Cancel', ghost: true, value: null }, {
    label: 'OK', primary: true, run: () => {
      const c = calc(); if (c.w > 12000 || c.h > 12000) { app.ui.toast('Max 12000 px'); return false; }
      res({ w: c.w, h: c.h, dx: Math.round((c.w - d.width) * st.ax / 2), dy: Math.round((c.h - d.height) * st.ay / 2), ext: st.ext });
    },
  }], { width: 480, onClose: v => v === null && res(null) }));
}

/** a small form of number fields. fields: [{key, label, value, min, max, step, unit}] -> {key: value} | null */
export function numberPrompt(title, fields, opts = {}) {
  const st = {}; const rows = fields.map(f => { st[f.key] = f.value; return fl(f.label, num({ ...f, cls: 'in', scrub: false, onChange: v => st[f.key] = v })); });
  return new Promise(res => modal(title, h('div', ...rows, opts.extra || null), [{ label: 'Cancel', ghost: true, value: null }, { label: 'OK', primary: true, run: () => res(st) }], { width: opts.width || 360, onClose: v => v === null && res(null) }));
}

export function fillDialog(app) {
  const st = { use: 'fg', color: { ...app.fg }, mode: 'normal', opacity: 100, preserve: false };
  const sw = swatch(st.color, c => st.color = c);
  const body = h('div', fl('Contents', select([['fg', 'Foreground color'], ['bg', 'Background color'], ['color', 'Color…'], ['black', 'Black'], ['white', 'White'], ['gray', '50% Gray']], 'fg', v => { st.use = v; sw.style.display = v === 'color' ? '' : 'none'; }, 'in'), sw),
    h('div.two', fl('Mode', blendSelect(st.mode, v => st.mode = v)), fl('Opacity %', num({ value: 100, min: 0, max: 100, cls: 'in', onChange: v => st.opacity = v }))),
    h('div.fl', chk('Preserve transparency', false, v => st.preserve = v)));
  sw.style.display = 'none';
  return new Promise(res => modal('Fill', body, [{ label: 'Cancel', ghost: true, value: null }, { label: 'OK', primary: true, run: () => res(st) }], { width: 400, onClose: v => v === null && res(null) }));
}
export function strokeDialog(app) {
  const st = { width: 4, color: { ...app.fg }, where: 'center', mode: 'normal', opacity: 100 };
  const body = h('div', h('div.two', fl('Width (px)', num({ value: 4, min: 1, max: 250, cls: 'in', onChange: v => st.width = v })), fl('Color', swatch(st.color, c => st.color = c))),
    fl('Location', seg([['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']], 'center', v => st.where = v)),
    h('div.two', fl('Mode', blendSelect('normal', v => st.mode = v)), fl('Opacity %', num({ value: 100, min: 0, max: 100, cls: 'in', onChange: v => st.opacity = v }))));
  return new Promise(res => modal('Stroke', body, [{ label: 'Cancel', ghost: true, value: null }, { label: 'OK', primary: true, run: () => res(st) }], { width: 400, onClose: v => v === null && res(null) }));
}
import { BLEND_MODES, blendName } from '../doc.js';
/** blend mode picker. Hovering or arrowing through the list calls onPreview(mode) so the canvas
 *  shows each mode live; onPreview(null) restores the original (always before onChange fires) */
export function blendSelect(value, onChange, withPass = false, cls = 'in', onPreview = null) {
  const items = [...(withPass ? [['pass', 'Pass Through'], null] : []), ...BLEND_MODES];
  const b = h('button.sel' + (cls ? '.' + cls : ''), { type: 'button' }, blendName(value));
  b.value = value;
  let list = null, hot = -1, ptr = null;
  const close = () => {
    if (!list) return;
    list.remove(); list = null; b.classList.remove('open');
    window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', key, true);
    onPreview && onPreview(null);
  };
  const pick = v => { close(); if (v !== b.value) { b.value = v; b.textContent = blendName(v); onChange(v); } };
  const rows = () => [...list.querySelectorAll('.mi')];
  const light = i => {
    const r = rows(); if (!r.length) return;
    hot = Math.max(0, Math.min(r.length - 1, i));
    r.forEach((x, j) => x.classList.toggle('hot', j === hot));
    r[hot].scrollIntoView({ block: 'nearest' });
    onPreview && onPreview(r[hot].dataset.v);
  };
  const off = e => { if (list && !list.contains(e.target) && e.target !== b) close(); };
  const key = e => {
    if (!list) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') light(hot + (k === 'ArrowDown' ? 1 : -1));
    else if (k === 'Enter' || k === ' ') pick(rows()[hot].dataset.v);
    else if (k === 'Escape') close();
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  const open = () => {
    if (list || b.disabled) return;
    list = h('div.drop.blendlist');
    for (const it of items) {
      if (!it) { list.append(h('div.sep')); continue; }
      const r = h('div.mi' + (it[0] === b.value ? '.cur' : ''), { on: { click: () => pick(it[0]) } }, h('span', it[1]));
      r.dataset.v = it[0];
      r.addEventListener('mouseenter', () => { if (list && rows().indexOf(r) !== hot) light(rows().indexOf(r)); });
      list.append(r);
    }
    document.body.append(list);
    const rc = b.getBoundingClientRect(), mh = Math.min(list.scrollHeight + 2, window.innerHeight - 16);
    const top = Math.max(8, Math.min(rc.bottom + 3, window.innerHeight - mh - 8));
    Object.assign(list.style, { left: rc.left + 'px', top: top + 'px', width: Math.max(rc.width, 170) + 'px', maxHeight: mh + 'px' });
    b.classList.add('open');
    list.addEventListener('pointermove', e => { ptr = { x: e.clientX, y: e.clientY }; });
    // scrolling moves rows under a still pointer: preview whatever ends up there
    list.addEventListener('scroll', () => {
      if (!ptr) return;
      const r = document.elementFromPoint(ptr.x, ptr.y), row = r && r.closest && r.closest('.blendlist .mi');
      if (row && rows().indexOf(row) !== hot) light(rows().indexOf(row));
    });
    const cur = rows().findIndex(r => r.dataset.v === b.value);
    hot = cur; if (cur >= 0) { rows()[cur].classList.add('hot'); rows()[cur].scrollIntoView({ block: 'center' }); }
    setTimeout(() => { window.addEventListener('pointerdown', off, true); window.addEventListener('keydown', key, true); }, 0);
  };
  b.addEventListener('click', () => list ? close() : open());
  b.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
  return b;
}

export function newGuideDialog(app) {
  const st = { axis: 'h', pos: 0 }; const u = app.prefs.units;
  const body = h('div', fl('Orientation', seg([['h', 'Horizontal'], ['v', 'Vertical']], 'h', v => st.axis = v)), fl(`Position (${u})`, num({ value: 0, digits: 2, cls: 'in', scrub: false, onChange: v => st.pos = v })));
  return new Promise(res => modal('New guide', body, [{ label: 'Cancel', ghost: true, value: null }, { label: 'OK', primary: true, run: () => res({ axis: st.axis, pos: Math.round(toPx(st.pos, u, app.doc.ppi, st.axis === 'v' ? app.doc.width : app.doc.height)) }) }], { width: 340, onClose: v => v === null && res(null) }));
}
export function guideLayoutDialog(app) {
  const st = { cols: 3, rows: 0, gutter: 0, margin: 0, center: false, clear: true };
  const n = (k, label, v, max = 50) => fl(label, num({ value: v, min: 0, max, cls: 'in', scrub: false, onChange: x => st[k] = x }));
  const body = h('div', h('div.two', n('cols', 'Columns', 3), n('rows', 'Rows', 0)), h('div.two', n('gutter', 'Gutter (px)', 0, 5000), n('margin', 'Margin (px)', 0, 5000)),
    h('div.fl', chk('Center guides', false, v => st.center = v)), h('div.fl', chk('Clear existing guides', true, v => st.clear = v)));
  return new Promise(res => modal('New guide layout', body, [{ label: 'Cancel', ghost: true, value: null }, { label: 'OK', primary: true, run: () => res(st) }], { width: 380, onClose: v => v === null && res(null) }));
}

export function settingsDialog(app) {
  const p = app.prefs;
  const body = h('div',
    fl('Ruler units', select([['px', 'Pixels'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters'], ['pt', 'Points'], ['pct', 'Percent']], p.units, v => app.setPref('units', v), 'in')),
    fl('Skin', select(['mono', 'violet', 'paper', 'terminal', 'ember', 'ice', 'wyrm'], p.skin, v => app.setPref('skin', v), 'in')),
    h('div.fl', chk('Show pixel grid above 800%', p.pixelGrid !== false, v => app.setPref('pixelGrid', v))),
    h('div.fl', chk('Autosave and recover after a crash', p.autosave !== false, v => app.setPref('autosave', v))),
    h('div.fl', chk('Dropping a file on an open document opens it in a new tab (instead of placing it; ⌥ switches)', !!p.dropOpens, v => app.setPref('dropOpens', v))),
    fl('History states', num({ value: p.history || 100, min: 10, max: 500, cls: 'in', scrub: false, onChange: v => app.setPref('history', v) })));
  return modal('Settings', body, [{ label: 'Done', primary: true }], { width: 440 });
}
export function aboutDialog() {
  return modal('About stlv', h('div', { style: { lineHeight: '1.6' } }, h('div', { style: { fontFamily: 'var(--cond)', fontSize: '32px', letterSpacing: '.2em' } }, 'STLV'), 'A lean image editor. Version 0.1.0', h('br'), h('span.lbl', 'Built for Sterea. Native shell + WebGL2 compositor. No third-party code.')), [{ label: 'OK', primary: true }], { width: 380 });
}
export { lbl, fl };
