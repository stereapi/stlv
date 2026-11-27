// Gradient model: colour stops + opacity stops (any can be transparent), each
// with a midpoint. Merged into premultiplied stops for the shader, so a fade
// to transparent never passes through grey.

import { clamp, lerp } from './util.js';

export const GRAD_TYPES = ['linear', 'radial', 'angle', 'reflected', 'diamond'];

export function defaultGradient(fg = { r: 0, g: 0, b: 0 }, bg = { r: 255, g: 255, b: 255 }) {
  return { colors: [{ pos: 0, color: { ...fg }, mid: 0.5 }, { pos: 1, color: { ...bg }, mid: 0.5 }], alphas: [{ pos: 0, a: 1, mid: 0.5 }, { pos: 1, a: 1, mid: 0.5 }], type: 'linear', angle: 90, scale: 1, reverse: false, dither: true, ox: 0, oy: 0, name: 'Foreground to Background' };
}
export function gradientPresets(fg, bg) {
  const c = (pos, color) => ({ pos, color, mid: 0.5 }), a = (pos, v) => ({ pos, a: v, mid: 0.5 });
  const W = { r: 255, g: 255, b: 255 }, K = { r: 0, g: 0, b: 0 };
  return [
    { name: 'Foreground to Background', colors: [c(0, fg), c(1, bg)], alphas: [a(0, 1), a(1, 1)] },
    { name: 'Foreground to Transparent', colors: [c(0, fg), c(1, fg)], alphas: [a(0, 1), a(1, 0)] },
    { name: 'Black, White', colors: [c(0, K), c(1, W)], alphas: [a(0, 1), a(1, 1)] },
    { name: 'Sunset to Transparent', colors: [c(0, { r: 255, g: 179, b: 71 }), c(1, { r: 255, g: 61, b: 139 })], alphas: [a(0, 0), a(1, 1)] },
    { name: 'Spectrum', colors: [c(0, { r: 255, g: 0, b: 0 }), c(1 / 6, { r: 255, g: 255, b: 0 }), c(2 / 6, { r: 0, g: 255, b: 0 }), c(3 / 6, { r: 0, g: 255, b: 255 }), c(4 / 6, { r: 0, g: 0, b: 255 }), c(5 / 6, { r: 255, g: 0, b: 255 }), c(1, { r: 255, g: 0, b: 0 })], alphas: [a(0, 1), a(1, 1)] },
    { name: 'Night', colors: [c(0, { r: 11, g: 13, b: 31 }), c(0.5, { r: 90, g: 60, b: 255 }), c(1, { r: 255, g: 79, b: 216 })], alphas: [a(0, 1), a(1, 1)] },
    { name: 'Ice', colors: [c(0, { r: 100, g: 180, b: 240 }), c(1, { r: 243, g: 239, b: 230 })], alphas: [a(0, 1), a(1, 1)] },
    { name: 'Transparent to Black', colors: [c(0, K), c(1, K)], alphas: [a(0, 0), a(1, 1)] },
  ];
}

function expand(list, key) {
  // midpoints become explicit 50% stops; returns sorted [{pos, v}]
  const s = [...list].sort((p, q) => p.pos - q.pos), out = [];
  for (let i = 0; i < s.length; i++) {
    out.push({ pos: s[i].pos, v: s[i][key] });
    if (i < s.length - 1 && Math.abs((s[i].mid ?? 0.5) - 0.5) > 1e-3) {
      const p = s[i].pos + (s[i + 1].pos - s[i].pos) * s[i].mid;
      out.push({ pos: p, v: key === 'a' ? (s[i].a + s[i + 1].a) / 2 : mixC(s[i].color, s[i + 1].color, 0.5) });
    }
  }
  return out;
}
const mixC = (a, b, t) => ({ r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) });
function sampleList(list, t, isAlpha) {
  if (t <= list[0].pos) return list[0].v;
  for (let i = 0; i < list.length - 1; i++) if (t <= list[i + 1].pos) {
    const u = (t - list[i].pos) / Math.max(1e-6, list[i + 1].pos - list[i].pos);
    return isAlpha ? lerp(list[i].v, list[i + 1].v, u) : mixC(list[i].v, list[i + 1].v, u);
  }
  return list[list.length - 1].v;
}
/** merged stops [{pos, r,g,b,a}] (straight colour, 0..1) */
export function mergedStops(grad) {
  const cs = expand(grad.colors, 'color'), as = expand(grad.alphas, 'a');
  let pos = [...new Set([...cs.map(s => s.pos), ...as.map(s => s.pos), 0, 1])].map(p => clamp(p, 0, 1)).sort((a, b) => a - b);
  pos = pos.filter((p, i) => i === 0 || p - pos[i - 1] > 1e-5);
  if (pos.length > 32) pos = Array.from({ length: 32 }, (_, i) => i / 31);
  let stops = pos.map(p => { const c = sampleList(cs, p, false), a = sampleList(as, p, true); return { pos: p, r: c.r / 255, g: c.g / 255, b: c.b / 255, a }; });
  if (grad.reverse) stops = stops.map(s => ({ ...s, pos: 1 - s.pos })).reverse();
  return stops;
}
/** colour at t (0..1) as {r,g,b,a} 0..255 / 0..1 */
export function sampleGradient(grad, t) {
  const st = mergedStops(grad);
  if (t <= st[0].pos) return toC(st[0]);
  for (let i = 0; i < st.length - 1; i++) if (t <= st[i + 1].pos) {
    const u = (t - st[i].pos) / Math.max(1e-6, st[i + 1].pos - st[i].pos), A = st[i], Bs = st[i + 1];
    const a = lerp(A.a, Bs.a, u), pr = lerp(A.r * A.a, Bs.r * Bs.a, u), pg = lerp(A.g * A.a, Bs.g * Bs.a, u), pb = lerp(A.b * A.a, Bs.b * Bs.a, u);
    return a > 0 ? { r: pr / a * 255, g: pg / a * 255, b: pb / a * 255, a } : { r: 0, g: 0, b: 0, a: 0 };
  }
  return toC(st[st.length - 1]);
}
const toC = s => ({ r: s.r * 255, g: s.g * 255, b: s.b * 255, a: s.a });

/** CSS preview over a checkerboard */
export function gradientCSS(grad, dir = '90deg') {
  const st = mergedStops(grad).map(s => `rgba(${Math.round(s.r * 255)},${Math.round(s.g * 255)},${Math.round(s.b * 255)},${s.a.toFixed(3)}) ${(s.pos * 100).toFixed(2)}%`);
  return `linear-gradient(${dir}, ${st.join(', ')}), var(--checker)`;
}

/** start/end points in doc px: explicit (tool) or from angle/scale inside bounds b (fill layer, overlay) */
export function gradientGeometry(grad, b) {
  if (grad.p0 && grad.p1) return { p0: grad.p0, p1: grad.p1 };
  const a = (grad.angle ?? 90) * Math.PI / 180, dir = { x: Math.cos(a), y: -Math.sin(a) };
  const c = { x: b.x + b.w / 2 + (grad.ox || 0), y: b.y + b.h / 2 + (grad.oy || 0) };
  const L = (Math.abs(b.w * dir.x) + Math.abs(b.h * dir.y)) * (grad.scale ?? 1);
  const t = grad.type;
  if (t === 'linear') return { p0: { x: c.x - dir.x * L / 2, y: c.y - dir.y * L / 2 }, p1: { x: c.x + dir.x * L / 2, y: c.y + dir.y * L / 2 } };
  if (t === 'angle') return { p0: c, p1: { x: c.x + dir.x, y: c.y + dir.y } };
  const r = t === 'radial' ? Math.hypot(b.w, b.h) / 2 * (grad.scale ?? 1) : L / 2;
  return { p0: c, p1: { x: c.x + dir.x * r, y: c.y + dir.y * r } };
}

export function gradientUniforms(grad, geo) {
  const st = mergedStops(grad), n = st.length;
  const pos = new Float32Array(32), mid = new Float32Array(32).fill(0.5), col = new Float32Array(128);
  st.forEach((s, i) => { pos[i] = s.pos; col.set([s.r * s.a, s.g * s.a, s.b * s.a, s.a], i * 4); });
  for (let i = n; i < 32; i++) { pos[i] = 1; col.set(col.subarray((n - 1) * 4, n * 4), i * 4); }
  return {
    uGType: ['1i', Math.max(0, GRAD_TYPES.indexOf(grad.type))], uGCount: ['1i', n],
    uG0: ['2f', geo.p0.x, geo.p0.y], uG1: ['2f', geo.p1.x, geo.p1.y],
    uGPos: ['1fv', pos], uGMid: ['1fv', mid], uGCol: ['4fv', col], uGDither: ['1f', grad.dither === false ? 0 : 1],
  };
}
export function cloneGradient(g) { return JSON.parse(JSON.stringify(g)); }
