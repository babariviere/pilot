import AppKit
import PilotCore
import SwiftUI

/// `Pilot --mission-tabs-check` switches the tabs of a large offline mission (100 tasks, a 50 KB brief,
/// 1,000 activity events) in a real window and reports how long the main thread is blocked per switch.
/// It never connects to the daemon. Add `--rounds N` to change how often every tab is visited.
@MainActor
enum MissionTabsCheck {
    static func run() async {
        let arguments = CommandLine.arguments
        let rounds = arguments.firstIndex(of: "--rounds").flatMap { Int(arguments[safe: $0 + 1] ?? "") } ?? 4
        NSApp.appearance = NSAppearance(named: .aqua)
        for window in NSApp.windows { window.close() }
        let model = AppModel.shared
        let fixture = MissionTabsFixture()
        model.client.loadFixture(projects: [fixture.project], sessions: fixture.sessions)
        model.client.loadMissionFixture([fixture.detail])
        model.daemon.markRunningForSnapshot()
        model.inspectorVisible = false
        model.openMission(fixture.detail.mission.id)
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1280, height: 860),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MainWindow().environmentObject(model)
            .environment(\.pilotFonts, model.settings.fonts))
        window.orderFrontRegardless()
        try? await Task.sleep(for: .seconds(2))
        await calibrate()

        // --tabs tasks,overview limits the cycle, for profiling one tab.
        let order: [MissionTab] = arguments.firstIndex(of: "--tabs").flatMap { arguments[safe: $0 + 1] }
            .map { $0.split(separator: ",").compactMap { MissionTab(rawValue: String($0)) } }
            ?? [.tasks, .brief, .chats, .artifacts, .activity, .overview]
        var results: [MissionTab: [Switch]] = [:]
        var taskRows: [Int] = []
        for _ in 0..<rounds {
            for tab in order {
                let rows = MissionTaskRow.bodyEvaluations
                results[tab, default: []].append(await measure(tab, model: model, window: window))
                if tab == .tasks { taskRows.append(MissionTaskRow.bodyEvaluations - rows) }
            }
        }
        func ms(_ value: Double) -> String { String(format: "%7.1f ms", value) }
        func median(_ values: [Double]) -> Double { values.isEmpty ? 0 : values.sorted()[values.count / 2] }
        print("mission-tabs-check: \(fixture.detail.tasks.count) tasks, \(fixture.detail.brief?.markdown.utf8.count ?? 0) B brief, "
              + "\(fixture.detail.events.count) events, \(rounds) rounds")
        print("Wall times include waiting for the CPU on a busy machine; main-thread CPU time does not.")
        print("tab         first sync  first stall   first cpu | median sync median stall  median cpu | worst stall")
        for tab in order {
            let runs = results[tab] ?? []
            guard let first = runs.first else { continue }
            let later = Array(runs.dropFirst())
            print("\(tab.rawValue.padding(toLength: 10, withPad: " ", startingAt: 0)) "
                  + "\(ms(first.sync))  \(ms(first.stall))  \(ms(first.cpu)) | \(ms(median(later.map(\.sync))))  "
                  + "\(ms(median(later.map(\.stall))))  \(ms(median(later.map(\.cpu)))) | \(ms(runs.map(\.stall).max() ?? 0))")
        }
        if !taskRows.isEmpty {
            print("Task rows built per switch to Tasks: \(taskRows.map(String.init).joined(separator: ", ")) "
                  + "of \(fixture.detail.tasks.filter { !$0.status.isClosed }.count) open tasks")
        }
        if let index = arguments.firstIndex(of: "--screenshot"), let path = arguments[safe: index + 1] {
            for tab in order {
                model.missionTab = tab
                try? await Task.sleep(for: .milliseconds(400))
                if let view = window.contentView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                    view.cacheDisplay(in: view.bounds, to: bitmap)
                    try? bitmap.representation(using: .png, properties: [:])?
                        .write(to: URL(fileURLWithPath: "\(path)-\(tab.rawValue).png"))
                }
            }
        }
        window.close()
        exit(0)
    }

    struct Switch {
        /// Selecting the tab through the first synchronous layout and display.
        var sync: Double
        /// Longest main-thread gap in the following second, including deferred work such as Markdown blocks.
        var stall: Double
        /// Main-thread CPU time from the switch through the following second, less the idle polling.
        var cpu: Double
    }

    private static func measure(_ tab: MissionTab, model: AppModel, window: NSWindow) async -> Switch {
        let clock = ContinuousClock()
        let cpuStart = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        let start = clock.now
        model.missionTab = tab
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let sync = milliseconds(start.duration(to: clock.now))
        var stall = sync
        var last = clock.now
        let end = last.advanced(by: .seconds(1))
        var polls = 0
        while clock.now < end {
            try? await Task.sleep(for: .milliseconds(2))
            polls += 1
            let now = clock.now
            stall = max(stall, milliseconds(last.duration(to: now)))
            last = now
        }
        let cpu = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - cpuStart) / 1e6
        return Switch(sync: sync, stall: stall, cpu: max(0, cpu - Double(polls) * idlePollCost))
    }

    /// Main-thread CPU time of one idle poll, measured once before the switches.
    private static var idlePollCost = 0.0

    private static func calibrate() async {
        let cpuStart = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        for _ in 0..<200 { try? await Task.sleep(for: .milliseconds(2)) }
        idlePollCost = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - cpuStart) / 1e6 / 200
    }

    private static func milliseconds(_ duration: Duration) -> Double {
        let parts = duration.components
        return Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1e15
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

/// A long-running mission: 100 tasks with descriptions, links, artifacts and dependencies, twelve chats,
/// a 50 KB brief and 1,000 activity events over three months.
@MainActor
struct MissionTabsFixture {
    let project: Project
    let sessions: [SessionSummary]
    let detail: MissionDetail

    init(taskCount: Int = 100, briefBytes: Int = 50_000, eventCount: Int = 1000) {
        let now = Date().timeIntervalSince1970 * 1000
        let missionId = "large-mission"
        project = Project(id: "large", name: "Large mission fixture", path: "/tmp/pilot-large-mission", createdAt: now)
        let topics = ["Port auth", "Pagination", "Error envelope", "SDK"]
        sessions = (0..<12).map { index in
            SessionSummary(id: "chat-\(index)", title: "Mission chat \(index): \(topics[index % 4])",
                           cwd: "/tmp/pilot-large-mission", projectId: "large", branch: "feat/chat-\(index)",
                           createdAt: now - Double(index) * 3_600_000, updatedAt: now - Double(index) * 60_000,
                           // Idle: working chats animate in the sidebar, which would add to every measurement.
                           state: "idle", missionId: missionId)
        }
        let statuses: [String] = (0..<taskCount).map { index in
            switch index % 20 {
            case 0..<8: "done"
            case 8: "dropped"
            case 9..<15: "todo"
            case 15, 16: "in_progress"
            case 17, 18: "in_review"
            default: "blocked"
            }
        }
        var tasks: [[String: Any]] = []
        var resources: [[String: Any]] = []
        var artifacts: [[String: Any]] = []
        let phases = ["Phase 1 polish", "Phase 2: coordination", "Phase 3: Linear"]
        for index in 0..<taskCount {
            var task: [String: Any] = [
                "id": "task-\(index)", "number": index + 1,
                "title": "Task \(index + 1): make the mission page responsive with long content and live updates",
                "body": "Reported after the redesign. Measure first, then fix the slow path without changing the layout. "
                    + "Keep the change focused and add a regression test where it helps. Details in the brief, section \(index % 9).",
                "status": statuses[index], "order": Double(index), "milestone": phases[index % 3],
                "createdAt": now, "updatedAt": now,
            ]
            if index % 4 == 1 { task["sessionId"] = "chat-\(index % 12)" }
            if index > 3, index % 5 == 0 { task["dependsOn"] = ["task-\(index - 1)", "task-\(index - 3)"] }
            tasks.append(task)
            resources.append(["id": "pr-\(index)", "taskId": "task-\(index)", "url": "https://github.com/acme/app/pull/\(1000 + index)",
                              "kind": "github.pr", "externalId": "acme/app#\(1000 + index)", "createdAt": now,
                              "pullRequest": ["number": 1000 + index, "url": "https://github.com/acme/app/pull/\(1000 + index)",
                                              "title": "Task \(index + 1)", "state": statuses[index] == "done" ? "merged" : "open",
                                              "checkedAt": now]])
            if index % 3 == 0 {
                resources.append(["id": "lin-\(index)", "taskId": "task-\(index)", "url": "https://linear.app/acme/issue/APP-\(index)",
                                  "kind": "linear.issue", "externalId": "APP-\(index)", "createdAt": now])
            }
            if index % 4 == 0 {
                artifacts.append(["artifactId": "artifact-\(index)", "sessionId": "chat-\(index % 12)", "taskId": "task-\(index)",
                                  "title": "Mockup \(index)", "kind": "swiftui", "revision": 2, "linkedAt": now])
            }
        }
        for index in 0..<20 {
            resources.append(["id": "link-\(index)", "url": "https://example.com/spec/\(index)", "kind": "url",
                              "title": "Spec \(index)", "createdAt": now])
            artifacts.append(["artifactId": "mission-artifact-\(index)", "sessionId": "chat-\(index % 12)",
                              "title": "Diagram \(index)", "kind": "html", "linkedAt": now])
        }
        let kinds = ["update", "task", "claim", "handoff", "resource", "brief", "decision", "comment"]
        let events: [[String: Any]] = (0..<eventCount).map { index in
            var event: [String: Any] = [
                "id": eventCount - index, "kind": kinds[index % kinds.count],
                "text": "Event \(eventCount - index): task #\(index % taskCount + 1) moved forward. The chat posted a short update "
                    + "about what changed, what remains and what it needs from the user.",
                "at": now - Double(index) * 2_600_000,
            ]
            if index % 3 != 0 { event["sessionId"] = "chat-\(index % 12)" }
            if index % 7 == 0 { event["health"] = "on_track" }
            return event
        }
        let detail: [String: Any] = [
            "mission": ["id": missionId, "projectId": "large", "title": "Large mission",
                        "goal": "Let several chats of one project share a goal, tracked from one mission page.",
                        "status": "active", "coordinatorSessionId": "chat-0", "briefRevision": 37,
                        "createdAt": now - 30 * 86_400_000, "updatedAt": now],
            "brief": ["missionId": missionId, "revision": 37, "markdown": Self.brief(bytes: briefBytes),
                      "authorSessionId": "chat-0", "createdAt": now - 600_000],
            "decisions": (0..<30).map { ["id": "decision-\($0)", "text": "Decision \($0): keep the mission page calm and fast, "
                + "and measure tab switches with large missions.", "createdAt": now, "updatedAt": now] },
            "comments": (0..<10).map { ["id": "comment-\($0)", "text": "Comment \($0) on the brief.", "authorSessionId": "chat-\($0)",
                                        "createdAt": now - Double($0) * 60_000] },
            "tasks": tasks, "artifacts": artifacts, "resources": resources, "events": events,
        ]
        let data = try! JSONSerialization.data(withJSONObject: detail)
        self.detail = try! JSONDecoder().decode(MissionDetail.self, from: data)
    }

    /// Headings, paragraphs, lists and code, repeated to the requested size.
    static func brief(bytes: Int) -> String {
        var text = "# Missions\n\n"
        var section = 0
        while text.utf8.count < bytes {
            section += 1
            text += """
            ## Section \(section)

            Missions let several chats of one project share a goal: a versioned brief, tasks, decisions, comments, links, \
            artifacts and activity, tracked from one mission page. This section records the **intent** and the `constraints`.

            - The coordinator reads the brief and keeps tasks current.
            - Chats claim tasks, open one pull request each and link it.
            - The user reviews results and records decisions.

            ```swift
            let detail = client.missionDetails[missionId]
            let open = detail?.tasks.filter { !$0.status.isClosed }
            ```

            > Decisions override the brief. Edit the brief with an expected revision.


            """
        }
        return text
    }
}
