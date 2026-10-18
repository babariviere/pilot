import PilotCore
import SwiftUI

/// Quick jumps to Pilot's own Slack triage board and Linear queue (a project's Linear list), never the Linear app.
/// The focused project, or the project on screen, goes first; with several candidates and none in context, the
/// palette lists them instead of guessing one.
enum TriageJump: Equatable {
    case slack
    case linear

    var kind: TrackedKind { self == .slack ? .slack : .linear }
    var title: String { self == .slack ? "Slack triage" : "Linear queue" }
    var keywords: [String] {
        self == .slack ? ["slack", "triage", "board", "reports"] : ["linear", "queue", "triage", "issues", "tickets"]
    }

    /// Projects whose `kind` source is configured, in sidebar order, the preferred one first.
    static func projects(_ jump: TriageJump, in ordered: [Project], sources: [TrackingSource],
                         preferred: String?) -> [Project] {
        let ids = Set(sources.filter { $0.kind == jump.kind && $0.configured }.map(\.projectId))
        let tracking = ordered.filter { ids.contains($0.id) }
        return tracking.filter { $0.id == preferred } + tracking.filter { $0.id != preferred }
    }

    /// The one project to open without asking: the preferred one when it tracks the source, or the only one that does.
    static func target(_ jump: TriageJump, in ordered: [Project], sources: [TrackingSource],
                       preferred: String?) -> Project? {
        let candidates = projects(jump, in: ordered, sources: sources, preferred: preferred)
        if let preferred, let match = candidates.first(where: { $0.id == preferred }) { return match }
        return candidates.count == 1 ? candidates[0] : nil
    }
}

extension AppModel {
    /// The project in context: the focused one, else the page's or open chat's project.
    var contextProjectId: String? {
        focusedProject?.id ?? selectedSession?.projectId ?? selectedMission?.projectId
            ?? selectedProjectId.flatMap { client.project($0)?.id }
    }

    /// The Go menu or the palette entry: opens the board or queue, or lets the user pick a project.
    func jump(to jump: TriageJump) {
        let ordered = orderedProjects
        if let project = TriageJump.target(jump, in: ordered, sources: client.trackingSources, preferred: contextProjectId) {
            open(jump, in: project.id)
        } else {
            // Several projects, or none set up: the palette lists them, or how to set one up.
            showCommandPalette(query: jump.title)
        }
    }

    func open(_ jump: TriageJump, in projectId: String) {
        if let scope = sidebarScope, scope != projectId { focus(on: projectId) }
        switch jump {
        case .slack: openSlackTriage(projectId)
        case .linear:
            openProject(projectId)
            // The Overview presents its Linear list once it is on screen.
            pendingTrackedSheet = PendingTrackedSheet(projectId: projectId, kind: .linear)
        }
    }
}

/// A tracked-items list the project page should present when it appears, as for the Linear queue jump.
struct PendingTrackedSheet: Equatable {
    let projectId: String
    let kind: TrackedKind
}

extension CommandPaletteCatalog {
    /// "Slack triage" and "Linear queue" per tracking project, the project in context first. With none set up,
    /// one entry says where to set it up.
    func triageJumps() -> [CommandPaletteEntry] {
        let model = model
        var entries: [CommandPaletteEntry] = []
        for jump in [TriageJump.slack, .linear] {
            let projects = TriageJump.projects(jump, in: model.orderedProjects, sources: model.client.trackingSources,
                                               preferred: model.contextProjectId)
            let icon: PilotIcon = jump == .slack ? .slackChannel : .linearIssue
            if projects.isEmpty {
                entries.append(CommandPaletteEntry(
                    item: CommandPaletteItem(id: "jump:\(jump.kind.rawValue):setup", kind: .page, title: jump.title,
                                             keywords: jump.keywords),
                    icon: icon, detail: "No project tracks \(jump == .slack ? "Slack" : "Linear") yet. Set it up in Settings.",
                    perform: openSettings))
                continue
            }
            for (index, project) in projects.enumerated() {
                let team = jump == .linear ? project.tracking?.linearTeamName : nil
                entries.append(CommandPaletteEntry(
                    item: CommandPaletteItem(id: "jump:\(jump.kind.rawValue):\(project.id)", kind: .page, title: jump.title,
                                             keywords: jump.keywords + [project.name] + [team].compactMap { $0 },
                                             suggested: index == 0),
                    icon: icon, suffix: [project.name, team].compactMap { $0 }.joined(separator: " · ")
                ) { model.open(jump, in: project.id) })
            }
        }
        return entries
    }
}
