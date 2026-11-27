// Gaussian blur as three box passes (O(n), any radius), for single-channel
// masks and premultiplied RGBA; and an exact Euclidean distance transform
// (Felzenszwalb) for selection expand / contract.

/** box sizes whose 3-pass result approximates a gaussian of sigma */
export function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2, mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4), m = Math.round(mIdeal);
  const sizes = []; for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

// one running-sum box pass of radius r over `src` into `dst`, horizontally (stride 1) or vertically
function boxH(src, dst, w, h, r, ch, chs) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) for (let c = 0; c < chs; c++) {
    const row = y * w;
    let ti = row, li = row, ri = row + r;
    const fv = src[row * ch + c], lv = src[(row + w - 1) * ch + c];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[(row + Math.min(j, w - 1)) * ch + c];
    for (let j = 0; j <= r; j++) { val += (ri < row + w ? src[ri * ch + c] : lv) - fv; dst[ti++ * ch + c] = val * iarr; ri++; }
    for (let j = r + 1; j < w - r; j++) { val += src[ri++ * ch + c] - src[li++ * ch + c]; dst[ti++ * ch + c] = val * iarr; }
    for (let j = Math.max(w - r, r + 1); j < w; j++) { val += lv - src[li++ * ch + c]; dst[ti++ * ch + c] = val * iarr; }
  }
}
function boxV(src, dst, w, h, r, ch, chs) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) for (let c = 0; c < chs; c++) {
    let ti = x, li = ti, ri = ti + r * w;
    const fv = src[ti * ch + c], lv = src[(ti + w * (h - 1)) * ch + c];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[(ti + Math.min(j, h - 1) * w) * ch + c];
    for (let j = 0; j <= r; j++) { val += (ri < w * h ? src[ri * ch + c] : lv) - fv; dst[ti * ch + c] = val * iarr; ri += w; ti += w; }
    for (let j = r + 1; j < h - r; j++) { val += src[ri * ch + c] - src[li * ch + c]; dst[ti * ch + c] = val * iarr; li += w; ri += w; ti += w; }
    for (let j = Math.max(h - r, r + 1); j < h; j++) { val += lv - src[li * ch + c]; dst[ti * ch + c] = val * iarr; li += w; ti += w; }
  }
}
/** in-place blur of a Float32Array with `ch` interleaved channels */
export function blurFloat(buf, w, h, ch, sigma, edge = 'clamp') {
  if (sigma < 0.3) return buf;
  const tmp = new Float32Array(buf.length);
  for (const size of boxesForGauss(sigma)) {
    const r = Math.min((size - 1) >> 1, Math.max(0, Math.min(w, h) - 1));
    if (r < 1) continue;
    boxH(buf, tmp, w, h, Math.min(r, w - 1), ch, ch);
    boxV(tmp, buf, w, h, Math.min(r, h - 1), ch, ch);
  }
  void edge;
  return buf;
}
/** box blur (one size) of a Float32Array */
export function boxFloat(buf, w, h, ch, r, passes = 1) {
  const tmp = new Float32Array(buf.length);
  for (let i = 0; i < passes; i++) { boxH(buf, tmp, w, h, Math.min(r, w - 1), ch, ch); boxV(tmp, buf, w, h, Math.min(r, h - 1), ch, ch); }
  return buf;
}

/** gaussian blur of ImageData (premultiplies so transparent edges don't darken) */
export function blurImageData(id, sigma, box = false) {
  const { width: w, height: h, data: d } = id, n = w * h, f = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const a = d[i * 4 + 3] / 255; f[i * 4] = d[i * 4] * a; f[i * 4 + 1] = d[i * 4 + 1] * a; f[i * 4 + 2] = d[i * 4 + 2] * a; f[i * 4 + 3] = d[i * 4 + 3]; }
  if (box) boxFloat(f, w, h, 4, Math.max(1, Math.round(sigma))); else blurFloat(f, w, h, 4, sigma);
  for (let i = 0; i < n; i++) { const a = f[i * 4 + 3]; const k = a > 0.001 ? 255 / a : 0; d[i * 4] = f[i * 4] * k; d[i * 4 + 1] = f[i * 4 + 1] * k; d[i * 4 + 2] = f[i * 4 + 2] * k; d[i * 4 + 3] = a; }
  return id;
}

/** single channel (alpha 0..255 in a Uint8ClampedArray or the A of RGBA) */
export function blurAlpha(alpha, w, h, sigma) {
  const f = Float32Array.from(alpha); blurFloat(f, w, h, 1, sigma);
  for (let i = 0; i < f.length; i++) alpha[i] = f[i];
  return alpha;
}

/* ---------- exact euclidean distance transform ---------- */
const INF = 1e20;
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const dq = q - v[k]; d[q] = dq * dq + f[v[k]]; }
}
/** squared distance from every pixel to the nearest pixel where inside[i] is true */
export function edt(inside, w, h) {
  const out = new Float32Array(w * h), n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w * h; i++) out[i] = inside[i] ? 0 : INF;
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = out[y * w + x]; edt1d(f, h, d, v, z); for (let y = 0; y < h; y++) out[y * w + x] = d[y]; }
  for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) f[x] = out[o + x]; edt1d(f, w, d, v, z); for (let x = 0; x < w; x++) out[o + x] = d[x]; }
  return out;
}
