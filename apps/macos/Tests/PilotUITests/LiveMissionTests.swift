import AppKit
import PilotCore
import SwiftUI
import Testing
import WebKit
@testable import Pilot

/// Opt-in only. The runner supplies an isolated, real daemon and deterministic local model.
@Test(.enabled(if: ProcessInfo.processInfo.environment["PILOT_LIVE_TEST_URL"] != nil))
@MainActor func liveMissionFlows() async throws {
    _ = NSApplication.shared
    let url = try #require(ProcessInfo.processInfo.environment["PILOT_LIVE_TEST_URL"].flatMap(URL.init(string:)))
    let model = AppModel.shared
    let client = model.client
    client.connect(to: url)
    try await liveUntil { client.connected && !client.projects.isEmpty }
    let project = try #require(client.projects.first)
    let source = try await client.spawn(SpawnRequest(projectId: project.id, message: "Say hello. Do not use tools.",
                                                    title: "Source chat", model: "live-test/deterministic"))
    try await liveUntil { client.session(source.id)?.outcome == .done }
    let empty = try await client.createMission(CreateMissionRequest(projectId: project.id, title: "New goal", goal: "A user-created goal"))
    let made = try await client.createMission(CreateMissionRequest(projectId: project.id, title: "Drafted goal",
                                                                  goal: "", fromSessionId: source.id))
    let id = made.mission.id
    try await liveUntil { client.missionDetails[id]?.brief != nil && client.missionDetails[id]?.tasks.count == 1 }
    #expect(client.mission(id)?.coordinatorSessionId == source.id)
    #expect(client.mission(id)?.goal == "Live drafted goal")
    #expect(client.missionDetails[id]?.decisions.first?.text == "Keep data local")
    #expect(client.session(source.id)?.missionId == id)

    let other = try await client.spawn(SpawnRequest(projectId: project.id, message: "Say hello. Do not use tools.",
                                                   title: "Member chat", model: "live-test/deterministic"))
    try await liveUntil { client.session(other.id)?.outcome == .done }
    let task = try #require(client.missionDetails[id]?.tasks.first)
    _ = try await client.joinMission(other.id, JoinMissionRequest(missionId: id, taskId: task.id))
    try await liveUntil { client.missionDetails[id]?.tasks.first?.sessionId == other.id }
    _ = try await client.leaveMission(other.id)
    try await liveUntil { client.session(other.id)?.missionId == nil }
    #expect(try await client.missionDetail(id).tasks.first?.sessionId == nil)
    _ = try await client.joinMission(other.id, JoinMissionRequest(missionId: id))

    let rejected = try await client.spawn(SpawnRequest(projectId: project.id, message: "Say hello. Do not use tools.",
                                                      title: "Rejected join", model: "live-test/deterministic"))
    _ = try await client.joinMission(rejected.id, JoinMissionRequest(missionId: empty.mission.id))
    _ = try await client.updateMissionTask(id, taskId: task.id, MissionTaskWrite(sessionId: .set(other.id)))
    do {
        _ = try await client.joinMission(rejected.id, JoinMissionRequest(missionId: id, taskId: task.id))
        Issue.record("A stale task selection must fail")
    } catch let error as ClientError {
        #expect(error.status == 409)
    }
    try await liveUntil { client.session(rejected.id)?.missionId == empty.mission.id }
    #expect(try await client.missionDetail(id).tasks.first?.sessionId == other.id)

    let editor = BriefEditorState()
    editor.sync(client.missionDetails[id]?.brief)
    editor.text += "\nUser edit"
    await editor.save(missionId: id, client: client)
    #expect(editor.error == nil && editor.conflict == nil && !editor.dirty)
    let savedRevision = editor.baseRevision
    editor.text = "Unsaved local text"
    _ = try await client.saveMissionBrief(id, MissionBriefWrite(markdown: "# Concurrent edit", expectedRevision: savedRevision))
    try await liveUntil { client.missionDetails[id]?.brief?.revision == savedRevision + 1 }
    editor.sync(client.missionDetails[id]?.brief)
    #expect(editor.text == "Unsaved local text")
    await editor.save(missionId: id, client: client)
    #expect(editor.conflict == savedRevision + 1)
    #expect(editor.text == "Unsaved local text" && editor.dirty)
    await editor.reload(missionId: id, client: client)
    #expect(editor.text == "# Concurrent edit" && !editor.dirty && editor.conflict == nil)
    await editor.view(1, missionId: id, client: client)
    #expect(editor.viewing?.markdown.contains("Live draft") == true)

    let decision = try await client.addMissionDecision(id, text: "New user decision")
    _ = try await client.updateMissionDecision(id, decisionId: decision.id, text: "Edited user decision")
    #expect(try await client.missionDetail(id).decisions.contains { $0.text == "Edited user decision" })
    try await client.deleteMissionDecision(id, decisionId: decision.id)
    let comment = try await client.addMissionComment(id, MissionCommentWrite(text: "Please clarify", anchor: "Concurrent edit",
                                                                           targetSessionId: other.id))
    try await liveUntil { client.missionDetails[id]?.comments.contains { $0.id == comment.id } == true }
    // A user's own comment to a chat is not a user-facing attention item.
    #expect(!model.needsYou(try #require(client.mission(id))).contains { if case .comment = $0 { true } else { false } })
    _ = try await client.resolveMissionComment(id, commentId: comment.id)
    #expect(try await client.missionDetail(id).comments.first { $0.id == comment.id }?.isOpen == false)
    try await client.deleteMissionComment(id, commentId: comment.id)
    _ = try await client.updateMission(id, UpdateMissionRequest(coordinatorSessionId: .clear))
    try await liveUntil {
        guard let mission = client.mission(id) else { return false }
        return model.needsYou(mission).contains { if case .comment = $0 { true } else { false } }
    }
    _ = try await client.updateMission(id, UpdateMissionRequest(coordinatorSessionId: .set(source.id)))

    _ = try await client.updateMissionTask(id, taskId: task.id, MissionTaskWrite(status: .blocked, sessionId: .set(other.id)))
    try await liveUntil { client.missionDetails[id]?.tasks.first?.status == .blocked }
    #expect(model.needsYou(try #require(client.mission(id))).contains { if case .blockedTask = $0 { true } else { false } })
    _ = try await client.updateMissionTask(id, taskId: task.id, MissionTaskWrite(status: .todo, sessionId: .clear))
    let second = try await client.createMissionTask(id, MissionTaskWrite(title: "Second task", order: 1))
    let ordered = try await client.missionDetail(id).orderedTasks
    for move in MissionTaskOrdering.move(second.id, by: -1, in: ordered) {
        _ = try await client.updateMissionTask(id, taskId: move.taskId, MissionTaskWrite(order: move.order))
    }
    #expect(try await client.missionDetail(id).orderedTasks.first?.id == second.id)
    model.startChat(for: second, missionId: id)
    try await liveUntil { model.selectedSessionId != nil && model.selectedSessionId != source.id }
    let started = try #require(model.selectedSessionId)
    try await liveUntil { client.session(started)?.missionId == id && client.session(started)?.outcome == .done }
    #expect(try await client.missionDetail(id).tasks.first { $0.id == second.id }?.sessionId == started)
    for status in MissionTaskStatus.allCases {
        _ = try await client.updateMissionTask(id, taskId: task.id, MissionTaskWrite(status: status))
        #expect(try await client.missionDetail(id).tasks.first { $0.id == task.id }?.status == status)
    }
    let resource = try await client.addMissionResource(id, MissionResourceWrite(url: "https://github.com/octo/repo/pull/42", title: "Review"))
    #expect(resource.kind == .githubPullRequest && resource.externalId == "octo/repo#42")
    try await client.deleteMissionResource(id, resourceId: resource.id)
    _ = try await client.addMissionResource(id, MissionResourceWrite(url: "https://example.com/design", title: "Design"))
    _ = try await client.postMissionEvent(id, MissionEventWrite(text: "Live handoff", kind: .handoff, health: .atRisk))
    #expect(try await client.missionEvents(id).first?.text == "Live handoff")
    let oldest = try #require(try await client.missionEvents(id).last)
    #expect(try await client.missionEvents(id, before: oldest.id).allSatisfy { $0.id < oldest.id })

    try await liveUntil { client.session(source.id)?.outcome == .done }
    let artifact = try #require(try await client.sessionArtifacts(source.id).first)
    let pinned = try await client.linkMissionArtifact(id, MissionArtifactLinkWrite(sessionId: source.id,
                                                                                 artifactId: artifact.id, revision: 1))
    #expect(pinned.revision == 1)
    let reference = ArtifactReference(id: artifact.id, sessionId: source.id, title: artifact.title, revision: 1)
    #expect(try await client.artifact(reference).revision == 1)
    try await client.unlinkMissionArtifact(id, artifactId: artifact.id)
    let latest = try await client.linkMissionArtifact(id, MissionArtifactLinkWrite(sessionId: source.id, artifactId: artifact.id))
    #expect(latest.revision == nil)

    let control = try #require(ProcessInfo.processInfo.environment["PILOT_LIVE_CONTROL_URL"].flatMap(URL.init(string:)))
    let restart = Task { try await URLSession.shared.data(from: control.appendingPathComponent("restart")) }
    try await liveUntil { !client.connected }
    _ = try await restart.value
    try await liveUntil { client.connected && client.missionDetails[id]?.artifacts.count == 1 }
    _ = try await client.postMissionEvent(id, MissionEventWrite(text: "After reconnect"))
    try await liveUntil { client.missionDetails[id]?.events.first?.text == "After reconnect" }
    #expect(client.session(source.id)?.missionId == id)

    // These are the shipping native views, populated by WebSocket updates, not fixtures.
    model.openMission(id)
    try await liveUntil { client.missionDetails[id]?.resources.count == 1 }
    for tab in MissionTab.allCases {
        model.missionTab = tab
        try await liveCapture(MissionPage(missionId: id).environmentObject(model), name: tab.rawValue)
    }
    let member = try #require(client.session(other.id))
    try await liveCapture(MissionInspectorPane(session: member).environmentObject(model).frame(width: 320), name: "inspector")
    try await liveCapture(ArtifactViewer(reference: reference, latest: false).environmentObject(model),
                          name: "artifact-viewer", ready: liveImageReady)
    try await liveCapture(CreateMissionSheet(projectId: project.id, sourceSessionId: nil).environmentObject(model), name: "new", exercise: { host in
        try liveType(host, index: 0, text: "Native created")
        try liveType(host, index: 1, text: "A native form goal")
        try await Task.sleep(for: .milliseconds(100))
        try liveClick(host, x: 663, top: 868)
        try await liveUntil { client.missions.contains { $0.title == "Native created" } }
    })
    try await liveCapture(CreateMissionSheet(projectId: nil, sourceSessionId: rejected.id).environmentObject(model), name: "make", exercise: { host in
        try liveType(host, index: 0, text: "Native drafted")
        try await Task.sleep(for: .milliseconds(100))
        try liveClick(host, x: 663, top: 868)
        try await liveUntil { client.missions.contains { $0.title == "Native drafted" && $0.briefRevision == 1 } }
    })
    model.removeFromMission(other.id)
    try await liveUntil { client.session(other.id)?.missionId == nil }
    try await liveCapture(AddToMissionSheet(sessionId: other.id).environmentObject(model), name: "add", exercise: { host in
        try liveClick(host, x: 680, top: 868)
        try await liveUntil { client.session(other.id)?.missionId != nil }
    })
    let mission = try #require(client.mission(id))
    try await liveCapture(MissionSidebarRow(mission: mission, needsYou: model.needsYou(mission).count,
                                           chatCount: model.members(of: mission).count, working: 0,
                                           selected: true, isExpanded: .constant(true)).environmentObject(model).frame(width: 260),
                          name: "sidebar")
    #expect(client.mission(empty.mission.id) != nil)
}

@MainActor private func liveUntil(_ check: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(30)
    while !check() {
        if Date() > deadline { throw ClientError("Live condition timed out") }
        try await Task.sleep(for: .milliseconds(50))
    }
}

@MainActor private func liveCapture<V: View>(_ view: V, name: String,
                                            ready: ((NSView) async throws -> Void)? = nil,
                                            exercise: ((NSView) async throws -> Void)? = nil) async throws {
    let host = NSHostingView(rootView: view.frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.background))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 900),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    defer { window.close() }
    try await Task.sleep(for: .milliseconds(300))
    if let ready { try await ready(host) }
    host.layoutSubtreeIfNeeded()
    func describe(_ element: Any, depth: Int = 0) -> String {
        guard depth < 30, let accessible = element as? NSAccessibilityProtocol else { return "" }
        let row = String(repeating: " ", count: depth) + "\(accessible.accessibilityRole()?.rawValue ?? "") | \(accessible.accessibilityLabel() ?? "") | \(accessible.accessibilityTitle() ?? "") | \(accessible.accessibilityValue() ?? "")\n"
        return row + (accessible.accessibilityChildren() ?? []).map { describe($0, depth: depth + 1) }.joined()
    }
    func describeViews(_ view: NSView, depth: Int = 0) -> String {
        let text = (view as? NSTextField)?.stringValue ?? (view as? NSTextView)?.string ?? ""
        return String(repeating: " ", count: depth) + "\(type(of: view)) \(view.frame) \(text)\n"
            + view.subviews.map { describeViews($0, depth: depth + 1) }.joined()
    }
    let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: bitmap)
    let directory = ProcessInfo.processInfo.environment["PILOT_LIVE_CAPTURE_DIR"] ?? "/tmp/native-live"
    try (describe(host) + describeViews(host)).write(to: URL(filePath: directory).appendingPathComponent(name + ".txt"), atomically: true, encoding: .utf8)
    try #require(bitmap.representation(using: .png, properties: [:])).write(to: URL(filePath: directory).appendingPathComponent(name + ".png"))
    if let exercise { try await exercise(host) }
}

@MainActor private func liveType(_ host: NSView, index: Int, text: String) throws {
    func fields(_ view: NSView) -> [NSTextField] {
        if let field = view as? NSTextField, field.isEditable { return [field] }
        return view.subviews.flatMap(fields)
    }
    let inputs = fields(host)
    try #require(inputs.indices.contains(index), "Missing native input \(index)")
    let field = inputs[index]
    let window = try #require(host.window)
    window.makeFirstResponder(field)
    field.selectText(nil)
    let editor = try #require(field.currentEditor() as? NSTextView)
    editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
    window.makeFirstResponder(nil)
}

@MainActor private func liveImageReady(_ host: NSView) async throws {
    func findWeb(_ view: NSView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        return view.subviews.lazy.compactMap(findWeb).first
    }
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
        if let web = findWeb(host),
           let width = try? await web.evaluateJavaScript("document.querySelector('img')?.naturalWidth"),
           width as? Int == 1 { return }
        try await Task.sleep(for: .milliseconds(100))
    }
    throw ClientError("Live artifact image did not finish rendering")
}

@MainActor private func liveClick(_ host: NSView, x: CGFloat, top: CGFloat) throws {
    let window = try #require(host.window)
    let point = NSPoint(x: x, y: host.isFlipped ? top : host.bounds.height - top)
    let location = host.convert(point, to: nil)
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        let event = try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
            clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
        window.sendEvent(event)
    }
}
