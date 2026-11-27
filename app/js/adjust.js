// Adjustment layers: definitions (params + defaults for the UI) and how they
// become shader uniforms / lookup tables. The math lives in FS_ADJUST (gl.js).

import { clamp } from './util.js';

export const ADJUSTMENTS = {
  bc: { name: 'Brightness / Contrast', params: [['brightness', 'Brightness', -150, 150, 0], ['contrast', 'Contrast', -50, 100, 0]] },
  levels: { name: 'Levels', hist: true, params: [['inBlack', 'Input black', 0, 253, 0], ['gamma', 'Midtones', 0.1, 9.99, 1, 0.01], ['inWhite', 'Input white', 2, 255, 255], ['outBlack', 'Output black', 0, 255, 0], ['outWhite', 'Output white', 0, 255, 255]] },
  curves: { name: 'Curves', curve: true, params: [] },
  hs: { name: 'Hue / Saturation', params: [['hue', 'Hue', -180, 180, 0], ['sat', 'Saturation', -100, 100, 0], ['light', 'Lightness', -100, 100, 0], ['colorize', 'Colorize', 'bool', false]] },
  vibrance: { name: 'Vibrance', params: [['vibrance', 'Vibrance', -100, 100, 0], ['sat', 'Saturation', -100, 100, 0]] },
  bw: { name: 'Black & White', params: [['reds', 'Reds', -200, 300, 40], ['yellows', 'Yellows', -200, 300, 60], ['greens', 'Greens', -200, 300, 40], ['cyans', 'Cyans', -200, 300, 60], ['blues', 'Blues', -200, 300, 20], ['magentas', 'Magentas', -200, 300, 80], ['tint', 'Tint', 'bool', false], ['tintHue', 'Tint hue', 0, 360, 35], ['tintSat', 'Tint saturation', 0, 100, 25]] },
  invert: { name: 'Invert', params: [] },
  dehaze: { name: 'Dehaze', params: [['amount', 'Amount', -100, 100, 40]] },
  threshold: { name: 'Threshold', params: [['level', 'Level', 1, 255, 128]] },
};
export const ADJ_ORDER = ['bc', 'levels', 'curves', 'hs', 'vibrance', 'bw', 'invert', 'dehaze', 'threshold'];
const TYPE_ID = { bc: 1, levels: 2, curves: 3, hs: 4, vibrance: 5, bw: 6, invert: 7, dehaze: 8, threshold: 9 };

export function defaultParams(adj) {
  const p = {};
  for (const [k, , a, , d] of ADJUSTMENTS[adj].params) p[k] = a === 'bool' ? d : d;
  if (adj === 'curves') p.curves = { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] };
  return p;
}

/** monotone cubic (Fritsch-Carlson) through points -> Float32Array(256) */
export function curveLut(pts) {
  pts = [...pts].sort((a, b) => a[0] - b[0]);
  const n = pts.length, xs = pts.map(q => q[0]), ys = pts.map(q => q[1]), dx = [], sl = [], m = [], lut = new Float32Array(256);
  if (n === 1) return lut.fill(ys[0]);
  for (let i = 0; i < n - 1; i++) { dx[i] = Math.max(1e-3, xs[i + 1] - xs[i]); sl[i] = (ys[i + 1] - ys[i]) / dx[i]; }
  m[0] = sl[0]; m[n - 1] = sl[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (!sl[i]) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / sl[i], b = m[i + 1] / sl[i], hh = a * a + b * b;
    if (hh > 9) { const t = 3 / Math.sqrt(hh); m[i] = t * a * sl[i]; m[i + 1] = t * b * sl[i]; }
  }
  for (let x = 0, i = 0; x < 256; x++) {
    if (x <= xs[0]) { lut[x] = ys[0]; continue; }
    if (x >= xs[n - 1]) { lut[x] = ys[n - 1]; continue; }
    while (x > xs[i + 1]) i++;
    const hh = dx[i], t = (x - xs[i]) / hh, t2 = t * t, t3 = t2 * t;
    lut[x] = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hh * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hh * m[i + 1];
  }
  return lut;
}

function lutRows(all, r, g, b) {
  const out = new Uint8Array(256 * 4), id = x => x;
  [all || id, r || id, g || id, b || id].forEach((f, row) => { for (let v = 0; v < 256; v++) out[row * 256 + v] = clamp(Math.round(f(v)), 0, 255); });
  return out;
}

/** {uniforms, lut?} for the adjust shader */
export function adjustUniforms(adj, p) {
  const u = { uType: ['1i', TYPE_ID[adj] || 0], uP0: ['4f', 0, 0, 0, 0], uP1: ['4f', 0, 0, 0, 0] };
  let lut = null;
  if (adj === 'bc') {
    const f = p.contrast >= 0 ? 1 + p.contrast / 100 * 1.5 : 1 + p.contrast / 100;
    lut = lutRows(v => (v + p.brightness * 0.6 - 127.5) * f + 127.5);
  } else if (adj === 'levels') {
    const iw = Math.max(p.inWhite, p.inBlack + 1);
    lut = lutRows(v => p.outBlack + (p.outWhite - p.outBlack) * Math.pow(clamp((v - p.inBlack) / (iw - p.inBlack), 0, 1), 1 / p.gamma));
  } else if (adj === 'curves') {
    const c = p.curves, L = k => { const t = curveLut(c[k]); return v => t[v]; };
    lut = lutRows(L('rgb'), L('r'), L('g'), L('b'));
  } else if (adj === 'hs') {
    u.uP0 = ['4f', p.hue / 360, p.sat / 100, p.light / 100, p.colorize ? 1 : 0];
    u.uP1 = ['4f', ((p.hue % 360) + 360) % 360 / 360, clamp(0.25 + p.sat / 200, 0, 1), 0, 0];
  } else if (adj === 'vibrance') {
    u.uP0 = ['4f', p.vibrance / 100, p.sat / 100, 0, 0];
  } else if (adj === 'bw') {
    u.uP0 = ['4f', p.reds / 100, p.yellows / 100, p.greens / 100, p.cyans / 100];
    u.uP1 = ['4f', p.blues / 100, p.magentas / 100, p.tint ? p.tintSat / 100 : 0, p.tintHue / 360];
  } else if (adj === 'dehaze') {
    u.uP0 = ['4f', p.amount / 100, 0, 0, 0];
  } else if (adj === 'threshold') {
    u.uP0 = ['4f', p.level / 255, 0, 0, 0];
  }
  return { uniforms: u, lut };
}

/** CPU version for destructive Image > Adjustments on a pixel layer (ImageData in place) */
export function adjustImageData(adj, p, id) {
  const d = id.data, n = d.length;
  const { lut } = adjustUniforms(adj, p);
  if (lut) { for (let i = 0; i < n; i += 4) { if (!d[i + 3]) continue; for (let c = 0; c < 3; c++) d[i + c] = lut[(c + 1) * 256 + lut[d[i + c]]]; } return id; }
  // the rest via the same formulas as the shader
  for (let i = 0; i < n; i += 4) {
    if (!d[i + 3]) continue;
    let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    [r, g, b] = cpuAdjust(adj, p, r, g, b);
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
  }
  return id;
}
function rgb2hsl(r, g, b) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dd = mx - mn; let h = 0, s = 0; if (dd > 1e-6) { s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn); h = (mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4) / 6; } return [h, s, l]; }
function h2r(p, q, t) { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }
function hsl2rgb(h, s, l) { if (s <= 0) return [l, l, l]; const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; return [h2r(p, q, h + 1 / 3), h2r(p, q, h), h2r(p, q, h - 1 / 3)]; }
function cpuAdjust(adj, p, r, g, b) {
  if (adj === 'hs') {
    let [hh, s, l] = rgb2hsl(r, g, b); const S = p.sat / 100, L = p.light / 100;
    if (p.colorize) { hh = (((p.hue % 360) + 360) % 360) / 360; s = clamp(0.25 + p.sat / 200, 0, 1); } else { hh = ((hh + p.hue / 360) % 1 + 1) % 1; s = clamp(S >= 0 ? s + (1 - s) * s * S * 1.6 : s * (1 + S), 0, 1); }
    l = L >= 0 ? l + (1 - l) * L : l * (1 + L);
    return hsl2rgb(hh, s, l).map(v => clamp(v, 0, 1));
  }
  if (adj === 'vibrance') {
    const V = p.vibrance / 100, S = p.sat / 100, mx = Math.max(r, g, b), mn = Math.min(r, g, b), avg = (r + g + b) / 3, s = mx - mn;
    const k = 1 + S + V * (V > 0 ? (1 - s) * (1 - s) * 1.6 : 1);
    return [r, g, b].map(v => clamp(avg + (v - avg) * k, 0, 1));
  }
  if (adj === 'bw') {
    const W = { r: p.reds / 100, y: p.yellows / 100, g: p.greens / 100, c: p.cyans / 100, b: p.blues / 100, m: p.magentas / 100 };
    let mx, md, mn, pri, sec;
    if (r >= g && r >= b) { mx = r; pri = 'r'; if (g >= b) { md = g; mn = b; sec = 'y'; } else { md = b; mn = g; sec = 'm'; } }
    else if (g >= b) { mx = g; pri = 'g'; if (r >= b) { md = r; mn = b; sec = 'y'; } else { md = b; mn = r; sec = 'c'; } }
    else { mx = b; pri = 'b'; if (r >= g) { md = r; mn = g; sec = 'm'; } else { md = g; mn = r; sec = 'c'; } }
    const v = clamp(mn + (md - mn) * W[sec] + (mx - md) * W[pri], 0, 1);
    if (p.tint) { const t = hsl2rgb(p.tintHue / 360, p.tintSat / 100, 0.5); return t.map(tc => v < 0.5 ? 2 * v * tc : 1 - 2 * (1 - v) * (1 - tc)); }
    return [v, v, v];
  }
  if (adj === 'invert') return [1 - r, 1 - g, 1 - b];
  if (adj === 'threshold') { const v = (0.2126 * r + 0.7152 * g + 0.0722 * b) >= p.level / 255 ? 1 : 0; return [v, v, v]; }
  return [r, g, b];
}
