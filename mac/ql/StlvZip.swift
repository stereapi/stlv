// Reads composite.png out of a .stlv (a zip) for the Quick Look extensions.
// stlv stores it uncompressed; a deflated entry is inflated with Compression.
import Foundation
import Compression

enum StlvZip {
  struct Bad: Error {}

  static func composite(_ url: URL) throws -> Data {
    let d = try Data(contentsOf: url, options: .alwaysMapped)
    return try entry("composite.png", in: d)
  }

  static func entry(_ want: String, in d: Data) throws -> Data {
    let b = [UInt8](d)
    func u16(_ p: Int) -> Int { Int(b[p]) | Int(b[p + 1]) << 8 }
    func u32(_ p: Int) -> Int { u16(p) | u16(p + 2) << 16 }
    // end of central directory
    var e = b.count - 22
    while e >= 0 && u32(e) != 0x06054b50 { e -= 1 }
    guard e >= 0 else { throw Bad() }
    var p = u32(e + 16)
    for _ in 0..<u16(e + 10) {
      guard p + 46 <= b.count, u32(p) == 0x02014b50 else { throw Bad() }
      let method = u16(p + 10), csize = u32(p + 20), size = u32(p + 24)
      let nl = u16(p + 28), xl = u16(p + 30), cl = u16(p + 32), off = u32(p + 42)
      let name = String(decoding: b[(p + 46)..<(p + 46 + nl)], as: UTF8.self)
      if name == want {
        let start = off + 30 + u16(off + 26) + u16(off + 28)
        guard start + csize <= b.count else { throw Bad() }
        let body = Data(b[start..<(start + csize)])
        if method == 0 { return body }
        guard method == 8 else { throw Bad() }
        var out = Data(count: size)
        let n = out.withUnsafeMutableBytes { o in
          body.withUnsafeBytes { i in
            compression_decode_buffer(o.bindMemory(to: UInt8.self).baseAddress!, size,
                                      i.bindMemory(to: UInt8.self).baseAddress!, csize, nil, COMPRESSION_ZLIB)
          }
        }
        guard n == size else { throw Bad() }
        return out
      }
      p += 46 + nl + xl + cl
    }
    throw Bad()
  }
}
