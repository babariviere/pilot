import AppKit
import NativeTestSupport
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Suite(.serialized) @MainActor
struct DiagnosticSetupInteractionTests {
    @Test(.timeLimit(.minutes(1)))
    func diagnoseSetupSubmitsReasonOrBlankThroughMountedControls() async throws {
        for reason in ["Why does the composer freeze after reconnect?", " \n\t"] {
            let fixture = try DiagnosticSetupFixture()
            do {
                try await fixture.present()
                let editor = try fixture.editor()
                #expect(editor.returnInsertsNewline, "Return must keep editing this multiline reason")
                fixture.enter(reason, in: editor)
                try await fixture.settle()
                let start = try fixture.control("sheet-primary")
                #expect(start.controlEnabled, "blank is a valid optional reason")
                #expect(fixture.client.fixtureSpawnRequests.isEmpty)
                try await NativeInput.click(start)
                try await fixture.settle { fixture.window.attachedSheet == nil }
                let request = try #require(fixture.client.fixtureSpawnRequests.first)
                #expect(fixture.client.fixtureSpawnRequests.count == 1)
                #expect(request.role == .diagnostics && request.mode == .ask)
                #expect(request.diagnosticTarget?.host == fixture.host)
                #expect(request.diagnosticTarget?.sessionId == fixture.source.id)
                #expect(request.diagnosticHistoryAccess == true)
                if reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    #expect(request.message.contains("Diagnose your admitted target chat"))
                    #expect(request.diagnosticTitleFromReply == true)
                } else {
                    #expect(request.message == reason)
                    #expect(request.diagnosticTitleFromReply == nil)
                }
                fixture.expectOriginalUnchanged()
            } catch { await fixture.close(); throw error }
            await fixture.close()
        }
    }

    @Test(.timeLimit(.minutes(1)))
    func diagnoseReasonBoundsApplyToButtonAndKeyboardAndCancelStartsNothing() async throws {
        let fixture = try DiagnosticSetupFixture()
        do {
            try await fixture.present()
            let editor = try fixture.editor()
            let exact = String(repeating: "é", count: DiagnosticSetup.maxQuestionBytes / 2)
            fixture.enter(exact + "é", in: editor)
            try await fixture.settle { try fixture.control("sheet-primary").controlEnabled == false }
            try fixture.commandReturn(editor)
            try await fixture.settle()
            #expect(fixture.client.fixtureSpawnRequests.isEmpty, "keyboard submission also enforces the byte limit")
            #expect(editor.string == exact + "é", "invalid input must not be silently truncated")
            fixture.enter(exact, in: editor)
            try await fixture.settle { try fixture.control("sheet-primary").controlEnabled }
            try await NativeInput.click(fixture.control("sheet-cancel"))
            try await fixture.settle { fixture.window.attachedSheet == nil }
            #expect(fixture.client.fixtureSpawnRequests.isEmpty)
            fixture.expectOriginalUnchanged()
        } catch { await fixture.close(); throw error }
        await fixture.close()
    }

    @Test(.timeLimit(.minutes(1)))
    func diagnoseStartErrorKeepsReasonForKeyboardRetryAndAskStillSubmits() async throws {
        for askingAboutPilot in [false, true] {
            let fixture = try DiagnosticSetupFixture()
            do {
                try await fixture.present(askingAboutPilot: askingAboutPilot)
                let setup = try #require(fixture.app.diagnosticSetupTarget)
                let target = try DiagnosticSetup.resolve(selected: setup.reference, setup: setup,
                    localHost: fixture.host, local: fixture.client.sessions, hosted: fixture.app.hosts.sessions)
                let editor = try fixture.editor()
                let reason = "Investigate a reconnect failure, not a request to restart anything."
                fixture.enter(reason, in: editor)
                try await fixture.settle()
                fixture.app.diagnosingSessions.insert(target.admissionKey)
                try await NativeInput.click(fixture.control("sheet-primary"))
                try await fixture.settle()
                #expect(fixture.window.attachedSheet != nil, "a rejected start must keep setup open")
                #expect(fixture.client.fixtureSpawnRequests.isEmpty)
                #expect(try fixture.editor().string == reason, "start errors preserve the user's draft")
                #expect(try fixture.control("sheet-primary").controlEnabled)
                fixture.app.diagnosingSessions.remove(target.admissionKey)
                try fixture.commandReturn(fixture.editor())
                try await fixture.settle { fixture.window.attachedSheet == nil }
                let request = try #require(fixture.client.fixtureSpawnRequests.first)
                #expect(fixture.client.fixtureSpawnRequests.count == 1)
                #expect(request.message == reason)
                #expect(request.role == .diagnostics && request.mode == .ask)
                if askingAboutPilot {
                    #expect(request.diagnosticScope == .app && request.diagnosticTarget == nil)
                    #expect(request.diagnosticHost == fixture.host)
                } else {
                    #expect(request.diagnosticTarget?.host == fixture.host)
                    #expect(request.diagnosticTarget?.sessionId == fixture.source.id)
                }
                fixture.expectOriginalUnchanged()
            } catch { await fixture.close(); throw error }
            await fixture.close()
        }
    }
}

private struct DiagnosticSetupFixtureRoot: View {
    @ObservedObject var app: AppModel
    var body: some View {
        Color.clear.frame(width: 660, height: 850)
            .sheet(item: $app.diagnosticSetupTarget) { setup in
                DiagnosticSetupSheet(setup: setup).environmentObject(app)
            }
    }
}

@MainActor private final class DiagnosticSetupFixture {
    let host = HostRef(hostId: "local", daemonId: "setup-daemon", lineageId: "setup-lineage")
    let source = SessionSummary(id: "01234567-89ab-4cde-8fab-0123456789ab", title: "Original chat",
        cwd: "/fixture/source", createdAt: 1, updatedAt: 2, state: "idle", mode: .ask)
    let client = PilotClient()
    let app: AppModel
    let window: NSWindow
    let directory: URL
    let defaults: UserDefaults
    let suite = "DiagnosticSetupInteractionTests.\(UUID().uuidString)"

    init() throws {
        _ = NSApplication.shared
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defaults = try #require(UserDefaults(suiteName: suite))
        let hosts = ClientDirectory(operationDirectory: directory)
        app = AppModel(projectFolderDefaults: defaults, client: client, hosts: hosts)
        client.loadFixture(projects: [], sessions: [source])
        client.fixtureModels = ModelList(models: [ModelOption(id: "fixture/diagnostic", provider: "fixture",
            name: "Offline diagnostics", thinkingLevels: ["off", "high"])], defaultModel: "fixture/diagnostic")
        try app.registerLocal(host)
        try hosts.install(client, host: host)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 850),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: DiagnosticSetupFixtureRoot(app: app))
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderFrontRegardless()
    }

    func present(askingAboutPilot: Bool = false) async throws {
        if askingAboutPilot { app.askAboutPilot() } else { app.diagnose(source) }
        try await settle { self.window.attachedSheet?.contentView != nil }
        try await settle { try self.control("sheet-primary").controlEnabled }
        #expect(client.fixtureSpawnRequests.isEmpty, "opening setup starts nothing")
    }

    func control(_ id: String) throws -> ControlGeometryView {
        let content = try #require(window.attachedSheet?.contentView)
        return try #require(NativeInput.views(in: content, of: ControlGeometryView.self)
            .first { $0.identifier?.rawValue == id })
    }

    func editor() throws -> SubmitTextView {
        let content = try #require(window.attachedSheet?.contentView)
        let editors = NativeInput.views(in: content, of: SubmitTextView.self)
        try #require(editors.count == 1, "both setup modes mount the existing bounded question editor")
        return try #require(editors.first)
    }

    func enter(_ value: String, in editor: SubmitTextView) {
        editor.string = value
        editor.didChangeText()
    }

    func commandReturn(_ editor: SubmitTextView) throws {
        let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: editor.window?.windowNumber ?? 0,
            context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        editor.keyDown(with: event)
    }

    func settle(until ready: () throws -> Bool = { true }) async throws {
        for pass in 0..<150 {
            window.contentView?.layoutSubtreeIfNeeded()
            window.attachedSheet?.contentView?.layoutSubtreeIfNeeded()
            window.update()
            try await Task.sleep(for: .milliseconds(20))
            if pass >= 11, (try? ready()) == true { return }
        }
        try #require(try ready(), "the production setup sheet must settle")
    }

    func expectOriginalUnchanged(sourceLocation: SourceLocation = #_sourceLocation) {
        #expect(client.session(source.id) == source, sourceLocation: sourceLocation)
        #expect(client.fixtureSendRequests.isEmpty, "the reason never goes to the diagnosed chat", sourceLocation: sourceLocation)
    }

    func close() async {
        if let sheet = window.attachedSheet { window.endSheet(sheet) }
        window.contentView = nil; window.close()
        await app.hosts.disconnectAll()
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
    }
}
