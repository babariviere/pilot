import AppKit
import PilotCore
import SwiftUI

/// Offline regression check: scrolling through a transcript with large inline artifacts must move
/// rows on screen by the user's scroll only, while lazy rows above are realized with estimated
/// heights and artifacts grow once measured. No daemon is needed; revisions are seeded into the cache.
@MainActor
enum ArtifactScrollCheck {
    static func run() async {
        setvbuf(stdout, nil, _IOLBF, 0)
        do {
            for window in NSApp.windows { window.orderOut(nil) }
            let model = AppModel.shared
            let session = SessionSummary(id: "artifact-scroll", title: "Artifact scroll", cwd: "/tmp",
                createdAt: 0, updatedAt: 0, state: "idle", model: "fixture/model")
            model.client.loadFixture(projects: [], sessions: [session])
            model.client.fixtureModels = ModelList(models: [], defaultModel: "fixture/model")
            var entries: [JSONValue] = []
            for id in 1...90 {
                if id % 12 == 0 {
                    let artifactId = "artifact-\(id)"
                    let height = 900 + (id % 5) * 150
                    let json = """
                    {"id":"\(artifactId)","sessionId":"\(session.id)","title":"Artifact \(id)","kind":"html","revision":1,
                     "createdAt":1,"updatedAt":1,"source":"","libraries":[],
                     "html":"<div style='height:\(height)px;background:repeating-linear-gradient(#69f 0 37px,#f96 37px 61px,#fff 61px 83px);font:40px sans-serif'>Artifact \(id)</div>"}
                    """
                    let revision = try JSONDecoder().decode(ArtifactRevision.self, from: Data(json.utf8))
                    ArtifactInlineCache.store(revision, for: ArtifactReference(id: artifactId, sessionId: session.id,
                        title: revision.title, revision: 1))
                    entries.append(.object(["id": .number(Double(id)), "kind": .string("pilot.artifact"),
                        "data": .object(["artifact": .object(["id": .string(artifactId), "sessionId": .string(session.id),
                            "title": .string(revision.title), "revision": .number(1)])])]))
                } else {
                    let text = "### Reply \(id)\n\n" + String(repeating: "A paragraph that wraps as the window narrows. ", count: 2 + id % 9)
                    entries.append(.object(["id": .number(Double(id)), "kind": .string("pi.assistant"),
                        "model": .array([.object(["role": .string("assistant"), "content": .string(text)])])]))
                }
            }
            var transcript = Transcript()
            transcript.apply(.object(["type": .string("snapshot"), "entries": .array(entries)]))
            print("artifact-scroll-check: \(transcript.rows.count) rows")
            let feed = SessionFeed(sessionId: session.id, transcript: transcript)
            let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 1000, height: 800),
                styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let hosting = NSHostingView(rootView: ChatView(session: session, feed: feed)
                .background(Theme.background).environmentObject(model))
            window.contentView = hosting
            window.orderFrontRegardless()
            try await Task.sleep(for: .milliseconds(1500))
            guard let observer = find(ScrollObserverView.self, in: hosting).first, let scroll = observer.enclosingScrollView,
                  let document = scroll.documentView else { throw ClientError("No transcript") }
            var failures: [String] = []
            // Cold rows and unmeasured artifacts first, then cached sizes and prepared Markdown.
            for pass in 0..<2 {
                for (direction, label) in [(-1.0, "up"), (1.0, "down")] {
                    let result = try await sweep(scroll: scroll, document: document, direction: direction)
                    print("sweep \(pass) \(label): steps=\(result.steps) jumps=\(result.jumps) largest=\(result.largest)pt")
                    if result.jumps > 0 { failures.append("Sweep \(pass) \(label): \(result.jumps) jumps, largest \(result.largest)pt") }
                    if result.steps < 100 { failures.append("Sweep \(pass) \(label): only \(result.steps) steps") }
                }
            }
            feed.stop()
            window.close()
            if !failures.isEmpty {
                print("artifact-scroll-check: FAILED\n" + failures.joined(separator: "\n"))
                exit(1)
            }
            print("artifact-scroll-check: ok")
            exit(0)
        } catch {
            print("artifact-scroll-check: \(error)")
            exit(1)
        }
    }

    private struct SweepResult {
        var steps = 0
        var jumps = 0
        var largest: CGFloat = 0
    }

    /// Scroll like a trackpad, in small live-scroll steps, letting layout and artifact measurement
    /// run in between. Compare where the same row is on screen before and after each step.
    private static func sweep(scroll: NSScrollView, document: NSView, direction: CGFloat) async throws -> SweepResult {
        let center = NotificationCenter.default
        let clip = scroll.contentView
        center.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        defer { center.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll) }
        var result = SweepResult()
        let step: CGFloat = 45
        for _ in 0..<2000 {
            let visible = clip.bounds
            let top = document.bounds.minY - scroll.contentInsets.top
            let bottom = document.bounds.maxY - visible.height + scroll.contentInsets.bottom
            let target = min(bottom, max(top, visible.minY + direction * step))
            if abs(target - visible.minY) < 0.5 { break }
            let before = rows(in: document)
            clip.scroll(to: NSPoint(x: visible.minX, y: target))
            scroll.reflectScrolledClipView(clip)
            center.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
            try await Task.sleep(for: .milliseconds(30))
            result.steps += 1
            let after = rows(in: document)
            // The first row that started inside the viewport and is still realized: its screen
            // position must have moved by exactly the user's scroll.
            guard let reference = before.filter({ $0.value.top >= visible.minY && $0.value.top < visible.maxY && after[$0.key] != nil })
                .min(by: { $0.value.top < $1.value.top }), let moved = after[reference.key] else { continue }
            let expected = reference.value.top - target
            let actual = moved.top - clip.bounds.minY
            let jump = abs(actual - expected)
            if jump > 1 {
                result.jumps += 1
                result.largest = max(result.largest, jump)
                print("  jump \(Int(jump))pt row=\(reference.key) offset=\(Int(clip.bounds.minY)) document=\(Int(document.bounds.height))")
            }
        }
        return result
    }

    /// Realized transcript rows in a flipped document, keyed by row id.
    private static func rows(in document: NSView) -> [String: (top: CGFloat, bottom: CGFloat)] {
        var out: [String: (top: CGFloat, bottom: CGFloat)] = [:]
        for row in find(TranscriptRowAnchorView.self, in: document) where row.window != nil {
            let rect = row.convert(row.bounds, to: document)
            out[row.rowID] = (rect.minY, rect.maxY)
        }
        return out
    }

    private static func find<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
        if let match = view as? T { return [match] }
        return view.subviews.flatMap { find(type, in: $0) }
    }
}
