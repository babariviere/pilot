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

    @Published var selectedSessionId: String?
    @Published var inspectorVisible = false
    @Published var inspectorTab: InspectorTab = .changes
    @Published var sidebarQuery = ""
    /// Project preselected in the new-session screen.
    @Published var draftProjectId: String?
    @Published var collapsedProjects: Set<String> = []

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
        client.onTransition = { [weak self] previous, session in
            self?.notifier.sessionChanged(from: previous, to: session)
        }
        terminals.bind(to: settings)
        Task {
            await daemon.ensureRunning()
            client.connect(to: daemon.baseURL)
        }
    }

    func newSession(in projectId: String?) {
        draftProjectId = projectId
        selectedSessionId = nil
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
