// Text layers: layout (lines, wrapping in a box, tracking, leading,
// alignment) and rasterising into a canvas. Size is in points and converts
// with the document's ppi. Fonts come from the system (via the shell) and
// are loaded as FontFace so every installed style renders exactly.

import { canvas, ctx, C, fnv } from './util.js';
import { bridge } from './bridge.js';

/* ---------- fonts ---------- */
export const fonts = {
  list: null,           // [{family, styles:[{style, weight, italic, ps}]}]
  loaded: new Map(),    // key family|style -> css family name
  pending: new Map(),
  listeners: new Set(),
  async init() {
    if (this.list) return this.list;
    let list = null;
    try { list = await bridge.fonts(); } catch { }
    if (!list || !list.length) list = FALLBACK.map(f => ({ family: f, styles: [{ style: 'Regular', weight: 5, italic: false }, { style: 'Bold', weight: 9, italic: false }, { style: 'Italic', weight: 5, italic: true }] }));
    this.list = list;
    this.flyer = list.filter(f => f.flyer).map(f => f.family);   // the fonts stlv ships (mac/fonts)
    return list;
  },
  /** fontPick options for the "Flyer fonts" tick box: a pref, plus previews of the shipped fonts from their own files
   *  (the page can't see fonts the app process loads by CSS name) */
  flyerPick(app) {
    if (!this.flyer || !this.flyer.length) return {};
    return {
      only: { label: 'Flyer fonts', list: this.flyer, get: () => !!app.prefs.flyerFonts, set: v => app.setPref('flyerFonts', v) },
      face: (f, el) => {
        if (!this.flyer.includes(f)) return;
        const fam = this.family(f), st = fam && fam.styles[0] ? fam.styles[0].style : 'Regular';
        const now = this.css(f, st, name => { if (name) el.style.fontFamily = `"${name}"`; });
        if (now) el.style.fontFamily = `"${now}"`;
      },
    };
  },
  family(name) { return (this.list || []).find(f => f.family === name); },
  /** css font-family to use for family+style; starts loading it if needed */
  css(family, style, onReady) {
    const key = family + '|' + style;
    if (this.loaded.has(key)) return this.loaded.get(key);
    if (!this.pending.has(key)) this.pending.set(key, this.load(family, style).then(name => { this.loaded.set(key, name); this.pending.delete(key); for (const f of this.listeners) f(key); return name; }));
    if (onReady) this.pending.get(key).then(onReady);
    return null;
  },
  async load(family, style) {
    const tok = await bridge.fontFile(family, style).catch(() => null);
    if (tok) {
      try {
        const buf = await (await fetch(bridge.url('font', tok.token))).arrayBuffer();
        const name = 'stlvf-' + fnv(family + '|' + style);
        const ff = new FontFace(name, buf); await ff.load(); document.fonts.add(ff);
        return name;
      } catch (e) { console.warn('font load failed', family, style, e); }
    }
    return null; // fall back to the CSS family name
  },
};
const FALLBACK = ['Helvetica Neue', 'Helvetica', 'Arial', 'Avenir Next', 'Futura', 'Gill Sans', 'Georgia', 'Times New Roman', 'Didot', 'Baskerville', 'Menlo', 'Courier New', 'Impact', 'Arial Black', 'Verdana', 'Trebuchet MS', 'Optima', 'American Typewriter', 'Marker Felt', 'Chalkboard', 'Rockwell', 'Copperplate', 'Bodoni 72', 'Big Caslon', 'Palatino', 'Hoefler Text', 'SF Pro', 'DIN Condensed', 'Avenir Next Condensed'];

/** the style to use when switching to family: keep the current one if it has it, else its regular */
export function styleFor(family, current) {
  const f = fonts.family(family), st = f && (f.styles.find(s => s.style === current) || f.styles.find(s => /^(regular|roman|book|medium|normal)$/i.test(s.style)) || f.styles[0]);
  return st ? st.style : current;
}

export function styleTraits(family, style) {
  const f = fonts.family(family), s = f && f.styles.find(x => x.style === style);
  const w = s ? s.weight : /bold|black|heavy/i.test(style) ? 9 : /light|thin/i.test(style) ? 3 : 5;
  // NSFontManager weights 0..15 -> css 100..900
  const css = Math.min(900, Math.max(100, Math.round(((w - 1) / 13) * 8 + 1) * 100));
  return { weight: css, italic: s ? s.italic : /italic|oblique/i.test(style) };
}

/** css font string at px size for a text layer */
export function fontString(l, px, onReady) {
  const loaded = fonts.css(l.font, l.fontStyle, onReady);
  if (loaded) return `${px}px "${loaded}"`;
  const t = styleTraits(l.font, l.fontStyle);
  return `${t.italic ? 'italic ' : ''}${t.weight} ${px}px "${l.font}", -apple-system, Helvetica, Arial, sans-serif`;
}

/* ---------- layout ---------- */
const mctx = ctx(canvas(4, 4));
export function layoutText(l, doc) {
  const px = l.size * doc.ppi / 72;
  const lead = l.leading ? l.leading * doc.ppi / 72 : px * 1.2;
  const track = (l.tracking || 0) / 1000 * px;
  const font = fontString(l, px, () => { l.raster = null; l.touch(); doc.changed('pixels', { layer: l }); });
  mctx.font = font; mctx.letterSpacing = track + 'px';
  const text = l.caps ? l.text.toUpperCase() : l.text;
  let lines = [];
  for (const para of text.split('\n')) {
    if (!l.box) { lines.push(para); continue; }
    // wrap words to the box width
    const words = para.split(/(\s+)/); let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && mctx.measureText(test.trimEnd()).width > l.box.w) { lines.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
    }
    lines.push(line);
  }
  const m = mctx.measureText('Hg'), asc = m.fontBoundingBoxAscent || px * 0.8, desc = m.fontBoundingBoxDescent || px * 0.2;
  const out = lines.map((t, i) => {
    const w = mctx.measureText(t).width - (t.length ? track : 0);
    let x = 0;
    const W = l.box ? l.box.w : 0;
    if (l.align === 'center') x = l.box ? (W - w) / 2 : -w / 2;
    else if (l.align === 'right') x = l.box ? W - w : -w;
    const y = l.box ? asc + i * lead : i * lead;      // baseline, relative to the anchor
    return { text: t, x, y, w };
  });
  return { font, px, lead, track, asc, desc, lines: out };
}

/** local (pre-transform) bounds of the laid-out text */
export function textLocalBounds(lay, l) {
  let x0 = Infinity, x1 = -Infinity;
  for (const ln of lay.lines) { x0 = Math.min(x0, ln.x); x1 = Math.max(x1, ln.x + Math.max(ln.w, 1)); }
  if (l.box) { x0 = Math.min(x0, 0); x1 = Math.max(x1, l.box.w); }
  const first = lay.lines[0], last = lay.lines[lay.lines.length - 1];
  let y0 = first.y - lay.asc, y1 = last.y + lay.desc;
  if (l.box) { y0 = Math.min(y0, 0); y1 = Math.max(y1, l.box.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** rasterise into l.raster = {canvas, x, y, rev, bounds} (doc px). Warp is applied later by the compositor's mesh. */
export function rasterizeText(l, doc) {
  const lay = layoutText(l, doc), lb = textLocalBounds(lay, l);
  const pad = Math.ceil(lay.px * 0.3) + 4;
  const M = l.xform || [1, 0, 0, 1, 0, 0];        // a b c d e f : x' = a x + c y + e
  // bounds of the transformed local box
  const pts = [[lb.x - pad, lb.y - pad], [lb.x + lb.w + pad, lb.y - pad], [lb.x + lb.w + pad, lb.y + lb.h + pad], [lb.x - pad, lb.y + lb.h + pad]]
    .map(([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]);
  const minX = Math.floor(Math.min(...pts.map(p => p[0]))), minY = Math.floor(Math.min(...pts.map(p => p[1])));
  const maxX = Math.ceil(Math.max(...pts.map(p => p[0]))), maxY = Math.ceil(Math.max(...pts.map(p => p[1])));
  const W = Math.min(16384, maxX - minX), H = Math.min(16384, maxY - minY);
  const c = canvas(W, H), x = ctx(c);
  if (!l.editing) {
    x.setTransform(M[0], M[1], M[2], M[3], M[4] - minX, M[5] - minY);
    x.font = lay.font; x.letterSpacing = lay.track + 'px'; x.textBaseline = 'alphabetic';
    x.fillStyle = C.css(l.color, 1);
    for (const ln of lay.lines) x.fillText(ln.text, ln.x, ln.y);
    x.setTransform(1, 0, 0, 1, 0, 0);
  }
  const ax = Math.round(l.x), ay = Math.round(l.y);
  const rev = ((l.raster && l.raster.rev) || 0) + 1;
  l.raster = { canvas: c, x: ax + minX, y: ay + minY, rev, layout: lay, local: lb, bounds: { x: ax + minX + pad, y: ay + minY + pad, w: W - pad * 2, h: H - pad * 2 } };
  return l.raster;
}

/* ---------- text box style (a box behind each line, or one around the block) ---------- */
export const defaultTextBox = () => ({ enabled: true, fill: 'solid', color: { r: 242, g: 92, b: 45 }, gradient: null, shape: 'lines', padX: 18, padY: 12, invert: false, opacity: 1 });
/** doc-space polygons of a text layer's box: tight to the ink of each line (cap height to baseline
 *  plus the line's own descenders), padded by padX / padY % of the type size, through the layer's transform */
export function textBoxPolys(l, doc, tb) {
  if (!l.raster) rasterizeText(l, doc);
  const lay = l.raster.layout; if (!lay) return [];
  mctx.font = lay.font; mctx.letterSpacing = lay.track + 'px';
  const capH = mctx.measureText('H').actualBoundingBoxAscent || lay.px * 0.7;
  const px = (tb.padX ?? 18) / 100 * lay.px, py = (tb.padY ?? 12) / 100 * lay.px;
  const rects = [];
  for (const ln of lay.lines) {
    if (!ln.text.trim()) continue;
    const m = mctx.measureText(ln.text), x0 = ln.x - (m.actualBoundingBoxLeft || 0), x1 = ln.x + (m.actualBoundingBoxRight || ln.w);
    rects.push({ x0: x0 - px, x1: x1 + px, y0: ln.y - capH - py, y1: ln.y + Math.max(0, m.actualBoundingBoxDescent || 0) + py });
  }
  if (!rects.length) return [];
  const list = tb.shape === 'block' ? [rects.reduce((a, r) => ({ x0: Math.min(a.x0, r.x0), x1: Math.max(a.x1, r.x1), y0: Math.min(a.y0, r.y0), y1: Math.max(a.y1, r.y1) }))] : rects;
  const M = l.xform || [1, 0, 0, 1, 0, 0], ax = Math.round(l.x), ay = Math.round(l.y);
  return list.map(r => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]].map(([x, y]) => [M[0] * x + M[2] * y + M[4] + ax, M[1] * x + M[3] * y + M[5] + ay]));
}

/** rough doc-space quad of a text layer (for hit testing and transform boxes) */
export function textQuad(l, doc) {
  if (!l.raster) rasterizeText(l, doc);
  const lb = l.raster.local, M = l.xform || [1, 0, 0, 1, 0, 0], ax = Math.round(l.x), ay = Math.round(l.y);
  return [[lb.x, lb.y], [lb.x + lb.w, lb.y], [lb.x + lb.w, lb.y + lb.h], [lb.x, lb.y + lb.h]].map(([x, y]) => ({ x: M[0] * x + M[2] * y + M[4] + ax, y: M[1] * x + M[3] * y + M[5] + ay }));
}
