// Transform math: affine / projective (distort, perspective) maps, warp
// (bicubic Bézier patch with 16 control points, or a preset), meshes for the
// GPU, and rendering a mesh back to pixels at any resample quality.

import { M3, canvas, ctx, R, clamp } from './util.js';
import { VS_MESH, FS_MESH, VS_RECT } from './gl.js';

export const WARP_STYLES = [['none', 'None'], ['arc', 'Arc'], ['arcLower', 'Arc Lower'], ['arcUpper', 'Arc Upper'], ['arch', 'Arch'], ['bulge', 'Bulge'], ['flag', 'Flag'], ['wave', 'Wave'], ['fish', 'Fish'], ['rise', 'Rise'], ['inflate', 'Inflate'], ['squeeze', 'Squeeze'], ['twist', 'Twist'], ['custom', 'Custom']];

/** preset warp: (u,v) in 0..1 over box {x,y,w,h} -> point. b = bend -1..1, hd/vd distortions -1..1 */
export function warpPreset(style, b, hd, vd, u, v, box) {
  const W = box.w, H = box.h;
  let x = u * W, y = v * H;
  const s = 1 - (2 * u - 1) ** 2;          // 1 at centre, 0 at the sides
  switch (style) {
    case 'arc': {
      if (Math.abs(b) < 1e-4) break;
      const A = b * Math.PI, R0 = W / Math.abs(A), th = (u - 0.5) * Math.abs(A);
      // bend up: the top edge is a circle of length W; bend down: the bottom edge is
      if (b > 0) { const r = R0 - v * H; x = W / 2 + r * Math.sin(th); y = R0 - r * Math.cos(th); }
      else { const r = R0 - (1 - v) * H; x = W / 2 + r * Math.sin(th); y = H - R0 + r * Math.cos(th); }
      break;
    }
    case 'arcLower': y += b * H * 0.5 * v * s; break;
    case 'arcUpper': y -= b * H * 0.5 * (1 - v) * s; break;
    case 'arch': y -= b * H * 0.5 * s; break;
    case 'bulge': y += b * H * 0.5 * (2 * v - 1) * s; break;
    case 'flag': y += b * H * 0.25 * Math.sin(2 * Math.PI * u); break;
    case 'wave': y += b * H * 0.25 * Math.sin(2 * Math.PI * u + v * Math.PI); break;
    case 'fish': y += b * H * 0.45 * (2 * v - 1) * Math.sin(Math.PI * u) ** 2 * (1.4 - u); break;
    case 'rise': y -= b * H * 0.5 * Math.sin((u - 0.5) * Math.PI); break;
    case 'inflate': { const sv = 1 - (2 * v - 1) ** 2; x += b * W * 0.15 * (2 * u - 1) * sv; y += b * H * 0.15 * (2 * v - 1) * s; break; }
    case 'squeeze': { const sv = 1 - (2 * v - 1) ** 2; x -= b * W * 0.2 * (2 * u - 1) * sv; y += b * H * 0.2 * (2 * v - 1) * s; break; }
    case 'twist': {
      const dx = x - W / 2, dy = y - H / 2, r = Math.hypot(dx / (W / 2), dy / (H / 2)), a = b * Math.PI / 2 * Math.max(0, 1 - r);
      x = W / 2 + dx * Math.cos(a) - dy * Math.sin(a); y = H / 2 + dx * Math.sin(a) + dy * Math.cos(a); break;
    }
  }
  // horizontal / vertical distortion: a perspective-like taper
  if (hd) { y = H / 2 + (y - H / 2) * (1 + hd * (2 * u - 1) * 0.5); }
  if (vd) { x = W / 2 + (x - W / 2) * (1 + vd * (2 * v - 1) * 0.5); }
  return { x: box.x + x, y: box.y + y };
}

/** 16 control points (row-major, 4x4) of the identity patch over quad corners */
export function gridFromQuad(q) {
  const g = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const u = i / 3, v = j / 3;
    const top = { x: q[0].x + (q[1].x - q[0].x) * u, y: q[0].y + (q[1].y - q[0].y) * u }, bot = { x: q[3].x + (q[2].x - q[3].x) * u, y: q[3].y + (q[2].y - q[3].y) * u };
    g.push({ x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v });
  }
  return g;
}
/** control grid that matches a preset (fit by sampling) — so a preset can be refined by hand */
export function gridFromPreset(style, b, hd, vd, box) {
  if (style === 'arc' || style === 'twist' || style === 'wave' || style === 'flag') {
    // these need more than one bicubic patch to be exact; sample at the control positions is a good start
  }
  const g = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) g.push(warpPreset(style, b, hd, vd, i / 3, j / 3, box));
  // turn sampled curve points into Bézier controls (interpolating cubic through 4 samples)
  return interpToBezier(g);
}
function interpToBezier(P) {
  // for each row then column: control points so the curve passes through samples at t = 0,1/3,2/3,1
  const conv = (a, b, c, d) => {
    // inverse of Bernstein basis at t=1/3, 2/3
    const p1 = { x: (-5 * a.x + 18 * b.x - 9 * c.x + 2 * d.x) / 6, y: (-5 * a.y + 18 * b.y - 9 * c.y + 2 * d.y) / 6 };
    const p2 = { x: (2 * a.x - 9 * b.x + 18 * c.x - 5 * d.x) / 6, y: (2 * a.y - 9 * b.y + 18 * c.y - 5 * d.y) / 6 };
    return [a, p1, p2, d];
  };
  const rows = []; for (let j = 0; j < 4; j++) rows.push(conv(P[j * 4], P[j * 4 + 1], P[j * 4 + 2], P[j * 4 + 3]));
  const out = new Array(16);
  for (let i = 0; i < 4; i++) { const col = conv(rows[0][i], rows[1][i], rows[2][i], rows[3][i]); for (let j = 0; j < 4; j++) out[j * 4 + i] = col[j]; }
  return out;
}
const bern = t => { const s = 1 - t; return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]; };
export function bezierPatch(G, u, v) {
  const bu = bern(u), bv = bern(v); let x = 0, y = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const w = bu[i] * bv[j]; x += G[j * 4 + i].x * w; y += G[j * 4 + i].y * w; }
  return { x, y };
}

/** triangle mesh [x,y,u,v ...] mapping texture (u,v in 0..1) through f(u,v) -> doc point */
export function buildMesh(f, n = 32) {
  const P = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const p = f(i / n, j / n); P.push(p.x, p.y); }
  const out = new Float32Array(n * n * 6 * 4); let k = 0;
  const put = (i, j) => { const o = (j * (n + 1) + i) * 2; out[k++] = P[o]; out[k++] = P[o + 1]; out[k++] = i / n; out[k++] = j / n; };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { put(i, j); put(i + 1, j); put(i, j + 1); put(i, j + 1); put(i + 1, j); put(i + 1, j + 1); }
  return out;
}
export function meshBounds(verts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < verts.length; i += 4) { x0 = Math.min(x0, verts[i]); x1 = Math.max(x1, verts[i]); y0 = Math.min(y0, verts[i + 1]); y1 = Math.max(y1, verts[i + 1]); }
  return R.out({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

/** the mapping for a transform state {mode, quad[4], grid[16], warp{style,bend,hd,vd}, box} */
export function mapperFor(t) {
  if (t.mode === 'warp') {
    if (t.warp && t.warp.style !== 'custom' && t.warp.style !== 'none') {
      const H = M3.squareToQuad(t.quad);   // preset warps happen in the box, then follow the quad
      return (u, v) => { const p = warpPreset(t.warp.style, t.warp.bend, t.warp.hd || 0, t.warp.vd || 0, u, v, { x: 0, y: 0, w: 1, h: 1 }); return M3.apply(H, p.x, p.y); };
    }
    return (u, v) => bezierPatch(t.grid, u, v);
  }
  const H = M3.squareToQuad(t.quad);
  return (u, v) => M3.apply(H, u, v);
}

/** render `src` canvas through the mapping into a new canvas (GPU). interp: 0 nearest, 1 bilinear, 2 bicubic */
export function renderMapped(comp, src, map, interp = 2, n = 48, clipTo) {
  const g = comp.g, gl = g.gl;
  const verts = buildMesh(map, n);
  let b = meshBounds(verts);
  if (clipTo) b = R.inter(b, clipTo) || { x: 0, y: 0, w: 1, h: 1 };
  b.w = Math.min(Math.max(1, b.w), 16384); b.h = Math.min(Math.max(1, b.h), 16384);
  const tex = g.upload(src);
  if (interp === 1) { g.filter(tex, 'mip'); gl.bindTexture(gl.TEXTURE_2D, tex.t); gl.generateMipmap(gl.TEXTURE_2D); } else g.filter(tex, 'linear');
  const target = g.texture(b.w, b.h, 'rgba8');
  g.clear(target, { x: 0, y: 0, w: b.w, h: b.h });
  const prog = g.program('mesh', VS_MESH, FS_MESH);
  g.mesh(prog, target, verts, { uSrcSize: ['2f', src.width, src.height], uInterp: ['1i', interp] }, { uSrc: tex }, { x: b.x, y: b.y });
  // read straight-alpha pixels
  const id = g.read(target, { x: 0, y: 0, w: b.w, h: b.h });
  g.free(tex); g.free(target);
  const out = canvas(b.w, b.h); ctx(out).putImageData(id, 0, 0);
  return { canvas: out, x: b.x, y: b.y };
}

/** resample a canvas to w x h with a method: nearest | bilinear | bicubic | smoother | sharper | auto */
export function resampleCanvas(comp, src, w, h, method = 'auto') {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (w === src.width && h === src.height) { const c = canvas(w, h); ctx(c).drawImage(src, 0, 0); return c; }
  const down = w < src.width || h < src.height;
  if (method === 'auto') method = down ? 'sharper' : 'smoother';
  if (method === 'nearest') { const c = canvas(w, h), x = ctx(c); x.imageSmoothingEnabled = false; x.drawImage(src, 0, 0, w, h); return c; }
  // big reductions: halve in steps first (box prefilter), then finish
  let cur = src;
  while (cur.width / 2 >= w * 1.0001 && cur.height / 2 >= h * 1.0001 && method !== 'bilinear') {
    const c = canvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2)), x = ctx(c); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, c.width, c.height); cur = c;
  }
  if (method === 'bilinear') { const c = canvas(w, h), x = ctx(c); x.imageSmoothingQuality = 'low'; x.drawImage(cur, 0, 0, w, h); return c; }
  const r = renderMapped(comp, cur, (u, v) => ({ x: u * w, y: v * h }), 2, 1, { x: 0, y: 0, w, h });
  let out = r.canvas;
  if (out.width !== w || out.height !== h) { const c = canvas(w, h); ctx(c).drawImage(out, r.x, r.y); out = c; }
  if (method === 'sharper' && down) sharpen(out, 0.35);
  if (method === 'smoother' && !down) { /* catmull-rom is already smooth */ }
  return out;
}
/** light unsharp mask (3x3) in place */
export function sharpen(c, amt) {
  const x = ctx(c), id = x.getImageData(0, 0, c.width, c.height), d = id.data, w = c.width, hh = c.height, src = new Uint8ClampedArray(d);
  for (let y = 1; y < hh - 1; y++) for (let i = 1; i < w - 1; i++) {
    const o = (y * w + i) * 4;
    for (let k = 0; k < 3; k++) {
      const blur = (src[o + k - 4] + src[o + k + 4] + src[o + k - w * 4] + src[o + k + w * 4]) / 4;
      d[o + k] = clamp(src[o + k] + (src[o + k] - blur) * amt, 0, 255);
    }
  }
  x.putImageData(id, 0, 0);
}
export { VS_RECT };
