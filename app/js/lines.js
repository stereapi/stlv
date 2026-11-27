// Lines: redraw a picture as lines, after op-art club flyers.
//   contour  rings that loop around shapes (iso-lines of the smoothed tone)
//   waves    parallel lines bent and thickened by the tone
//   strips   vertical columns, each a different treatment, shifted up or down
// CPU, anti-aliased by distance to the nearest line. Pattern coordinates are
// in document pixels (s.ox, s.oy), so two layers with the same settings line up.

import { canvas, ctx, getData } from './util.js';
import { blurImageData } from './blur.js';

const hash = (i, salt) => { let x = Math.imul((i + 1) ^ Math.imul(salt + 1, 0x9E3779B1), 0x85EBCA6B); x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
const cov = (half, dist) => { const c = half - dist + 0.5; return c <= 0 ? 0 : c >= 1 ? 1 : c; };

/** tone 0..1 (transparent counts as paper-white) of the source, smoothed by sigma px */
function toneOf(src, sigma) {
  const id = getData(src);
  if (sigma > 0.3) blurImageData(id, sigma);
  const d = id.data, n = src.width * src.height, L = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = d[i * 4 + 3] / 255; L[i] = a * (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255 + (1 - a); }
  return L;
}

export function lineRun(kind, src, p, s) {
  const w = src.width, h = src.height, k = s.scale, ox = s.ox * k, oy = s.oy * k;
  const L = toneOf(src, (p.smooth ?? 4) * k), sd = getData(src).data;
  const at = (x, y) => L[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  const inv = p.invert ? 1 : 0, T = (x, y) => inv ? 1 - at(x, y) : at(x, y);
  const phase = (p.phase || 0) / 100;

  // coverage of one treatment at layer pixel (x, y), reading the tone at row ty
  const contour = (x, y, ty) => {
    const n = p.lines || 24, v = T(x, ty) * n + phase;
    const gx = (T(x + 1, ty) - T(x - 1, ty)) * n / 2, gy = (T(x, ty + 1) - T(x, ty - 1)) * n / 2, g = Math.hypot(gx, gy);
    if (g < 1e-4) return 0;
    return cov((p.thick ?? 2.5) * k / 2, Math.abs(v - Math.round(v)) / g);
  };
  const waves = (x, y, ty, ang) => {
    const sp = Math.max(1.5, (p.spacing || 14) * k), bend = (p.bend ?? 40) * k, wig = (p.wiggle || 0) / 100 * sp * 1.5, per = 40 * sp / 14;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const q = (xx, yy) => {
      const X = xx + ox, Y = yy + oy, u = X * ca + Y * sa, v = -X * sa + Y * ca;
      return (v + bend * (T(xx, yy - y + ty) - 0.5) + wig * Math.sin(u / per * 6.2832 + phase * 6.2832)) / sp + phase;
    };
    const q0 = q(x, y), g = Math.hypot(q(x + 1, y) - q(x - 1, y), q(x, y + 1) - q(x, y - 1)) / 2;
    if (g < 1e-5) return 0;
    const dark = 1 - T(x, ty), half = Math.max(0.35, dark * (p.thick ?? 55) / 100 * sp / 2);
    return cov(half, Math.abs(q0 - Math.round(q0)) / g);
  };

  const out = canvas(w, h), oc = ctx(out), od = oc.createImageData(w, h), D = od.data;
  const ink = p.fg || { r: 20, g: 20, b: 20 }, pap = p.bgc || { r: 239, g: 233, b: 223 }, mode = p.paper || 0;
  const ang = (p.angle || 0) * Math.PI / 180;
  // strips: a treatment and a shift per column
  const cols = Math.max(1, p.cols || 6), colW = w / cols, seed = p.seed || 0, shift = (p.shift ?? 30) / 100 * h * 0.25;
  const colKind = [], colShift = [];
  for (let c = 0; c < cols; c++) { colKind.push(Math.floor(hash(c, seed) * 5)); colShift.push(Math.round((hash(c, seed + 99) - 0.5) * 2 * shift)); }

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c, ty = y, pic = false;
    if (kind === 'contour') c = contour(x, y, y);
    else if (kind === 'waves') c = waves(x, y, y, ang);
    else {
      const col = ((Math.floor((x + ox) / colW) % cols) + cols) % cols;
      ty = Math.min(h - 1, Math.max(0, y + colShift[col]));
      const kk = colKind[col];
      c = kk === 0 ? contour(x, y, ty) : kk === 1 ? waves(x, y, ty, ang) : kk === 2 ? waves(x, y, ty, ang + Math.PI / 2) : kk === 3 ? waves(x, y, ty, ang + Math.PI / 4) : 0;
      if (kk === 4) { pic = true; c = 1 - T(x, ty); }        // a plain band of the picture, in ink on paper
    }
    const a = sd[i + 3];
    if (mode === 1) { D[i] = ink.r; D[i + 1] = ink.g; D[i + 2] = ink.b; D[i + 3] = a * c; continue; }
    const base = mode === 2 && !pic ? [sd[i], sd[i + 1], sd[i + 2]] : [pap.r, pap.g, pap.b];
    D[i] = base[0] + (ink.r - base[0]) * c; D[i + 1] = base[1] + (ink.g - base[1]) * c; D[i + 2] = base[2] + (ink.b - base[2]) * c; D[i + 3] = a;
  }
  oc.putImageData(od, 0, 0);
  return out;
}
