// WebP lossless (VP8L) encoder. WebKit and ImageIO can't write WebP, so stlv
// writes it itself: subtract-green + per-block predictor transforms, LZ77
// back references, canonical Huffman codes limited to 15 bits.

class Bits {
  constructor(n = 1 << 20) { this.b = new Uint8Array(n); this.p = 0; this.acc = 0; this.nb = 0; }
  put(v, n) {
    while (n > 16) { this.put(v & 0xffff, 16); v = Math.floor(v / 65536); n -= 16; }
    this.acc = (this.acc | ((v & ((1 << n) - 1)) << this.nb)) >>> 0; this.nb += n;
    while (this.nb >= 8) { if (this.p >= this.b.length) { const nb = new Uint8Array(this.b.length * 2); nb.set(this.b); this.b = nb; } this.b[this.p++] = this.acc & 255; this.acc >>>= 8; this.nb -= 8; }
  }
  /** a Huffman code of length n, MSB first in the stream (stored bit-reversed) */
  code(c, n) { let r = 0; for (let i = 0; i < n; i++) { r = (r << 1) | (c & 1); c >>= 1; } this.put(r, n); }
  out() { if (this.nb) { this.put(0, 8 - this.nb); } return this.b.slice(0, this.p); }
}

/* ---------- Huffman ---------- */
function lengths(freq, maxLen) {
  const n = freq.length, L = new Uint8Array(n);
  let f = Array.from(freq);
  for (; ;) {
    const nodes = [];
    for (let i = 0; i < n; i++) if (f[i] > 0) nodes.push({ w: f[i], s: i });
    if (nodes.length === 0) return L;
    if (nodes.length === 1) { L[nodes[0].s] = 1; return L; }
    // simple O(n log n) Huffman via a sorted queue
    nodes.sort((a, b) => a.w - b.w);
    const q2 = []; let i1 = 0, i2 = 0;
    const take = () => (i2 >= q2.length || (i1 < nodes.length && nodes[i1].w <= q2[i2].w)) ? nodes[i1++] : q2[i2++];
    while ((nodes.length - i1) + (q2.length - i2) > 1) { const a = take(), b = take(); q2.push({ w: a.w + b.w, a, b }); }
    const root = take();
    let max = 0;
    const walk = (nd, d) => { if (nd.s !== undefined) { L[nd.s] = Math.max(1, d); max = Math.max(max, d); } else { walk(nd.a, d + 1); walk(nd.b, d + 1); } };
    walk(root, 0);
    if (max <= maxLen) return L;
    f = f.map(v => v > 0 ? Math.max(1, v >> 1) : 0); L.fill(0);
  }
}
function canon(L) {
  const maxL = Math.max(0, ...L), count = new Array(maxL + 2).fill(0), next = new Array(maxL + 2).fill(0), codes = new Uint32Array(L.length);
  for (const l of L) if (l) count[l]++;
  let code = 0; for (let b = 1; b <= maxL; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  for (let s = 0; s < L.length; s++) if (L[s]) codes[s] = next[L[s]]++;
  return codes;
}
const CL_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
/** write one prefix code for the histogram; returns {L, codes} to encode symbols with */
function writeCode(bw, freq) {
  const used = []; for (let i = 0; i < freq.length; i++) if (freq[i]) used.push(i);
  if (used.length <= 2 && used.every(s => s < 256)) {
    // simple code
    const L = new Uint8Array(freq.length), syms = used.length ? used : [0];
    bw.put(1, 1); bw.put(syms.length - 1, 1);
    if (syms[0] < 2) { bw.put(0, 1); bw.put(syms[0], 1); } else { bw.put(1, 1); bw.put(syms[0], 8); }
    if (syms.length === 2) { bw.put(syms[1], 8); L[syms[0]] = 1; L[syms[1]] = 1; }
    const codes = new Uint32Array(freq.length); if (syms.length === 2) { codes[syms[0]] = 0; codes[syms[1]] = 1; }
    return { L, codes };
  }
  const f = Array.from(freq);
  if (used.length === 1) f[used[0] === 0 ? 1 : 0] = 1;      // a code needs two symbols
  const L = lengths(f, 15), codes = canon(L);
  // run-length the code lengths: 0..15 literal, 17 = 3..10 zeros, 18 = 11..138 zeros
  const toks = [];
  for (let i = 0; i < L.length;) {
    if (L[i] === 0) { let j = i; while (j < L.length && L[j] === 0 && j - i < 138) j++; const run = j - i;
      if (run >= 11) toks.push([18, run - 11]); else if (run >= 3) toks.push([17, run - 3]); else for (let k = 0; k < run; k++) toks.push([0]);
      i = j; } else { toks.push([L[i]]); i++; }
  }
  const cf = new Array(19).fill(0); for (const t of toks) cf[t[0]]++;
  if (cf.filter(Boolean).length === 1) cf[cf.findIndex(v => v) === 0 ? 1 : 0] = 1;
  const CLL = lengths(cf, 7), CLC = canon(CLL);
  let n = 19; while (n > 4 && !CLL[CL_ORDER[n - 1]]) n--;
  bw.put(0, 1); bw.put(n - 4, 4);
  for (let i = 0; i < n; i++) bw.put(CLL[CL_ORDER[i]], 3);
  bw.put(0, 1);   // max_symbol = alphabet size
  for (const t of toks) { bw.code(CLC[t[0]], CLL[t[0]]); if (t[0] === 17) bw.put(t[1], 3); else if (t[0] === 18) bw.put(t[1], 7); }
  return { L, codes };
}

/* ---------- LZ77 prefix values ---------- */
function prefix(v) {   // v >= 1 -> [code, extraBits, extraValue]
  const d = v - 1;
  if (d < 4) return [d, 0, 0];
  const hb = 31 - Math.clz32(d), second = (d >> (hb - 1)) & 1, eb = hb - 1;
  return [2 * hb + second, eb, d & ((1 << eb) - 1)];
}

/* ---------- entropy-coded image ---------- */
function tokenize(px, w, h, lz) {
  // px: Uint32Array ARGB. tokens: literal -> index; backref -> [len, dist]
  const n = px.length, toks = [];
  if (!lz) { for (let i = 0; i < n; i++) toks.push(i); return toks; }
  const HB = 1 << 16, head = new Int32Array(HB).fill(-1);
  const hash3 = i => (Math.imul(px[i], 0x9E3779B1) ^ Math.imul(px[i + 1], 0x85EBCA6B) ^ Math.imul(px[i + 2], 0xC2B2AE35)) >>> 16;
  let i = 0;
  while (i < n) {
    let bestL = 0, bestD = 0;
    if (i + 2 < n) {
      const cand = [1, w, head[hash3(i)] >= 0 ? i - head[hash3(i)] : 0];
      for (const d of cand) {
        if (d <= 0 || d > i || d > 1048000) continue;   // distance+120 must stay under 2^20 (40 distance codes)
        let l = 0; const max = Math.min(4096, n - i);
        while (l < max && px[i + l] === px[i + l - d]) l++;
        if (l > bestL) { bestL = l; bestD = d; }
      }
      head[hash3(i)] = i;
    }
    if (bestL >= 3) { toks.push(-1, bestL, bestD); for (let k = 1; k < bestL && i + k + 2 < n; k += 7) head[hash3(i + k)] = i + k; i += bestL; }
    else { toks.push(i); i++; }
  }
  return toks;
}
function writeImage(bw, px, w, h, isMain) {
  bw.put(0, 1);                 // no colour cache
  if (isMain) bw.put(0, 1);     // no meta prefix codes
  const toks = tokenize(px, w, h, true);
  const G = new Uint32Array(256 + 24), Rr = new Uint32Array(256), Bb = new Uint32Array(256), A = new Uint32Array(256), D = new Uint32Array(40);
  for (let t = 0; t < toks.length;) {
    if (toks[t] >= 0) { const c = px[toks[t]]; G[(c >>> 8) & 255]++; Rr[(c >>> 16) & 255]++; Bb[c & 255]++; A[c >>> 24]++; t++; }
    else { G[256 + prefix(toks[t + 1])[0]]++; D[prefix(toks[t + 2] + 120)[0]]++; t += 3; }
  }
  const cg = writeCode(bw, G), cr = writeCode(bw, Rr), cb = writeCode(bw, Bb), ca = writeCode(bw, A), cd = writeCode(bw, D);
  for (let t = 0; t < toks.length;) {
    if (toks[t] >= 0) {
      const c = px[toks[t]], g = (c >>> 8) & 255, r = (c >>> 16) & 255, b = c & 255, a = c >>> 24;
      bw.code(cg.codes[g], cg.L[g]); bw.code(cr.codes[r], cr.L[r]); bw.code(cb.codes[b], cb.L[b]); bw.code(ca.codes[a], ca.L[a]); t++;
    } else {
      const [lc, le, lv] = prefix(toks[t + 1]); bw.code(cg.codes[256 + lc], cg.L[256 + lc]); if (le) bw.put(lv, le);
      const [dc, de, dv] = prefix(toks[t + 2] + 120); bw.code(cd.codes[dc], cd.L[dc]); if (de) bw.put(dv, de);
      t += 3;
    }
  }
}

/* ---------- predictors ---------- */
const avg = (a, b) => ((((a >>> 24) + (b >>> 24)) >> 1) << 24 | (((a >>> 16 & 255) + (b >>> 16 & 255)) >> 1) << 16 | (((a >>> 8 & 255) + (b >>> 8 & 255)) >> 1) << 8 | (((a & 255) + (b & 255)) >> 1)) >>> 0;
const ch = (c, s) => (c >>> s) & 255;
function select(L, T, TL) {
  let pl = 0, pt = 0;
  for (const s of [24, 16, 8, 0]) { const p = ch(L, s) + ch(T, s) - ch(TL, s); pl += Math.abs(p - ch(L, s)); pt += Math.abs(p - ch(T, s)); }
  return pl < pt ? L : T;
}
const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;
function caHalf(a, b) { let o = 0; for (const s of [24, 16, 8, 0]) { const x = ch(a, s), y = ch(b, s); o |= clamp255(x + Math.trunc((x - y) / 2)) << s; } return o >>> 0; }
const MODES = [1, 2, 11, 13];
function predict(mode, L, T, TL) { return mode === 1 ? L : mode === 2 ? T : mode === 11 ? select(L, T, TL) : caHalf(avg(L, T), TL); }
const sub = (a, b) => ((((a >>> 24) - (b >>> 24)) & 255) << 24 | (((a >>> 16 & 255) - (b >>> 16 & 255)) & 255) << 16 | (((a >>> 8 & 255) - (b >>> 8 & 255)) & 255) << 8 | (((a & 255) - (b & 255)) & 255)) >>> 0;

/** ImageData -> WebP lossless bytes */
export function encodeWebPLossless(id) {
  const w = id.width, h = id.height, d = id.data, n = w * h;
  if (w > 16384 || h > 16384) throw new Error('WebP is limited to 16384 px');
  const px = new Uint32Array(n);
  let alpha = false;
  for (let i = 0; i < n; i++) { const a = d[i * 4 + 3]; if (a < 255) alpha = true; const g = d[i * 4 + 1]; px[i] = ((a << 24) | (((d[i * 4] - g) & 255) << 16) | (g << 8) | ((d[i * 4 + 2] - g) & 255)) >>> 0; }   // subtract green
  // pick a predictor per 32x32 block by least absolute residual
  const bits = 3, bs = 1 << (bits + 2), bw_ = Math.ceil(w / bs), bh = Math.ceil(h / bs), modes = new Uint8Array(bw_ * bh);
  const at = (x, y) => px[y * w + x];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw_; bx++) {
    let best = 1, bestCost = Infinity;
    for (const m of MODES) {
      let cost = 0;
      for (let y = by * bs; y < Math.min(h, by * bs + bs); y += 2) for (let x = bx * bs; x < Math.min(w, bx * bs + bs); x += 2) {
        if (!x || !y) continue;
        const p = predict(m, at(x - 1, y), at(x, y - 1), at(x - 1, y - 1)), r = sub(at(x, y), p);
        for (const s of [24, 16, 8, 0]) { const v = ch(r, s); cost += v > 127 ? 256 - v : v; }
      }
      if (cost < bestCost) { bestCost = cost; best = m; }
    }
    modes[by * bw_ + bx] = best;
  }
  const res = new Uint32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let p;
    if (!x && !y) p = 0xff000000;
    else if (!y) p = px[i - 1];
    else if (!x) p = px[i - w];
    else { const m = modes[(y >> (bits + 2)) * bw_ + (x >> (bits + 2))], T = px[i - w], L = px[i - 1], TL = px[i - w - 1]; p = predict(m, L, T, TL); }
    res[i] = sub(px[i], p);
  }
  const bw = new Bits(Math.max(1 << 16, n));
  bw.put(0x2f, 8); bw.put(w - 1, 14); bw.put(h - 1, 14); bw.put(alpha ? 1 : 0, 1); bw.put(0, 3);
  bw.put(1, 1); bw.put(2, 2);                          // transform: subtract green
  bw.put(1, 1); bw.put(0, 2); bw.put(bits, 3);         // transform: predictor
  const sub_ = new Uint32Array(bw_ * bh); for (let i = 0; i < sub_.length; i++) sub_[i] = (0xff000000 | (modes[i] << 8)) >>> 0;
  writeImage(bw, sub_, bw_, bh, false);
  bw.put(0, 1);                                        // no more transforms
  writeImage(bw, res, w, h, true);
  const vp8l = bw.out();
  const pad = vp8l.length & 1, total = 4 + 8 + vp8l.length + pad;
  const out = new Uint8Array(8 + total), dv = new DataView(out.buffer);
  out.set([82, 73, 70, 70]); dv.setUint32(4, total, true); out.set([87, 69, 66, 80, 86, 80, 56, 76], 8); dv.setUint32(16, vp8l.length, true); out.set(vp8l, 20);
  return out;
}
