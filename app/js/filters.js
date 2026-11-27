// Filters (CPU). Blur: gaussian, box, motion, zoom, spin. Pixelate: mosaic,
// crystallize, color halftone. Code + generative (ported from SB Machine's
// sb_fx.py): ASCII, code rain, point cloud. Each runs on a canvas and returns
// a canvas (possibly larger: blurs grow the bounds). Live filters re-run when
// the layer or a parameter changes; while a slider is dragged they preview at
// reduced size.

import { canvas, ctx, getData, R } from './util.js';
import { blurImageData } from './blur.js';
import { lineRun } from './lines.js';
import { sbRun, SB_GROUPS, SB_NAMES, SB_AMT, SB_OWN_COLOUR } from './sbfx.js';

export const FILTERS = {
  gauss: { name: 'Gaussian Blur', group: 'Blur', params: [['radius', 'Radius', 0.1, 250, 8, ' px', 0.1]], pad: p => Math.ceil(p.radius * 3) },
  box: { name: 'Box Blur', group: 'Blur', params: [['radius', 'Radius', 1, 250, 10, ' px']], pad: p => Math.ceil(p.radius * 2) },
  motion: { name: 'Motion Blur', group: 'Blur', params: [['angle', 'Angle', -180, 180, 0, '°'], ['dist', 'Distance', 1, 2000, 60, ' px']], pad: p => Math.ceil(p.dist / 2) + 2 },
  zoom: { name: 'Zoom Blur', group: 'Blur', params: [['amount', 'Amount', 1, 100, 25, '']], center: true, pad: () => 0 },
  spin: { name: 'Spin Blur', group: 'Blur', params: [['angle', 'Angle', 1, 90, 10, '°']], center: true, pad: () => 0 },
  mosaic: { name: 'Mosaic', group: 'Pixelate', params: [['cell', 'Cell size', 2, 400, 24, ' px']] },
  crystal: { name: 'Crystallize', group: 'Pixelate', params: [['cell', 'Cell size', 3, 400, 30, ' px']] },
  halftone: { name: 'Color Halftone', group: 'Pixelate', params: [['rad', 'Max radius', 4, 127, 12, ' px'], ['c', 'Cyan angle', 0, 360, 108, '°'], ['m', 'Magenta angle', 0, 360, 162, '°'], ['y', 'Yellow angle', 0, 360, 90, '°'], ['k', 'Black angle', 0, 360, 45, '°']] },
  ascii: { name: 'ASCII', group: 'Code', params: [['cells', 'Cells across', 16, 300, 64, ''], ['bg', 'Picture', 0, 100, 20, '%'], ['flick', 'Digit flicker', 0, 60, 16, '%'], ['band', 'Band', 0, 100, 0, '%'], ['seed', 'Seed', 0, 999, 7, ''], ['col', 'Color', ['FG / BG swatches', 'Image'], 0]] },
  rain: { name: 'Code Rain', group: 'Code', params: [['cells', 'Columns', 12, 200, 44, ''], ['dens', 'Density', 0, 100, 72, '%'], ['trail', 'Trail', 20, 300, 100, '%'], ['pic', 'Picture', 0, 100, 78, '%'], ['seed', 'Seed', 0, 999, 42, ''], ['col', 'Color', ['FG / BG swatches', 'Image'], 0]] },
  cloud: { name: 'Point Cloud', group: 'Generative', params: [['dens', 'Dots across', 12, 240, 54, ''], ['size', 'Dot size', 20, 200, 100, '%'], ['depth', 'Depth', 0, 200, 100, '%'], ['turn', 'Turn', -80, 80, 28, '°'], ['thr', 'Threshold', 0, 60, 8, '%'], ['bgm', 'Background', ['Black', 'Transparent'], 0], ['col', 'Color', ['FG / BG swatches', 'Image'], 0]] },
};
// SB FX: SB Machine's clip looks (sbfx.js, on the GPU). `sb` = the mode, `short` = the name inside the SB FX menu
for (const [sub, modes] of SB_GROUPS) for (const m of modes) {
  const params = [['amt', SB_AMT[m] || 'Strength', 0, 100, 70, '%']];
  if (m === 'chrome') params.push(['flow', 'Flow', 0, 100, 0, '%'], ['beat', 'Phase', 0, 16, 0, '', 0.1]);
  FILTERS['sb_' + m] = { name: 'SB ' + SB_NAMES[m], short: SB_NAMES[m], group: 'SB FX', sub, sb: m, ownColour: SB_OWN_COLOUR.includes(m), params };
}
// Lines (lines.js): op-art line drawings. fg = ink, bgc = paper
const PAPER = ['paper', 'Paper', ['Colour', 'Transparent', 'Picture'], 0];
FILTERS.contour = { name: 'Contour Loops', group: 'Lines', inkPaper: true, params: [['lines', 'Rings', 4, 120, 26, ''], ['thick', 'Thickness', 0.5, 20, 2.5, ' px', 0.1], ['smooth', 'Smooth', 0, 40, 5, ' px', 0.5], ['phase', 'Phase', 0, 100, 0, '%'], ['invert', 'Tone', ['Normal', 'Inverted'], 0], PAPER] };
FILTERS.waves = { name: 'Wave Lines', group: 'Lines', inkPaper: true, params: [['spacing', 'Spacing', 3, 120, 16, ' px'], ['thick', 'Thickness', 5, 100, 60, '%'], ['bend', 'Bend', 0, 400, 150, ' px'], ['wiggle', 'Wiggle', 0, 100, 0, '%'], ['angle', 'Angle', -90, 90, 0, '°'], ['smooth', 'Smooth', 0, 40, 4, ' px', 0.5], ['phase', 'Phase', 0, 100, 0, '%'], ['invert', 'Tone', ['Normal', 'Inverted'], 0], PAPER] };
FILTERS.strips = { name: 'Line Strips', group: 'Lines', inkPaper: true, params: [['cols', 'Columns', 2, 24, 6, ''], ['shift', 'Shift', 0, 100, 30, '%'], ['seed', 'Shuffle', 0, 999, 3, ''], ['lines', 'Rings', 4, 120, 26, ''], ['spacing', 'Spacing', 3, 120, 12, ' px'], ['thick', 'Thickness', 5, 100, 55, '%'], ['bend', 'Bend', 0, 400, 150, ' px'], ['angle', 'Angle', -90, 90, 0, '°'], ['smooth', 'Smooth', 0, 40, 4, ' px', 0.5], ['phase', 'Phase', 0, 100, 0, '%'], PAPER] };
export const FILTER_GROUPS = ['Blur', 'Pixelate', 'Code', 'Generative', 'Lines', 'SB FX'];

export function defaultFilterParams(type, app, doc) {
  const p = {};
  for (const q of FILTERS[type].params) p[q[0]] = Array.isArray(q[2]) ? q[3] : q[4];
  if (FILTERS[type].center && doc) { p.cx = doc.width / 2; p.cy = doc.height / 2; }
  if (app) { p.fg = { ...app.fg }; p.bgc = { ...app.bg }; }
  if (FILTERS[type].inkPaper) { p.fg = { r: 20, g: 20, b: 20 }; p.bgc = { r: 239, g: 233, b: 223 }; }
  if (FILTERS[type].sb) { p.col = 'blood'; if (doc) p.ref = Math.max(doc.width, doc.height); }
  return p;
}

/* ---------- helpers ---------- */
const mk = canvas;
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const hash = (i, salt = 0) => { let x = Math.imul((i + 1) ^ Math.imul(salt + 1, 0x9E3779B1), 0x85EBCA6B); x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35); x ^= x >>> 16; return x >>> 0; };
const toArr = c => c ? [c.r, c.g, c.b] : [0, 0, 0];
function padded(src, pad) { if (!pad) return src; const c = mk(src.width + pad * 2, src.height + pad * 2); ctx(c).drawImage(src, pad, pad); return c; }
/** average of n transformed copies; 'lighter' sums premultiplied colour so alpha averages too */
function avgCopies(src, n, xf) {
  const out = mk(src.width, src.height), c = ctx(out);
  c.globalCompositeOperation = 'lighter'; c.globalAlpha = 1 / n;
  for (let i = 0; i < n; i++) { c.save(); xf(c, n === 1 ? 0 : i / (n - 1) - 0.5); c.drawImage(src, 0, 0); c.restore(); }
  return out;
}
function avg2(src, n1, n2, xf) { let o = avgCopies(src, n1, (c, t) => xf(c, t, 1)); if (n2 > 1) o = avgCopies(o, n2, (c, t) => xf(c, t, 1 / n1)); return o; }
function cellStats(src, cw, ch, cols, rows) {
  const w = src.width, hh = src.height, d = getData(src).data, S = new Float64Array(cols * rows * 6), M = new Float32Array(cols * rows);
  for (let y = 0; y < hh; y++) { const cy = Math.min(rows - 1, Math.floor(y / ch)); for (let x = 0; x < w; x++) {
    const k = cy * cols + Math.min(cols - 1, Math.floor(x / cw)), i = (y * w + x) * 4, a = d[i + 3] / 255, r = d[i] * a, g = d[i + 1] * a, b = d[i + 2] * a, L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    S[k * 6] += r; S[k * 6 + 1] += g; S[k * 6 + 2] += b; S[k * 6 + 3] += a; S[k * 6 + 4] += L; S[k * 6 + 5]++; if (L > M[k]) M[k] = L; } }
  return k => { const n = S[k * 6 + 5] || 1, al = S[k * 6 + 3] || 1; return { a: S[k * 6 + 3] / n, L: S[k * 6 + 4] / n, max: M[k], col: [S[k * 6] / al, S[k * 6 + 1] / al, S[k * 6 + 2] / al] }; };
}
const RAMP = ' .:-=+*#%@', DIGITS = '0123456789';
const monoFont = px => `${Math.max(4, Math.round(px))}px Menlo, "SF Mono", monospace`;
function dimmed(src, k) { const o = mk(src.width, src.height), c = ctx(o); c.drawImage(src, 0, 0); c.globalCompositeOperation = 'source-atop'; c.fillStyle = `rgba(0,0,0,${1 - k})`; c.fillRect(0, 0, o.width, o.height); c.globalCompositeOperation = 'source-over'; return o; }

/* ---------- the filters. run(src, p, info{ox, oy, scale}) -> canvas (same size as src) ---------- */
const RUN = {
  contour: (src, p, s) => lineRun('contour', src, p, s), waves: (src, p, s) => lineRun('waves', src, p, s), strips: (src, p, s) => lineRun('strips', src, p, s),
  ...Object.fromEntries(Object.values(FILTERS).filter(f => f.sb).map(f => ['sb_' + f.sb, (src, p, s) => sbRun(f.sb, src, p, s)])),
  gauss(src, p, s) { const id = getData(src); blurImageData(id, p.radius * s.scale); const o = mk(src.width, src.height); ctx(o).putImageData(id, 0, 0); return o; },
  box(src, p, s) { const id = getData(src); blurImageData(id, Math.max(1, p.radius * s.scale), true); const o = mk(src.width, src.height); ctx(o).putImageData(id, 0, 0); return o; },
  motion(src, p, s) {
    const d = p.dist * s.scale, a = -p.angle * Math.PI / 180, n1 = Math.max(2, Math.min(24, Math.ceil(d / 3))), n2 = Math.max(1, Math.min(16, Math.ceil(d / n1 / 1.5)));
    return avg2(src, n1, n2, (c, t, k) => c.translate(Math.cos(a) * d * k * t, Math.sin(a) * d * k * t));
  },
  zoom(src, p, s) {
    const cx = (p.cx - s.ox) * s.scale, cy = (p.cy - s.oy) * s.scale, range = p.amount * 0.006, n1 = 24, n2 = Math.max(1, Math.min(16, Math.ceil(range * Math.max(src.width, src.height) / n1 / 2)));
    return avg2(src, n1, n2, (c, t, k) => { c.translate(cx, cy); const z = 1 + (t + 0.5) * range * k; c.scale(z, z); c.translate(-cx, -cy); });
  },
  spin(src, p, s) {
    const cx = (p.cx - s.ox) * s.scale, cy = (p.cy - s.oy) * s.scale, th = p.angle * Math.PI / 180, n1 = 24, n2 = Math.max(1, Math.min(16, Math.ceil(th * Math.max(src.width, src.height) / 2 / n1 / 1.5)));
    return avg2(src, n1, n2, (c, t, k) => { c.translate(cx, cy); c.rotate(th * t * k); c.translate(-cx, -cy); });
  },
  mosaic(src, p, s) {
    const w = src.width, hh = src.height, d = getData(src).data, cell = Math.max(1, p.cell * s.scale);
    const ox = (s.ox * s.scale) % cell, oy = (s.oy * s.scale) % cell;   // grid anchored to the document, not the layer
    const gw = Math.ceil((w + ox) / cell) + 1, gh = Math.ceil((hh + oy) / cell) + 1, S = new Float64Array(gw * gh * 5);
    for (let y = 0; y < hh; y++) { const gy = Math.floor((y + oy) / cell) * gw; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, g = (gy + Math.floor((x + ox) / cell)) * 5, a = d[i + 3]; S[g] += d[i] * a; S[g + 1] += d[i + 1] * a; S[g + 2] += d[i + 2] * a; S[g + 3] += a; S[g + 4]++; } }
    const o = mk(w, hh), c = ctx(o);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const g = (j * gw + i) * 5, a = S[g + 3]; if (!a) continue;
      c.fillStyle = `rgba(${S[g] / a | 0},${S[g + 1] / a | 0},${S[g + 2] / a | 0},${a / S[g + 4] / 255})`;
      const x0 = Math.round(i * cell - ox), y0 = Math.round(j * cell - oy); c.fillRect(x0, y0, Math.round((i + 1) * cell - ox) - x0, Math.round((j + 1) * cell - oy) - y0); }
    return o;
  },
  crystal(src, p, s) {
    const w = src.width, hh = src.height, sd = getData(src).data, o = mk(w, hh), oc = ctx(o), od = oc.createImageData(w, hh), D = od.data;
    const cell = Math.max(2, p.cell * s.scale), gw = Math.ceil(w / cell) + 1, gh = Math.ceil(hh / cell) + 1, sx = new Float32Array(gw * gh), sy = new Float32Array(gw * gh);
    const rnd = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const k = j * gw + i; sx[k] = (i + rnd(k)) * cell; sy[k] = (j + rnd(k + 9999)) * cell; }
    for (let y = 0; y < hh; y++) { const cj = Math.floor(y / cell); for (let x = 0; x < w; x++) { const ci = Math.floor(x / cell); let best = 1e18, bk = 0;
      for (let jj = Math.max(0, cj - 1); jj <= Math.min(gh - 1, cj + 1); jj++) for (let ii = Math.max(0, ci - 1); ii <= Math.min(gw - 1, ci + 1); ii++) {
        const k = jj * gw + ii, dx = sx[k] - x, dy = sy[k] - y, dd = dx * dx + dy * dy; if (dd < best) { best = dd; bk = k; } }
      const si = (Math.min(hh - 1, sy[bk] | 0) * w + Math.min(w - 1, sx[bk] | 0)) * 4, t = (y * w + x) * 4;
      D[t] = sd[si]; D[t + 1] = sd[si + 1]; D[t + 2] = sd[si + 2]; D[t + 3] = sd[si + 3]; } }
    oc.putImageData(od, 0, 0); return o;
  },
  halftone(src, p, s) {
    const w = src.width, hh = src.height, sd = getData(src).data, Rr = Math.max(1.5, p.rad * s.scale), g = Rr * Math.SQRT2;
    const o = mk(w, hh), c = ctx(o); c.fillStyle = '#fff'; c.fillRect(0, 0, w, hh); c.globalCompositeOperation = 'multiply';
    const cmyk = (x, y, ch) => { const i = (Math.min(hh - 1, Math.max(0, y | 0)) * w + Math.min(w - 1, Math.max(0, x | 0))) * 4, a = sd[i + 3] / 255;
      const r = (sd[i] * a + 255 * (1 - a)) / 255, gg = (sd[i + 1] * a + 255 * (1 - a)) / 255, b = (sd[i + 2] * a + 255 * (1 - a)) / 255, k = 1 - Math.max(r, gg, b);
      if (ch === 3) return k; if (k >= 1) return 0; return (1 - [r, gg, b][ch] - k) / (1 - k); };
    const n = Math.ceil(Math.hypot(w, hh) / g / 2) + 1;
    [['c', '#00ffff', 0], ['m', '#ff00ff', 1], ['y', '#ffff00', 2], ['k', '#000000', 3]].forEach(([key, col, ch]) => {
      const a = p[key] * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a); c.beginPath();
      for (let v = -n; v <= n; v++) for (let u = -n; u <= n; u++) {
        const x = w / 2 + u * g * ca - v * g * sa, y = hh / 2 + u * g * sa + v * g * ca; if (x < -g || y < -g || x > w + g || y > hh + g) continue;
        const r = Rr * Math.sqrt(cmyk(x, y, ch)); if (r < 0.3) continue; c.moveTo(x + r, y); c.arc(x, y, r, 0, 6.2832); }
      c.fillStyle = col; c.fill(); });
    c.globalCompositeOperation = 'destination-in'; c.drawImage(src, 0, 0);
    return o;
  },
  ascii(src, p, s) {
    const FG = toArr(p.fg), BGc = toArr(p.bgc || { r: 243, g: 239, b: 230 });
    const w = src.width, hh = src.height, cw = Math.max(3, Math.min(w, hh) / p.cells), ch = cw * 1.7, cols = Math.ceil(w / cw), rows = Math.ceil(hh / ch);
    const cell = cellStats(src, cw, ch, cols, rows), n = cols * rows, L = new Float32Array(n), Cc = [];
    for (let k = 0; k < n; k++) { Cc[k] = cell(k); L[k] = Cc[k].L; }
    const srt = Float32Array.from(L).sort(), lo = srt[n * 0.03 | 0] * 255, hi = srt[n * 0.97 | 0] * 255;
    const out = dimmed(src, p.bg / 100), c = ctx(out);
    c.globalCompositeOperation = 'lighter'; c.font = monoFont(ch * 0.82); c.textAlign = 'center'; c.textBaseline = 'middle';
    const bc = p.band > 0 ? p.band / 100 * rows : -1e9, bw = Math.max(2, rows * 0.1);
    for (let k = 0; k < n; k++) { if (Cc[k].a < 0.05) continue;
      const cy = k / cols | 0, cx = k % cols, v = Math.min(255, Math.max(0, (L[k] * 255 - lo) * 255 / Math.max(24, hi - lo))), lvl = Math.min(9, v * 10 / 256 | 0), r = hash(k, 7);
      const band = Math.abs(cy - bc) < bw && lvl >= 1, flick = lvl >= 4 && r % 100 < p.flick;
      const chr = band || flick ? DIGITS[((r + Math.imul(p.seed, 2654435761)) >>> 7) % 10] : RAMP[lvl]; if (chr === ' ') continue;
      c.fillStyle = band ? rgba(BGc, Cc[k].a) : rgba(p.col === 1 ? Cc[k].col.map(x => Math.min(255, x * 1.4)) : FG, (120 + v * 135 / 255) / 255 * Cc[k].a);
      c.fillText(chr, (cx + 0.5) * cw, (cy + 0.5) * ch); }
    return out;
  },
  rain(src, p, s) {
    const FG = toArr(p.fg), BGc = toArr(p.bgc || { r: 243, g: 239, b: 230 });
    const w = src.width, hh = src.height, cw = Math.max(4, Math.min(w, hh) / p.cells), ch = cw * 1.7, cols = Math.ceil(w / cw), rows = Math.ceil(hh / ch), t = p.seed / 10;
    const cell = p.col === 1 ? cellStats(src, cw, ch, cols, rows) : null;
    const out = dimmed(src, p.pic / 100), c = ctx(out);
    c.globalCompositeOperation = 'lighter'; c.font = monoFont(ch * 0.82); c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let j = 0; j < cols; j++) { const r = hash(j, 1); if (r % 100 >= p.dens) continue;
      const speed = 5 + (r % 1009) / 1009 * 15, trail = (5 + (r % 613) / 613 * 13) * p.trail / 100, period = rows + trail + 4 + (r % 211) / 211 * rows * 0.8;
      const head = ((r % 4099) / 4099 * period + speed * t) % period;
      for (let i = 0; i < rows; i++) { const dd = head - i; if (dd < 0 || dd >= trail) continue;
        const rr = hash(i * cols + j, 3), rate = 6 + (rr % 997) / 997 * 8, tick = Math.floor(t * rate + (rr % 389) / 389), dg = ((rr + Math.imul(tick, 2654435761)) >>> 7) % 10;
        const isHead = dd < 1, a = isHead ? 1 : Math.pow(1 - dd / trail, 1.4) * 0.83;
        c.fillStyle = isHead ? rgba(BGc, 1) : rgba(cell ? cell(i * cols + j).col.map(x => Math.min(255, x * 1.5 + 30)) : FG, a);
        c.fillText(DIGITS[dg], (j + 0.5) * cw, (i + 0.5) * ch); } }
    return out;
  },
  cloud(src, p, s) {
    const FG = toArr(p.fg), BGc = toArr(p.bgc || { r: 243, g: 239, b: 230 });
    const w = src.width, hh = src.height, cols = p.dens, sx = w / cols, rows = Math.max(1, Math.round(hh / sx)), sy = hh / rows, cell = cellStats(src, sx, sy, cols, rows);
    const dots = [], depth = p.depth / 100, ang = p.turn * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang), F = w * 1.8;
    for (let k = 0; k < cols * rows; k++) { const q = cell(k), L = 0.4 * q.L + 0.6 * q.max; if (L <= p.thr / 100) continue;
      const X = (k % cols + 0.5) * sx - w / 2, Y = ((k / cols | 0) + 0.5) * sy - hh / 2, Z = (L - 0.5) * w * 0.6 * depth, rx = X * ca + Z * sa, rz = -X * sa + Z * ca, sc = F / (F + rz);
      dots.push([rz, w / 2 + rx * sc, hh / 2 + Y * sc, L * sc, L, q.col]); }
    dots.sort((a, b) => b[0] - a[0]);
    const out = mk(w, hh), c = ctx(out); if (p.bgm === 0) { c.fillStyle = 'rgb(8,8,8)'; c.fillRect(0, 0, w, hh); }
    const rmax = sx * 0.42 * p.size / 100;
    for (const [, x, y, size, L, col] of dots) { const r = Math.max(0.6, rmax * (size < 0.45 ? 0.35 : size < 0.75 ? 0.65 : 1));
      c.fillStyle = p.col === 1 ? rgba(col.map(v => Math.min(255, v * 1.3)), 1) : rgba(L > 0.62 ? BGc : FG, 1);
      c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill(); }
    return out;
  },
};

/** run filters in order on a canvas placed at doc (x, y). scale < 1 = small preview,
 *  scaled back up to document size at the end. Returns {canvas, x, y} */
export function runChain(list, src, x, y, scale = 1) {
  let cur = src, ox = x, oy = y;
  if (scale < 1) { cur = mk(Math.max(1, Math.round(src.width * scale)), Math.max(1, Math.round(src.height * scale))); const c = ctx(cur); c.imageSmoothingQuality = 'high'; c.drawImage(src, 0, 0, cur.width, cur.height); }
  for (const f of list) {
    const def = FILTERS[f.type]; if (!def) continue;
    const pad = def.pad ? Math.ceil(def.pad(f.params) * scale) : 0;
    ox -= pad / scale; oy -= pad / scale;
    cur = RUN[f.type](padded(cur, pad), f.params, { ox, oy, scale });
  }
  if (scale < 1) {
    const W = Math.round(cur.width / scale), H = Math.round(cur.height / scale), big = mk(W, H), bc = ctx(big);
    bc.imageSmoothingQuality = 'high'; bc.drawImage(cur, 0, 0, W, H); cur = big;
  }
  return { canvas: cur, x: Math.round(ox), y: Math.round(oy) };
}
export const runFilter = (type, params, src, x, y) => runChain([{ type, params }], src, x, y, 1);
/** a layer's live filters applied in order: {canvas, x, y, rev} (cached) */
export function liveSource(layer, base, interactive) {
  const active = layer.filters.filter(f => f.visible !== false);
  if (!active.length || !base) return null;
  const key = JSON.stringify(active) + '|' + base.rev + '|' + base.canvas.width + 'x' + base.canvas.height + '|' + base.x + ',' + base.y;
  const c = layer._live;
  if (c && c.key === key && (c.scale === 1 || interactive)) return c;
  const px = base.canvas.width * base.canvas.height;
  const scale = interactive && px > 1.2e6 ? Math.sqrt(1.2e6 / px) : 1;
  const r = runChain(active, base.canvas, base.x, base.y, scale);
  layer._live = { key, canvas: r.canvas, x: r.x, y: r.y, rev: (c ? c.rev : 0) + 1, scale };
  return layer._live;
}
/** bake a filter into a pixel layer's canvas, through the selection. Returns {canvas, x, y} */
export function bakeFilter(type, params, layer, selection) {
  const r = runFilter(type, params, layer.canvas, layer.x, layer.y, 1);
  if (!selection || !selection.active) return { canvas: r.canvas, x: Math.round(r.x), y: Math.round(r.y) };
  // only inside the selection: original outside, filtered inside
  const b = R.union({ x: layer.x, y: layer.y, w: layer.canvas.width, h: layer.canvas.height }, { x: Math.round(r.x), y: Math.round(r.y), w: r.canvas.width, h: r.canvas.height });
  const out = mk(b.w, b.h), oc = ctx(out);
  const filt = mk(b.w, b.h), fc = ctx(filt); fc.drawImage(r.canvas, Math.round(r.x) - b.x, Math.round(r.y) - b.y);
  fc.globalCompositeOperation = 'destination-in'; fc.drawImage(selection.maskCanvas(), -b.x, -b.y);
  oc.drawImage(layer.canvas, layer.x - b.x, layer.y - b.y);
  oc.globalCompositeOperation = 'destination-out'; oc.drawImage(selection.maskCanvas(), -b.x, -b.y);
  oc.globalCompositeOperation = 'source-over'; oc.drawImage(filt, 0, 0);
  return { canvas: out, x: b.x, y: b.y };
}
