// Finder icons for .stlv: the saved composite, like a PSD's thumbnail.
import AppKit
import QuickLookThumbnailing

@objc(ThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
  override func provideThumbnail(for request: QLFileThumbnailRequest, _ handler: @escaping (QLThumbnailReply?, Error?) -> Void) {
    do {
      guard let img = NSImage(data: try StlvZip.composite(request.fileURL)), img.size.width > 0, img.size.height > 0 else {
        handler(nil, StlvZip.Bad()); return
      }
      let m = request.maximumSize
      let k = min(m.width / img.size.width, m.height / img.size.height)
      let size = CGSize(width: max(1, (img.size.width * k).rounded()), height: max(1, (img.size.height * k).rounded()))
      handler(QLThumbnailReply(contextSize: size, currentContextDrawing: {
        NSGraphicsContext.current?.imageInterpolation = .high
        img.draw(in: CGRect(origin: .zero, size: size))
        return true
      }), nil)
    } catch { handler(nil, error) }
  }
}
