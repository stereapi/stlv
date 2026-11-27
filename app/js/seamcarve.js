// Content-aware scale by seam carving. Each round computes the energy and the
// cumulative cost once, then pulls many non-overlapping seams out of it
// (greedy), so a 50% change takes a handful of rounds instead of thousands.
// Protected pixels (a selection, or high-alpha areas) cost so much that no
// seam goes through them. The ops are recorded so the same seams can be
// applied to every layer (whole-canvas resize).

const BIG = 1e7;

function energy(px, w, h, protect) {
  const L = new Float32Array(w * h), E = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { const a = px[i * 4 + 3] / 255; L[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) * a + (1 - a) * 128; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const l = L[x > 0 ? i - 1 : i], r = L[x < w - 1 ? i + 1 : i], u = L[y > 0 ? i - w : i], d = L[y < h - 1 ? i + w : i];
    E[i] = Math.abs(r - l) + Math.abs(d - u) + (px[i * 4 + 3] / 255) * 2;
    if (protect && protect[i] > 127) E[i] += BIG;
  }
  return E;
}
/** up to n non-overlapping vertical seams: Int32Array(h) of x per row each */
function findSeams(px, w, h, n, protect) {
  const E = energy(px, w, h, protect), M = new Float32Array(w * h);
  for (let x = 0; x < w; x++) M[x] = E[x];
  for (let y = 1; y < h; y++) {
    const o = y * w, p = o - w;
    for (let x = 0; x < w; x++) {
      let m = M[p + x]; if (x > 0 && M[p + x - 1] < m) m = M[p + x - 1]; if (x < w - 1 && M[p + x + 1] < m) m = M[p + x + 1];
      M[o + x] = E[o + x] + m;
    }
  }
  const order = Array.from({ length: w }, (_, x) => x).sort((a, b) => M[(h - 1) * w + a] - M[(h - 1) * w + b]);
  // protected pixels are off limits, exactly like pixels another seam already took
  const used = new Uint8Array(w * h), seams = [];
  if (protect) for (let i = 0; i < w * h; i++) if (protect[i] > 127) used[i] = 2;
  for (const start of order) {
    if (seams.length >= n) break;
    const path = new Int32Array(h); let x = start, ok = true;
    if (used[(h - 1) * w + x]) continue;
    path[h - 1] = x;
    for (let y = h - 2; y >= 0; y--) {
      let best = -1, bm = Infinity;
      for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w || used[y * w + xx]) continue; const m = M[y * w + xx]; if (m < bm) { bm = m; best = xx; } }
      // seams crowd into the same flat areas: rather than give up, step sideways to the nearest free pixel
      for (let rad = 2; best < 0 && rad <= 32; rad++) for (const xx of [x - rad, x + rad]) { if (xx < 0 || xx >= w || used[y * w + xx]) continue; const m = M[y * w + xx]; if (m < bm) { bm = m; best = xx; } }
      if (best < 0) { ok = false; break; }
      x = best; path[y] = x;
    }
    if (!ok) continue;
    for (let y = 0; y < h; y++) used[y * w + path[y]] = 1;
    seams.push(path);
  }
  return { seams, used };
}
/** apply a recorded op to an RGBA buffer (or a 1-channel one with ch = 1) */
export function applyOp(op, px, w, h, ch = 4) {
  const used = new Uint8Array(w * h);
  for (const s of op.seams) for (let y = 0; y < h; y++) used[y * w + s[y]] = 1;
  const r = op.seams.length;
  if (op.type === 'remove') {
    const nw = w - r, out = new (px.constructor)(nw * h * ch);
    for (let y = 0; y < h; y++) { let o = y * nw * ch; for (let x = 0; x < w; x++) { const i = y * w + x; if (used[i]) continue; for (let c = 0; c < ch; c++) out[o + c] = px[i * ch + c]; o += ch; } }
    return { px: out, w: nw, h };
  }
  const nw = w + r, out = new (px.constructor)(nw * h * ch);
  for (let y = 0; y < h; y++) {
    let o = y * nw * ch;
    for (let x = 0; x < w; x++) {
      const i = y * w + x; for (let c = 0; c < ch; c++) out[o + c] = px[i * ch + c]; o += ch;
      if (used[i]) { const j = x < w - 1 ? i + 1 : i; for (let c = 0; c < ch; c++) out[o + c] = (px[i * ch + c] + px[j * ch + c]) / 2; o += ch; }
    }
  }
  return { px: out, w: nw, h };
}
function transpose(px, w, h, ch = 4) {
  const out = new (px.constructor)(px.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) out[(x * h + y) * ch + c] = px[(y * w + x) * ch + c];
  return out;
}
/** change width by seams; returns {px, w, h, ops} */
function carveW(px, w, h, tw, protect, progress, p0, p1) {
  const ops = [];
  const total = Math.abs(tw - w) || 1;
  let prot = protect;
  while (w !== tw) {
    const shrink = tw < w, left = Math.abs(tw - w);
    const n = Math.max(1, Math.min(left, Math.floor(w * (shrink ? 0.08 : 0.25))));
    let { seams } = findSeams(px, w, h, n, prot);
    if (!seams.length && prot) { prot = null; continue; }   // no room left around the protected area: let it give
    if (!seams.length) break;
    const op = { type: shrink ? 'remove' : 'insert', seams };
    const r = applyOp(op, px, w, h, 4);
    if (prot) prot = applyOp(op, prot, w, h, 1).px;
    px = r.px; w = r.w; ops.push(op);
    progress && progress(p0 + (p1 - p0) * (1 - Math.abs(tw - w) / total));
  }
  return { px, w, h, ops, protect: prot };
}
/** img: {data: Uint8ClampedArray, width, height}. returns {data, width, height, ops:[{axis, op}]} */
export function carve(img, tw, th, protect, progress) {
  let px = img.data, w = img.width, h = img.height, prot = protect || null;
  const log = [];
  if (tw !== w) { const r = carveW(px, w, h, tw, prot, progress, 0, th !== h ? 0.5 : 1); px = r.px; w = r.w; prot = r.protect; for (const op of r.ops) log.push({ axis: 'x', op }); }
  if (th !== h) {
    let t = transpose(px, w, h), tp = prot ? transpose(prot, w, h, 1) : null;
    const r = carveW(t, h, w, th, tp, progress, tw !== img.width ? 0.5 : 0, 1);
    for (const op of r.ops) log.push({ axis: 'y', op });
    px = transpose(r.px, r.w, w); h = r.w;
  }
  return { data: px instanceof Uint8ClampedArray ? px : new Uint8ClampedArray(px), width: w, height: h, ops: log };
}
/** replay recorded ops on another RGBA buffer of the same original size */
export function replay(ops, data, w, h, ch = 4) {
  let px = data;
  for (const { axis, op } of ops) {
    if (axis === 'x') { const r = applyOp(op, px, w, h, ch); px = r.px; w = r.w; }
    else { const t = transpose(px, w, h, ch); const r = applyOp(op, t, h, w, ch); px = transpose(r.px, r.w, w, ch); h = r.w; }
  }
  return { data: px, width: w, height: h };
}

/* worker entry */
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = e => {
    const { img, tw, th, protect } = e.data;
    const r = carve(img, tw, th, protect, p => self.postMessage({ progress: p }));
    self.postMessage({ done: true, data: r.data, width: r.width, height: r.height, ops: r.ops }, [r.data.buffer]);
  };
}
