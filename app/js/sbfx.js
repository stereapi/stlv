// SB FX: SB Machine's clip looks as stlv filters, on the GPU (WebGL2).
//
// A port of TSR1/sbfx/filters.js, which is itself a port of sb_machine's
// sb_fx.py filter_clip. The numbers match, so a layer graded here matches a
// photo graded in SB FX and a frame graded in SB Machine. Sizes are relative
// to the document's long side (SB Machine's 1920), so the look doesn't change
// with the layer's size, and pattern grids (dither, halftone, riso...) are
// anchored to the document, not to the layer.
//
// Differences from sbfx: textures hold premultiplied alpha and the result
// keeps the layer's alpha; the JPEG stage (digicam, webcam) is a small CPU
// JPEG (DCT + quantise) so filters stay synchronous like the rest.

import { canvas, ctx } from './util.js';

export const SB_PALETTE = {
  blood: ['c8141e', 'efe3cc'], oxblood: ['6d0d12', 'efe3cc'], ember: ['e2521b', 'f3e6cf'],
  rust: ['9c3a17', 'efe3cc'], gold: ['c9a227', 'f5ecd6'], sand: ['d9b98c', '0b0505'],
  bone: ['e6d8c0', 'c8141e'], white: ['f4f1ea', 'c8141e'], ash: ['8c8680', 'efe3cc'],
  rose: ['d6457a', 'f5e9ec'], magenta: ['b0178c', 'f5e6f0'], violet: ['6a1fb0', 'efe3cc'],
  cobalt: ['2a4bd0', 'eef0f8'], ice: ['9fd3e6', '0b0505'], teal: ['16867f', 'eaf5f3'],
  acid: ['a4d11e', '0b0505'],
};
export const SB_GROUPS = [
  ['B&W', ['noir', 'sil', 'flat', 'keep']],
  ['Y2K', ['chrome', 'holo', 'digicam', 'glow', 'dither', 'lenti']],
  ['Print', ['halftone', 'riso', 'pop', 'gradient', 'ink']],
  ['Cam', ['webcam', 'night', 'thermal', 'infrared']],
];
export const SB_NAMES = {
  noir: 'Noir', sil: 'Silhouette', flat: 'Flat', keep: 'Keep Colour',
  chrome: 'Chrome', holo: 'Holo', digicam: 'Digicam', glow: 'Glow', dither: 'Dither',
  lenti: 'Lenticular', halftone: 'Halftone', riso: 'Riso', pop: 'Pop', gradient: 'Gradient Map',
  ink: 'Ink Lines', webcam: 'Webcam', night: 'Night Vision', thermal: 'Thermal',
  infrared: 'Infrared',
};
export const SB_AMT = {
  flat: 'Fill', chrome: 'Bands', holo: 'Shimmer', digicam: 'Crunch', glow: 'Bloom',
  dither: 'Pixel size', lenti: 'Strip width', halftone: 'Dot size', riso: 'Misprint',
  pop: 'Lightness', ink: 'Detail', webcam: 'Crunch', night: 'Noise', infrared: 'Strength',
};
/** these bring their own colours: no colour picker */
export const SB_OWN_COLOUR = ['digicam', 'webcam', 'night', 'thermal', 'infrared', 'lenti'];
const MODE_ID = {
  noir: 1, sil: 2, flat: 3, keep: 4, chrome: 5, holo: 6, digicam: 7, glow: 8,
  dither: 9, lenti: 10, halftone: 11, riso: 12, pop: 13, gradient: 14, ink: 15, webcam: 16,
  night: 17, thermal: 18, infrared: 19,
};

/** an SB FX layer: an adjustment layer (adj 'sbfx') that runs a look on everything below it */
export const sbLayerParams = (mode = 'noir') => ({ mode, amt: 70, col: 'blood', flow: 0, beat: 0 });
export const sbLayerTitle = p => 'SB ' + (SB_NAMES[p && p.mode] || 'FX');

export function sbHexRgb(h) {
  h = String(h).replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}
/** [accent, light] RGB 0..1 for a palette name or a '#rrggbb' */
export function sbColourPair(col) {
  if (SB_PALETTE[col]) return SB_PALETTE[col].map(sbHexRgb);
  const a = sbHexRgb(col || 'c8141e');
  const l = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
  return [a, sbHexRgb(l > 150 / 255 ? '0b0505' : 'e6d8c0')];
}

/* ---------- shaders ---------- */
const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 o;
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 un(vec4 s) { return s.a > 0.0 ? s.rgb / s.a : vec3(0.0); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
`;

// a smaller copy (mip level for big steps), with a prep for some modes. Premultiplied in and out.
const FS_DOWN = COMMON + `
uniform sampler2D uSrc;
uniform float uLod, uAmt;
uniform int uPrep;
void main() {
  vec4 s = textureLod(uSrc, vUv, uLod);
  vec3 c = un(s);
  if (uPrep == 1) {                       // glow: only what is brighter than 110
    c = max(c - 110.0 / 255.0, 0.0);
  } else if (uPrep == 2) {                // digicam: a stop hot, punchy, a touch cool
    float y = lum(c);
    float cr = (c.r - y) * 0.713 + 0.5, cb = (c.b - y) * 0.564 + 0.5;
    y = clamp(y * 1.18 + 8.0 / 255.0, 0.0, 1.0);
    float sat = 1.35 + 0.35 * uAmt;
    cr = clamp((cr - 0.5) * sat + 0.5 - 3.0 / 255.0, 0.0, 1.0);
    cb = clamp((cb - 0.5) * sat + 0.5 + 6.0 / 255.0, 0.0, 1.0);
    c = vec3(y + 1.403 * (cr - 0.5), y - 0.714 * (cr - 0.5) - 0.344 * (cb - 0.5),
             y + 1.773 * (cb - 0.5));
  } else if (uPrep == 3) {                // webcam: a magenta-blue cast
    c = c * 1.1 - 10.0 / 255.0 + vec3(12.0, 0.0, 18.0) / 255.0;
  }
  o = vec4(clamp(c, 0.0, 1.0) * s.a, s.a);
}`;

// separable gaussian: 15 taps, spaced so they always span ~3 sigma (premultiplied)
const FS_BLUR = COMMON + `
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  float st = max(1.0, uSigma / 2.4);
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -7; i <= 7; i++) {
    float x = float(i) * st;
    float w = exp(-0.5 * x * x / max(1e-4, uSigma * uSigma));
    acc += texture(uSrc, vUv + uDir * x) * w;
    wsum += w;
  }
  o = acc / wsum;
}`;

const FS_MAIN = COMMON + `
uniform sampler2D uSrc, uB1, uB2;
uniform vec2 uSize, uOff;
uniform float uRef, uLo, uHi, uAmt, uFlow, uBeat, uSeed;
uniform vec3 uAcc, uLight;
uniform int uMode;

vec3 S(vec2 uv) { return un(textureLod(uSrc, uv, 0.0)); }
vec3 SL(vec2 uv, float lod) { return un(textureLod(uSrc, uv, lod)); }
float lev(float g) { return clamp((g - uLo) / max(8.0 / 255.0, uHi - uLo), 0.0, 1.0); }
float scurve(float x, float k, float p) {
  float s = 1.0 / (1.0 + exp(-k * (x - p)));
  float s0 = 1.0 / (1.0 + exp(k * p)), s1 = 1.0 / (1.0 + exp(-k * (1.0 - p)));
  return (s - s0) / (s1 - s0);
}
float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
vec3 inferno(float t) {
  const vec3 c0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184);
  const vec3 c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
  const vec3 c2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
  const vec3 c3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813);
  const vec3 c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
  const vec3 c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
  const vec3 c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}
vec3 B1(vec2 uv) { return un(texture(uB1, uv)); }
float lv(vec2 uv) { return lev(lum(B1(uv))); }

void main() {
  vec2 uv = vUv;
  vec2 px = uv * uSize;                       // layer pixel, y from the top
  vec2 pd = px + uOff;                        // the same pixel in document space
  float sc = uRef / 1920.0;
  vec3 c = S(uv);
  float g = lum(c), a = uAmt;
  vec3 r = c;

  if (uMode == 1) {                                         // noir
    r = vec3(scurve(lev(g), 3.0 + 11.0 * a, 0.5));
  } else if (uMode == 2) {                                  // silhouette
    r = scurve(lev(g), (3.0 + 11.0 * a) * 1.8, 0.56) * uAcc;
  } else if (uMode == 3) {                                  // flat
    float cut = 0.85 - 0.7 * a;
    r = uAcc * clamp((lv(uv) - cut) / 0.04 + 0.5, 0.0, 1.0);
  } else if (uMode == 4) {                                  // keep colour
    float v = scurve(lev(g), 3.0 + 11.0 * a, 0.5);
    r = vec3(v);
    vec3 ah = rgb2hsv(uAcc);
    if (ah.y > 60.0 / 255.0) {
      vec3 hh = rgb2hsv(c);
      float d = abs(hh.x - ah.x); d = min(d, 1.0 - d) * 180.0;
      float m = clamp((13.0 - d) / 6.0, 0.0, 1.0);
      m = min(m, clamp((hh.y * 255.0 - 90.0) * 4.0 / 255.0, 0.0, 1.0));
      m = min(m, clamp((hh.z * 255.0 - 35.0) * 4.0 / 255.0, 0.0, 1.0));
      vec3 col = min(clamp(v * 0.6 + 0.6, 0.0, 1.1) * uAcc, vec3(1.0));
      r = mix(r, col, m);
    }
  } else if (uMode == 5) {                                  // chrome (+ flow)
    float bands = 1.2 + 2.3 * a;
    float arg = 6.2831853 * bands * pow(lv(uv), 0.8);
    if (uFlow > 0.0) {
      float f = uFlow, fr = fract(uBeat);
      arg += sin(6.2831853 * (uv.y * 1.4 + uv.x * 0.45) + 3.14159265 * uBeat / 4.0) * 1.6 * f;
      arg += 6.2831853 * (uBeat / 4.0 * (0.25 + 0.75 * f) + 0.18 * f * (1.0 - pow(1.0 - fr, 3.0)));
    }
    float v = clamp((0.5 - 0.5 * cos(arg)) * 1.08 - 0.04, 0.0, 1.0);
    r = v + 0.55 * 4.0 * v * (1.0 - v) * (uAcc - v);
  } else if (uMode == 6) {                                  // holo
    float x = lev(g);
    float hue = fract(rgb2hsv(uAcc).x + (uv.x * 0.6 + uv.y * 0.9) * 0.5 + x * (0.6 + 1.4 * a));
    r = hsv2rgb(vec3(hue, clamp(170.0 - 110.0 * x, 40.0, 255.0) / 255.0, (120.0 + 135.0 * x) / 255.0));
    r += max(g - lum(B1(uv)), 0.0) * 1.5;
  } else if (uMode == 7) {                                  // digicam: oversharpen the JPEG
    r = 1.9 * un(texture(uB2, uv)) - 0.9 * B1(uv);
  } else if (uMode == 8) {                                  // glow
    r = 0.66 * c + 0.19 * g + 0.22 * uAcc + B1(uv) * (0.8 + 2.2 * a);
  } else if (uMode == 9) {                                  // dither 1-bit
    float p = max(1.0, floor((2.0 + 6.0 * a) * sc + 0.5));
    vec2 cell = floor(pd / p);
    float x = lev(lum(SL(((cell + 0.5) * p - uOff) / uSize, log2(p))));
    ivec2 q = ivec2(cell);
    int xx = q.x & 7, yy = q.y & 7, s = xx ^ yy;
    int b = ((s & 1) << 5) | ((yy & 1) << 4) | ((s & 2) << 2) | ((yy & 2) << 1) |
            ((s & 4) >> 1) | ((yy & 4) >> 2);
    r = x > (float(b) + 0.5) / 64.0 ? uAcc : uAcc * 0.16;
  } else if (uMode == 10) {                                 // lenticular
    float s = max(2.0, floor((4.0 + 12.0 * a) * sc + 0.5));
    if (mod(floor(pd.x / s), 2.0) > 0.5) {
      float gv = lum(S(vec2(fract((px.x - floor(s * 2.5)) / uSize.x), uv.y)));
      r = vec3(gv, 1.0 - gv, 1.0) * 0.7 + c * 0.3;
    }
  } else if (uMode == 11) {                                 // halftone
    float cs = max(4.0, floor((7.0 + 14.0 * a) * sc + 0.5));
    vec2 ctr = (floor(pd / cs) + 0.5) * cs - uOff;
    float x = lev(lum(SL(ctr / uSize, log2(cs))));
    float m = clamp((1.0 - x) * cs * 0.74 - length(px - ctr) + 0.5, 0.0, 1.0);
    r = mix(uLight, uAcc, m);
  } else if (uMode == 12) {                                 // riso, two inks
    vec2 q = floor(pd / 2.0);
    float grain = 0.35 + 0.55 * a;
    float x1 = lev(lum(SL((q * 2.0 + 1.0 - uOff) / uSize, 1.0)));
    bool b1 = clamp(1.2 - x1 * 1.45, 0.0, 1.0) > hash(q + uSeed) * grain + (1.0 - grain) * 0.5;
    float off = max(1.0, floor((4.0 + 10.0 * a) * sc * 0.5 + 0.5));
    vec2 q2 = q - vec2(off, -off);
    float x2 = lev(lum(SL((q2 * 2.0 + 1.0 - uOff) / uSize, 1.0)));
    bool b2 = clamp(0.95 - abs(x2 - 0.55) * 2.1, 0.0, 1.0) >
              hash(q2 + uSeed + 17.0) * grain + (1.0 - grain) * 0.5;
    vec3 paper = vec3(240.0, 228.0, 214.0) / 255.0, navy = vec3(24.0, 58.0, 112.0) / 255.0;
    r = paper;
    if (b1) r *= 1.0 - 0.9 * (1.0 - navy);
    if (b2) r *= 1.0 - 0.85 * (1.0 - uAcc);
  } else if (uMode == 13) {                                 // pop 4-tone
    float x = lv(uv), sh = (a * 100.0 - 50.0) / 250.0;
    int qd = int(x >= 0.26 - sh) + int(x >= 0.52 - sh) + int(x >= 0.78 - sh);
    r = qd == 0 ? vec3(22.0, 12.0, 40.0) / 255.0 : qd == 1 ? uAcc :
        qd == 2 ? vec3(250.0, 200.0, 60.0) / 255.0 : vec3(250.0, 241.0, 234.0) / 255.0;
  } else if (uMode == 14) {                                 // gradient map
    float x = scurve(lev(g), 3.0 + 11.0 * a, 0.5);
    vec3 opp = hsv2rgb(vec3(fract(rgb2hsv(uAcc).x + 75.0 / 180.0), 90.0 / 255.0, 1.0));
    r = x < 0.5 ? mix(uAcc * 0.22, uAcc, x / 0.5) : mix(uAcc, opp, (x - 0.5) / 0.5);
  } else if (uMode == 15) {                                 // ink lines
    vec2 d = vec2(max(1.0, 2.0 * sc)) / uSize;
    float tl = lv(uv + d * vec2(-1, -1)), t = lv(uv + d * vec2(0, -1)), tr = lv(uv + d * vec2(1, -1));
    float l = lv(uv + d * vec2(-1, 0)), rr = lv(uv + d * vec2(1, 0));
    float bl = lv(uv + d * vec2(-1, 1)), b = lv(uv + d * vec2(0, 1)), br = lv(uv + d * vec2(1, 1));
    float gx = (tr + 2.0 * rr + br) - (tl + 2.0 * l + bl);
    float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
    float mag = (abs(gx) + abs(gy)) * 255.0, th = 70.0 - 58.0 * a;
    r = uAcc * smoothstep(th * 1.2, th * 2.5, mag);
  } else if (uMode == 16) {                                 // webcam: the tiny JPEG
    r = un(texture(uB2, uv));
  } else if (uMode == 17) {                                 // night vision
    float v = clamp(lev(g) * 1.35 + 22.0 / 255.0, 0.0, 1.0);
    vec2 q = floor(pd / 2.0);
    float n = (hash(q + uSeed) + hash(q + uSeed + 3.1) + hash(q + uSeed + 7.7) - 1.5) * 2.0;
    v = clamp(v + n * (6.0 + 26.0 * a) / 255.0, 0.0, 1.0);
    vec2 dd = (px - uSize * 0.5) / (uSize * 0.62);
    float line = max(1.0, floor(3.0 * sc + 0.5));
    v *= clamp(1.0 - 0.8 * dot(dd, dd), 0.0, 1.0) * (mod(floor(pd.y / line), 3.0) < 0.5 ? 0.72 : 1.0);
    r = vec3(0.4 * v, v, 0.28 * v);
  } else if (uMode == 18) {                                 // thermal
    r = inferno(clamp(scurve(lv(uv), 3.0 + 11.0 * a, 0.5), 0.0, 1.0));
  } else if (uMode == 19) {                                 // infrared
    vec3 ir = vec3(0.2 * c.r + 1.1 * c.g, 0.85 * c.r, 0.3 * c.b + 0.6 * c.g);
    r = mix(c, ir, 0.35 + 0.65 * a);
  }
  o = vec4(clamp(r, 0.0, 1.0), textureLod(uSrc, uv, 0.0).a);   // straight colour, the layer's alpha
}`;

/* ---------- a small JPEG round trip (baseline: 4:2:0, IJG tables) ---------- */
const QY = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
const COS = new Float32Array(64);
for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) COS[u * 8 + x] = (u ? 0.5 : Math.SQRT1_2 * 0.5) * Math.cos((2 * x + 1) * u * Math.PI / 16);
function qTable(base, quality) {
  const Q = Math.max(1, Math.min(100, Math.round(quality * 100))), s = Q < 50 ? 5000 / Q : 200 - 2 * Q;
  return base.map(b => Math.max(1, Math.min(255, Math.floor((b * s + 50) / 100))));
}
/** DCT, quantise and back, in place, over a w x h plane (values 0..255) */
function jpegPlane(P, w, h, q) {
  const B = new Float32Array(64), T = new Float32Array(64);
  for (let by = 0; by < h; by += 8) for (let bx = 0; bx < w; bx += 8) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) B[y * 8 + x] = P[Math.min(h - 1, by + y) * w + Math.min(w - 1, bx + x)] - 128;
    for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let s = 0; for (let x = 0; x < 8; x++) s += COS[u * 8 + x] * B[y * 8 + x]; T[y * 8 + u] = s; }
    for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) { let s = 0; for (let y = 0; y < 8; y++) s += COS[v * 8 + y] * T[y * 8 + u]; const k = v * 8 + u; B[k] = Math.round(s / q[k]) * q[k]; }
    for (let u = 0; u < 8; u++) for (let y = 0; y < 8; y++) { let s = 0; for (let v = 0; v < 8; v++) s += COS[v * 8 + y] * B[v * 8 + u]; T[y * 8 + u] = s; }
    for (let y = 0; y < 8 && by + y < h; y++) for (let x = 0; x < 8 && bx + x < w; x++) { let s = 0; for (let u = 0; u < 8; u++) s += COS[u * 8 + x] * T[y * 8 + u]; P[(by + y) * w + bx + x] = s + 128; }
  }
}
/** straight RGBA in, the same picture after a JPEG at `quality` (0..1) out; alpha kept */
export function jpegCrunch(px, w, h, quality) {
  const n = w * h, cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
  const Y = new Float32Array(n), Cb = new Float32Array(cw * ch), Cr = new Float32Array(cw * ch), cnt = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2], k = (y >> 1) * cw + (x >> 1);
    Y[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[k] += -0.168736 * r - 0.331264 * g + 0.5 * b + 128; Cr[k] += 0.5 * r - 0.418688 * g - 0.081312 * b + 128; cnt[k]++;
  }
  for (let k = 0; k < cw * ch; k++) { Cb[k] /= cnt[k]; Cr[k] /= cnt[k]; }
  jpegPlane(Y, w, h, qTable(QY, quality));
  const qc = qTable(QC, quality); jpegPlane(Cb, cw, ch, qc); jpegPlane(Cr, cw, ch, qc);
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, k = (y >> 1) * cw + (x >> 1), yy = Y[y * w + x], cb = Cb[k] - 128, cr = Cr[k] - 128;
    out[i] = yy + 1.402 * cr; out[i + 1] = yy - 0.344136 * cb - 0.714136 * cr; out[i + 2] = yy + 1.772 * cb; out[i + 3] = px[i + 3];
  }
  return out;
}

/* ---------- the GL engine (its own context, separate from the compositor) ---------- */
let E = null;
function compile(gl, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('SB FX shader: ' + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('SB FX link: ' + gl.getProgramInfoLog(p));
  const loc = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; loc[name] = gl.getUniformLocation(p, name); }
  return { p, loc };
}
function engine() {
  if (E && !E.gl.isContextLost()) return E;
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const gl = c.getContext('webgl2', { premultipliedAlpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) throw new Error('SB FX needs WebGL2');
  E = { gl, vao: gl.createVertexArray(), max: gl.getParameter(gl.MAX_TEXTURE_SIZE), progs: { down: compile(gl, FS_DOWN), blur: compile(gl, FS_BLUR), main: compile(gl, FS_MAIN) } };
  return E;
}

/** the image's own levels (filter_clip): 2nd / 98th percentile of the grey of its visible pixels, eased 20% to the full range */
function levelsOf(src) {
  const w = 96, h = Math.max(1, Math.round(96 * src.height / src.width)), c = canvas(w, h), x = ctx(c);
  x.drawImage(src, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data, g = [];
  for (let i = 0; i < w * h; i++) if (d[4 * i + 3] > 127) g.push(0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]);
  if (g.length < 4) return [0, 1];
  g.sort((a, b) => a - b);
  let lo = g[Math.floor(0.02 * (g.length - 1))], hi = g[Math.floor(0.98 * (g.length - 1))];
  lo = 0.8 * lo; hi = hi + 0.2 * (255 - hi);
  return [lo / 255, hi / 255];
}

/**
 * Run SB FX `mode` on a canvas. p: {amt 0..100, col (palette name or #hex), flow, beat, ref (document long side)}.
 * info: {ox, oy, scale} as the other filters get it. Returns a canvas the same size.
 */
export function sbRun(mode, src, p, info = { ox: 0, oy: 0, scale: 1 }) {
  const { gl, vao, progs, max } = engine();
  const W = src.width, H = src.height;
  if (W > max || H > max) throw new Error('SB FX: layer too big for the GPU');
  const made = [], tex = (w, h, filter = gl.LINEAR) => {
    const t = gl.createTexture(); made.push(t);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const fbos = [], target = (w, h, filter) => {
    const t = tex(w, h, filter), fb = gl.createFramebuffer(); fbos.push(fb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { fb, tex: t, w, h };
  };
  const upload = img => {
    const t = gl.createTexture(); made.push(t);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  };
  const draw = (name, uniforms, textures, t) => {
    const { p: prog, loc } = progs[name];
    gl.useProgram(prog); gl.bindVertexArray(vao);
    let unit = 0;
    for (const [k, tx] of Object.entries(textures)) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tx); if (loc[k]) gl.uniform1i(loc[k], unit); unit++; }
    for (const [k, v] of Object.entries(uniforms)) {
      const l = loc[k]; if (!l) continue;
      if (Array.isArray(v)) (v.length === 2 ? gl.uniform2fv : gl.uniform3fv).call(gl, l, v);
      else if (k === 'uMode' || k === 'uPrep') gl.uniform1i(l, v); else gl.uniform1f(l, v);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, t.w, t.h); gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const read = t => { const px = new Uint8ClampedArray(t.w * t.h * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  const down = (s, sh, w, h, prep = 0, amt = 0, mips = true) => { const t = target(w, h); draw('down', { uLod: mips ? Math.max(0, Math.log2(sh / h)) : 0, uPrep: prep, uAmt: amt }, { uSrc: s }, t); return t; };
  const blur = (s, sh, w, h, sigma, prep = 0, mips = true) => {
    const a = down(s, sh, w, h, prep, 0, mips), b = target(w, h);
    draw('blur', { uDir: [1 / w, 0], uSigma: sigma }, { uSrc: a.tex }, b);
    draw('blur', { uDir: [0, 1 / h], uSigma: sigma }, { uSrc: b.tex }, a);
    return a.tex;
  };
  try {
    const scale = info.scale || 1, ref = Math.max(8, (p.ref || Math.max(W, H) / scale) * scale), amt = (p.amt ?? 70) / 100;
    const [acc, light] = sbColourPair(p.col || 'blood');
    const S = upload(src), T = { uSrc: S };
    const half = [Math.max(1, Math.round(W / 2)), Math.max(1, Math.round(H / 2))];
    if (mode === 'flat') T.uB1 = blur(S, H, ...half, ref / 700 / 2);
    if (mode === 'chrome') T.uB1 = blur(S, H, ...half, ref / 900 / 2);
    if (mode === 'holo') T.uB1 = blur(S, H, ...half, ref / 400 / 2);
    if (mode === 'pop') T.uB1 = blur(S, H, ...half, ref / 600 / 2);
    if (mode === 'ink') T.uB1 = blur(S, H, ...half, Math.max(2, ref / 500) / 2);
    if (mode === 'thermal') T.uB1 = blur(S, H, Math.max(1, Math.round(W / 4)), Math.max(1, Math.round(H / 4)), Math.max(1, ref / 900));
    if (mode === 'glow') T.uB1 = blur(S, H, Math.max(1, Math.round(W / 8)), Math.max(1, Math.round(H / 8)), Math.max(1.5, ref / 8 / 60), 1);
    if (mode === 'digicam' || mode === 'webcam') {
      // SB Machine shrinks a 1080-line frame to this many lines, then JPEGs it
      const lines = mode === 'digicam' ? 720 - 400 * amt : 320 - 220 * amt, s = Math.min(1, lines / 1080);
      const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s)), q = mode === 'digicam' ? 0.60 - 0.40 * amt : 0.40 - 0.30 * amt;
      const small = down(S, H, w, h, mode === 'digicam' ? 2 : 3, amt), pm = read(small);
      for (let i = 0; i < pm.length; i += 4) { const a = pm[i + 3]; if (a && a < 255) { const k = 255 / a; pm[i] *= k; pm[i + 1] *= k; pm[i + 2] *= k; } }
      const J = jpegCrunch(pm, w, h, q), jt = gl.createTexture(); made.push(jt);
      gl.bindTexture(gl.TEXTURE_2D, jt);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, new ImageData(J, w, h));
      const f = mode === 'webcam' ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      T.uB2 = jt;
      if (mode === 'digicam') T.uB1 = blur(jt, h, w, h, Math.max(1, ref / 500 * s), 0, false);
    }
    if (!T.uB1) T.uB1 = S;
    if (!T.uB2) T.uB2 = S;
    const [lo, hi] = levelsOf(src), out = target(W, H);
    draw('main', {
      uMode: MODE_ID[mode] || 0, uSize: [W, H], uOff: [(info.ox || 0) * scale, (info.oy || 0) * scale], uRef: ref,
      uLo: lo, uHi: hi, uAmt: amt, uFlow: mode === 'chrome' ? (p.flow || 0) / 100 : 0, uBeat: p.beat || 0, uSeed: 37.0, uAcc: acc, uLight: light,
    }, T, out);
    const o = canvas(W, H);
    ctx(o).putImageData(new ImageData(read(out), W, H), 0, 0);
    return o;
  } finally {
    for (const f of fbos) gl.deleteFramebuffer(f);
    for (const t of made) gl.deleteTexture(t);
  }
}
