import AppKit
import GhosttyTerminal
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func terminalOpeningReopeningAndRestartingAcquireKeyboardFocus() async throws {
    _ = NSApplication.shared
    let hosts = HostClients()
    let host = HostRef(hostId: "local", daemonId: "focus", lineageId: "test")
    let client = PilotClient()
    client.loadFixture(projects: [], sessions: [])
    try hosts.install(client, host: host)
    let store = TerminalStore(hosts: hosts)
    func ref(_ session: SessionSummary) -> HostResourceRef { HostResourceRef(host: host, kind: .session, localId: session.id) }
    let paneID = UUID()
    let session = SessionSummary(id: "focus-a", title: "Terminal", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle")
    let other = SessionSummary(id: "focus-b", title: "Other", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle")
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 300),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer {
        window.close()
        for id in Array(store.order) { store.remove(id) }
    }
    let container = NSView(frame: window.contentLayoutRect)
    window.contentView = container
    let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 100, height: 40))
    container.addSubview(editor)
    #expect(window.makeFirstResponder(editor))

    func mount(_ session: SessionSummary) throws -> NSHostingView<TerminalSurfaceView> {
        let state = try #require(store.states[ref(session).storageKey])
        let hosting = NSHostingView(rootView: TerminalSurfaceView(context: state))
        hosting.frame = NSRect(x: 100, y: 0, width: 500, height: 300)
        container.addSubview(hosting)
        hosting.layoutSubtreeIfNeeded()
        return hosting
    }
    func focused(in hosting: NSView) -> Bool {
        guard let responder = window.firstResponder as? AppTerminalView else { return false }
        return responder.isDescendant(of: hosting)
    }
    func waitForFocus(in hosting: NSView) async -> Bool {
        for _ in 0..<100 {
            if focused(in: hosting) { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return focused(in: hosting)
    }

    // A hidden, cached terminal must leave the editor alone.
    store.select(session, ref: ref(session), isVisible: false, paneID: paneID)
    var hosting = try mount(session)
    try await Task.sleep(for: .milliseconds(100))
    #expect(window.firstResponder === editor)
    store.select(session, ref: ref(session), isVisible: true, paneID: paneID)
    #expect(await waitForFocus(in: hosting))

    // Session status updates must not steal focus back after the user clicks the editor.
    #expect(window.makeFirstResponder(editor))
    store.select(session, ref: ref(session), isVisible: true, paneID: paneID)
    try await Task.sleep(for: .milliseconds(100))
    #expect(window.firstResponder === editor)

    store.select(session, ref: ref(session), isVisible: false, paneID: paneID)
    store.select(session, ref: ref(session), isVisible: true, paneID: paneID)
    #expect(await waitForFocus(in: hosting))

    // Newly created surfaces can request focus before they are mounted in a window.
    store.select(other, ref: ref(other), isVisible: true, paneID: paneID)
    let otherHosting = try mount(other)
    #expect(await waitForFocus(in: otherHosting))
    store.select(session, ref: ref(session), isVisible: true, paneID: paneID)
    #expect(await waitForFocus(in: hosting))

    // Reopening the inspector creates a new pane owner around the cached surface.
    store.paneDidDisappear(sessionId: ref(session).storageKey, paneID: paneID)
    #expect(window.makeFirstResponder(editor))
    store.select(session, ref: ref(session), isVisible: true, paneID: UUID())
    #expect(await waitForFocus(in: hosting))

    store.restart(session, ref: ref(session))
    hosting.removeFromSuperview()
    hosting = try mount(session)
    #expect(await waitForFocus(in: hosting))

    // Workspace preparation finishes after the terminal pane has already opened.
    let preparing = SessionSummary(id: "focus-preparing", title: "Preparing", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "starting")
    store.select(preparing, ref: ref(preparing), isVisible: true, paneID: paneID)
    #expect(store.states[ref(preparing).storageKey] == nil)
    let prepared = SessionSummary(id: preparing.id, title: preparing.title, cwd: preparing.cwd, createdAt: 1, updatedAt: 2, state: "idle")
    store.select(prepared, ref: ref(prepared), isVisible: true, paneID: paneID)
    let preparedHosting = try mount(prepared)
    #expect(await waitForFocus(in: preparedHosting))
}
