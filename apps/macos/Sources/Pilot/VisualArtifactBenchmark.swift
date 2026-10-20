import AppKit
import Darwin
import PilotCore
import SwiftUI

/// Benchmarks observe when each artifact first draws: a visual's first tree, an HTML page's finished load.
@MainActor
enum ArtifactRenderTiming {
    static var rendered: ((String) -> Void)?
}

/// `Pilot --visual-artifact-bench <fixture.json> --kind visual|html`: opens a chat holding the fixture's ten charts
/// of one kind, offline (scripts/bench/visual-artifacts.ts writes the fixture, apps/macos/scripts/bench-visuals.sh
/// drives it). It reports, for Pilot together with the helper processes the artifacts start (WebKit's processes or
/// the visual service): the time to the first drawn artifact and to every artifact on screen when the chat opens,
/// physical footprint and process count once all ten have drawn, CPU while idle, and CPU, display-frame hitches and
/// frame times while scrolling through them at 60 Hz. One JSON line goes to stdout.
@MainActor
enum VisualArtifactBenchmark {
    static func run() async {
        setvbuf(stdout, nil, _IOLBF, 0)
        let arguments = CommandLine.arguments
        func value(_ flag: String) -> String? {
            arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        }
        do {
            guard let path = value("--visual-artifact-bench") else { throw ClientError("Pass the fixture path") }
            let kind = value("--kind") ?? "visual"
            let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any]
            for (name, source) in fixture?["libraries"] as? [String: String] ?? [:] {
                if let library = ArtifactLibrary(rawValue: name) { ArtifactLibraryHandler.benchmarkSources[library] = Data(source.utf8) }
            }
            let revisions = (fixture?["revisions"] as? [[String: Any]] ?? []).filter { $0["kind"] as? String == kind }
            guard !revisions.isEmpty else { throw ClientError("No \(kind) revisions in the fixture") }

            for window in NSApp.windows { window.orderOut(nil) }
            NSApp.appearance = NSAppearance(named: .aqua)
            let model = AppModel.shared
            let session = SessionSummary(id: "visual-bench", title: "Visual benchmark", cwd: "/tmp", createdAt: 0, updatedAt: 0,
                                         state: "idle", model: "fixture/model")
            model.client.loadFixture(projects: [], sessions: [session])
            model.client.fixtureModels = ModelList(models: [], defaultModel: "fixture/model")
            var entries: [JSONValue] = []
            for (index, object) in revisions.enumerated() {
                let revision = try ArtifactRevision.decoding(JSONSerialization.data(withJSONObject: object))
                let reference = ArtifactReference(id: revision.id, sessionId: session.id, title: revision.title, revision: 1)
                ArtifactInlineCache.store(revision, for: reference)
                let text = "### Chart \(index + 1)\n\nHere is \(revision.title.lowercased()), with the last twelve months."
                entries.append(.object(["id": .number(Double(entries.count + 1)), "kind": .string("pi.assistant"),
                                        "model": .array([.object(["role": .string("assistant"), "content": .string(text)])])]))
                entries.append(.object(["id": .number(Double(entries.count + 1)), "kind": .string("pilot.artifact"),
                                        "data": .object(["artifact": .object([
                                            "id": .string(revision.id), "sessionId": .string(session.id),
                                            "title": .string(revision.title), "revision": .number(1),
                                        ])])]))
            }
            var transcript = Transcript()
            transcript.apply(.object(["type": .string("snapshot"), "entries": .array(entries)]))
            let feed = SessionFeed(sessionId: session.id, transcript: transcript)

            let before = Set(HelperProcesses.current().keys)
            let clock = ContinuousClock()
            var drawn: [String: ContinuousClock.Instant] = [:]
            ArtifactRenderTiming.rendered = { id in if drawn[id] == nil { drawn[id] = clock.now } }
            let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 1280, height: 820),
                                  styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let hosting = NSHostingView(rootView: ChatView(session: session, feed: feed)
                .background(Theme.background).environmentObject(model).environment(\.pilotFonts, model.settings.fonts))
            window.contentView = hosting
            let opened = clock.now
            window.orderFrontRegardless()

            // First render: the chat opens at its newest rows; wait for what it shows to draw.
            try await waitUntil(seconds: 20) { !drawn.isEmpty }
            try await Task.sleep(for: .seconds(3))
            let firstDrawn = drawn.values.min().map { milliseconds(opened.duration(to: $0)) } ?? -1
            let openingSet = drawn
            let openingDrawn = openingSet.values.max().map { milliseconds(opened.duration(to: $0)) } ?? -1

            guard let observer = find(ScrollObserverView.self, in: hosting).first, let scroll = observer.enclosingScrollView else {
                throw ClientError("No transcript")
            }
            // Draw every artifact: scroll to the top and back, giving each row time to appear.
            for direction in [-1.0, 1.0] { try await sweep(scroll, direction: direction, step: 60, pause: .milliseconds(40)) }
            try await waitUntil(seconds: 20) { drawn.count >= revisions.count }
            try await Task.sleep(for: .seconds(3))

            let helpers = HelperProcesses.current().filter { !before.contains($0.key) || $0.value.isVisualService }
            let self_ = HelperProcesses.usage(getpid())
            let helperUsage = helpers.keys.compactMap { HelperProcesses.usage($0) }
            let footprint = (self_?.footprint ?? 0) + helperUsage.reduce(0) { $0 + $1.footprint }

            // Idle: nothing changes for five seconds.
            let idle = try await cpu(of: Array(helpers.keys), seconds: 5) {}

            // Scrolling: live-scroll steps at 60 Hz through every artifact, up then down.
            let frames = FrameMonitor()
            frames.start(on: hosting)
            var frameTimes: [Double] = []
            let scrolling = try await cpu(of: Array(helpers.keys), seconds: nil) {
                frameTimes = try await liveScroll(scroll, window: window, clock: clock)
            }
            frames.stop()
            frameTimes.sort()

            func p(_ q: Double) -> Double { frameTimes.isEmpty ? 0 : frameTimes[min(frameTimes.count - 1, Int(Double(frameTimes.count) * q))] }
            let result: [String: Any] = [
                "kind": kind,
                "artifacts": revisions.count,
                "drawn": drawn.count,
                "firstDrawnMs": round1(firstDrawn),
                "openingArtifacts": openingSet.count,
                "openingDrawnMs": round1(openingDrawn),
                "footprintMiB": round1(Double(footprint) / 1_048_576),
                "appFootprintMiB": round1(Double(self_?.footprint ?? 0) / 1_048_576),
                "helperProcesses": helpers.count,
                "helperNames": helpers.values.map(\.name).sorted(),
                "idleCPU": round1(idle.app + idle.helpers),
                "idleAppCPU": round1(idle.app),
                "scrollCPU": round1(scrolling.app + scrolling.helpers),
                "scrollAppCPU": round1(scrolling.app),
                "displayHz": frames.frameDuration > 0 ? Int((1 / frames.frameDuration).rounded()) : 0,
                "frames": frames.frames,
                "hitches": frames.hitches,
                "droppedFrames": frames.dropped,
                "longestFrameGapMs": round1(frames.longest * 1000),
                "hitchTimeRatioMsPerS": round1(frames.hitchTimeRatio),
                "scrollFrameP50Ms": round1(p(0.5)),
                "scrollFrameP95Ms": round1(p(0.95)),
                "scrollFramesOver16ms": frameTimes.filter { $0 > 16 }.count,
                "scrollSteps": frameTimes.count,
            ]
            let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: json, as: UTF8.self))
            feed.stop()
            window.close()
            exit(0)
        } catch {
            print("visual-artifact-bench failed: \(error)")
            exit(1)
        }
    }

    private static func waitUntil(seconds: Double, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > deadline { throw ClientError("Timed out waiting for artifacts to draw") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    /// CPU of Pilot and of the given helpers, in percent of one core, over a fixed time or while body runs.
    private static func cpu(of helpers: [pid_t], seconds: Double?, _ body: () async throws -> Void) async throws
        -> (app: Double, helpers: Double) {
        let appStart = HelperProcesses.usage(getpid())?.cpu ?? 0
        let helperStart = helpers.map { HelperProcesses.usage($0)?.cpu ?? 0 }
        let clock = ContinuousClock()
        let began = clock.now
        if let seconds { try await Task.sleep(for: .seconds(seconds)) } else { try await body() }
        let wall = Double(began.duration(to: clock.now).components.seconds)
            + Double(began.duration(to: clock.now).components.attoseconds) / 1e18
        let app = (HelperProcesses.usage(getpid())?.cpu ?? appStart) - appStart
        let helper = zip(helpers, helperStart).reduce(0.0) { total, pair in
            total + ((HelperProcesses.usage(pair.0)?.cpu ?? pair.1) - pair.1)
        }
        return (app / wall * 100, helper / wall * 100)
    }

    /// Live-scroll steps at 60 Hz, up to the top then back to the bottom, drawing each step. Returns each step's
    /// main-thread layout and display time in milliseconds.
    private static func liveScroll(_ scroll: NSScrollView, window: NSWindow, clock: ContinuousClock) async throws -> [Double] {
        let center = NotificationCenter.default
        let clip = scroll.contentView
        center.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        defer { center.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll) }
        var times: [Double] = []
        let began = clock.now
        var tick = 0
        for direction in [-1.0, 1.0] {
            while true {
                let visible = clip.bounds
                guard let document = scroll.documentView else { break }
                let top = document.bounds.minY - scroll.contentInsets.top
                let bottom = document.bounds.maxY - visible.height + scroll.contentInsets.bottom
                let target = min(bottom, max(top, visible.minY + direction * 30))
                if abs(target - visible.minY) < 0.5 { break }
                let start = clock.now
                clip.scroll(to: NSPoint(x: visible.minX, y: target))
                scroll.reflectScrolledClipView(clip)
                center.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
                window.contentView?.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                times.append(milliseconds(start.duration(to: clock.now)))
                tick += 1
                try await clock.sleep(until: began.advanced(by: .milliseconds(16) * tick))
            }
        }
        return times
    }

    /// Slow scrolling that lets rows realize and artifacts load between steps.
    private static func sweep(_ scroll: NSScrollView, direction: CGFloat, step: CGFloat, pause: Duration) async throws {
        let clip = scroll.contentView
        for _ in 0..<2000 {
            let visible = clip.bounds
            guard let document = scroll.documentView else { return }
            let top = document.bounds.minY - scroll.contentInsets.top
            let bottom = document.bounds.maxY - visible.height + scroll.contentInsets.bottom
            let target = min(bottom, max(top, visible.minY + direction * step))
            if abs(target - visible.minY) < 0.5 { return }
            clip.scroll(to: NSPoint(x: visible.minX, y: target))
            scroll.reflectScrolledClipView(clip)
            try await Task.sleep(for: pause)
        }
    }

    private static func milliseconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
    }

    private static func round1(_ value: Double) -> Double { (value * 10).rounded() / 10 }

    private static func find<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
        if let match = view as? T { return [match] }
        return view.subviews.flatMap { find(type, in: $0) }
    }
}

/// The processes artifacts run in: WebKit's content, GPU and networking processes, and the visual service.
enum HelperProcesses {
    struct Process {
        let name: String
        let isVisualService: Bool
    }

    struct Usage {
        let footprint: UInt64
        /// User and system CPU seconds since the process started.
        let cpu: Double
    }

    /// Matching processes now: WebKit's (any app's, so callers diff against a snapshot) and this bundle's
    /// visual service.
    static func current() -> [pid_t: Process] {
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return [:] }
        var pids = [pid_t](repeating: 0, count: Int(count) + 64)
        let filled = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        let bundle = Bundle.main.bundlePath
        var result: [pid_t: Process] = [:]
        for pid in pids.prefix(Int(max(0, filled))) where pid > 0 {
            var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
            guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { continue }
            let path = String(cString: buffer)
            let name = (path as NSString).lastPathComponent
            if name.hasPrefix("com.apple.WebKit.") {
                result[pid] = Process(name: name, isVisualService: false)
            } else if name == "PilotVisuals", path.hasPrefix(bundle) {
                result[pid] = Process(name: name, isVisualService: true)
            }
        }
        return result
    }

    static func usage(_ pid: pid_t) -> Usage? {
        var info = rusage_info_v4()
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        guard status == 0 else { return nil }
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        let ticks = Double(info.ri_user_time + info.ri_system_time)
        return Usage(footprint: info.ri_phys_footprint, cpu: ticks * Double(timebase.numer) / Double(timebase.denom) / 1e9)
    }
}
