import AppKit
import SwiftUI

/// Service links prefer desktop apps; PR links reuse Helium tabs. Never changes browser defaults.
@MainActor
final class BrowserLinkOpener {
    nonisolated static let heliumID = "net.imput.helium"
    static let shared = BrowserLinkOpener()

    private let canLookup: (URL) -> Bool
    private let focus: (String) async -> Bool
    private let openNormally: (URL) -> Void
    private let openDesktop: (URL) -> Bool
    private var pending: URL?
    private var openingKey: String?
    private var requestVersion = 0
    private(set) var task: Task<Void, Never>?

    init(canLookup: @escaping (URL) -> Bool = { url in
        guard let app = NSWorkspace.shared.urlForApplication(toOpen: url),
              Bundle(url: app)?.bundleIdentifier == heliumID else { return false }
        return !NSRunningApplication.runningApplications(withBundleIdentifier: heliumID).isEmpty
    }, focus: @escaping (String) async -> Bool = { await HeliumTabLookup.focus($0) },
         openNormally: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) },
         openDesktop: @escaping (URL) -> Bool = { url in
             guard NSWorkspace.shared.urlForApplication(toOpen: url) != nil else { return false }
             return NSWorkspace.shared.open(url)
         }) {
        self.canLookup = canLookup
        self.focus = focus
        self.openNormally = openNormally
        self.openDesktop = openDesktop
    }

    func open(_ url: URL) {
        guard let key = Self.pullRequestKey(url), canLookup(url) else {
            pending = nil
            requestVersion += 1
            if let native = DesktopAppLink.url(for: url), openDesktop(native) { return }
            openNormally(url)
            return
        }
        // One lookup at a time, with one latest pending click. Repeated clicks on the same
        // PR coalesce; rapid navigation cannot spawn an unbounded queue of Apple events.
        guard key != openingKey else { pending = nil; return }
        requestVersion += 1
        pending = url
        guard task == nil else { return }
        task = Task {
            while let url = pending {
                pending = nil
                guard let key = Self.pullRequestKey(url) else { continue }
                openingKey = key
                let version = requestVersion
                let focused = await focus(key)
                if !focused, pending == nil, version == requestVersion { openNormally(url) }
            }
            openingKey = nil
            task = nil
        }
    }

    nonisolated static func pullRequestKey(_ url: URL) -> String? {
        let value = url.absoluteString
        guard let range = value.range(of: #"^https?://github\.com/([a-z0-9_.-]+)/([a-z0-9_.-]+)/pull/([1-9][0-9]*)(?=[/?#]|$)"#,
                                      options: [.regularExpression, .caseInsensitive]) else { return nil }
        return String(value[range]).lowercased().replacingOccurrences(of: #"^https?://github\.com/"#,
                                                                   with: "", options: .regularExpression)
    }

    static var action: OpenURLAction {
        OpenURLAction { url in
            guard handles(url) else { return .systemAction }
            shared.open(url)
            return .handled
        }
    }

    nonisolated static func handles(_ url: URL) -> Bool {
        pullRequestKey(url) != nil || DesktopAppLink.url(for: url) != nil
    }
}

enum HeliumTabLookup {
    // JXA needs no installed scripting dictionary at compile time. The target key is an
    // argument, never executable source. Read only URLs, never page content or titles.
    static let script = #"""
    function prKey(url) {
        var match = /^https?:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?=[/?#]|$)/i.exec(url);
        return match ? (match[1] + '/' + match[2] + '/pull/' + match[3]).toLowerCase() : null;
    }
    function run(argv) {
        var browser = Application('net.imput.helium');
        if (!browser.running()) return 'not-found';
        var windows = browser.windows();
        for (var w = 0; w < windows.length; w++) {
            var window = windows[w];
            var urls = window.tabs.url();
            for (var t = 0; t < urls.length; t++) {
                if (prKey(urls[t]) !== argv[0]) continue;
                window.activeTabIndex = t + 1;
                window.minimized = false;
                window.index = 1;
                browser.activate();
                return 'focused';
            }
        }
        return 'not-found';
    }
    """#

    static func focus(_ key: String) async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: run(script: script, arguments: [key]) == "focused")
            }
        }
    }

    /// Off-main, event-driven wait with a hard deadline, including a stalled permission prompt.
    static func run(script: String, arguments: [String], timeout: TimeInterval = 5) -> String? {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/osascript")
        process.arguments = ["-l", "JavaScript", "-e", script, "--"] + arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        let ended = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in ended.signal() }
        do { try process.run() } catch { return nil }
        if ended.wait(timeout: .now() + timeout) == .timedOut {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
