// stlv: the native Mac shell.
//
// A WKWebView hosts the editor (stlv/app, plain JS). This file gives it what a
// browser can't: native menus, open/save panels with real paths, the system
// font files, the pasteboard, a data folder, and the quit/close handshake.
//
// The page talks to Swift two ways:
//   messages  window.webkit.messageHandlers.stlv.postMessage({id, cmd, ...})
//             replies arrive as stlvBridge.reply(id, value)
//   the stlv:// scheme, for bytes (no base64):
//     GET  stlv://app/<path>        the editor's files
//     GET  stlv://file/<token>      a file the user opened
//     POST stlv://save/<token>      write the body to a path the user picked
//     GET|POST stlv://data/<name>   ~/Library/Application Support/stlv/<name>
//     GET|POST stlv://clip          the pasteboard as PNG
//     GET  stlv://font/<token>      a font file, for FontFace

import Cocoa
import WebKit
import UniformTypeIdentifiers

let appSupport: URL = {
  // STLV_DATA=<folder> gives a test run its own data (autosave, prefs), so it never restores or clears the real session's
  let env = ProcessInfo.processInfo.environment["STLV_DATA"]
  let u = env.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("stlv", isDirectory: true)
  try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
  return u
}()

/// Where the editor's files come from: --dev <dir> serves the source folder
/// live (no rebuild while working on the JS); otherwise the bundled copy.
let appDir: URL = {
  let a = CommandLine.arguments
  if let i = a.firstIndex(of: "--dev"), i + 1 < a.count { return URL(fileURLWithPath: a[i + 1], isDirectory: true) }
  return Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
}()
let testMode = CommandLine.arguments.contains("--test")

/// Paths the page may read or write, by opaque token. Only paths the user
/// picked in a panel (or opened from Finder / the recent list) get one.
final class Tokens {
  private var map: [String: URL] = [:]
  func issue(_ u: URL) -> String {
    if let t = map.first(where: { $0.value == u })?.key { return t }
    let t = UUID().uuidString.lowercased(); map[t] = u; return t
  }
  func url(_ t: String) -> URL? { map[t] }
}
let tokens = Tokens()

func mime(_ ext: String) -> String {
  switch ext.lowercased() {
  case "html": return "text/html; charset=utf-8"
  case "js", "mjs": return "text/javascript; charset=utf-8"
  case "css": return "text/css; charset=utf-8"
  case "json": return "application/json"
  case "png": return "image/png"
  case "jpg", "jpeg": return "image/jpeg"
  case "webp": return "image/webp"
  case "svg": return "image/svg+xml"
  case "woff2": return "font/woff2"
  case "ttf": return "font/ttf"
  case "otf": return "font/otf"
  default: return "application/octet-stream"
  }
}

final class Scheme: NSObject, WKURLSchemeHandler {
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, let host = url.host else { return fail(task, 400) }
    let path = url.path.removingPercentEncoding ?? url.path
    let post = task.request.httpMethod == "POST"
    if task.request.httpMethod == "OPTIONS" { return ok(task, Data(), "text/plain") }   // CORS preflight
    var body = task.request.httpBody ?? Data()
    if body.isEmpty, let stream = task.request.httpBodyStream {
      // bodies can arrive as a stream (e.g. Blobs): read it all
      stream.open(); defer { stream.close() }
      let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 1 << 16); defer { buf.deallocate() }
      while stream.hasBytesAvailable { let n = stream.read(buf, maxLength: 1 << 16); if n <= 0 { break }; body.append(buf, count: n) }
    }
    switch host {
    case "app":
      let rel = path.hasPrefix("/") ? String(path.dropFirst()) : path
      let f = appDir.appendingPathComponent(rel.isEmpty ? "index.html" : rel).standardizedFileURL
      guard f.path.hasPrefix(appDir.standardizedFileURL.path), let d = try? Data(contentsOf: f) else { return fail(task, 404) }
      ok(task, d, mime(f.pathExtension))
    case "file", "font":
      guard let u = tokens.url(String(path.dropFirst())), let d = try? Data(contentsOf: u) else { return fail(task, 404) }
      ok(task, d, mime(u.pathExtension))
    case "save":
      guard post, let u = tokens.url(String(path.dropFirst())) else { return fail(task, 400) }
      do { try body.write(to: u, options: .atomic); ok(task, Data("{\"ok\":true}".utf8), "application/json") }
      catch { ok(task, Data("{\"ok\":false,\"error\":\(jsonString(error.localizedDescription))}".utf8), "application/json") }
    case "data":
      let name = String(path.dropFirst())
      guard !name.isEmpty, !name.contains("..") else { return fail(task, 400) }
      let f = appSupport.appendingPathComponent(name)
      if post {
        try? FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        if body.isEmpty { try? FileManager.default.removeItem(at: f) } else { try? body.write(to: f, options: .atomic) }
        ok(task, Data("{\"ok\":true}".utf8), "application/json")
      } else if let d = try? Data(contentsOf: f) { ok(task, d, mime(f.pathExtension)) } else { fail(task, 404) }
    case "clip":
      let pb = NSPasteboard.general
      if post && path == "/text" {
        pb.clearContents(); pb.setString(String(decoding: body, as: UTF8.self), forType: .string)
        ok(task, Data("{\"ok\":true}".utf8), "application/json")
      } else if post {
        pb.clearContents(); pb.setData(body, forType: .png)
        ok(task, Data("{\"ok\":true}".utf8), "application/json")
      } else if let d = pb.data(forType: .png) { ok(task, d, "image/png") }
      else if let t = pb.data(forType: .tiff), let r = NSBitmapImageRep(data: t), let p = r.representation(using: .png, properties: [:]) { ok(task, p, "image/png") }
      else { fail(task, 404) }
    default: fail(task, 404)
    }
  }
  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
  private func ok(_ t: WKURLSchemeTask, _ d: Data, _ type: String) {
    t.didReceive(HTTPURLResponse(url: t.request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": type, "Content-Length": "\(d.count)", "Cache-Control": "no-store",
                                                // stlv://app, stlv://file, stlv://save... are different hosts: let the page read them
                                                "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*"])!)
    t.didReceive(d); t.didFinish()
  }
  private func fail(_ t: WKURLSchemeTask, _ code: Int) {
    t.didReceive(HTTPURLResponse(url: t.request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"])!)
    t.didReceive(Data()); t.didFinish()
  }
}

func jsonString(_ s: String) -> String {
  let d = try! JSONSerialization.data(withJSONObject: [s]); let a = String(data: d, encoding: .utf8)!
  return String(a.dropFirst().dropLast())
}
func json(_ v: Any) -> String {
  guard JSONSerialization.isValidJSONObject(["v": v]), let d = try? JSONSerialization.data(withJSONObject: ["v": v]) else { return "null" }
  let s = String(data: d, encoding: .utf8)!   // {"v":...}
  return String(s.dropFirst(5).dropLast())
}

final class Shell: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSMenuItemValidation {
  var window: NSWindow!
  var web: WKWebView!
  let scheme = Scheme()
  var pageReady = false
  var pendingOpen: [URL] = []
  var allowQuit = false
  var menuItems: [String: NSMenuItem] = [:]
  var typing = false   // a text field in the page has focus (the page says so)

  func applicationDidFinishLaunching(_ n: Notification) {
    let cfg = WKWebViewConfiguration()
    cfg.setURLSchemeHandler(scheme, forURLScheme: "stlv")
    cfg.userContentController.add(self, name: "stlv")
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
    cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
    let boot = "window.stlvNative = { version: 1, test: \(testMode) };"
    cfg.userContentController.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))

    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: cfg)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsMagnification = false
    web.allowsBackForwardNavigationGestures = false
    if #available(macOS 13.3, *) { web.isInspectable = true }
    web.setValue(false, forKey: "drawsBackground")

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "stlv"
    window.minSize = NSSize(width: 1024, height: 680)
    window.backgroundColor = NSColor(red: 0.024, green: 0.024, blue: 0.024, alpha: 1)
    window.contentView = web
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.tabbingMode = .disallowed
    if !window.setFrameUsingName("stlv.main") { window.center() }
    window.setFrameAutosaveName("stlv.main")
    if !testMode { window.makeKeyAndOrderFront(nil) }

    buildBaseMenu(nil)
    let page = testMode ? "stlv://app/index.html?test=1" : "stlv://app/index.html"
    web.load(URLRequest(url: URL(string: page)!))
    NSApp.activate(ignoringOtherApps: true)
  }

  // Files from Finder ("Open With", drag onto the Dock icon)
  func application(_ sender: NSApplication, open urls: [URL]) {
    if pageReady { sendOpen(urls) } else { pendingOpen += urls }
  }
  func sendOpen(_ urls: [URL]) {
    let list = urls.map { ["token": tokens.issue($0), "name": $0.lastPathComponent, "path": $0.path] }
    js("stlvBridge.event('open', \(json(list)))")
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if allowQuit || !pageReady { return .terminateNow }
    js("stlvBridge.event('quit', null)")       // the page asks about unsaved work, then sends 'terminate'
    return .terminateCancel
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if allowQuit || !pageReady { return true }
    js("stlvBridge.event('quit', null)")
    return false
  }
  func windowWillClose(_ n: Notification) { NSApp.terminate(nil) }
  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

  func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
    pageReady = true
    if !pendingOpen.isEmpty { sendOpen(pendingOpen); pendingOpen = [] }
    // development: --script <file.js> runs a script once the editor has booted
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: "--script"), i + 1 < a.count, let js = try? String(contentsOfFile: a[i + 1], encoding: .utf8) {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.web.evaluateJavaScript("(async () => { try { \(js) } catch (e) { stlvBridge && window.webkit.messageHandlers.stlv.postMessage({cmd:'log', text:'script error: ' + e.message + ' ' + e.stack}); } })()", completionHandler: nil) }
    }
  }
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    // The page crashed: reload it. Autosave brings the work back.
    pageReady = false
    web.reload()
  }
  // Keep every navigation inside the app
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let u = a.request.url, u.scheme == "stlv" { decisionHandler(.allow) } else {
      if let u = a.request.url, a.navigationType == .linkActivated { NSWorkspace.shared.open(u) }
      decisionHandler(.cancel)
    }
  }
  // JS alert/confirm (used rarely; the app draws its own dialogs)
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
  }
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  func js(_ s: String) { web.evaluateJavaScript(s, completionHandler: nil) }
  func reply(_ id: Any?, _ v: Any) {
    guard let id = id else { return }
    js("stlvBridge.reply(\(json(id)), \(json(v)))")
  }

  // ── messages from the page ───────────────────────────────────────────
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let msg = m.body as? [String: Any], let cmd = msg["cmd"] as? String else { return }
    let id = msg["id"]
    switch cmd {
    case "menu":
      if let menus = msg["menus"] as? [[String: Any]] { buildBaseMenu(menus) }
    case "menuState":
      // [{id, checked, enabled, title}]
      for s in (msg["items"] as? [[String: Any]]) ?? [] {
        guard let mid = s["id"] as? String, let it = menuItems[mid] else { continue }
        if let ch = s["checked"] as? Bool { it.state = ch ? .on : .off }
        if let en = s["enabled"] as? Bool { it.isEnabled = en }
        if let t = s["title"] as? String { it.title = t }
      }
    case "title":
      window.title = (msg["title"] as? String) ?? "stlv"
      window.isDocumentEdited = (msg["edited"] as? Bool) ?? false
      if let p = msg["path"] as? String, !p.isEmpty { window.representedURL = URL(fileURLWithPath: p) } else { window.representedURL = nil }
    case "open":
      let p = NSOpenPanel()
      p.allowsMultipleSelection = (msg["multiple"] as? Bool) ?? false
      p.canChooseDirectories = false
      if let exts = msg["types"] as? [String], !exts.isEmpty { p.allowedContentTypes = exts.compactMap { UTType(filenameExtension: $0) } }
      p.beginSheetModal(for: window) { r in
        guard r == .OK else { return self.reply(id, NSNull()) }
        self.reply(id, p.urls.map { ["token": tokens.issue($0), "name": $0.lastPathComponent, "path": $0.path, "size": (try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0] })
      }
    case "save":
      let p = NSSavePanel()
      p.nameFieldStringValue = (msg["name"] as? String) ?? "untitled"
      if let exts = msg["types"] as? [String], !exts.isEmpty { p.allowedContentTypes = exts.compactMap { UTType(filenameExtension: $0) } }
      if let dir = msg["dir"] as? String { p.directoryURL = URL(fileURLWithPath: dir, isDirectory: true) }
      p.canCreateDirectories = true
      p.isExtensionHidden = false
      p.beginSheetModal(for: window) { r in
        guard r == .OK, let u = p.url else { return self.reply(id, NSNull()) }
        self.reply(id, ["token": tokens.issue(u), "name": u.lastPathComponent, "path": u.path])
      }
    case "token":
      // a path the page knew before (recent files): only if it still exists
      if let path = msg["path"] as? String, FileManager.default.fileExists(atPath: path) {
        let u = URL(fileURLWithPath: path); reply(id, ["token": tokens.issue(u), "name": u.lastPathComponent, "path": path])
      } else { reply(id, NSNull()) }
    case "sibling":
      // another file in the folder the user picked in a save panel
      if let t = msg["token"] as? String, let u = tokens.url(t), let name = msg["name"] as? String, !name.contains("/"), !name.hasPrefix(".") {
        let f = u.deletingLastPathComponent().appendingPathComponent(name)
        reply(id, ["token": tokens.issue(f), "name": name, "path": f.path])
      } else { reply(id, NSNull()) }
    case "fonts":
      reply(id, fontList())
    case "fontFile":
      // family + style name -> token for the font file
      let fam = (msg["family"] as? String) ?? "", sty = (msg["style"] as? String) ?? ""
      reply(id, fontToken(fam, sty) ?? NSNull())
    case "reveal":
      if let path = msg["path"] as? String { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
    case "terminate":
      allowQuit = true; NSApp.terminate(nil)
    case "log":
      FileHandle.standardError.write(Data(("[page] " + ((msg["text"] as? String) ?? "") + "\n").utf8))
    case "testDone":
      print((msg["report"] as? String) ?? "")
      exit((msg["failed"] as? Int ?? 1) == 0 ? 0 : 1)
    case "snapshot":
      // development: a PNG of the window's web view (no screen-recording permission needed)
      let path = (msg["path"] as? String) ?? "/tmp/stlv-snapshot.png"
      let cfg = WKSnapshotConfiguration()
      web.takeSnapshot(with: cfg) { img, err in
        if let img = img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
          try? png.write(to: URL(fileURLWithPath: path)); self.reply(id, path)
        } else { self.reply(id, "error: \(String(describing: err))") }
      }
    case "quitNow":
      allowQuit = true; NSApp.terminate(nil)
    case "beep":
      NSSound.beep()
    case "typing":
      typing = (msg["on"] as? Bool) ?? false
    default:
      reply(id, NSNull())
    }
  }

  // ── fonts ────────────────────────────────────────────────────────────
  func fontList() -> [[String: Any]] {
    let fm = NSFontManager.shared
    return fm.availableFontFamilies.filter { !$0.hasPrefix(".") }.sorted().map { fam in
      let members = (fm.availableMembers(ofFontFamily: fam) ?? []).map { m -> [String: Any] in
        // [postscript name, style name, weight 0..15, traits]
        let traits = (m.count > 3 ? m[3] as? UInt : 0) ?? 0
        return ["ps": m[0] as? String ?? "", "style": m[1] as? String ?? "", "weight": m[2] as? Int ?? 5,
                "italic": (traits & NSFontTraitMask.italicFontMask.rawValue) != 0]
      }
      return ["family": fam, "styles": members, "flyer": bundledFamilies.contains(fam)]
    }
  }
  /** families of the fonts shipped in Contents/Resources/Fonts (the flyer set) */
  lazy var bundledFamilies: Set<String> = {
    guard let dir = Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
          let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
    var out = Set<String>()
    for f in files where ["ttf", "otf"].contains(f.pathExtension.lowercased()) {
      for d in (CTFontManagerCreateFontDescriptorsFromURL(f as CFURL) as? [CTFontDescriptor]) ?? [] {
        if let fam = CTFontDescriptorCopyAttribute(d, kCTFontFamilyNameAttribute) as? String { out.insert(fam) }
      }
    }
    return out
  }()
  func fontToken(_ family: String, _ style: String) -> [String: Any]? {
    let fm = NSFontManager.shared
    let members = fm.availableMembers(ofFontFamily: family) ?? []
    guard let m = members.first(where: { ($0[1] as? String) == style }) ?? members.first, let ps = m[0] as? String else { return nil }
    let desc = CTFontDescriptorCreateWithNameAndSize(ps as CFString, 12)
    guard let u = CTFontDescriptorCopyAttribute(desc, kCTFontURLAttribute) as? URL else { return nil }
    return ["token": tokens.issue(u), "ps": ps, "ext": u.pathExtension.lowercased()]
  }

  // ── menus ────────────────────────────────────────────────────────────
  // The page owns the menu model; Swift builds it and sends ids back.
  func buildBaseMenu(_ menus: [[String: Any]]?) {
    menuItems = [:]
    let bar = NSMenu()
    let appItem = NSMenuItem(); bar.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(cmdItem("About stlv", "app.about", "", []))
    appMenu.addItem(.separator())
    appMenu.addItem(cmdItem("Settings…", "app.settings", ",", [.command]))
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide stlv", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    others.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit stlv", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    for m in menus ?? [] {
      let it = NSMenuItem(); it.title = m["title"] as? String ?? ""
      let sub = NSMenu(title: it.title); sub.autoenablesItems = false
      fill(sub, (m["items"] as? [[String: Any]]) ?? [])
      it.submenu = sub; bar.addItem(it)
      if it.title == "Window" { NSApp.windowsMenu = sub }
    }
    NSApp.mainMenu = bar
  }
  func fill(_ menu: NSMenu, _ items: [[String: Any]]) {
    for d in items {
      if (d["sep"] as? Bool) == true { menu.addItem(.separator()); continue }
      let title = d["title"] as? String ?? ""
      let id = d["id"] as? String ?? ""
      var mods: NSEvent.ModifierFlags = []
      for k in (d["mods"] as? [String]) ?? [] {
        switch k { case "cmd": mods.insert(.command); case "shift": mods.insert(.shift); case "alt": mods.insert(.option); case "ctrl": mods.insert(.control); default: break }
      }
      let it = cmdItem(title, id, (d["key"] as? String) ?? "", mods)
      if let ch = d["checked"] as? Bool { it.state = ch ? .on : .off }
      if let en = d["enabled"] as? Bool { it.isEnabled = en }
      if let kids = d["items"] as? [[String: Any]] {
        let sub = NSMenu(title: title); sub.autoenablesItems = false
        fill(sub, kids); it.submenu = sub; it.action = nil
      }
      menu.addItem(it)
    }
  }
  func cmdItem(_ title: String, _ id: String, _ key: String, _ mods: NSEvent.ModifierFlags) -> NSMenuItem {
    let it = NSMenuItem(title: title, action: #selector(menuPick(_:)), keyEquivalent: key)
    it.keyEquivalentModifierMask = key.isEmpty ? [] : mods
    it.target = self
    it.representedObject = id
    if !id.isEmpty { menuItems[id] = it }
    return it
  }
  @objc func menuPick(_ s: NSMenuItem) {
    guard let id = s.representedObject as? String else { return }
    // while typing, the text shortcuts edit the text, not the document
    let textAction: [String: Selector] = ["select.all": #selector(NSText.selectAll(_:)), "edit.copy": #selector(NSText.copy(_:)),
                                          "edit.cut": #selector(NSText.cut(_:)), "edit.paste": #selector(NSText.paste(_:))]
    if typing, let sel = textAction[id], NSApp.sendAction(sel, to: nil, from: s) { return }
    js("stlvBridge.event('command', \(json(id)))")
  }
  func validateMenuItem(_ item: NSMenuItem) -> Bool { item.isEnabled }
}

let app = NSApplication.shared
let shell = Shell()
app.delegate = shell
app.setActivationPolicy(testMode ? .accessory : .regular)
if testMode { DispatchQueue.main.asyncAfter(deadline: .now() + 300) { print("test timeout"); exit(2) } }
app.run()
