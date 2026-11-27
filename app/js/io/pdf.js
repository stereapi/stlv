// PDF export: one page at the document's physical size (pixels / ppi),
// the image as JPEG (DCTDecode) or lossless (Flate), transparency as a soft
// mask, optional bleed and crop marks.

import { Writer, deflate } from './binary.js';

/** id: ImageData (straight alpha). opts {ppi, jpeg: Uint8Array|null, bleedMM, marks} */
export async function writePDF(id, opts) {
  const W = id.width, H = id.height, ppi = opts.ppi || 72;
  const wPt = W / ppi * 72, hPt = H / ppi * 72;
  const bleed = (opts.bleedMM || 0) / 25.4 * 72, marks = opts.marks ? 18 : 0, pad = bleed + marks;
  const pw = wPt + pad * 2, ph = hPt + pad * 2;
  const n = W * H, d = id.data;
  let hasAlpha = false; for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { hasAlpha = true; break; }
  let imgStream, filter;
  if (opts.jpeg) { imgStream = opts.jpeg; filter = '/DCTDecode'; }
  else { const rgb = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2]; } imgStream = await deflate(rgb); filter = '/FlateDecode'; }
  let smask = null;
  if (hasAlpha) { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3]; smask = await deflate(a); }
  // the image fills the trim box; with bleed, the image is extended by its own edge (scaled to cover)
  let content = `q ${(wPt + bleed * 2).toFixed(3)} 0 0 ${(hPt + bleed * 2).toFixed(3)} ${(marks).toFixed(3)} ${(marks).toFixed(3)} cm /Im0 Do Q\n`;
  if (marks) {
    const L = 12, off = 3, x0 = pad, y0 = pad, x1 = pad + wPt, y1 = pad + hPt;
    content += '0 G 0.25 w\n';
    for (const [x, y, dx, dy] of [[x0, y0, -1, -1], [x1, y0, 1, -1], [x0, y1, -1, 1], [x1, y1, 1, 1]]) {
      content += `${x.toFixed(2)} ${(y + dy * (bleed + off)).toFixed(2)} m ${x.toFixed(2)} ${(y + dy * (bleed + off + L)).toFixed(2)} l S\n`;
      content += `${(x + dx * (bleed + off)).toFixed(2)} ${y.toFixed(2)} m ${(x + dx * (bleed + off + L)).toFixed(2)} ${y.toFixed(2)} l S\n`;
    }
  }
  const w = new Writer(imgStream.length + 4096), offs = [];
  const obj = (num, body, stream) => { offs[num] = w.p; w.ascii(`${num} 0 obj\n${body}`); if (stream) { w.ascii('\nstream\n'); w.bytes(stream); w.ascii('\nendstream'); } w.ascii('\nendobj\n'); };
  w.ascii('%PDF-1.4\n'); w.bytes(new Uint8Array([37, 226, 227, 207, 211, 10]));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const trim = `[${pad.toFixed(3)} ${pad.toFixed(3)} ${(pad + wPt).toFixed(3)} ${(pad + hPt).toFixed(3)}]`, bleedBox = `[${marks.toFixed(3)} ${marks.toFixed(3)} ${(pw - marks).toFixed(3)} ${(ph - marks).toFixed(3)}]`;
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(3)} ${ph.toFixed(3)}] /TrimBox ${trim} /BleedBox ${bleedBox} /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`);
  const cs = new TextEncoder().encode(content);
  obj(4, `<< /Length ${cs.length} >>`, cs);
  obj(5, `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter}${smask ? ' /SMask 6 0 R' : ''} /Length ${imgStream.length} >>`, imgStream);
  if (smask) obj(6, `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${smask.length} >>`, smask);
  const count = smask ? 7 : 6, xref = w.p;
  w.ascii(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) w.ascii(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
  w.ascii(`trailer\n<< /Size ${count} /Root 1 0 R /Info << /Producer (stlv) >> >>\nstartxref\n${xref}\n%%EOF\n`);
  return w.out();
}
