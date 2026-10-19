import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Suite(.serialized) @MainActor
struct DiagnosticRepairFooterTests {
    @Test(arguments: [420.0, 800.0, 1400.0])
    func productionFooterStaysFixedWhileReadingLongHistoryAndKeepsTheComposer(width: CGFloat) async throws {
        let fixture = try FooterFixture(width: width)
        defer { fixture.close() }
        fixture.seedHistory()
        try await fixture.settle { fixture.feed.presentation.historyRowCount == 500 }
        let anchor = try #require(fixture.anchor(.primary))
        let observer = try #require(fixture.views(ScrollObserverView.self).first)
        let scroll = try #require(observer.enclosingScrollView)
        let document = try #require(scroll.documentView)
        #expect(!anchor.isDescendant(of: document), "the production repair control is outside transcript scrolling")
        #expect(fixture.views(DiagnosticRepairActionAnchorView.self).filter { $0.role == .primary }.count == 1)
        let originalFrame = anchor.convert(anchor.bounds, to: fixture.hosting)
        #expect(fixture.hosting.bounds.contains(originalFrame))
        let editor = try #require(fixture.views(SubmitTextView.self).first)
        fixture.expectActionAlignedWithComposer(anchor, editor: editor)
        #expect(fixture.window.makeFirstResponder(editor))
        fixture.window.update()
        let responder = fixture.window.firstResponder

        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 40))
        scroll.reflectScrolledClipView(scroll.contentView)
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
        try await fixture.settle()
        #expect(anchor.convert(anchor.bounds, to: fixture.hosting) == originalFrame)
        let readingOrigin = scroll.contentView.bounds.origin
        let proposal = fixture.proposal()
        fixture.state.session.diagnosticRepairProposal = proposal
        fixture.updateClient()
        try await fixture.settle { fixture.anchor(.dismiss) != nil }
        #expect(fixture.anchor(.primary) === anchor, "proposal publication keeps the one action mounted")
        #expect(fixture.views(DiagnosticRepairActionAnchorView.self).filter { $0.role == .primary }.count == 1,
                "the summary must not add a duplicate primary Review control")
        #expect(fixture.views(SubmitTextView.self).contains { $0 === editor }, "review no longer replaces the composer")
        #expect(fixture.composer.draft == "Keep this draft")
        #expect(fixture.window.firstResponder === responder, "publication does not take keyboard focus")
        #expect(abs(scroll.contentView.bounds.origin.y - readingOrigin.y) <= 1, "publication never scrolls to the newest row")
        #expect(fixture.client.fixtureSpawnRequests.isEmpty)

        let dismissAnchor = try #require(fixture.anchor(.dismiss))
        let dismissButton = try #require(fixture.button(at: dismissAnchor))
        dismissButton.performClick(nil)
        try await fixture.settle { fixture.anchor(.dismiss) == nil }
        #expect(fixture.model.dismissedDiagnosticRepairProposal(for: fixture.reference) == proposal.id)
        #expect(fixture.anchor(.primary) != nil, "Not now hides the summary, never the fixed Review action")
        #expect(fixture.client.fixtureSpawnRequests.isEmpty)
        let reviewButtonAnchor = try #require(fixture.anchor(.primary))
        let reviewButton = try #require(fixture.button(at: reviewButtonAnchor))
        reviewButton.performClick(nil)
        #expect(fixture.model.diagnosticRepairTarget?.reference == fixture.reference)
        #expect(fixture.client.fixtureSpawnRequests.isEmpty, "Review alone cannot start a Build")
    }

    @Test(arguments: [420.0, 1400.0])
    func questionWorkingPendingAndErrorTransitionsLeaveTheFooterReachable(width: CGFloat) async throws {
        let fixture = try FooterFixture(width: width)
        defer { fixture.close() }
        fixture.seedHistory()
        try await fixture.settle { fixture.feed.status.hasRows }
        var presentation = fixture.feed.presentation
        presentation.pendingQuestion = AgentQuestion(entryID: 501, question: "Which symptom should I inspect?",
            options: [.init(label: "Sidebar"), .init(label: "Reconnect")])
        fixture.feed.presentation = presentation
        fixture.state.session.diagnosticRepairProposal = fixture.proposal()
        fixture.updateClient()
        try await fixture.settle()
        #expect(fixture.feed.status.questionForComposer(session: fixture.state.session, hasSnapshot: true) != nil)
        #expect(fixture.anchor(.primary) != nil && fixture.anchor(.dismiss) == nil,
                "the live question stays in front while the single Review action remains reachable")
        #expect(!fixture.views(SubmitTextView.self).isEmpty)

        presentation.pendingQuestion = nil; presentation.working = true
        fixture.feed.presentation = presentation
        fixture.state.session.diagnosticRepairProposal = nil
        fixture.setWorking()
        fixture.updateClient()
        try await fixture.settle()
        let requestAnchor = try #require(fixture.anchor(.primary))
        let request = try #require(fixture.button(at: requestAnchor))
        request.performClick(nil); request.performClick(nil)
        try await fixture.settle { fixture.client.fixtureSendRequests.count == 1 }
        #expect(fixture.model.diagnosticRepairRequest(for: fixture.reference)?.isPending == true)
        let pendingAnchor = try #require(fixture.anchor(.primary))
        let editor = try #require(fixture.views(SubmitTextView.self).first)
        fixture.expectActionAlignedWithComposer(pendingAnchor, editor: editor)
        #expect(fixture.client.fixtureSpawnRequests.isEmpty)
        #expect(!fixture.views(SubmitTextView.self).isEmpty, "working/request state keeps the normal composer and Stop region")

        var failed = try #require(fixture.model.diagnosticRepairRequest(for: fixture.reference))
        failed.phase = .failed; failed.error = "Synthetic unavailable host"
        fixture.model.diagnosticRepairRequests[fixture.reference.storageKey] = failed
        try await fixture.settle()
        #expect(fixture.anchor(.primary) != nil)
        #expect(fixture.model.diagnosticRepairRequest(for: fixture.reference)?.error == failed.error)
        let failedAnchor = try #require(fixture.anchor(.primary))
        fixture.expectActionAlignedWithComposer(failedAnchor, editor: editor)
        #expect(fixture.client.fixtureSendRequests.count == 1 && fixture.client.fixtureSpawnRequests.isEmpty)
    }

    @Test func originalPendingStartRemainsCheckableWithoutAProposalAndOfflineActionsStayDisabled() async throws {
        let fixture = try FooterFixture(width: 420)
        defer { fixture.close() }
        fixture.seedHistory()
        try await fixture.settle { fixture.feed.status.hasRows }
        let proposal = fixture.proposal()
        fixture.state.session.diagnosticRepairProposal = proposal
        fixture.updateClient()
        let binding = DiagnosticRepairProjectBinding(id: UUID().uuidString.lowercased(), revision: 1,
            host: fixture.context.host, projectId: "source", path: "/sources/pilot", configuredAt: "2026-10-19T00:00:00Z")
        let admission = try DiagnosticRepair.admission(specialist: fixture.state.session, specialistHost: fixture.context.host,
            proposal: proposal, binding: binding)
        let request = SpawnRequest(projectId: binding.projectId, message: "Already reviewed bounded material",
            title: admission.repairTitle, mode: .build, workspace: .clone, diagnosticRepair: admission)
        let (original, delivery) = try await fixture.model.hosts.deliver(host: fixture.context.host, kind: "repair-create",
            targetId: nil, payload: request, origin: fixture.context.host)
        #expect(delivery == .unknown)
        fixture.state.session.diagnosticRepairProposal = nil
        fixture.updateClient()
        try await fixture.settle()
        let buttonAnchor = try #require(fixture.anchor(.primary))
        let button = try #require(fixture.button(at: buttonAnchor))
        #expect(button.isEnabled)
        button.performClick(nil)
        #expect(fixture.model.diagnosticRepairTarget?.reference == fixture.reference)
        #expect(fixture.model.hosts.pendingOperations[original.operationId] == original)
        #expect(fixture.client.fixtureSpawnRequests.isEmpty && fixture.client.fixtureSendRequests.isEmpty)
        fixture.client.disconnect()
        try await fixture.settle {
            guard let anchor = fixture.anchor(.primary), let button = fixture.button(at: anchor) else { return false }
            return !button.isEnabled
        }
        let offlineAnchor = try #require(fixture.anchor(.primary))
        let offline = try #require(fixture.button(at: offlineAnchor))
        #expect(!offline.isEnabled)
        offline.performClick(nil)
        #expect(fixture.model.hosts.pendingOperations.count == 1)
        #expect(fixture.client.fixtureSpawnRequests.isEmpty && fixture.client.fixtureSendRequests.isEmpty)
    }
}

@MainActor private final class FooterState: ObservableObject {
    @Published var session: SessionSummary
    init(_ session: SessionSummary) { self.session = session }
}

private struct FooterChat: View {
    @ObservedObject var state: FooterState
    let fixture: FooterFixture
    var body: some View {
        ChatView(session: state.session, feed: fixture.feed, composer: fixture.composer, context: fixture.context,
                 appModel: fixture.model)
            .environmentObject(fixture.model).environment(\.hostViewContext, fixture.context)
    }
}

@MainActor private final class FooterFixture {
    let client = PilotClient()
    let model: AppModel
    let state: FooterState
    let feed: SessionFeed
    let composer = ComposerState()
    let context: HostViewContext
    let reference: HostResourceRef
    let window: NSWindow
    let defaults: UserDefaults
    let suite: String
    let directory: URL
    var hosting: NSHostingView<FooterChat>!

    init(width: CGFloat) throws {
        _ = NSApplication.shared
        suite = "DiagnosticRepairFooterTests.\(UUID().uuidString)"
        defaults = try #require(UserDefaults(suiteName: suite))
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let hosts = HostClients(operationDirectory: directory,
            readScopedModelCapability: { _, _ in "fixture" }, readNativeCapability: { _, _ in "fixture" })
        model = AppModel(projectFolderDefaults: defaults, client: client, hosts: hosts)
        let host = HostRef(hostId: "local", daemonId: UUID().uuidString, lineageId: UUID().uuidString)
        let id = UUID().uuidString.lowercased()
        var session = SessionSummary(id: id, title: "App investigation", cwd: "/tmp", createdAt: 1, updatedAt: 1,
            state: "idle", mode: .ask, role: .diagnostics, diagnosticScope: .app)
        session.diagnosticHost = host
        state = FooterState(session)
        client.loadFixture(projects: [], sessions: [session])
        client.fixtureModels = ModelList(models: [])
        try model.registerLocal(host)
        try hosts.install(client, host: host)
        context = HostViewContext(host: host, hosts: model.hosts)
        reference = context.ref(.session, id)
        feed = SessionFeed(sessionId: id, transcript: Transcript())
        composer.draft = "Keep this draft"
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 760),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        hosting = NSHostingView(rootView: FooterChat(state: state, fixture: self))
        window.contentView = hosting
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderFrontRegardless(); window.update()
    }

    func proposal() -> DiagnosticRepairProposal {
        DiagnosticRepairProposal(id: "diagnostic-proposal:v1:\(UUID().uuidString.lowercased())", createdAt: "2026-10-19T00:00:00Z",
            evidenceRefs: ["diagnostic:v1:host:synthetic"], findings: "Selection remains after a host changes.", uncertainty: .high,
            suggestedRepair: "Fence selection by host identity.", regressionTestGuidance: "Switch verified hosts in the mounted sidebar.",
            subject: .app(host: context.host), repairTitle: "Sidebar retains obsolete selection")
    }
    func updateClient() { client.loadFixture(projects: [], sessions: [state.session]) }
    func setWorking() {
        let old = state.session
        var working = SessionSummary(id: old.id, title: old.title, cwd: old.cwd, createdAt: old.createdAt,
            updatedAt: old.updatedAt + 1, state: "working", mode: .ask, role: .diagnostics, diagnosticScope: .app)
        working.diagnosticHost = context.host
        state.session = working
    }
    func seedHistory() {
        let entries: [JSONValue] = (1...500).map { index in .object([
            "id": .number(Double(index)), "kind": .string("pi.user"),
            "model": .array([.object(["role": .string("user"), "content": .string("Retained message \(index). " + String(repeating: "History text. ", count: 12))])]),
        ]) }
        feed.applyFixtureEvents([.object(["type": .string("snapshot"), "entries": .array(entries)])])
    }
    func views<T: NSView>(_ type: T.Type) -> [T] {
        func collect(_ view: NSView) -> [T] { (view as? T).map { [$0] } ?? view.subviews.flatMap(collect) }
        return collect(hosting)
    }
    func anchor(_ role: DiagnosticRepairActionAnchorView.Role) -> DiagnosticRepairActionAnchorView? {
        views(DiagnosticRepairActionAnchorView.self).first { $0.role == role }
    }
    func button(at anchor: NSView) -> NSButton? {
        let frame = anchor.convert(anchor.bounds, to: hosting)
        return views(NSButton.self).first { $0.convert($0.bounds, to: hosting).contains(NSPoint(x: frame.midX, y: frame.midY)) }
    }
    func expectActionAlignedWithComposer(_ anchor: NSView, editor: NSView,
                                        sourceLocation: SourceLocation = #_sourceLocation) {
        let actionFrame = anchor.convert(anchor.bounds, to: hosting)
        let editorFrame = editor.convert(editor.bounds, to: hosting)
        #expect(actionFrame.minX >= editorFrame.minX, sourceLocation: sourceLocation)
        #expect(abs(actionFrame.maxX - editorFrame.maxX) <= 12,
                "repair actions share the centered composer column even in a wide window",
                sourceLocation: sourceLocation)
    }
    func settle(until ready: () -> Bool = { true }) async throws {
        for pass in 0..<150 {
            hosting.layoutSubtreeIfNeeded(); window.update()
            try await Task.sleep(for: .milliseconds(20))
            if pass >= 11, ready() { return }
        }
        #expect(ready(), "the production chat must settle")
    }
    func close() {
        feed.stop(); window.contentView = nil; window.close(); hosting = nil
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
    }
}
