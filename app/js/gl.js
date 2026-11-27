// WebGL2 plumbing + all shaders. Convention: texel (x, y) == document pixel
// (x, y) (row 0 = top of the image); only the final screen draw flips.
// Every texture holds premultiplied alpha.

export const VS_RECT = `#version 300 es
in vec2 aPos;               // unit quad 0..1
uniform vec4 uRect;         // x,y,w,h in target pixels
uniform vec2 uTarget;       // target size
void main(){ vec2 p = uRect.xy + aPos * uRect.zw; gl_Position = vec4(p / uTarget * 2.0 - 1.0, 0.0, 1.0); }`;

const BLEND_GLSL = `
float lum(vec3 c){ return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c){ float l = lum(c), n = min(min(c.r,c.g),c.b), x = max(max(c.r,c.g),c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6); if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6); return c; }
vec3 setLum(vec3 c, float l){ return clipColor(c + (l - lum(c))); }
float sat(vec3 c){ return max(max(c.r,c.g),c.b) - min(min(c.r,c.g),c.b); }
vec3 setSat(vec3 c, float s){ float mx = max(max(c.r,c.g),c.b), mn = min(min(c.r,c.g),c.b); vec3 r = vec3(0); if (mx > mn) r = (c - mn) * s / (mx - mn); return r; }
float burn(float b, float s){ return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }
float dodge(float b, float s){ return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
float softl(float b, float s){ float d = b <= 0.25 ? ((16.0*b - 12.0)*b + 4.0)*b : sqrt(b); return s <= 0.5 ? b - (1.0 - 2.0*s)*b*(1.0 - b) : b + (2.0*s - 1.0)*(d - b); }
float hardl(float b, float s){ return s <= 0.5 ? b * 2.0*s : 1.0 - (1.0 - b)*(1.0 - (2.0*s - 1.0)); }
float vivid(float b, float s){ return s <= 0.5 ? burn(b, 2.0*s) : dodge(b, 2.0*s - 1.0); }
float pin(float b, float s){ return s <= 0.5 ? min(b, 2.0*s) : max(b, 2.0*s - 1.0); }
// mode ids follow BLEND_MODES in doc.js
vec3 B(vec3 b, vec3 s, int m){
  if (m == 0 || m == 1) return s;                          // normal, dissolve
  if (m == 2) return min(b, s);                            // darken
  if (m == 3) return b * s;                                // multiply
  if (m == 4) return vec3(burn(b.r,s.r), burn(b.g,s.g), burn(b.b,s.b));
  if (m == 5) return max(b + s - 1.0, 0.0);                // linear burn
  if (m == 6) return lum(s) < lum(b) ? s : b;              // darker color
  if (m == 7) return max(b, s);                            // lighten
  if (m == 8) return b + s - b * s;                        // screen
  if (m == 9) return vec3(dodge(b.r,s.r), dodge(b.g,s.g), dodge(b.b,s.b));
  if (m == 10) return min(b + s, 1.0);                     // linear dodge (add)
  if (m == 11) return lum(s) > lum(b) ? s : b;             // lighter color
  if (m == 12) return vec3(hardl(s.r,b.r), hardl(s.g,b.g), hardl(s.b,b.b)); // overlay = hard light swapped
  if (m == 13) return vec3(softl(b.r,s.r), softl(b.g,s.g), softl(b.b,s.b));
  if (m == 14) return vec3(hardl(b.r,s.r), hardl(b.g,s.g), hardl(b.b,s.b));
  if (m == 15) return vec3(vivid(b.r,s.r), vivid(b.g,s.g), vivid(b.b,s.b));
  if (m == 16) return clamp(b + 2.0*s - 1.0, 0.0, 1.0);    // linear light
  if (m == 17) return vec3(pin(b.r,s.r), pin(b.g,s.g), pin(b.b,s.b));
  if (m == 18) return step(1.0, b + s);                    // hard mix
  if (m == 19) return abs(b - s);                          // difference
  if (m == 20) return b + s - 2.0 * b * s;                 // exclusion
  if (m == 21) return max(b - s, 0.0);                     // subtract
  if (m == 22) return vec3(s.r > 0.0 ? min(b.r/s.r,1.0) : 1.0, s.g > 0.0 ? min(b.g/s.g,1.0) : 1.0, s.b > 0.0 ? min(b.b/s.b,1.0) : 1.0); // divide
  if (m == 23) return setLum(setSat(s, sat(b)), lum(b));   // hue
  if (m == 24) return setLum(setSat(b, sat(s)), lum(b));   // saturation
  if (m == 25) return setLum(s, lum(b));                   // color
  if (m == 26) return setLum(b, lum(s));                   // luminosity
  return s;
}
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// premultiplied d (backdrop) and s (source, already scaled by opacity/mask)
vec4 blendP(vec4 d, vec4 s, int m, vec2 fc, float seed){
  float as = s.a, ab = d.a;
  if (as <= 0.0) return d;
  vec3 cs = s.rgb / as, cb = ab > 0.0 ? d.rgb / ab : vec3(0.0);
  if (m == 1) { if (hash12(fc + seed) < as) { as = 1.0; } else return d; }
  vec3 r = as * (1.0 - ab) * cs + as * ab * clamp(B(cb, cs, m), 0.0, 1.0) + (1.0 - as) * d.rgb;
  return vec4(r, as + ab * (1.0 - as));
}`;

export const FS_BLEND = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uDst, uSrc, uMask, uClip;
uniform ivec2 uSrcOff, uSrcSize, uMaskOff, uMaskSize, uClipOff, uClipSize;
uniform int uMode, uSrcKind, uHasMask, uHasClip;   // srcKind 0 texture, 1 constant
uniform float uOpacity, uMaskBg, uSeed;
uniform vec4 uConst;
out vec4 o;
${BLEND_GLSL}
vec4 at(sampler2D t, ivec2 p, ivec2 off, ivec2 sz){ ivec2 q = p - off; if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) return vec4(0.0); return texelFetch(t, q, 0); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 d = texelFetch(uDst, p, 0);
  vec4 s = uSrcKind == 1 ? uConst : at(uSrc, p, uSrcOff, uSrcSize);
  float k = uOpacity;
  if (uHasMask == 1) { ivec2 q = p - uMaskOff; k *= (q.x < 0 || q.y < 0 || q.x >= uMaskSize.x || q.y >= uMaskSize.y) ? uMaskBg : texelFetch(uMask, q, 0).r; }
  if (uHasClip == 1) k *= at(uClip, p, uClipOff, uClipSize).a;
  if (uMode == 100) { o = mix(d, s, k); return; }          // pass-through group with opacity / mask
  o = blendP(d, s * k, uMode, gl_FragCoord.xy, uSeed);
}`;

export const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform ivec2 uOff; uniform int uUnpremul;
out vec4 o;
void main(){ vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy) + uOff, 0); if (uUnpremul == 1 && c.a > 0.0) c.rgb /= c.a; o = c; }`;

export const FS_CLEAR = `#version 300 es
precision highp float; uniform vec4 uColor; out vec4 o; void main(){ o = uColor; }`;

/* adjustment layers: work on un-premultiplied colour of the composite below */
export const FS_ADJUST = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uDst, uMask, uClip, uLut, uHaze;
uniform ivec2 uMaskOff, uMaskSize, uClipOff, uClipSize, uHazeSize;
uniform int uHasMask, uHasClip, uType;
uniform float uOpacity, uMaskBg;
uniform vec4 uP0, uP1;      // parameters (meaning per type)
uniform vec3 uAir;          // dehaze: atmospheric light
uniform vec2 uDocSize;
out vec4 o;
vec3 rgb2hsl(vec3 c){ float mx = max(max(c.r,c.g),c.b), mn = min(min(c.r,c.g),c.b), l = (mx+mn)/2.0, h = 0.0, s = 0.0, d = mx - mn;
  if (d > 1e-6){ s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn); h = mx == c.r ? (c.g - c.b)/d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r)/d + 2.0 : (c.r - c.g)/d + 4.0; h /= 6.0; }
  return vec3(h, s, l); }
float h2r(float p, float q, float t){ t = fract(t); return t < 1.0/6.0 ? p + (q-p)*6.0*t : t < 0.5 ? q : t < 2.0/3.0 ? p + (q-p)*(2.0/3.0 - t)*6.0 : p; }
vec3 hsl2rgb(vec3 c){ if (c.y <= 0.0) return vec3(c.z); float q = c.z < 0.5 ? c.z*(1.0+c.y) : c.z + c.y - c.z*c.y, p = 2.0*c.z - q; return vec3(h2r(p,q,c.x+1.0/3.0), h2r(p,q,c.x), h2r(p,q,c.x-1.0/3.0)); }
float lutAt(float v, float row){ return texture(uLut, vec2((clamp(v,0.0,1.0)*255.0 + 0.5)/256.0, (row + 0.5)/4.0)).r; }
vec3 adjust(vec3 c, ivec2 p){
  if (uType == 1 || uType == 2 || uType == 3) {             // brightness/contrast, levels, curves: per-channel LUTs (row 0 = all, 1..3 = r,g,b)
    vec3 a = vec3(lutAt(c.r, 0.0), lutAt(c.g, 0.0), lutAt(c.b, 0.0));
    return vec3(lutAt(a.r, 1.0), lutAt(a.g, 2.0), lutAt(a.b, 3.0));
  }
  if (uType == 4) {                                         // hue / saturation: uP0 = (hue/360, sat -1..1, light -1..1, colorize)
    vec3 h = rgb2hsl(c);
    if (uP0.w > 0.5) { h.x = uP1.x; h.y = uP1.y; } else { h.x = fract(h.x + uP0.x + 1.0); h.y = clamp(uP0.y >= 0.0 ? h.y + (1.0 - h.y) * h.y * uP0.y * 1.6 : h.y * (1.0 + uP0.y), 0.0, 1.0); }
    h.z = uP0.z >= 0.0 ? h.z + (1.0 - h.z) * uP0.z : h.z * (1.0 + uP0.z);
    return hsl2rgb(h);
  }
  if (uType == 5) {                                         // vibrance: uP0.x vibrance, uP0.y saturation (-1..1)
    float mx = max(max(c.r,c.g),c.b), mn = min(min(c.r,c.g),c.b), avg = (c.r+c.g+c.b)/3.0, s = mx - mn;
    float k = 1.0 + uP0.y + uP0.x * (uP0.x > 0.0 ? (1.0 - s)*(1.0 - s)*1.6 : 1.0);
    return avg + (c - avg) * k;
  }
  if (uType == 6) {                                         // black & white: uP0 = reds,yellows,greens,cyans  uP1 = blues,magentas,tint?,tintHue
    float r = c.r, g = c.g, b = c.b, mx, md, mn, wp, ws;
    if (r >= g && r >= b) { mx = r; wp = uP0.x; if (g >= b) { md = g; mn = b; ws = uP0.y; } else { md = b; mn = g; ws = uP1.y; } }
    else if (g >= b) { mx = g; wp = uP0.z; if (r >= b) { md = r; mn = b; ws = uP0.y; } else { md = b; mn = r; ws = uP0.w; } }
    else { mx = b; wp = uP1.x; if (r >= g) { md = r; mn = g; ws = uP1.y; } else { md = g; mn = r; ws = uP0.w; } }
    float v = clamp(mn + (md - mn) * ws + (mx - md) * wp, 0.0, 1.0);
    if (uP1.z > 0.0) { vec3 t = hsl2rgb(vec3(uP1.w, uP1.z, 0.5)); return v < 0.5 ? 2.0*v*t : 1.0 - 2.0*(1.0-v)*(1.0-t); }
    return vec3(v);
  }
  if (uType == 7) return 1.0 - c;                           // invert
  if (uType == 8) {                                         // dehaze (dark channel prior): transmission map in uHaze
    vec2 uv = (vec2(p) + 0.5) / uDocSize;
    float t = texture(uHaze, uv).r;
    float amt = uP0.x;
    if (amt < 0.0) return mix(c, uAir, -amt * 0.6);
    float tt = max(0.1, 1.0 - amt * (1.0 - t));
    return (c - uAir) / tt + uAir;
  }
  if (uType == 9) { float l = dot(c, vec3(0.2126,0.7152,0.0722)); return vec3(step(uP0.x, l)); }   // threshold
  return c;
}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 d = texelFetch(uDst, p, 0);
  float k = uOpacity;
  if (uHasMask == 1) { ivec2 q = p - uMaskOff; k *= (q.x < 0 || q.y < 0 || q.x >= uMaskSize.x || q.y >= uMaskSize.y) ? uMaskBg : texelFetch(uMask, q, 0).r; }
  if (uHasClip == 1) { ivec2 q = p - uClipOff; k *= (q.x < 0 || q.y < 0 || q.x >= uClipSize.x || q.y >= uClipSize.y) ? 0.0 : texelFetch(uClip, q, 0).a; }
  if (d.a <= 0.0 || k <= 0.0) { o = d; return; }
  vec3 c = d.rgb / d.a;
  vec3 r = clamp(adjust(c, p), 0.0, 1.0);
  o = vec4(mix(c, r, k) * d.a, d.a);
}`;

/* gradients: shared by the gradient tool, gradient fill layers and the gradient overlay style */
export const GRAD_GLSL = `
uniform int uGType, uGCount;
uniform vec2 uG0, uG1;
uniform float uGPos[32], uGMid[32];
uniform vec4 uGCol[32];     // premultiplied
uniform float uGDither;
vec4 gradAt(vec2 p){
  vec2 d = uG1 - uG0, v = p - uG0; float L2 = max(dot(d,d), 1e-6), L = sqrt(L2), t;
  if (uGType == 1) t = length(v) / L;
  else if (uGType == 2) { float a = atan(v.y, v.x) - atan(d.y, d.x); t = fract(a / 6.2831853 + 1.0); t = 1.0 - t; if (t >= 1.0) t = 0.0; }
  else if (uGType == 3) t = abs(dot(v, d) / L2);
  else if (uGType == 4) { vec2 u = d / L; t = (abs(dot(v, u)) + abs(dot(v, vec2(-u.y, u.x)))) / L; }
  else t = dot(v, d) / L2;
  t = clamp(t, 0.0, 1.0);
  vec4 c = uGCol[0];
  if (t >= uGPos[uGCount - 1]) c = uGCol[uGCount - 1];
  else for (int i = 0; i < 31; i++) {
    if (i >= uGCount - 1) break;
    if (t >= uGPos[i] && t <= uGPos[i + 1]) {
      float u = (t - uGPos[i]) / max(uGPos[i + 1] - uGPos[i], 1e-6), m = uGMid[i];
      u = u < m ? 0.5 * u / max(m, 1e-4) : 0.5 + 0.5 * (u - m) / max(1.0 - m, 1e-4);
      c = mix(uGCol[i], uGCol[i + 1], u); break;
    }
  }
  if (uGDither > 0.0) { float n = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5; c.rgb += n / 255.0 * c.a; c.a += n / 255.0 * step(c.a, 0.999) * step(0.001, c.a); }
  return c;
}`;
export const FS_GRADIENT = `#version 300 es
precision highp float; precision highp int;
${GRAD_GLSL}
out vec4 o;
void main(){ o = gradAt(gl_FragCoord.xy); }`;

/* layer style: gradient overlay over the layer's own pixels, inside its shape */
export const FS_STYLE = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uSrc; uniform ivec2 uSrcOff, uSrcSize; uniform float uFill, uOvOpacity, uSeed; uniform int uOvMode;
${GRAD_GLSL}
${BLEND_GLSL}
out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); ivec2 q = p - uSrcOff;
  vec4 c = (q.x < 0 || q.y < 0 || q.x >= uSrcSize.x || q.y >= uSrcSize.y) ? vec4(0.0) : texelFetch(uSrc, q, 0);
  float a = c.a; if (a <= 0.0) { o = vec4(0.0); return; }
  vec3 cc = c.rgb / a;
  vec4 inner = vec4(cc * uFill, uFill);                     // content at fill opacity, inside the shape
  vec4 g = gradAt(gl_FragCoord.xy) * uOvOpacity;
  vec4 r = blendP(inner, g, uOvMode, gl_FragCoord.xy, uSeed);
  o = r * a;
}`;

/* mesh draw: textured triangles, doc-space positions; for transforms and warped text */
export const VS_MESH = `#version 300 es
in vec2 aPos; in vec2 aUV;
uniform vec2 uTarget; uniform vec2 uTOff;
out vec2 vUV;
void main(){ vUV = aUV; gl_Position = vec4((aPos - uTOff) / uTarget * 2.0 - 1.0, 0.0, 1.0); }`;
export const FS_MESH = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uSrc; uniform vec2 uSrcSize; uniform int uInterp;   // 0 nearest, 1 bilinear (mipmapped), 2 bicubic
in vec2 vUV; out vec4 o;
vec4 cubic(float v){ vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v; vec4 s = n*n*n; float x = s.x, y = s.y - 4.0*s.x, z = s.z - 4.0*s.y + 6.0*s.x, w = 6.0 - x - y - z; return vec4(x, y, z, w) * (1.0/6.0); }
vec4 catmull(sampler2D t, vec2 uv){
  vec2 px = uv * uSrcSize - 0.5, f = fract(px), i = floor(px); vec4 acc = vec4(0.0); float ws = 0.0;
  for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) {
    vec2 d = vec2(float(x), float(y)) - f; vec2 a = abs(d);
    vec2 w = mix(((-0.5*a + 2.5)*a - 4.0)*a + 2.0, (1.5*a - 2.5)*a*a + 1.0, step(a, vec2(1.0)));
    ivec2 q = clamp(ivec2(i) + ivec2(x, y), ivec2(0), ivec2(uSrcSize) - 1);
    float ww = w.x * w.y; acc += texelFetch(t, q, 0) * ww; ws += ww;
  }
  return acc / ws;
}
void main(){
  if (vUV.x < 0.0 || vUV.y < 0.0 || vUV.x > 1.0 || vUV.y > 1.0) { o = vec4(0.0); return; }
  vec2 dx = dFdx(vUV * uSrcSize), dy = dFdy(vUV * uSrcSize); float scale = max(length(dx), length(dy));
  if (uInterp == 0) o = texelFetch(uSrc, clamp(ivec2(vUV * uSrcSize), ivec2(0), ivec2(uSrcSize) - 1), 0);
  else if (uInterp == 2 && scale < 1.0) o = clamp(catmull(uSrc, vUV), 0.0, 1.0);
  else o = texture(uSrc, vUV);
  o.rgb = min(o.rgb, vec3(o.a));
}`;

/* the final view: document composite on a checkerboard, scaled; flips y for the screen */
export const VS_VIEW = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;   // screen rect of the doc in device px (x,y,w,h), y down
uniform vec2 uScreen;
out vec2 vUV;
void main(){ vUV = aPos; vec2 p = uRect.xy + aPos * uRect.zw; gl_Position = vec4(p.x / uScreen.x * 2.0 - 1.0, 1.0 - p.y / uScreen.y * 2.0, 0.0, 1.0); }`;
export const FS_VIEW = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform float uChecker; uniform vec3 uCk1, uCk2; uniform int uNearest; uniform vec2 uDocSize; uniform float uZoom;
in vec2 vUV; out vec4 o;
void main(){
  vec4 c = uNearest == 1 ? texelFetch(uSrc, clamp(ivec2(vUV * uDocSize), ivec2(0), ivec2(uDocSize) - 1), 0) : texture(uSrc, vUV);
  vec2 sp = gl_FragCoord.xy / uChecker; float k = mod(floor(sp.x) + floor(sp.y), 2.0);
  vec3 bg = mix(uCk1, uCk2, k);
  o = vec4(c.rgb + bg * (1.0 - c.a), 1.0);
}`;

/* dehaze helpers: dark channel at 1/4 size, then a min filter */
export const FS_DARK = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform ivec2 uSrcSize; uniform int uStep; uniform vec3 uAir;
out vec4 o;
void main(){
  ivec2 b = ivec2(gl_FragCoord.xy) * uStep; float m = 1.0;
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) { if (x >= uStep || y >= uStep) continue;
    ivec2 q = min(b + ivec2(x, y), uSrcSize - 1); vec4 c = texelFetch(uSrc, q, 0); vec3 u = c.a > 0.0 ? c.rgb / c.a : vec3(1.0);
    u /= max(uAir, vec3(0.05)); m = min(m, min(min(u.r, u.g), u.b)); }
  o = vec4(m, m, m, 1.0);
}`;
export const FS_MINF = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform ivec2 uDir; uniform ivec2 uSize; uniform int uR; uniform int uMode;  // 0 min, 1 box mean
out vec4 o;
void main(){ ivec2 p = ivec2(gl_FragCoord.xy); float m = uMode == 0 ? 1.0 : 0.0; float n = 0.0;
  for (int i = -16; i <= 16; i++) { if (i < -uR || i > uR) continue; float v = texelFetch(uSrc, clamp(p + uDir * i, ivec2(0), uSize - 1), 0).r; if (uMode == 0) m = min(m, v); else { m += v; n += 1.0; } }
  if (uMode == 1) m /= n; o = vec4(m, m, m, 1.0); }`;
export const FS_TRANS = `#version 300 es
precision highp float;
uniform sampler2D uSrc; out vec4 o;
void main(){ float d = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r; float t = 1.0 - 0.95 * d; o = vec4(t, t, t, 1.0); }`;

/* ---------- GL helper ---------- */
export class GL {
  constructor(canvasEl) {
    const gl = canvasEl.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.floatRT = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.progs = {};
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    this.meshBuf = gl.createBuffer();
    this.meshVao = gl.createVertexArray();
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    this.fbo = gl.createFramebuffer();
  }
  program(name, vs, fs) {
    if (this.progs[name]) return this.progs[name];
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(name + ': ' + gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aUV');
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ': ' + gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const nm = info.name.replace(/\[0\]$/, ''); u[nm] = gl.getUniformLocation(p, info.name); }
    return (this.progs[name] = { p, u });
  }
  /** fmt 'rgba8' | 'rgba16f' | 'r8' */
  texture(w, h, fmt = 'rgba8', filter = 'nearest') {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const [ifmt, f, ty] = fmt === 'rgba16f' ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT] : fmt === 'r8' ? [gl.R8, gl.RED, gl.UNSIGNED_BYTE] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, f, ty, null);
    this.filter(t, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { t, w, h, fmt, mip: false };
  }
  filter(t, mode) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, t.t || t);
    const mag = mode === 'nearest' ? gl.NEAREST : gl.LINEAR, min = mode === 'mip' ? gl.LINEAR_MIPMAP_LINEAR : mag;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
  }
  free(t) { if (t) this.gl.deleteTexture(t.t); }
  /** upload a canvas / ImageData into an RGBA8 texture (premultiplied by the unpack flag) */
  upload(src, tex) {
    const gl = this.gl, w = src.width, h = src.height;
    if (!tex || tex.w !== w || tex.h !== h) { this.free(tex); tex = this.texture(w, h, 'rgba8', 'linear'); }
    gl.bindTexture(gl.TEXTURE_2D, tex.t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src);
    tex.mip = false;
    return tex;
  }
  uploadRect(tex, data, x, y) { const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, tex.t); gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, data.width, data.height, gl.RGBA, gl.UNSIGNED_BYTE, data); tex.mip = false; }
  target(tex) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, tex ? this.fbo : null);
    if (tex) { gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.t, 0); gl.viewport(0, 0, tex.w, tex.h); }
  }
  /** draw a rect (target px) with program prog; binds sampler units in order of `tex` entries */
  rect(prog, target, r, uniforms = {}, tex = {}) {
    const gl = this.gl;
    this.target(target);
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(prog.u.uRect, r.x, r.y, r.w, r.h);
    gl.uniform2f(prog.u.uTarget, target ? target.w : gl.drawingBufferWidth, target ? target.h : gl.drawingBufferHeight);
    let unit = 0;
    for (const [name, t] of Object.entries(tex)) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t ? (t.t || t) : null); if (prog.u[name]) gl.uniform1i(prog.u[name], unit); unit++; }
    setUniforms(gl, prog, uniforms);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(r.x, r.y, r.w, r.h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.SCISSOR_TEST);
  }
  clear(target, r, color = [0, 0, 0, 0]) {
    const gl = this.gl; this.target(target);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(r.x, r.y, r.w, r.h);
    gl.clearColor(...color); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.SCISSOR_TEST);
  }
  /** triangles: Float32Array [x,y,u,v, ...] in doc space (minus tOff) */
  mesh(prog, target, verts, uniforms, tex, tOff = { x: 0, y: 0 }) {
    const gl = this.gl;
    this.target(target);
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuf); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.uniform2f(prog.u.uTarget, target.w, target.h); gl.uniform2f(prog.u.uTOff, tOff.x, tOff.y);
    let unit = 0;
    for (const [name, t] of Object.entries(tex)) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.t || t); gl.uniform1i(prog.u[name], unit); unit++; }
    setUniforms(gl, prog, uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 4);
    gl.bindVertexArray(null);
  }
  /** read a target rect as ImageData (straight alpha) via an RGBA8 un-premultiply pass */
  read(src, r) {
    const gl = this.gl, tmp = this.texture(r.w, r.h, 'rgba8');
    const p = this.program('copy', VS_RECT, FS_COPY);
    this.rect(p, tmp, { x: 0, y: 0, w: r.w, h: r.h }, { uOff: ['2i', r.x, r.y], uUnpremul: ['1i', 1] }, { uSrc: src });
    const px = new Uint8ClampedArray(r.w * r.h * 4);
    gl.readPixels(0, 0, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.target(null); this.free(tmp);
    return new ImageData(px, r.w, r.h);
  }
}

export function setUniforms(gl, prog, uniforms) {
  for (const [name, v] of Object.entries(uniforms)) {
    const loc = prog.u[name]; if (loc == null) continue;
    const [type, ...a] = v;
    switch (type) {
      case '1i': gl.uniform1i(loc, a[0]); break;
      case '2i': gl.uniform2i(loc, a[0], a[1]); break;
      case '1f': gl.uniform1f(loc, a[0]); break;
      case '2f': gl.uniform2f(loc, a[0], a[1]); break;
      case '3f': gl.uniform3f(loc, a[0], a[1], a[2]); break;
      case '4f': gl.uniform4f(loc, a[0], a[1], a[2], a[3]); break;
      case '1fv': gl.uniform1fv(loc, a[0]); break;
      case '4fv': gl.uniform4fv(loc, a[0]); break;
    }
  }
}
