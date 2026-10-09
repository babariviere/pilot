import AppKit
import PilotCore
import SwiftUI

/// Offline regression check using the production ChatView. No daemon or user-session writes.
@MainActor
enum TranscriptOpeningCheck {
    static func run(directory: URL) async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for window in NSApp.windows { window.orderOut(nil) }
            let model = AppModel.shared
            let sessions = (0..<2).map {
                SessionSummary(id: "opening-\($0)", title: "Opening regression \($0)", cwd: "/tmp",
                    createdAt: 0, updatedAt: 0, state: "idle", model: "fixture/model")
            }
            model.client.loadFixture(projects: [], sessions: sessions)
            model.client.fixtureModels = ModelList(models: [], defaultModel: "fixture/model")
            var transcript = Transcript()
            let arguments = CommandLine.arguments
            let snapshot: JSONValue
            if let index = arguments.firstIndex(of: "--transcript-fixture"), index + 1 < arguments.count {
                snapshot = try JSONValue.decode(Data(contentsOf: URL(filePath: arguments[index + 1])))
            } else {
                // Varied historical rows with collapsed thinking, without artifacts.
                let entries: [JSONValue] = (1...180).map { id in
                    let content: [JSONValue] = [
                        .object(["type": .string("thinking"), "thinking": .string("Inspect the layout.")]),
                        .object(["type": .string("text"), "text": .string("### Reply \(id)\n\n"
                            + String(repeating: "A paragraph that wraps as the window narrows. ", count: 1 + id % 10))]),
                    ]
                    return .object(["id": .number(Double(id)), "kind": .string("pi.assistant"),
                        "model": .array([.object(["role": .string("assistant"), "content": .array(content)])])])
                }
                snapshot = .object(["type": .string("snapshot"), "entries": .array(entries)])
            }
            transcript.apply(snapshot)
            print("transcript-opening-check: \(transcript.rows.count) rows")
            let feeds = sessions.map { SessionFeed(sessionId: $0.id, transcript: transcript) }
            let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 900, height: 700),
                styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            var failures: [String] = []
            // Reuse one hosting view, just as the app does when changing the selected session.
            let hosting = NSHostingView(rootView: ChatView(session: sessions[0], feed: feeds[0])
                .id(sessions[0].id).background(Theme.background).environmentObject(model))
            window.contentView = hosting
            window.orderFrontRegardless()
            for (step, target) in [0, 1, 0, 1].enumerated() {
                hosting.rootView = ChatView(session: sessions[target], feed: feeds[target])
                    .id(sessions[target].id).background(Theme.background).environmentObject(model)
                try await Task.sleep(for: .milliseconds(700))
                for (resize, width) in [900.0, 620.0, 900.0].enumerated() {
                    window.setContentSize(NSSize(width: width, height: 700))
                    try await Task.sleep(for: .milliseconds(400))
                    hosting.layoutSubtreeIfNeeded()
                    guard let observer = findObserver(hosting), let scroll = observer.enclosingScrollView,
                          let document = scroll.documentView else {
                        failures.append("No transcript on step \(step)"); continue
                    }
                    let distance = document.isFlipped
                        ? document.bounds.maxY - scroll.contentView.bounds.maxY
                        : scroll.contentView.bounds.minY - document.bounds.minY
                    let remaining = max(0, distance + scroll.contentInsets.bottom - 8)
                    print("step=\(step) width=\(width) remaining=\(remaining) height=\(document.frame.height)")
                    if remaining > 2 { failures.append("Step \(step), width \(width): bottom missed by \(remaining)") }
                    let url = directory.appending(path: "opening-\(step)-\(resize)-\(Int(width)).png")
                    if let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) {
                        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
                        try bitmap.representation(using: .png, properties: [:])?.write(to: url)
                        let ink = inkFraction(bitmap, host: hosting, scroll: scroll)
                        print("visible transcript ink=\(ink)")
                        if ink < 0.003 { failures.append("Step \(step), width \(width): blank transcript") }
                    }
                }
            }
            // Snapshot delivery after the empty view has appeared must also scroll after layout.
            let empty = SessionFeed(sessionId: sessions[0].id, transcript: Transcript())
            hosting.rootView = ChatView(session: sessions[0], feed: empty)
                .id("delayed").background(Theme.background).environmentObject(model)
            try await Task.sleep(for: .milliseconds(200))
            empty.applyFixtureEvents([snapshot])
            try await Task.sleep(for: .milliseconds(900))
            if let scroll = findObserver(hosting)?.enclosingScrollView, let document = scroll.documentView {
                let remaining = max(0, document.bounds.maxY - scroll.contentView.bounds.maxY + scroll.contentInsets.bottom - 8)
                print("delayed snapshot remaining=\(remaining)")
                if remaining > 2 { failures.append("Delayed snapshot missed bottom by \(remaining)") }
                if let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) {
                    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
                    try bitmap.representation(using: .png, properties: [:])?.write(to: directory.appending(path: "delayed.png"))
                    if inkFraction(bitmap, host: hosting, scroll: scroll) < 0.003 {
                        failures.append("Blank transcript after delayed snapshot")
                    }
                }

                // A real user gesture suspends follow. Later content must not pull the reader down.
                let center = NotificationCenter.default
                center.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
                scroll.contentView.scroll(to: NSPoint(x: 0, y: 500))
                scroll.reflectScrolledClipView(scroll.contentView)
                center.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
                center.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
                empty.applyFixtureEvents([.object(["type": .string("entry_appended"), "entry": .object([
                    "id": .number(1_000_001), "kind": .string("pi.assistant"),
                    "model": .array([.object(["role": .string("assistant"), "content": .string("New output while reading history.")])]),
                ])])])
                try await Task.sleep(for: .milliseconds(500))
                if findObserver(hosting)?.state?.follow.shouldScrollToBottom != false
                    || document.bounds.maxY - scroll.contentView.bounds.maxY < 500 {
                    failures.append("New output pulled the reader back to the bottom")
                }
            } else { failures.append("No transcript after delayed snapshot") }
            feeds.forEach { $0.stop() }
            empty.stop()
            window.close()
            if !failures.isEmpty {
                print("transcript-opening-check: FAILED\n" + failures.joined(separator: "\n"))
                exit(1)
            }
            print("transcript-opening-check: ok")
            exit(0)
        } catch {
            print("transcript-opening-check: \(error)")
            exit(1)
        }
    }

    private static func findObserver(_ view: NSView) -> ScrollObserverView? {
        if let observer = view as? ScrollObserverView { return observer }
        return view.subviews.lazy.compactMap(findObserver).first
    }

    /// Sample only the upper half of the transcript, excluding the composer and scrollbar.
    private static func inkFraction(_ bitmap: NSBitmapImageRep, host: NSView, scroll: NSScrollView) -> Double {
        let rect = scroll.convert(scroll.bounds, to: host).insetBy(dx: 20, dy: 20)
        let scale = CGFloat(bitmap.pixelsWide) / host.bounds.width
        let top = host.isFlipped ? rect.minY : host.bounds.height - rect.maxY
        let x0 = max(0, Int(rect.minX * scale)), x1 = min(bitmap.pixelsWide, Int(rect.maxX * scale))
        let y0 = max(0, Int(top * scale)), y1 = min(bitmap.pixelsHigh, Int((top + rect.height / 2) * scale))
        guard x1 > x0, y1 > y0, let background = bitmap.colorAt(x: x0, y: y0)?.usingColorSpace(.deviceRGB) else { return 0 }
        var ink = 0, total = 0
        for y in stride(from: y0, to: y1, by: 2) {
            for x in stride(from: x0, to: x1, by: 2) {
                total += 1
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                if abs(color.redComponent - background.redComponent) + abs(color.greenComponent - background.greenComponent)
                    + abs(color.blueComponent - background.blueComponent) > 0.15 { ink += 1 }
            }
        }
        return total == 0 ? 0 : Double(ink) / Double(total)
    }
}
