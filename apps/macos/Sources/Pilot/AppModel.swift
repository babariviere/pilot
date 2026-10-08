import AppKit
import Foundation
import PilotCore

enum InspectorTab: Hashable {
    case changes
    case terminal
    case artifacts
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let daemon = DaemonController()
    let client = PilotClient()
    let feeds = SessionFeedCache()
    let settings = AppSettings.shared
    let terminals = TerminalStore()
    let notifier = Notifier()
    let attention = SessionAttention()
    /// Drafts outlive their views, but are local to this app launch.
    let newSessionForm = NewSessionForm()
    private var chatComposers: [String: ComposerState] = [:]
    @Published private(set) var reviewRevision = 0

    @Published var selectedSessionId: String?
    @Published var inspectorVisible = false
    @Published var inspectorTab: InspectorTab = .changes
    @Published var sidebarQuery = ""
    /// Project preselected in the new-session screen.
    @Published var draftProjectId: String?
    /// One-shot prefill consumed by the new-session composer, never submitted automatically.
    @Published var draftMessage: String?
    @Published var collapsedProjects: Set<String> = []
    /// Sidebar-only grouping. Repository paths and daemon project records are unchanged.
    @Published var projectFolders: ProjectFolders {
        didSet { projectFolders.save(defaults: projectFolderDefaults) }
    }
    @Published var showingArchive = false
    /// nil browses every project's archived chats.
    @Published var archiveProjectId: String?
    @Published var sessionActionError: String?
    @Published var pendingSessionActions: Set<String> = []

    /// Captured from SwiftUI so non-view code (notifications, menu) can reopen the window.
    var openWindowAction: (() -> Void)?

    private var started = false
    private let projectFolderDefaults: UserDefaults

    init(projectFolderDefaults: UserDefaults = .standard) {
        self.projectFolderDefaults = projectFolderDefaults
        projectFolders = ProjectFolders.load(defaults: projectFolderDefaults)
    }

    var selectedSession: SessionSummary? {
        selectedSessionId.flatMap { client.session($0) }
    }

    func composer(for sessionId: String) -> ComposerState {
        if let composer = chatComposers[sessionId] { return composer }
        let composer = ComposerState()
        chatComposers[sessionId] = composer
        return composer
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

    func newSession(in projectId: String?, message: String? = nil) {
        showingArchive = false
        // Returning Home without choosing a project must keep the retained task's destination.
        if let projectId { draftProjectId = projectId }
        if message != nil { newSessionForm.invalidatePendingSubmission() }
        draftMessage = message
        selectedSessionId = nil
    }

    func debugSession(_ session: SessionSummary) {
        let projects = client.projects.filter { $0.name.caseInsensitiveCompare("pilot") == .orderedSame }
        guard projects.count == 1, let project = projects.first else {
            sessionActionError = projects.isEmpty
                ? "Add a project named pilot before debugging a session."
                : "More than one project is named pilot. Rename the others before debugging a session."
            return
        }
        guard let path = session.sessionPath, !path.isEmpty else {
            sessionActionError = "The daemon has not provided this session's data path. Update or restart pilotd and try again."
            return
        }
        newSession(in: project.id, message: """
        Investigate and fix a Pilot issue in the referenced session.

        Session: \(session.title)
        Session ID: \(session.id)
        Session data path: \(path)
        Session working directory: \(session.cwd)

        Read the session history, tool calls, and logs to diagnose the issue, then fix the underlying problem in Pilot. Treat the original session's data and workspace as read-only.

        Issue / reason:

        """)
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
