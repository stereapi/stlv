// Binary helpers: CRC32, deflate via the built-in CompressionStream, a small
// zip reader/writer, and PNG / JPEG metadata patching (ppi, sRGB).

const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf, crc = 0) { crc = ~crc >>> 0; for (let i = 0; i < buf.length; i++) crc = CRC_T[(crc ^ buf[i]) & 255] ^ (crc >>> 8); return (~crc) >>> 0; }

async function pump(stream, data) {
  const s = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export const deflateRaw = d => pump(new CompressionStream('deflate-raw'), d);
export const inflateRaw = d => pump(new DecompressionStream('deflate-raw'), d);
export const deflate = d => pump(new CompressionStream('deflate'), d);   // zlib (PDF, PSD zip)
export const inflate = d => pump(new DecompressionStream('deflate'), d);

export class Writer {
  constructor(n = 1 << 16) { this.b = new Uint8Array(n); this.p = 0; this.dv = new DataView(this.b.buffer); }
  need(n) { if (this.p + n <= this.b.length) return; let m = this.b.length * 2; while (m < this.p + n) m *= 2; const nb = new Uint8Array(m); nb.set(this.b.subarray(0, this.p)); this.b = nb; this.dv = new DataView(nb.buffer); }
  u8(v) { this.need(1); this.b[this.p++] = v; }
  u16(v, le) { this.need(2); this.dv.setUint16(this.p, v, le); this.p += 2; }
  i16(v, le) { this.need(2); this.dv.setInt16(this.p, v, le); this.p += 2; }
  u32(v, le) { this.need(4); this.dv.setUint32(this.p, v >>> 0, le); this.p += 4; }
  i32(v, le) { this.need(4); this.dv.setInt32(this.p, v, le); this.p += 4; }
  f64(v, le) { this.need(8); this.dv.setFloat64(this.p, v, le); this.p += 8; }
  bytes(a) { this.need(a.length); this.b.set(a, this.p); this.p += a.length; }
  ascii(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 255); }
  out() { return this.b.slice(0, this.p); }
}
export class Reader {
  constructor(buf) { this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); this.dv = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength); this.p = 0; }
  u8() { return this.b[this.p++]; }
  i8() { const v = this.dv.getInt8(this.p); this.p += 1; return v; }
  u16(le) { const v = this.dv.getUint16(this.p, le); this.p += 2; return v; }
  i16(le) { const v = this.dv.getInt16(this.p, le); this.p += 2; return v; }
  u32(le) { const v = this.dv.getUint32(this.p, le); this.p += 4; return v; }
  i32(le) { const v = this.dv.getInt32(this.p, le); this.p += 4; return v; }
  f64(le) { const v = this.dv.getFloat64(this.p, le); this.p += 8; return v; }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  ascii(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p++]); return s; }
  skip(n) { this.p += n; }
  get left() { return this.b.length - this.p; }
}

/* ---------- zip (store + deflate) ---------- */
export async function zip(files) {   // files: [{name, data: Uint8Array, compress}]
  const w = new Writer(1 << 20), central = [];
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data);
    const body = f.compress ? await deflateRaw(f.data) : f.data, method = f.compress ? 8 : 0;
    const off = w.p;
    w.u32(0x04034b50, true); w.u16(20, true); w.u16(0x0800, true); w.u16(method, true); w.u16(0, true); w.u16(0x21, true);
    w.u32(crc, true); w.u32(body.length, true); w.u32(f.data.length, true); w.u16(name.length, true); w.u16(0, true); w.bytes(name); w.bytes(body);
    central.push({ name, crc, csize: body.length, size: f.data.length, method, off });
  }
  const cd = w.p;
  for (const c of central) {
    w.u32(0x02014b50, true); w.u16(20, true); w.u16(20, true); w.u16(0x0800, true); w.u16(c.method, true); w.u16(0, true); w.u16(0x21, true);
    w.u32(c.crc, true); w.u32(c.csize, true); w.u32(c.size, true); w.u16(c.name.length, true); w.u16(0, true); w.u16(0, true); w.u16(0, true); w.u16(0, true); w.u32(0, true); w.u32(c.off, true); w.bytes(c.name);
  }
  const cdSize = w.p - cd;
  w.u32(0x06054b50, true); w.u16(0, true); w.u16(0, true); w.u16(central.length, true); w.u16(central.length, true); w.u32(cdSize, true); w.u32(cd, true); w.u16(0, true);
  return w.out();
}
export async function unzip(buf) {
  const r = new Reader(buf), b = r.b, out = {};
  let e = b.length - 22; while (e >= 0 && r.dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a zip file');
  const n = r.dv.getUint16(e + 10, true); let p = r.dv.getUint32(e + 16, true);
  const dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const method = r.dv.getUint16(p + 10, true), csize = r.dv.getUint32(p + 20, true), nl = r.dv.getUint16(p + 28, true), xl = r.dv.getUint16(p + 30, true), cl = r.dv.getUint16(p + 32, true), off = r.dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
    const lnl = r.dv.getUint16(off + 26, true), lxl = r.dv.getUint16(off + 28, true), data = b.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    out[name] = method === 8 ? await inflateRaw(data) : data.slice();
    p += 46 + nl + xl + cl;
  }
  return out;
}

/* ---------- PNG / JPEG metadata ---------- */
function pngChunk(type, data) {
  const w = new Writer(data.length + 12); w.u32(data.length); const t = new TextEncoder().encode(type); w.bytes(t); w.bytes(data);
  const crc = crc32(w.b.subarray(4, 8 + data.length)); w.u32(crc); return w.out();
}
/** insert pHYs (ppi) and sRGB chunks after IHDR */
export function pngMeta(png, ppi, srgb = true) {
  const b = png instanceof Uint8Array ? png : new Uint8Array(png);
  const ihdrEnd = 8 + 8 + 13 + 4;
  const parts = [b.subarray(0, ihdrEnd)];
  if (srgb) parts.push(pngChunk('sRGB', new Uint8Array([0])));
  if (ppi) { const ppm = Math.round(ppi / 0.0254), d = new Writer(9); d.u32(ppm); d.u32(ppm); d.u8(1); parts.push(pngChunk('pHYs', d.out())); }
  // drop any existing pHYs / sRGB / iCCP after IHDR
  let p = ihdrEnd; const rest = [];
  while (p < b.length) { const len = new DataView(b.buffer, b.byteOffset + p).getUint32(0), type = String.fromCharCode(...b.subarray(p + 4, p + 8)); const end = p + 12 + len; if (!(type === 'pHYs' || (srgb && (type === 'sRGB' || type === 'iCCP' || type === 'gAMA' || type === 'cHRM')))) rest.push(b.subarray(p, end)); p = end; }
  return concat([...parts, ...rest]);
}
/** ppi from a PNG's pHYs, or null */
export function pngPPI(buf) {
  const b = new Uint8Array(buf); if (b[0] !== 0x89 || b[1] !== 0x50) return null;
  let p = 8; const dv = new DataView(b.buffer, b.byteOffset);
  while (p + 8 < b.length) { const len = dv.getUint32(p), type = String.fromCharCode(...b.subarray(p + 4, p + 8)); if (type === 'pHYs' && b[p + 16] === 1) return Math.round(dv.getUint32(p + 8) * 0.0254 * 100) / 100; if (type === 'IDAT') break; p += 12 + len; }
  return null;
}
/** set the JFIF density of a JPEG (inserting APP0 if needed) */
export function jpegMeta(jpg, ppi) {
  const b = new Uint8Array(jpg);
  const d = Math.max(1, Math.min(65535, Math.round(ppi)));
  if (b[2] === 0xFF && b[3] === 0xE0 && String.fromCharCode(...b.subarray(6, 11)) === 'JFIF\0') {
    const o = b.slice(); o[13] = 1; o[14] = d >> 8; o[15] = d & 255; o[16] = d >> 8; o[17] = d & 255; return o;
  }
  const app0 = new Uint8Array([0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
  return concat([b.subarray(0, 2), app0, b.subarray(2)]);
}
export function jpegPPI(buf) {
  const b = new Uint8Array(buf); if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
  if (b[2] === 0xFF && b[3] === 0xE0 && String.fromCharCode(...b.subarray(6, 10)) === 'JFIF') { const u = b[13], x = (b[14] << 8) | b[15]; if (u === 1 && x > 1) return x; if (u === 2 && x > 1) return Math.round(x * 2.54); }
  return null;
}
export function concat(parts) { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }
export const blobBytes = async b => new Uint8Array(await b.arrayBuffer());
