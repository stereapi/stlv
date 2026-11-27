// Export As: PNG, JPG, WebP (lossless), PSD (layers), PDF. Size / scale with
// a resample method, canvas / selection / each layer, trim, embedded ppi.

import { h, canvas, ctx, C, fmtBytes, round, canvasToBlob, debounce, sleep, getData } from '../util.js';
import { num, select, seg, chk, swatch, sliderRow, lbl, btn } from './widgets.js';
import { modal, RESAMPLE } from './dialogs.js';
import { resampleCanvas } from '../transform.js';
import { pngMeta, jpegMeta, blobBytes } from '../io/binary.js';
import { encodeWebPLossless } from '../io/webp.js';
import { writePSD } from '../io/psd.js';
import { writePDF } from '../io/pdf.js';
import { layerPixels } from '../commands.js';
import { bridge } from '../bridge.js';

const DEFAULTS = { fmt: 'png', transparent: true, srgb: true, quality: 85, matte: { r: 255, g: 255, b: 255 }, scale: 1, method: 'auto', what: 'canvas', trim: false, psdLayers: true, pdfImage: 'jpeg', bleed: 0, marks: false };
const EXT = { png: 'png', jpg: 'jpg', webp: 'webp', psd: 'psd', pdf: 'pdf' };

/** the flattened region to export (before scaling): canvas */
function region(app, o) {
  const d = app.doc, id = app.view.comp.readComposite(d);
  let c = canvas(d.width, d.height); ctx(c).putImageData(id, 0, 0);
  if (o.what === 'selection' && d.selection.active) {
    const b = d.selection.bounds(), t = canvas(b.w, b.h), x = ctx(t); x.drawImage(c, -b.x, -b.y);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(d.selection.maskCanvas(), -b.x, -b.y); c = t;
  }
  if (o.trim) c = trim(c);
  return c;
}
function trim(c) {
  const d = getData(c).data, w = c.width, hh = c.height; let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = y; }
  if (x1 < 0) return c;
  const t = canvas(x1 - x0 + 1, y1 - y0 + 1); ctx(t).drawImage(c, -x0, -y0); return t;
}
function scaled(app, c, o) {
  if (o.scale === 1) return c;
  return resampleCanvas(app.view.comp, c, Math.max(1, Math.round(c.width * o.scale)), Math.max(1, Math.round(c.height * o.scale)), o.method);
}
function flatten(c, matte) { const t = canvas(c.width, c.height), x = ctx(t); x.fillStyle = C.hex(matte); x.fillRect(0, 0, t.width, t.height); x.drawImage(c, 0, 0); return t; }

/** encode a single image -> Uint8Array */
export async function encode(app, c, o) {
  const ppi = app.doc.ppi * o.scale;
  if (o.fmt === 'png') return pngMeta(await blobBytes(await canvasToBlob(o.transparent ? c : flatten(c, o.matte), 'image/png')), ppi, o.srgb);
  if (o.fmt === 'jpg') return jpegMeta(await blobBytes(await canvasToBlob(flatten(c, o.matte), 'image/jpeg', o.quality / 100)), ppi);
  if (o.fmt === 'webp') return encodeWebPLossless(getData(o.transparent ? c : flatten(c, o.matte)));
  if (o.fmt === 'pdf') {
    const id = getData(c), jpeg = o.pdfImage === 'jpeg' ? await blobBytes(await canvasToBlob(flatten(c, { r: 255, g: 255, b: 255 }), 'image/jpeg', o.quality / 100)) : null;
    return writePDF(id, { ppi, jpeg, bleedMM: o.bleed, marks: o.marks });
  }
  throw new Error('unknown format');
}
export async function encodePSD(app, o) {
  const d = app.doc, merged = app.view.comp.readComposite(d);
  if (!o.psdLayers) {
    const { Doc, PixelLayer } = await import('../doc.js');
    const flat = new Doc({ name: d.name, width: d.width, height: d.height, ppi: d.ppi, background: 'none' });
    const L = new PixelLayer('Background', d.width, d.height); ctx(L.canvas).putImageData(merged, 0, 0); flat.insert(L, flat.root);
    return writePSD(flat, l => ({ canvas: l.canvas, x: 0, y: 0 }), merged);
  }
  const pixelsOf = l => {
    if (l.type === 'pixel' && !l.style.gradOverlay && !l.filters.length) return { canvas: l.canvas, x: l.x, y: l.y };
    return layerPixels(app, l);
  };
  return writePSD(d, pixelsOf, merged);
}

export function exportDialog(app, { quick = false } = {}) {
  const d = app.doc;
  const o = { ...DEFAULTS, ...(app.prefs.exportOpts || {}) };
  if (o.what === 'selection' && !d.selection.active) o.what = 'canvas';
  if (quick) return doExport(app, { ...o, fmt: 'png', what: 'canvas' });
  const prev = h('div', { style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: '#0c0d0f', position: 'relative' } });
  const img = h('img', { style: { maxWidth: '86%', maxHeight: '80%', background: 'var(--checker)', backgroundSize: '12px 12px', boxShadow: '0 10px 40px rgba(0,0,0,.6)' } });
  const meta = h('div.lbl', { style: { position: 'absolute', left: '12px', bottom: '10px' } });
  prev.append(img, meta);
  const side = h('div', { style: { padding: '14px 18px', overflow: 'auto' } });
  const save = () => { app.prefs.exportOpts = { ...o }; app.savePrefs(); };
  const refresh = debounce(async () => {
    try {
      const c0 = region(app, o), c = o.fmt === 'psd' ? c0 : scaled(app, c0, o);
      const pv = canvas(Math.min(560, c.width), Math.min(560, c.height)); { const k = Math.min(560 / c.width, 560 / c.height, 1); pv.width = Math.max(1, Math.round(c.width * k)); pv.height = Math.max(1, Math.round(c.height * k)); const x = ctx(pv); x.imageSmoothingQuality = 'high'; x.drawImage(o.fmt === 'png' && o.transparent || o.fmt === 'webp' && o.transparent ? c : flatten(c, o.fmt === 'pdf' ? { r: 255, g: 255, b: 255 } : o.matte), 0, 0, pv.width, pv.height); }
      img.src = pv.toDataURL();
      meta.textContent = `${c.width} × ${c.height} px · estimating…`;
      const t0 = performance.now();
      let bytes;
      if (o.what === 'layers') bytes = null;
      else if (o.fmt === 'psd') bytes = await encodePSD(app, o);
      else if (o.fmt === 'webp' && c.width * c.height > 4e6) bytes = null;
      else bytes = await encode(app, c, o);
      meta.textContent = `${c.width} × ${c.height} px · ${bytes ? '≈ ' + fmtBytes(bytes.length) : o.what === 'layers' ? 'one file per layer' : 'size shown after export'} · ${round(d.ppi * o.scale, 1)} ppi`;
      void t0;
    } catch (e) { meta.textContent = String(e.message || e); }
  }, 250);
  const draw = () => {
    side.innerHTML = '';
    const sec = (t, ...k) => side.append(h('div.sect', t), ...k);
    sec('Format', seg([['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP'], ['psd', 'PSD'], ['pdf', 'PDF']], o.fmt, v => { o.fmt = v; draw(); refresh(); save(); }));
    const opts = h('div', { style: { marginTop: '10px' } }); side.append(opts);
    const add = (...k) => opts.append(...k.filter(Boolean));
    const set = (k, v, redraw) => { o[k] = v; save(); if (redraw) draw(); refresh(); };
    if (o.fmt === 'png') add(h('div.row', chk('Transparency', o.transparent, v => set('transparent', v, true))), o.transparent ? null : h('div.row', lbl('Matte'), swatch(o.matte, c => set('matte', c))), h('div.row', chk('Mark as sRGB', o.srgb, v => set('srgb', v))));
    if (o.fmt === 'jpg') add(sliderRow('Quality', { value: o.quality, min: 1, max: 100, onChange: (v, f) => f && set('quality', v) }), h('div.row', lbl('Matte'), swatch(o.matte, c => set('matte', c))));
    if (o.fmt === 'webp') add(h('div.row', chk('Transparency', o.transparent, v => set('transparent', v, true))), o.transparent ? null : h('div.row', lbl('Matte'), swatch(o.matte, c => set('matte', c))), h('div.lbl', { style: { fontSize: '11px' } }, 'Lossless. (Neither WebKit nor macOS can write lossy WebP, so stlv encodes lossless itself.)'));
    if (o.fmt === 'psd') add(h('div.row', chk('Keep layers', o.psdLayers, v => set('psdLayers', v))), h('div.lbl', { style: { fontSize: '11px', lineHeight: 1.5 } }, 'Blend modes, opacity, fill, clipping, masks, groups and guides carry over. Text, fill layers, styles and live filters are written as pixels. Adjustment layers appear only in the merged image.'));
    if (o.fmt === 'pdf') add(h('div.row', lbl('Image'), seg([['jpeg', 'JPEG'], ['flate', 'Lossless']], o.pdfImage, v => set('pdfImage', v, true))), o.pdfImage === 'jpeg' ? sliderRow('Quality', { value: o.quality, min: 1, max: 100, onChange: (v, f) => f && set('quality', v) }) : null,
      h('div.row', lbl('Bleed'), num({ value: o.bleed, min: 0, max: 20, unit: ' mm', width: 64, onChange: (v, f) => f && set('bleed', v) }), chk('Crop marks', o.marks, v => set('marks', v))),
      h('div.lbl', { style: { fontSize: '11px' } }, `One page, ${round(d.width / d.ppi, 2)} × ${round(d.height / d.ppi, 2)} in. Bleed stretches the image edge to cover it.`));
    if (o.fmt !== 'psd') {
      const W = num({ value: Math.round(d.width * o.scale), min: 1, max: 16384, unit: ' px', width: 86, scrub: false, onChange: (v, f) => { if (f) { o.scale = v / d.width; save(); draw(); refresh(); } } });
      const H = num({ value: Math.round(d.height * o.scale), min: 1, max: 16384, unit: ' px', width: 86, scrub: false, onChange: (v, f) => { if (f) { o.scale = v / d.height; save(); draw(); refresh(); } } });
      sec('Size', h('div.row', seg([[0.25, '¼×'], [0.5, '½×'], [1, '1×'], [2, '2×'], [3, '3×']], o.scale, v => { o.scale = +v; save(); draw(); refresh(); })),
        h('div.row', lbl('W'), W, lbl('H'), H),
        h('div.row', lbl('Resample'), select(RESAMPLE.map(r => [r[0], r[1]]), o.method, v => set('method', v))),
        h('div.lbl', { style: { fontSize: '11px' } }, `Resolution written into the file: ${round(d.ppi * o.scale, 1)} ppi (same physical size).`));
      sec('What to export', seg([['canvas', 'Canvas'], ['selection', 'Selection'], ['layers', 'Each layer']], o.what, v => { if (v === 'selection' && !d.selection.active) { app.ui.toast('There is no selection'); draw(); return; } set('what', v, true); }),
        h('div.row', { style: { marginTop: '8px' } }, chk('Trim transparent pixels', o.trim, v => set('trim', v))));
    }
  };
  draw(); refresh();
  const body = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 330px', margin: '-16px -18px', height: '560px' } }, prev, side);
  modal('Export as', body, [{ label: 'Cancel', ghost: true }, { label: 'Export…', primary: true, run: () => { doExport(app, o); } }], { width: 980, note: '⇧⌘\' quick-exports a PNG' });
}

export async function doExport(app, o) {
  const d = app.doc, ext = EXT[o.fmt];
  try {
    if (o.what === 'layers' && o.fmt !== 'psd') {
      const target = await bridge.saveDialog({ name: `${d.name}.${ext}`, types: [ext] }); if (!target) return;
      const stem = target.name.replace(/\.[^.]+$/, ''), layers = d.all().filter(l => !l.isGroup && l.type !== 'adjust' && l.visible);
      let n = 0;
      await app.ui.busy('Exporting layers…', async (p) => {
        for (const l of layers) {
          const px = layerPixels(app, l); if (!px) continue;
          let c = canvas(d.width, d.height); ctx(c).drawImage(px.canvas, px.x, px.y);
          if (o.trim) c = trim(c);
          c = scaled(app, c, o);
          const bytes = await encode(app, c, o);
          const name = `${stem}-${l.name.replace(/[\\/:*?"<>|]+/g, '_')}.${ext}`;
          const t = target.web ? { web: true, name } : await bridge.siblingTarget(target, name);
          if (t) { await bridge.write(t, new Blob([bytes])); n++; }
          p(++n / layers.length / 2);
        }
      });
      app.ui.toast(`Exported ${layers.length} layers`);
      return;
    }
    const target = await bridge.saveDialog({ name: `${d.name}.${ext}`, types: [ext] }); if (!target) return;
    const bytes = await app.ui.busy('Exporting…', async () => {
      await sleep(10);
      if (o.fmt === 'psd') return encodePSD(app, o);
      return encode(app, scaled(app, region(app, o), o), o);
    });
    await bridge.write(target, new Blob([bytes]));
    app.ui.toast(`Exported ${target.name} (${fmtBytes(bytes.length)})`);
  } catch (e) { console.error(e); app.ui.alert('Export failed', String(e.message || e)); }
}
