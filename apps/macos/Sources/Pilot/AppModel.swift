import AppKit
import Foundation
import PilotCore

enum InspectorTab: Hashable {
    case changes
    case terminal
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let daemon = DaemonController()
    let client = PilotClient()
    let settings = AppSettings.shared
    let terminals = TerminalStore()
    let notifier = Notifier()
    let attention = SessionAttention()
    @Published private(set) var reviewRevision = 0

    @Published var selectedSessionId: String?
    @Published var inspectorVisible = false
    @Published var inspectorTab: InspectorTab = .changes
    @Published var sidebarQuery = ""
    /// Project preselected in the new-session screen.
    @Published var draftProjectId: String?
    @Published var collapsedProjects: Set<String> = []
    @Published var showingArchive = false
    /// nil browses every project's archived chats.
    @Published var archiveProjectId: String?
    @Published var sessionActionError: String?
    @Published var pendingSessionActions: Set<String> = []

    /// Captured from SwiftUI so non-view code (notifications, menu) can reopen the window.
    var openWindowAction: (() -> Void)?

    private var started = false

    var selectedSession: SessionSummary? {
        selectedSessionId.flatMap { client.session($0) }
    }

    func start() {
        guard !started else { return }
        started = true
        notifier.onOpenSession = { [weak self] id in self?.open(session: id) }
        notifier.requestAuthorization()
        client.onSessionsChanged = { [weak self] sessions, snapshot in
            guard let self else { return }
            for notification in self.attention.observe(sessions, snapshot: snapshot) {
                // Record completion versions for archives too, without surfacing old results.
                guard self.client.session(notification.sessionId)?.isArchived != true else { continue }
                self.notifier.deliver(notification)
            }
        }
        terminals.bind(to: settings)
        Task {
            await daemon.ensureRunning()
            client.connect(to: daemon.baseURL)
        }
    }

    func newSession(in projectId: String?) {
        showingArchive = false
        draftProjectId = projectId
        selectedSessionId = nil
    }

    func isUnread(_ session: SessionSummary) -> Bool { attention.isUnread(session) }

    func review(_ session: SessionSummary, chatVisible: Bool = false, explicit: Bool = false) {
        if attention.review(session, chatVisible: chatVisible, appActive: NSApp.isActive, explicit: explicit) {
            reviewRevision += 1
        }
    }

    func showArchive(in projectId: String? = nil) {
        archiveProjectId = projectId
        showingArchive = true
        selectedSessionId = nil
    }

    func setArchived(_ archived: Bool, sessionId: String) {
        guard !pendingSessionActions.contains(sessionId) else { return }
        pendingSessionActions.insert(sessionId)
        Task {
            defer { pendingSessionActions.remove(sessionId) }
            do {
                if archived { try await client.archive(sessionId) }
                else { try await client.restore(sessionId) }
            } catch {
                sessionActionError = error.localizedDescription
            }
        }
    }

    func stopSession(_ sessionId: String) {
        guard !pendingSessionActions.contains(sessionId) else { return }
        pendingSessionActions.insert(sessionId)
        Task {
            defer { pendingSessionActions.remove(sessionId) }
            do { try await client.stop(sessionId) }
            catch { sessionActionError = error.localizedDescription }
        }
    }

    /// Shows the inspector on `tab`, or hides it when it already shows that tab.
    func toggleInspector(_ tab: InspectorTab) {
        if inspectorVisible, inspectorTab == tab {
            inspectorVisible = false
        } else {
            inspectorTab = tab
            inspectorVisible = true
        }
    }

    func addProject() {
        guard let path = chooseFolder() else { return }
        Task {
            if let project = try? await client.createProject(ProjectRequest(path: path)) {
                newSession(in: project.id)
            }
        }
    }

    func open(session id: String) {
        selectedSessionId = id
        showMainWindow()
    }

    func showMainWindow() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first(where: { $0.identifier?.rawValue == MainWindow.id }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            openWindowAction?()
        }
    }
}
