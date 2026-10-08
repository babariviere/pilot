import AppKit
import Darwin
import PilotCore
import SwiftUI

/// An offline, bounded workload for profiling the actual app UI. Never opens user sessions,
/// starts a daemon, saves drafts, or loads extensions. Use --streaming for ten deltas/second.
@MainActor
enum PerformanceCheck {
    static func run() async {
        let arguments = CommandLine.arguments
        let streaming = arguments.contains("--streaming")
        let working = streaming || arguments.contains("--working")
        NSApp.appearance = NSAppearance(named: .aqua)
        for window in NSApp.windows { window.close() }
        let model = AppModel.shared
        let now = Date().timeIntervalSince1970 * 1000
        let project = Project(id: "performance", name: "Offline performance fixture", path: "/tmp/pilot-performance-fixture", createdAt: now)
        let sessions = (0..<12).map { index in
            SessionSummary(id: "performance-\(index)", title: "Performance session \(index)", cwd: project.path,
                           projectId: project.id, createdAt: now, updatedAt: now - Double(index),
                           state: working ? "working" : "idle", model: "fixture/model")
        }
        model.client.loadFixture(projects: [project], sessions: sessions)
        model.client.fixtureModels = ModelList(models: [ModelOption(id: "fixture/model", provider: "fixture", name: "Offline model")],
                                              defaultModel: "fixture/model")
        model.client.fixtureChangeSummaries = Dictionary(uniqueKeysWithValues: sessions.map {
            ($0.id, SessionChangeSummary(base: "HEAD", branch: "perf/fixture", fileCount: 0, additions: 0, deletions: 0))
        })
        model.daemon.markRunningForSnapshot()
        model.selectedSessionId = sessions[0].id
        model.inspectorVisible = false
        let entries: [JSONValue] = (1...1000).map { id in
            .object([
                "id": .number(Double(id)), "kind": .string("pi.user"),
                "model": .array([.object(["role": .string("user"), "content": .string("Historical message \(id)")])]),
            ])
        }
        let snapshot: JSONValue = .object([
            "type": .string("snapshot"), "entries": .array(entries),
            "run": working ? .object([:]) : .null,
        ])
        var transcript = Transcript()
        transcript.apply(snapshot)
        let feed = SessionFeed(sessionId: sessions[0].id, transcript: transcript)
        model.feeds.retain(feed, sessionId: sessions[0].id)
        feed.applyFixtureEvents([snapshot])
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1280, height: 820),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MainWindow().environmentObject(model).environment(\.pilotFonts, model.settings.fonts))
        window.orderFrontRegardless()
        do {
            try await Task.sleep(for: .seconds(2))
            var start = rusage()
            getrusage(RUSAGE_SELF, &start)
            let clock = ContinuousClock()
            let began = clock.now
            if streaming {
                feed.applyFixtureEvents([.object([
                    "type": .string("message_start"),
                    "message": .object(["role": .string("assistant"), "content": .array([.object(["type": .string("text"), "text": .string("")])])]),
                ])])
            }
            for _ in 0..<100 {
                if streaming {
                    feed.applyFixtureEvents([.object([
                        "type": .string("message_update"), "changes": .array([.object([
                            "type": .string("text_delta"), "contentIndex": .number(0), "delta": .string(" streamed text"),
                        ])]),
                    ])])
                }
                try await Task.sleep(for: .milliseconds(100))
            }
            let elapsed = began.duration(to: clock.now).components
            let wall = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
            var end = rusage()
            getrusage(RUSAGE_SELF, &end)
            func seconds(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000 }
            let cpu = seconds(end.ru_utime) + seconds(end.ru_stime) - seconds(start.ru_utime) - seconds(start.ru_stime)
            print("performance-check \(streaming ? "streaming" : working ? "working" : "idle"): CPU=\(cpu / wall * 100)% of one core, peak RSS=\(Double(end.ru_maxrss) / 1048576) MiB, rows=\(feed.presentation.rows.count)")
            if let index = arguments.firstIndex(of: "--screenshot"), index + 1 < arguments.count,
               let view = window.contentView,
               let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
                try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: arguments[index + 1]))
            }
            feed.stop()
            window.close()
            exit(0)
        } catch {
            print("performance-check failed: \(error)")
            exit(1)
        }
    }
}
