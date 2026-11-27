// Composites a document on the GPU: layers -> blend passes into ping-pong
// accumulation textures, groups (pass-through or isolated), clipping, masks,
// adjustment layers, fill layers and the gradient overlay style. The result
// is the same at any size, so export uses this too.

import { GL, VS_RECT, FS_BLEND, FS_COPY, FS_ADJUST, FS_GRADIENT, FS_STYLE, VS_MESH, FS_MESH, FS_DARK, FS_MINF, FS_TRANS } from './gl.js';
import { BLEND_IDS } from './doc.js';
import { R, getData } from './util.js';
import { gradientUniforms, gradientGeometry } from './gradient.js';
import { adjustUniforms } from './adjust.js';
import { rasterizeText, textBoxPolys } from './text.js';
import { sbRun } from './sbfx.js';
import { canvas, ctx } from './util.js';

// text box: the box under (or, inverted, cut by) a layer's or group's pixels. Premultiplied.
const FS_TBOX = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uSrc, uBox; uniform ivec2 uSrcOff, uSrcSize, uBoxOff, uBoxSize; uniform int uInv; uniform float uFill, uBoxOp;
out vec4 o;
vec4 at(sampler2D t, ivec2 p, ivec2 off, ivec2 sz){ ivec2 q = p - off; if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) return vec4(0.0); return texelFetch(t, q, 0); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = at(uSrc, p, uSrcOff, uSrcSize), b = at(uBox, p, uBoxOff, uBoxSize) * uBoxOp;
  o = uInv == 1 ? b * (1.0 - s.a) : s * uFill + b * (1.0 - s.a * uFill);
}`;

export class Compositor {
  constructor(canvasEl) {
    this.g = new GL(canvasEl);
    this.cache = new Map();      // layer id -> {tex, rev, src}
    this.maskCache = new Map();  // layer id -> {tex, rev, src}
    this.lutCache = new Map();
    this.levels = [];            // [{a,b}] per nesting depth
    this.pool = [];              // free doc-size temp textures
    this.result = null; this.size = null;
    this.hooks = { source: null, mesh: null, redraw: null };
    this.sbCache = new Map();    // SB FX layer id -> {key, tex, t, scaled}
    this.exact = false;          // true while exporting: SB FX layers never use their quick preview
    this.seed = Math.random() * 100;
    const g = this.g;
    this.P = {
      blend: g.program('blend', VS_RECT, FS_BLEND), copy: g.program('copy', VS_RECT, FS_COPY), adjust: g.program('adjust', VS_RECT, FS_ADJUST),
      grad: g.program('grad', VS_RECT, FS_GRADIENT), style: g.program('style', VS_RECT, FS_STYLE), mesh: g.program('mesh', VS_MESH, FS_MESH),
      tbox: g.program('tbox', VS_RECT, FS_TBOX), dark: g.program('dark', VS_RECT, FS_DARK), minf: g.program('minf', VS_RECT, FS_MINF), trans: g.program('trans', VS_RECT, FS_TRANS),
    };
  }
  get gl() { return this.g.gl; }

  /* ---------- buffers ---------- */
  setSize(w, h) {
    if (this.size && this.size.w === w && this.size.h === h) return;
    const g = this.g;
    for (const l of this.levels) { g.free(l.a); g.free(l.b); }
    for (const t of this.pool) g.free(t);
    g.free(this.result);
    this.levels = []; this.pool = [];
    this.fmt = g.floatRT && w * h <= 16e6 ? 'rgba16f' : 'rgba8';
    this.size = { w, h };
    this.result = g.texture(w, h, this.fmt, 'linear');
  }
  level(i) {
    while (this.levels.length <= i) this.levels.push({ a: this.g.texture(this.size.w, this.size.h, this.fmt), b: this.g.texture(this.size.w, this.size.h, this.fmt) });
    return this.levels[i];
  }
  temp() { return this.pool.pop() || this.g.texture(this.size.w, this.size.h, this.fmt, 'linear'); }
  release(t) { if (t) this.pool.push(t); }
  /** drop GPU copies of layers that no longer exist */
  gc(doc) {
    const ids = new Set(doc.all().map(l => l.id));
    for (const m of [this.cache, this.maskCache, this.sbCache]) for (const [id, e] of m) if (!ids.has(id)) { this.g.free(e.tex); m.delete(id); }
    while (this.pool.length > 4) this.g.free(this.pool.pop());
  }
  dispose() {
    for (const m of [this.cache, this.maskCache, this.sbCache]) for (const e of m.values()) this.g.free(e.tex);
    this.cache.clear(); this.maskCache.clear(); this.sbCache.clear(); this.size = null;
    for (const l of this.levels) { this.g.free(l.a); this.g.free(l.b); }
    for (const t of this.pool) this.g.free(t);
    this.g.free(this.result); this.levels = []; this.pool = []; this.result = null;
  }

  /* ---------- layer textures ---------- */
  texFor(key, src, rev, dirty, full) {
    let e = this.cache.get(key);
    if (!e || e.src !== src || e.tex.w !== src.width || e.tex.h !== src.height) {
      if (e) this.g.free(e.tex);
      e = { tex: this.g.upload(src), rev, src }; this.cache.set(key, e);
    } else if (e.rev !== rev) {
      const r = !full && dirty ? R.inter(R.out(dirty), { x: 0, y: 0, w: src.width, h: src.height }) : null;
      if (r && r.w * r.h < src.width * src.height * 0.6) this.g.uploadRect(e.tex, getData(src, r), r.x, r.y);
      else this.g.upload(src, e.tex);
      e.rev = rev;
    }
    return e.tex;
  }
  /** {tex, x, y, w, h} for a layer's own pixels (before style), or null */
  pixels(layer) {
    let src = null, x = 0, y = 0, rev = layer.rev;
    const hook = this.hooks.source && this.hooks.source(layer);
    if (hook) { src = hook.canvas; x = hook.x; y = hook.y; rev = hook.rev ?? rev; }
    else if (layer.type === 'pixel') { src = layer.canvas; x = layer.x; y = layer.y; }
    else if (layer.type === 'text') { const r = layer.raster; if (!r) return null; src = r.canvas; x = r.x; y = r.y; rev = r.rev; }
    if (!src) return null;
    const key = hook ? layer.id + ':h' : layer.id;
    const tex = this.texFor(key, src, rev, hook ? null : layer.dirty, hook ? true : layer.dirtyFull);
    if (!hook) { layer.dirty = null; layer.dirtyFull = false; }
    return { tex, x, y, w: src.width, h: src.height };
  }
  maskFor(layer) {
    const m = layer.mask; if (!m || !m.enabled) return null;
    let e = this.maskCache.get(layer.id);
    if (!e || e.src !== m.canvas || e.tex.w !== m.canvas.width || e.tex.h !== m.canvas.height) {
      if (e) this.g.free(e.tex);
      e = { tex: this.g.upload(m.canvas), rev: m.rev, src: m.canvas }; this.maskCache.set(layer.id, e); m.dirty = null;
    } else if (e.rev !== m.rev) {
      const r = m.dirty ? R.inter(R.out(m.dirty), { x: 0, y: 0, w: m.canvas.width, h: m.canvas.height }) : null;
      if (r) this.g.uploadRect(e.tex, getData(m.canvas, r), r.x, r.y); else this.g.upload(m.canvas, e.tex);
      e.rev = m.rev; m.dirty = null;
    }
    return { tex: e.tex, x: m.x, y: m.y, w: m.canvas.width, h: m.canvas.height, bg: m.bg / 255 };
  }

  /* ---------- prepare: the texture a layer contributes (premultiplied, doc-placed) ---------- */
  prepare(doc, layer, rect) {
    const g = this.g;
    if (layer.type === 'text' && !layer.raster) rasterizeText(layer, doc);
    if (layer.type === 'fill' && layer.kind === 'solid') {
      const c = layer.color; return { kind: 'const', color: [c.r / 255, c.g / 255, c.b / 255, 1] };
    }
    if (layer.type === 'fill' && layer.kind === 'gradient') {
      const t = this.temp(), grad = layer.gradient, geo = gradientGeometry(grad, { x: 0, y: 0, w: doc.width, h: doc.height });
      g.rect(this.P.grad, t, rect, gradientUniforms(grad, geo));
      return { tex: t, x: 0, y: 0, w: doc.width, h: doc.height, temp: true };
    }
    let px;
    const mesh = this.hooks.mesh && this.hooks.mesh(layer);
    if (mesh) {
      // transformed / warped: draw the source through the mesh into a doc-size temp
      let src;
      if (mesh.canvas) { const tex = this.texFor(layer.id + ':m', mesh.canvas, mesh.rev || 1, null, true); src = { tex, w: mesh.canvas.width, h: mesh.canvas.height }; }
      else src = this.pixels(layer);
      if (!src) return null;
      const t = this.temp(); g.clear(t, rect);
      if (mesh.interp === 1 && !src.tex.mip) { g.filter(src.tex, 'mip'); this.gl.bindTexture(this.gl.TEXTURE_2D, src.tex.t); this.gl.generateMipmap(this.gl.TEXTURE_2D); src.tex.mip = true; }
      else if (mesh.interp !== 1) g.filter(src.tex, 'linear');
      this.gl.enable(this.gl.SCISSOR_TEST); this.gl.scissor(rect.x, rect.y, rect.w, rect.h);
      g.mesh(this.P.mesh, t, mesh.verts, { uSrcSize: ['2f', src.w, src.h], uInterp: ['1i', mesh.interp ?? 2] }, { uSrc: src.tex });
      this.gl.disable(this.gl.SCISSOR_TEST);
      px = { tex: t, x: 0, y: 0, w: doc.width, h: doc.height, temp: true };
    } else {
      px = this.pixels(layer); if (!px) return null;
    }
    const ov = layer.style && layer.style.gradOverlay;
    if (ov && ov.enabled !== false) {
      const t = this.temp(), b = layerBounds(layer, px);
      const geo = gradientGeometry(ov, ov.align === false ? { x: 0, y: 0, w: doc.width, h: doc.height } : b);
      g.rect(this.P.style, t, rect, {
        ...gradientUniforms(ov, geo), uSrcOff: ['2i', px.x, px.y], uSrcSize: ['2i', px.w, px.h], uFill: ['1f', layer.fill],
        uOvOpacity: ['1f', ov.opacity ?? 1], uOvMode: ['1i', BLEND_IDS[ov.blend || 'normal'] ?? 0], uSeed: ['1f', this.seed],
      }, { uSrc: px.tex });
      if (px.temp) this.release(px.tex);
      const out = { tex: t, x: 0, y: 0, w: doc.width, h: doc.height, temp: true, styled: true }, tb = this.boxStyle(layer);
      return tb ? this.boxPass(doc, layer, tb, out, rect, 1) : out;
    }
    const tb = this.boxStyle(layer);
    if (tb) return this.boxPass(doc, layer, tb, px, rect, layer.fill);
    return px;
  }

  /* ---------- passes ---------- */
  blendPass(dst, cur, src, rect, mode, opacity, mask, clip) {
    const u = {
      uMode: ['1i', mode], uOpacity: ['1f', opacity], uSeed: ['1f', this.seed],
      uSrcKind: ['1i', src.kind === 'const' ? 1 : 0], uConst: ['4f', ...(src.color || [0, 0, 0, 0])],
      uSrcOff: ['2i', src.x || 0, src.y || 0], uSrcSize: ['2i', src.w || 0, src.h || 0],
      uHasMask: ['1i', mask ? 1 : 0], uMaskOff: ['2i', mask ? mask.x : 0, mask ? mask.y : 0], uMaskSize: ['2i', mask ? mask.w : 0, mask ? mask.h : 0], uMaskBg: ['1f', mask ? mask.bg : 1],
      uHasClip: ['1i', clip && clip.tex ? 1 : 0], uClipOff: ['2i', clip ? clip.x || 0 : 0, clip ? clip.y || 0 : 0], uClipSize: ['2i', clip ? clip.w || 0 : 0, clip ? clip.h || 0 : 0],
    };
    this.g.rect(this.P.blend, dst, rect, u, { uDst: cur, uSrc: src.tex || cur, uMask: mask ? mask.tex : cur, uClip: clip && clip.tex ? clip.tex : cur });
  }
  adjustPass(doc, layer, dst, cur, rect, mask, clip) {
    const au = adjustUniforms(layer.adj, layer.params);
    const lut = au.lut ? this.lutTex(layer, au.lut) : null;
    let haze = null, air = [1, 1, 1];
    if (layer.adj === 'dehaze') ({ haze, air } = this.hazeMap(doc, cur));
    this.g.rect(this.P.adjust, dst, rect, {
      ...au.uniforms, uOpacity: ['1f', layer.opacity], uAir: ['3f', ...air], uDocSize: ['2f', doc.width, doc.height],
      uHasMask: ['1i', mask ? 1 : 0], uMaskOff: ['2i', mask ? mask.x : 0, mask ? mask.y : 0], uMaskSize: ['2i', mask ? mask.w : 0, mask ? mask.h : 0], uMaskBg: ['1f', mask ? mask.bg : 1],
      uHasClip: ['1i', clip && clip.tex ? 1 : 0], uClipOff: ['2i', clip ? clip.x || 0 : 0, clip ? clip.y || 0 : 0], uClipSize: ['2i', clip ? clip.w || 0 : 0, clip ? clip.h || 0 : 0],
    }, { uDst: cur, uMask: mask ? mask.tex : cur, uClip: clip && clip.tex ? clip.tex : cur, uLut: lut || cur, uHaze: haze || cur });
    if (haze) this.g.free(haze);
  }
  /** a layer's or group's text box, or null */
  boxStyle(n) { const tb = n.style && n.style.textBox; return tb && tb.enabled !== false && (n.type === 'text' || n.isGroup) ? tb : null; }
  /** the box as a texture {tex, x, y, w, h, temp?}: polygons drawn on a canvas (cached), a gradient painted in on the GPU */
  boxTex(doc, n, tb, rect) {
    let polys = [];
    if (n.type === 'text') polys = textBoxPolys(n, doc, tb);
    else {
      const walk = g => { for (const c of g.children) { if (!c.visible) continue; if (c.isGroup) walk(c); else if (c.type === 'text') polys.push(...textBoxPolys(c, doc, tb)); } };
      walk(n);
      if (tb.shape === 'block' && polys.length) { const xs = polys.flat().map(p => p[0]), ys = polys.flat().map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); polys = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]; }
    }
    if (!polys.length) return null;
    const xs = polys.flat().map(p => p[0]), ys = polys.flat().map(p => p[1]);
    const bx = Math.floor(Math.min(...xs)) - 1, by = Math.floor(Math.min(...ys)) - 1, bw = Math.ceil(Math.max(...xs)) + 1 - bx, bh = Math.ceil(Math.max(...ys)) + 1 - by;
    const grad = tb.fill === 'gradient' && tb.gradient, col = tb.color || { r: 242, g: 92, b: 45 };
    const key = JSON.stringify([polys.map(q => q.map(p => [Math.round(p[0] * 4), Math.round(p[1] * 4)])), grad ? 'g' : col]);
    let e = this.cache.get(n.id + ':box');
    if (!e || e.key !== key) {
      const c = canvas(Math.min(16384, bw), Math.min(16384, bh)), x = ctx(c);
      x.fillStyle = grad ? '#fff' : `rgb(${col.r},${col.g},${col.b})`; x.beginPath();
      for (const q of polys) { x.moveTo(q[0][0] - bx, q[0][1] - by); for (const p of q.slice(1)) x.lineTo(p[0] - bx, p[1] - by); x.closePath(); }
      x.fill('nonzero');
      if (e) this.g.free(e.tex);
      e = { tex: this.g.upload(c), key, w: c.width, h: c.height }; this.cache.set(n.id + ':box', e);
    }
    const box = { tex: e.tex, x: bx, y: by, w: e.w, h: e.h };
    if (!grad) return box;
    const t = this.temp(), geo = gradientGeometry(grad, { x: bx, y: by, w: bw, h: bh });
    this.g.rect(this.P.style, t, rect, { ...gradientUniforms(grad, geo), uSrcOff: ['2i', bx, by], uSrcSize: ['2i', e.w, e.h], uFill: ['1f', 1], uOvOpacity: ['1f', 1], uOvMode: ['1i', 0], uSeed: ['1f', this.seed] }, { uSrc: e.tex });
    return { tex: t, x: 0, y: 0, w: doc.width, h: doc.height, temp: true };
  }
  /** src under its text box (or cut out of it) into a doc-size temp: {tex,...,temp,styled} */
  boxPass(doc, n, tb, src, rect, fill = 1) {
    const box = this.boxTex(doc, n, tb, rect); if (!box) return src;
    const t = this.temp();
    this.g.rect(this.P.tbox, t, rect, {
      uSrcOff: ['2i', src.x || 0, src.y || 0], uSrcSize: ['2i', src.w || 0, src.h || 0], uBoxOff: ['2i', box.x, box.y], uBoxSize: ['2i', box.w, box.h],
      uInv: ['1i', tb.invert ? 1 : 0], uFill: ['1f', fill], uBoxOp: ['1f', tb.opacity ?? 1],
    }, { uSrc: src.tex, uBox: box.tex });
    if (box.temp) this.release(box.tex);
    if (src.temp) this.release(src.tex);
    return { tex: t, x: 0, y: 0, w: doc.width, h: doc.height, temp: true, styled: true };
  }
  /** SB FX layer: read back the composite so far, run the look on it (sbfx.js, its own GL context),
   *  and mix the result in by opacity / mask / clip. Cached on the backdrop's pixels; while the
   *  backdrop keeps changing (painting under it) it runs at reduced size, then catches up. */
  sbPass(doc, layer, dst, cur, rect, mask, clip) {
    const W = doc.width, H = doc.height, full = { x: 0, y: 0, w: W, h: H }, back = this.g.read(cur, full), px = new Uint32Array(back.data.buffer);
    let hsh = 2166136261; for (let i = 0; i < px.length; i++) hsh = Math.imul(hsh ^ px[i], 16777619);
    const key = JSON.stringify(layer.params) + '|' + W + 'x' + H + '|' + (hsh >>> 0);
    let e = this.sbCache.get(layer.id);
    const now = performance.now(), busy = e && e.key !== key && now - e.t < 250 && !this.exact;
    if (!e || e.key !== key || (e.scaled && (this.exact || now - e.t >= 250))) {
      const scale = busy && W * H > 1e6 ? Math.sqrt(1e6 / (W * H)) : 1;
      let src = canvas(W, H); ctx(src).putImageData(back, 0, 0);
      if (scale < 1) { const s = canvas(W * scale, H * scale), c = ctx(s); c.imageSmoothingQuality = 'high'; c.drawImage(src, 0, 0, s.width, s.height); src = s; }
      let out = sbRun(layer.params.mode, src, { ...layer.params, ref: Math.max(W, H) }, { ox: 0, oy: 0, scale });
      if (scale < 1) { const b = canvas(W, H), c = ctx(b); c.imageSmoothingQuality = 'high'; c.drawImage(out, 0, 0, W, H); out = b; }
      if (!e || e.tex.w !== W || e.tex.h !== H) { if (e) this.g.free(e.tex); e = { tex: this.g.upload(out) }; this.sbCache.set(layer.id, e); }
      else this.g.upload(out, e.tex);
      Object.assign(e, { key, t: now, scaled: scale < 1 });
      if (e.scaled && this.hooks.redraw) { clearTimeout(e.timer); e.timer = setTimeout(() => this.hooks.redraw(), 300); }
    }
    this.blendPass(dst, cur, { tex: e.tex, x: 0, y: 0, w: W, h: H }, rect, 100, layer.opacity, mask, clip);
  }
  lutTex(layer, lut) {
    // lut: Uint8Array(256*4) rows: all, r, g, b
    const key = layer.id, gl = this.gl;
    let e = this.lutCache.get(key);
    if (!e) { e = { tex: this.g.texture(256, 4, 'r8', 'linear') }; this.lutCache.set(key, e); }
    gl.bindTexture(gl.TEXTURE_2D, e.tex.t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 4, gl.RED, gl.UNSIGNED_BYTE, lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return e.tex;
  }
  /** dark-channel-prior transmission map of the composite so far (1/4 size) */
  hazeMap(doc, cur) {
    const g = this.g, s = 4, lw = Math.ceil(doc.width / s), lh = Math.ceil(doc.height / s), r = { x: 0, y: 0, w: lw, h: lh };
    const a = g.texture(lw, lh, 'rgba8'), b = g.texture(lw, lh, 'rgba8');
    const dark = air => {
      g.rect(this.P.dark, a, r, { uSrcSize: ['2i', doc.width, doc.height], uStep: ['1i', s], uAir: ['3f', ...air] }, { uSrc: cur });
      g.rect(this.P.minf, b, r, { uDir: ['2i', 1, 0], uSize: ['2i', lw, lh], uR: ['1i', 3], uMode: ['1i', 0] }, { uSrc: a });
      g.rect(this.P.minf, a, r, { uDir: ['2i', 0, 1], uSize: ['2i', lw, lh], uR: ['1i', 3], uMode: ['1i', 0] }, { uSrc: b });
    };
    dark([1, 1, 1]);
    // atmospheric light: mean colour under the brightest 0.1% of the dark channel
    const gl = this.gl; g.target(a);
    const dk = new Uint8Array(lw * lh * 4); gl.readPixels(0, 0, lw, lh, gl.RGBA, gl.UNSIGNED_BYTE, dk);
    const small = g.read(cur, { x: 0, y: 0, w: doc.width, h: doc.height });
    const idx = []; for (let i = 0; i < lw * lh; i++) idx.push(i);
    idx.sort((p, q) => dk[q * 4] - dk[p * 4]);
    const n = Math.max(1, (lw * lh / 1000) | 0), air = [0, 0, 0];
    for (let k = 0; k < n; k++) { const i = idx[k], x = Math.min(doc.width - 1, (i % lw) * s), y = Math.min(doc.height - 1, ((i / lw) | 0) * s), o = (y * doc.width + x) * 4; air[0] += small.data[o] / 255; air[1] += small.data[o + 1] / 255; air[2] += small.data[o + 2] / 255; }
    for (let c = 0; c < 3; c++) air[c] = Math.max(0.05, air[c] / n);
    dark(air);
    g.rect(this.P.minf, b, r, { uDir: ['2i', 1, 0], uSize: ['2i', lw, lh], uR: ['1i', 4], uMode: ['1i', 1] }, { uSrc: a });
    g.rect(this.P.minf, a, r, { uDir: ['2i', 0, 1], uSize: ['2i', lw, lh], uR: ['1i', 4], uMode: ['1i', 1] }, { uSrc: b });
    g.rect(this.P.trans, b, r, {}, { uSrc: a });
    g.free(a); g.filter(b, 'linear');
    return { haze: b, air };
  }

  /* ---------- the walk ---------- */
  /** render rect (doc px) of doc into this.result; returns the result texture */
  render(doc, rect) {
    this.setSize(doc.width, doc.height);
    const full = { x: 0, y: 0, w: doc.width, h: doc.height };
    rect = rect ? R.inter(R.out(rect), full) : full;
    if (!rect) return this.result;
    if (doc.all().some(l => l.type === 'adjust' && l.adj === 'sbfx' && l.visible)) rect = full;   // SB FX reads the whole backdrop
    const L = this.level(0);
    this.g.clear(L.a, rect);
    const out = this.group(doc, doc.root.children, 0, L.a, rect);
    this.g.rect(this.P.copy, this.result, rect, { uOff: ['2i', 0, 0], uUnpremul: ['1i', 0] }, { uSrc: out });
    this.result.mip = false;
    return this.result;
  }
  group(doc, nodes, depth, cur, rect) {
    const L = this.level(depth);
    let clipSrc = null;            // prepared texture of the current clip base
    let baseVisible = true;
    const swap = () => (cur === L.a ? L.b : L.a);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const isBase = !n.clip;
      if (isBase) { if (clipSrc && clipSrc.temp) this.release(clipSrc.tex); clipSrc = null; baseVisible = n.visible; }
      if (!n.visible || (n.clip && !baseVisible)) continue;
      const nextClipped = nodes[i + 1] && nodes[i + 1].clip;
      const mask = this.maskFor(n);
      const clip = n.clip ? clipSrc : null;
      if (n.clip && !clipSrc) continue;    // base contributes nothing to clip to
      if (n.type === 'group') {
        const pass = n.blend === 'pass';
        const gtb = this.boxStyle(n);
        if (pass && n.opacity >= 1 && !mask && !clip && !nextClipped && !gtb) {
          cur = this.group(doc, n.children, depth, cur, rect);   // pass-through: children blend straight into this stack
          continue;
        }
        // isolated (or pass-through needing opacity / mask / a clip alpha): render the children on their own
        const isoPass = pass && !nextClipped && !gtb;
        const L2 = this.level(depth + 1);
        if (isoPass) this.g.rect(this.P.copy, L2.a, rect, { uOff: ['2i', 0, 0], uUnpremul: ['1i', 0] }, { uSrc: cur });
        else this.g.clear(L2.a, rect);
        let res = this.group(doc, n.children, depth + 1, L2.a, rect), keep = null, boxed = null;
        if (gtb) { boxed = this.boxPass(doc, n, gtb, { tex: res, x: 0, y: 0, w: doc.width, h: doc.height }, rect, 1); res = boxed.tex; }
        if (nextClipped) { keep = this.temp(); this.g.rect(this.P.copy, keep, rect, { uOff: ['2i', 0, 0], uUnpremul: ['1i', 0] }, { uSrc: res }); res = keep; }
        const dst = swap();
        this.blendPass(dst, cur, { tex: res, x: 0, y: 0, w: doc.width, h: doc.height }, rect, isoPass ? 100 : (BLEND_IDS[pass ? 'normal' : n.blend] ?? 0), n.opacity, mask, clip);
        cur = dst;
        if (boxed && boxed.temp) this.release(boxed.tex);
        if (keep) clipSrc = { tex: keep, x: 0, y: 0, w: doc.width, h: doc.height, temp: true };
        continue;
      }
      if (n.type === 'adjust') {
        const dst = swap(); if (n.adj === 'sbfx') this.sbPass(doc, n, dst, cur, rect, mask, clip); else this.adjustPass(doc, n, dst, cur, rect, mask, clip); cur = dst;
        continue;
      }
      const src = this.prepare(doc, n, rect);
      if (!src) continue;
      const dst = swap();
      const op = n.opacity * (src.styled ? 1 : n.fill);
      this.blendPass(dst, cur, src, rect, BLEND_IDS[n.blend] ?? 0, op, mask, clip);
      cur = dst;
      if (nextClipped && isBase) {
        // clipped layers use this layer's alpha (with its mask applied)
        if (mask) {
          const blank = this.temp(), t = this.temp(); this.g.clear(blank, rect);
          this.blendPass(t, blank, src, rect, 0, 1, mask, null); this.release(blank);
          if (src.temp) this.release(src.tex);
          clipSrc = { tex: t, x: 0, y: 0, w: doc.width, h: doc.height, temp: true };
        } else if (src.kind === 'const') clipSrc = { tex: null };   // a solid fill covers everything: nothing to clip
        else clipSrc = src;
      } else if (src.temp) this.release(src.tex);
    }
    if (clipSrc && clipSrc.temp) this.release(clipSrc.tex);
    return cur;
  }

  /** composite + read back as ImageData (straight alpha) */
  readComposite(doc, r) {
    this.exact = true; try { this.render(doc); } finally { this.exact = false; }
    return this.g.read(this.result, r || { x: 0, y: 0, w: doc.width, h: doc.height });
  }
  /** render a single layer's contribution alone (for thumbnails of groups etc.) */
  readLayer(doc, layer) {
    this.setSize(doc.width, doc.height);
    const full = { x: 0, y: 0, w: doc.width, h: doc.height }, L = this.level(0);
    this.g.clear(L.a, full);
    const out = this.group(doc, [layer], 0, L.a, full);
    return this.g.read(out, full);
  }
}

function layerBounds(layer, px) {
  if (layer.type === 'text' && layer.raster && layer.raster.bounds) return layer.raster.bounds;
  if (layer.contentBounds) return layer.contentBounds;
  return { x: px.x, y: px.y, w: px.w, h: px.h };
}
