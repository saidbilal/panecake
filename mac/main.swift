// Claude Deck's native shell: a window with a web view, plus the Node server that
// owns the `claude` processes. Quitting the app ends the server and those processes.
import Cocoa
import WebKit

final class DeckWebView: WKWebView {
    var lastMouseDown: NSEvent?

    override func mouseDown(with event: NSEvent) {
        lastMouseDown = event
        super.mouseDown(with: event)
    }

    private func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        return info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL] ?? []
    }
    override func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation {
        fileURLs(info).isEmpty ? super.draggingEntered(info) : .copy
    }
    override func draggingUpdated(_ info: NSDraggingInfo) -> NSDragOperation {
        fileURLs(info).isEmpty ? super.draggingUpdated(info) : .copy
    }
    override func performDragOperation(_ info: NSDraggingInfo) -> Bool {
        let urls = fileURLs(info)
        if urls.isEmpty { return super.performDragOperation(info) }
        let paths = urls.map { $0.path }
        if let data = try? JSONSerialization.data(withJSONObject: paths), let json = String(data: data, encoding: .utf8) {
            evaluateJavaScript("window.deckDrop(\(json))", completionHandler: nil)
        }
        return true
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: DeckWebView!
    let server = Process()
    let serverStdin = Pipe()
    var quitConfirmed = false

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        startServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "deck")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = DeckWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }

        let frame = NSRect(x: 0, y: 0, width: 1320, height: 860)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(calibratedRed: 0.10, green: 0.10, blue: 0.10, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.title = "Claude Deck"
        window.minSize = NSSize(width: 720, height: 420)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("ClaudeDeckMain")
        window.makeKeyAndOrderFront(nil)
    }

    func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        let app = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(item("Hide Claude Deck", #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Quit Claude Deck", #selector(NSApplication.terminate(_:)), "q"))
        app.submenu = appMenu; main.addItem(app)

        // These items are what make Cmd+C and Cmd+V reach the web view.
        let edit = NSMenuItem(); let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        editMenu.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        editMenu.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        editMenu.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        edit.submenu = editMenu; main.addItem(edit)

        let win = NSMenuItem(); let winMenu = NSMenu(title: "Window")
        winMenu.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        winMenu.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        winMenu.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        win.submenu = winMenu; main.addItem(win)
        NSApp.windowsMenu = winMenu
        NSApp.mainMenu = main
    }

    func startServer() {
        let info = Bundle.main.infoDictionary ?? [:]
        let node = info["DeckNode"] as? String ?? "/opt/homebrew/bin/node"
        let root = info["DeckRoot"] as? String ?? ""
        server.executableURL = URL(fileURLWithPath: node)
        server.arguments = [root + "/server.mjs"]
        server.currentDirectoryURL = URL(fileURLWithPath: root)
        var env = ProcessInfo.processInfo.environment
        env["DECK_PARENT"] = "1"
        server.environment = env
        let out = Pipe()
        server.standardOutput = out
        server.standardInput = serverStdin
        var buffer = ""
        var loaded = false
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; return }
            guard !loaded, let s = String(data: chunk, encoding: .utf8) else { return }
            buffer += s
            if let r = buffer.range(of: "DECK_READY ") {
                let line = buffer[r.upperBound...].prefix { $0 != "\n" }
                if let url = URL(string: String(line)) {
                    loaded = true
                    DispatchQueue.main.async { self?.web.load(URLRequest(url: url)) }
                }
            }
        }
        server.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.quitConfirmed else { return }
                let a = NSAlert()
                a.messageText = "Claude Deck's server stopped"
                a.informativeText = "Quit and reopen the app. Your chats are saved by Claude Code."
                a.runModal()
                self.quitConfirmed = true
                NSApp.terminate(nil)
            }
        }
        do { try server.run() } catch {
            let a = NSAlert()
            a.messageText = "Could not start Claude Deck"
            a.informativeText = "\(node): \(error.localizedDescription)"
            a.runModal()
            NSApp.terminate(nil)
        }
    }

    // Window drag and zoom requests from the web title bar.
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let cmd = message.body as? String else { return }
        if cmd == "drag", let e = web.lastMouseDown { window.performDrag(with: e) }
        else if cmd == "zoom" { window.performZoom(nil) }
    }

    // Links never navigate the app window away from the UI.
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.host == "127.0.0.1" { decisionHandler(.allow); return }
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // Quitting ends every chat's process, so ask first if any is mid-turn.
    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        if quitConfirmed { return .terminateNow }
        web.evaluateJavaScript("window.deckBusyCount ? window.deckBusyCount() : 0") { [weak self] value, _ in
            let busy = (value as? Int) ?? 0
            guard let self else { return }
            if busy > 0 {
                let a = NSAlert()
                a.messageText = busy == 1 ? "1 chat is still working" : "\(busy) chats are still working"
                a.informativeText = "Quitting stops them mid-turn. Their history stays saved and can be resumed."
                a.addButton(withTitle: "Quit Anyway")
                a.addButton(withTitle: "Cancel")
                if a.runModal() != .alertFirstButtonReturn { app.reply(toApplicationShouldTerminate: false); return }
            }
            self.quitConfirmed = true
            app.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ note: Notification) {
        quitConfirmed = true
        if server.isRunning { server.terminate() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
