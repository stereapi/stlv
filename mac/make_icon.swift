// Renders the stlv app icon (TSR-1 mono skin: mauve -> violet, bone wordmark)
// into AppIcon.iconset, then `iconutil -c icns` makes AppIcon.icns.
import AppKit

func render(_ size: Int) -> Data {
  let s = CGFloat(size)
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let inset = s * 0.1, r = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
  let path = NSBezierPath(roundedRect: r, xRadius: r.width * 0.225, yRadius: r.width * 0.225)
  // dark body
  NSColor(red: 0.04, green: 0.04, blue: 0.045, alpha: 1).setFill(); path.fill()
  // glow gradient band
  NSGraphicsContext.current!.saveGraphicsState(); path.addClip()
  let g = NSGradient(colors: [NSColor(red: 0.784, green: 0.627, blue: 0.706, alpha: 1), NSColor(red: 0.392, green: 0.314, blue: 0.667, alpha: 1)])!
  g.draw(in: NSRect(x: r.minX, y: r.minY, width: r.width, height: r.height * 0.42), angle: 0)
  NSGraphicsContext.current!.restoreGraphicsState()
  // wordmark
  let font = NSFont(name: "DINCondensed-Bold", size: s * 0.3) ?? NSFont.systemFont(ofSize: s * 0.26, weight: .heavy)
  let para = NSMutableParagraphStyle(); para.alignment = .center
  let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(red: 0.953, green: 0.937, blue: 0.902, alpha: 1), .kern: s * 0.025, .paragraphStyle: para]
  let str = NSAttributedString(string: "STLV", attributes: attrs)
  let h = str.size().height
  str.draw(in: NSRect(x: r.minX, y: r.minY + r.height * 0.5 - h * 0.18, width: r.width, height: h))
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128), ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
  try! render(px).write(to: dir.appendingPathComponent("icon_\(name).png"))
}
