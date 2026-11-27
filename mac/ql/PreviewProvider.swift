// Spacebar Quick Look for .stlv: the saved composite as a PNG.
import AppKit
import QuickLookUI
import UniformTypeIdentifiers

@objc(PreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
  func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
    let png = try StlvZip.composite(request.fileURL)
    guard let rep = NSBitmapImageRep(data: png) else { throw StlvZip.Bad() }
    let size = CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    return QLPreviewReply(dataOfContentType: .png, contentSize: size) { _ in png }
  }
}
