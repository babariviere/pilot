import AppKit
import Darwin
import PilotCore
import SwiftUI

/// An offline, bounded workload for profiling the actual app UI. Never opens user sessions,
/// starts a daemon, saves drafts, or loads extensions. Use --streaming for ten deltas/second.
/// --scrolling drives native live-scroll gestures through the transcript at 60 Hz, --sidebar-typing
/// types into the sidebar search, and --session-updates delivers daemon updates for other sessions.
/// --rich replaces the plain user messages with a realistic mix of Markdown, code and tool rows.
@MainActor
enum PerformanceCheck {
    static func run() async {
        let arguments = CommandLine.arguments
        let streaming = arguments.contains("--streaming")
        let scrolling = arguments.contains("--scrolling")
        let sidebarTyping = arguments.contains("--sidebar-typing")
        let sessionUpdates = arguments.contains("--session-updates")
        let working = streaming || arguments.contains("--working")
        NSApp.appearance = NSAppearance(named: .aqua)
        for window in NSApp.windows { window.close() }
        let model = AppModel.shared
        let now = Date().timeIntervalSince1970 * 1000
        let project = Project(id: "performance", name: "Offline performance fixture", path: "/tmp/pilot-performance-fixture", createdAt: now)
        func session(_ index: Int, updatedAt: Double) -> SessionSummary {
            SessionSummary(id: "performance-\(index)", title: "Performance session \(index)", cwd: project.path,
                           projectId: project.id, createdAt: now, updatedAt: updatedAt,
                           state: working ? "working" : "idle", model: "fixture/model")
        }
        let sessions = (0..<12).map { session($0, updatedAt: now - Double($0)) }
        model.client.loadFixture(projects: [project], sessions: sessions)
        model.client.fixtureModels = ModelList(models: [ModelOption(id: "fixture/model", provider: "fixture", name: "Offline model")],
                                              defaultModel: "fixture/model")
        model.client.fixtureChangeSummaries = Dictionary(uniqueKeysWithValues: sessions.map {
            ($0.id, SessionChangeSummary(base: "HEAD", branch: "perf/fixture", fileCount: 0, additions: 0, deletions: 0))
        })
        model.daemon.markRunningForSnapshot()
        model.selectedSessionId = sessions[0].id
        model.inspectorVisible = false
        let entries: [JSONValue] = arguments.contains("--rich") ? richEntries(count: 1000) : (1...1000).map { id in
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
            let chatBodies = ChatView.bodyEvaluations
            if streaming {
                feed.applyFixtureEvents([.object([
                    "type": .string("message_start"),
                    "message": .object(["role": .string("assistant"), "content": .array([.object(["type": .string("text"), "text": .string("")])])]),
                ])])
            }
            let transcript = scrolling ? findTranscript(window.contentView) : nil
            if scrolling, transcript == nil { throw ClientError("No transcript") }
            let center = NotificationCenter.default
            if let transcript { center.post(name: NSScrollView.willStartLiveScrollNotification, object: transcript) }
            let ticks = scrolling ? 600 : 100
            let query = "performance session"
            // Each scroll frame is laid out and drawn synchronously, so its main-thread cost is
            // measured directly rather than through timer delivery, which macOS coalesces.
            var frames: [Double] = []
            for tick in 0..<ticks {
                if streaming {
                    feed.applyFixtureEvents([.object([
                        "type": .string("message_update"), "changes": .array([.object([
                            "type": .string("text_delta"), "contentIndex": .number(0), "delta": .string(" streamed text"),
                        ])]),
                    ])])
                }
                if let transcript {
                    let frameStart = clock.now
                    // Up for the first half, then back down: lazy rows are realized both ways.
                    let clip = transcript.contentView
                    let step: CGFloat = tick < ticks / 2 ? -40 : 40
                    let y = transcript.documentView?.isFlipped == false ? clip.bounds.minY - step : clip.bounds.minY + step
                    clip.scroll(to: NSPoint(x: clip.bounds.minX, y: y))
                    transcript.reflectScrolledClipView(clip)
                    center.post(name: NSScrollView.didLiveScrollNotification, object: transcript)
                    window.contentView?.layoutSubtreeIfNeeded()
                    window.displayIfNeeded()
                    let frame = frameStart.duration(to: clock.now).components
                    frames.append(Double(frame.seconds) * 1000 + Double(frame.attoseconds) / 1e15)
                }
                if sidebarTyping {
                    let length = tick % (query.count + 1)
                    model.sidebarQuery = String(query.prefix(length))
                }
                if sessionUpdates {
                    // Another session's activity, as pilotd reports it while several agents work.
                    model.client.handle(.session(session(1 + tick % 11, updatedAt: now - 20 + Double(tick) / 1000)))
                }
                try await Task.sleep(for: .milliseconds(scrolling ? 16 : 100))
            }
            if let transcript { center.post(name: NSScrollView.didEndLiveScrollNotification, object: transcript) }
            let elapsed = began.duration(to: clock.now).components
            let wall = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
            var end = rusage()
            getrusage(RUSAGE_SELF, &end)
            func seconds(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000 }
            let cpu = seconds(end.ru_utime) + seconds(end.ru_stime) - seconds(start.ru_utime) - seconds(start.ru_stime)
            let mode = [streaming ? "streaming" : working ? "working" : "idle",
                        scrolling ? "scrolling" : nil, sidebarTyping ? "sidebar-typing" : nil,
                        sessionUpdates ? "session-updates" : nil].compactMap { $0 }.joined(separator: "+")
            var summary = "performance-check \(mode): CPU=\(cpu / wall * 100)% of one core, peak RSS=\(Double(end.ru_maxrss) / 1048576) MiB, rows=\(feed.presentation.rows.count), chat body evaluations=\(ChatView.bodyEvaluations - chatBodies)"
            if !frames.isEmpty {
                frames.sort()
                func ms(_ value: Double) -> String { String(format: "%.1fms", value) }
                summary += ", scroll frame p50=\(ms(frames[frames.count / 2])) p95=\(ms(frames[frames.count * 95 / 100])) max=\(ms(frames.last!))"
                summary += " over 16ms=\(frames.filter { $0 > 16 }.count)/\(frames.count)"
            }
            print(summary)
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

    /// Turns of a user request, a tool call with its result, and a Markdown answer with code.
    private static func richEntries(count: Int) -> [JSONValue] {
        func entry(_ id: Int, _ kind: String, _ message: JSONValue) -> JSONValue {
            .object(["id": .number(Double(id)), "kind": .string(kind), "model": .array([message])])
        }
        return (0..<count).map { index in
            let id = index + 1
            let turn = index / 4
            switch index % 4 {
            case 0:
                return entry(id, "pi.user", .object(["role": .string("user"), "content": .string(
                    "Turn \(turn): check why the session list jumps when a worker restarts, and fix it if it is simple.")]))
            case 1:
                return entry(id, "pi.assistant", .object(["role": .string("assistant"), "content": .array([
                    .object(["type": .string("text"), "text": .string("I'll read the ordering code first.")]),
                    .object(["type": .string("toolCall"), "id": .string("call-\(turn)"), "name": .string("bash"),
                             "arguments": .object(["command": .string("rg -n 'listPrecedes' apps/macos/Sources")])]),
                ])]))
            case 2:
                let output = (1...12).map { "Sources/PilotCore/SessionListOrdering.swift:\($0): static func listPrecedes" }
                return entry(id, "pi.tool-result", .object(["role": .string("toolResult"), "toolCallId": .string("call-\(turn)"),
                    "toolName": .string("bash"), "isError": .bool(false),
                    "content": .array([.object(["type": .string("text"), "text": .string(output.joined(separator: "\n"))])])]))
            default:
                let text = """
                ## Finding \(turn)

                The list re-sorts on **every** session update, so a restarting worker briefly moves to the top. \
                The comparison uses `updatedAt`, which changes when the worker starts, not when the user acts.

                1. Sort by `lastActivityAt` instead.
                2. Keep pinned sessions first.
                3. Add a regression test for restarts.

                ```swift
                static func listPrecedes(_ lhs: SessionSummary, _ rhs: SessionSummary) -> Bool {
                    if lhs.pinned != rhs.pinned { return lhs.pinned }
                    return (lhs.lastActivityAt ?? lhs.createdAt) > (rhs.lastActivityAt ?? rhs.createdAt)
                }
                ```

                > Restarts no longer reorder the sidebar; only user-visible activity does.
                """
                return entry(id, "pi.assistant", .object(["role": .string("assistant"), "stopReason": .string("stop"),
                    "content": .array([.object(["type": .string("text"), "text": .string(text)])])]))
            }
        }
    }

    private static func findTranscript(_ view: NSView?) -> NSScrollView? {
        guard let view else { return nil }
        if let observer = view as? ScrollObserverView { return observer.enclosingScrollView }
        return view.subviews.lazy.compactMap { findTranscript($0) }.first
    }
}
