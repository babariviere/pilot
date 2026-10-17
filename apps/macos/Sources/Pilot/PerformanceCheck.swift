import AppKit
import Darwin
import PilotCore
import SwiftUI

/// An offline, bounded workload for profiling the actual app UI. Never opens user sessions,
/// starts a daemon, saves drafts, or loads extensions. Use --streaming for ten deltas/second;
/// --rate N sets the deltas per second, --markdown streams a long Markdown reply (headings, lists,
/// code and tables) in --chunk N character deltas (default 12), and --seconds N sets the measured time.
/// Streaming reports process and main-thread CPU, physical footprint, display-frame hitches,
/// per-phase totals of the streaming signposts and the CPU after the reply completes.
/// --scrolling drives native live-scroll gestures through the transcript at 60 Hz, --sidebar-typing
/// types into the sidebar search, and --session-updates delivers daemon updates for other sessions.
/// --rich replaces the plain user messages with a realistic mix of Markdown, code and tool rows.
/// --diagrams adds a Mermaid flowchart to each --rich answer; --web-diagrams draws them with the
/// WebView renderer instead of the native one, for before/after comparisons in the same build.
@MainActor
enum PerformanceCheck {
    static func run() async {
        let arguments = CommandLine.arguments
        func number(_ flag: String) -> Int? {
            arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? Int(arguments[$0 + 1]) : nil }
        }
        let streaming = arguments.contains("--streaming")
        let scrolling = arguments.contains("--scrolling")
        let sidebarTyping = arguments.contains("--sidebar-typing")
        let sessionUpdates = arguments.contains("--session-updates")
        let markdown = arguments.contains("--markdown")
        let rate = max(1, min(number("--rate") ?? 10, 240))
        let measuredSeconds = max(1, min(number("--seconds") ?? 10, 120))
        let chunk = max(1, number("--chunk") ?? 12)
        let working = streaming || arguments.contains("--working")
        let diagrams = arguments.contains("--diagrams")
        NativeMermaid.webOnly = arguments.contains("--web-diagrams")
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
        let entries: [JSONValue] = arguments.contains("--rich") ? richEntries(count: 1000, diagrams: diagrams) : (1...1000).map { id in
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
            let ticks = scrolling ? 600 : rate * measuredSeconds
            let interval: Duration = scrolling ? .milliseconds(16) : .nanoseconds(1_000_000_000 / Int64(rate))
            // The streamed reply: enough Markdown for every delta, or the original short phrase.
            let reply = markdown ? Array(streamedReply(minimumLength: ticks * chunk)) : []
            func delta(_ tick: Int) -> String {
                guard markdown else { return " streamed text" }
                let start = min(reply.count, tick * chunk)
                return String(reply[start ..< min(reply.count, start + chunk)])
            }
            let frames = FrameMonitor()
            if streaming, let view = window.contentView {
                frames.transcript = findTranscript(view)
                frames.start(on: view)
            }
            StreamingTrace.reset()
            StreamingTrace.collecting = streaming
            var footprintPeak = physicalFootprint()
            var start = rusage()
            getrusage(RUSAGE_SELF, &start)
            let mainStart = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
            let clock = ContinuousClock()
            let began = clock.now
            let chatBodies = ChatView.bodyEvaluations
            let rowSections = TranscriptRowsSection.bodyEvaluations
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
            let query = "performance session"
            // Each scroll frame is laid out and drawn synchronously, so its main-thread cost is
            // measured directly rather than through timer delivery, which macOS coalesces.
            var scrollFrames: [Double] = []
            for tick in 0..<ticks {
                if streaming {
                    feed.applyFixtureEvents([.object([
                        "type": .string("message_update"), "changes": .array([.object([
                            "type": .string("text_delta"), "contentIndex": .number(0), "delta": .string(delta(tick)),
                        ])]),
                    ])])
                    footprintPeak = max(footprintPeak, physicalFootprint())
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
                    scrollFrames.append(Double(frame.seconds) * 1000 + Double(frame.attoseconds) / 1e15)
                }
                if sidebarTyping {
                    let length = tick % (query.count + 1)
                    model.sidebarQuery = String(query.prefix(length))
                }
                if sessionUpdates {
                    // Another session's activity, as pilotd reports it while several agents work.
                    model.client.handle(.session(session(1 + tick % 11, updatedAt: now - 20 + Double(tick) / 1000)))
                }
                // Absolute deadlines, so the delivered rate does not drift with the work per tick.
                try await clock.sleep(until: began.advanced(by: interval * (tick + 1)))
            }
            if let transcript { center.post(name: NSScrollView.didEndLiveScrollNotification, object: transcript) }
            let elapsed = began.duration(to: clock.now).components
            let wall = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
            var end = rusage()
            getrusage(RUSAGE_SELF, &end)
            let mainCPU = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - mainStart) / 1e9
            frames.stop()
            StreamingTrace.collecting = false
            let phases = StreamingTrace.snapshot()
            func seconds(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000 }
            let cpu = seconds(end.ru_utime) + seconds(end.ru_stime) - seconds(start.ru_utime) - seconds(start.ru_stime)
            let mode = [streaming ? "streaming" : working ? "working" : "idle",
                        streaming ? "\(rate)/s" : nil, streaming && markdown ? "markdown \(chunk) chars" : nil,
                        scrolling ? "scrolling" : nil, sidebarTyping ? "sidebar-typing" : nil,
                        sessionUpdates ? "session-updates" : nil,
                        diagrams ? (NativeMermaid.webOnly ? "web-diagrams" : "native-diagrams") : nil]
            .compactMap { $0 }.joined(separator: "+")
            func ms(_ value: Double) -> String { String(format: "%.1fms", value) }
            func mib(_ bytes: UInt64) -> String { String(format: "%.1f MiB", Double(bytes) / 1_048_576) }
            func percent(_ value: Double) -> String { String(format: "%.1f%%", value) }
            var summary = "performance-check \(mode): CPU=\(percent(cpu / wall * 100)) of one core, main thread=\(percent(mainCPU / wall * 100)), "
                + "peak RSS=\(String(format: "%.1f", Double(end.ru_maxrss) / 1048576)) MiB, rows=\(feed.presentation.rows.count), "
                + "chat body evaluations=\(ChatView.bodyEvaluations - chatBodies), "
                + "transcript rows evaluations=\(TranscriptRowsSection.bodyEvaluations - rowSections)"
            if streaming {
                summary += ", physical footprint peak=\(mib(footprintPeak)) end=\(mib(physicalFootprint()))"
                summary += ", \(frames.summary)"
            }
            if !scrollFrames.isEmpty {
                scrollFrames.sort()
                summary += ", scroll frame p50=\(ms(scrollFrames[scrollFrames.count / 2])) p95=\(ms(scrollFrames[scrollFrames.count * 95 / 100])) max=\(ms(scrollFrames.last!))"
                summary += " over 16ms=\(scrollFrames.filter { $0 > 16 }.count)/\(scrollFrames.count)"
            }
            print(summary)
            if streaming {
                for (phase, total) in phases where total.count > 0 {
                    let totalMs = Double(total.nanoseconds) / 1e6
                    print("  \(phase.label): \(total.count) calls, total \(ms(totalMs)) (\(percent(totalMs / 1000 / wall * 100)) of the run), "
                          + "mean \(String(format: "%.3fms", totalMs / Double(total.count))), longest \(ms(Double(total.longest) / 1e6))")
                }
                // The reply completes as pilotd reports it: the committed entry, then the end of the run.
                let text = markdown ? String(reply.prefix(ticks * chunk)) : String(repeating: " streamed text", count: ticks)
                feed.applyFixtureEvents([
                    .object(["type": .string("message_end"), "entry": .object([
                        "id": .number(1_000_001), "kind": .string("pi.assistant"),
                        "model": .array([.object(["role": .string("assistant"), "stopReason": .string("stop"),
                                                  "content": .array([.object(["type": .string("text"), "text": .string(text)])])])]),
                    ])]),
                    .object(["type": .string("run_end")]),
                ])
                try await Task.sleep(for: .seconds(2))
                var idleStart = rusage()
                getrusage(RUSAGE_SELF, &idleStart)
                let idleBegan = clock.now
                try await Task.sleep(for: .seconds(5))
                var idleEnd = rusage()
                getrusage(RUSAGE_SELF, &idleEnd)
                let idleWall = idleBegan.duration(to: clock.now).components
                let idleSeconds = Double(idleWall.seconds) + Double(idleWall.attoseconds) / 1e18
                let idleCPU = seconds(idleEnd.ru_utime) + seconds(idleEnd.ru_stime) - seconds(idleStart.ru_utime) - seconds(idleStart.ru_stime)
                print("  after completion: CPU=\(percent(idleCPU / idleSeconds * 100)) of one core over 5 s, physical footprint=\(mib(physicalFootprint()))")
            }
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
    private static func richEntries(count: Int, diagrams: Bool = false) -> [JSONValue] {
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
                var text = """
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
                if diagrams {
                    text += """


                    ```mermaid
                    flowchart LR
                      A[Worker \(turn) restarts] --> B{Sort key}
                      B -->|updatedAt| C[Jumps to the top]
                      B -->|lastActivityAt| D[Stays in place]
                      D --> E[(Session list)]
                    ```
                    """
                }
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

    /// The process's physical footprint, as Activity Monitor's Memory column and Xcode's gauge report it.
    static func physicalFootprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }

    /// A long agent answer with every block kind the transcript renders, repeated to the requested length.
    static func streamedReply(minimumLength: Int) -> String {
        var reply = ""
        var section = 0
        while reply.count < minimumLength {
            section += 1
            reply += """
            ## Step \(section): what changed and why

            The session list re-sorted on **every** update, so a restarting worker briefly jumped to the top. \
            The comparison used `updatedAt`, which changes when a worker starts, not when the user acts. \
            This step keeps the order stable and adds a regression test, see [the issue](https://example.com/issues/\(section)).

            1. Sort by `lastActivityAt` instead of `updatedAt`.
            2. Keep pinned sessions first, then the most recent activity.
            3. Add a regression test for restarts and reconnects.

            - Restarts no longer reorder the sidebar.
            - Archived chats keep their position.

            ```swift
            static func listPrecedes(_ lhs: SessionSummary, _ rhs: SessionSummary) -> Bool {
                if lhs.pinned != rhs.pinned { return lhs.pinned }
                let left = lhs.lastActivityAt ?? lhs.createdAt
                let right = rhs.lastActivityAt ?? rhs.createdAt
                return left == right ? lhs.id < rhs.id : left > right
            }
            ```

            | Case | Before | After |
            | --- | --- | --- |
            | Worker restart | Moves to top | Stays |
            | New message | Moves to top | Moves to top |
            | Rename | Stays | Stays |

            > Only user-visible activity changes the order now.


            """
        }
        return reply
    }
}

/// Counts display frames the main thread missed, from the window's display link (120 Hz on ProMotion displays).
/// A gap longer than one and a half frames is a hitch; its length in frames, less one, is the frames dropped.
@MainActor
private final class FrameMonitor: NSObject {
    private var link: CADisplayLink?
    private var last: CFTimeInterval?
    private var frameDuration: CFTimeInterval = 0
    private var frames = 0
    private var hitches = 0
    private var dropped = 0
    private var longest: CFTimeInterval = 0

    func start(on view: NSView) {
        let link = view.displayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
        sampleNewestRow()
        let duration = link.targetTimestamp - link.timestamp
        if duration > 0 { frameDuration = duration }
        defer { last = link.timestamp }
        guard let last, frameDuration > 0 else { return }
        frames += 1
        let gap = link.timestamp - last
        longest = max(longest, gap)
        if gap > frameDuration * 1.5 {
            hitches += 1
            dropped += max(0, Int((gap / frameDuration).rounded()) - 1)
        }
    }

    var summary: String {
        guard frameDuration > 0 else { return "display frames=unavailable (window not on screen)" }
        return "display \(Int((1 / frameDuration).rounded())) Hz frames=\(frames) hitches=\(hitches) dropped frames=\(dropped) "
            + "longest frame gap=\(String(format: "%.1fms", longest * 1000))"
            + ", newest row moved down=\(reversals) times (\(String(format: "%.0f", reversed)) pt, largest \(String(format: "%.0f", largestReversal)) pt)"
            + ", bottom gap changes=\(gapChanges)"
    }

    // MARK: Jumps

    /// While the transcript follows a streaming reply, the newest row may only move up on screen as it grows.
    /// Each frame where it moves down is a visible jump.
    weak var transcript: NSScrollView?
    private var newestTop: (row: String, y: CGFloat)?
    private var reversals = 0
    private var reversed: CGFloat = 0
    private var largestReversal: CGFloat = 0
    private var bottomGap: CGFloat?
    private var gapChanges = 0

    private func sampleNewestRow() {
        guard let scroll = transcript, let document = scroll.documentView else { return }
        let rows = TranscriptRowAnchorView.rows.allObjects.filter { $0.window != nil && $0.enclosingScrollView === scroll }
        // Window coordinates grow upward, so the newest row is the lowest, and moving down lowers its top.
        guard let newest = rows.min(by: { $0.convert($0.bounds, to: nil).maxY < $1.convert($1.bounds, to: nil).maxY }) else { return }
        let top = newest.convert(newest.bounds, to: nil).maxY
        let visible = scroll.contentView.bounds
        if let previous = newestTop, previous.row == newest.rowID, top < previous.y - 0.5 {
            reversals += 1
            reversed += previous.y - top
            largestReversal = max(largestReversal, previous.y - top)
        }
        newestTop = (newest.rowID, top)
        let gap = document.isFlipped ? document.bounds.maxY - visible.maxY : visible.minY - document.bounds.minY
        if let bottomGap, abs(gap - bottomGap) > 0.5 { gapChanges += 1 }
        bottomGap = gap
    }
}
