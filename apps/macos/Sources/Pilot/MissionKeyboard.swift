import PilotCore
import SwiftUI

/// What a keyboard list or the palette asks one mission task row to do. Rows own their sheets, popovers and title
/// field, so a request reaches the row that shows the task; rows are lazy, but the highlighted one is on screen.
enum MissionTaskCommand: Equatable {
    case editTitle, start, model, dependencies, link, moveUp, moveDown
}

struct MissionTaskRequest: Equatable {
    let id = UUID()
    let taskId: String
    let command: MissionTaskCommand
}

@MainActor
final class MissionTaskRequests: ObservableObject {
    @Published private(set) var latest: MissionTaskRequest?
    /// A row that appears later must not replay an old request, so each one runs once.
    private var consumed: UUID?

    func send(_ command: MissionTaskCommand, to taskId: String) {
        latest = MissionTaskRequest(taskId: taskId, command: command)
    }

    /// The command for `taskId`, once.
    func take(_ request: MissionTaskRequest?, for taskId: String) -> MissionTaskCommand? {
        guard let request, request.taskId == taskId, request.id != consumed else { return nil }
        consumed = request.id
        return request.command
    }
}

extension CommandPaletteCatalog {
    /// The highlighted mission task's actions: the same ones as its row menu, without hovering. Delete stays in the
    /// row's context menu.
    func missionTaskActions(missionId: String, taskId: String) -> (title: String, entries: [CommandPaletteEntry])? {
        let model = model
        let reference = model.currentMissionReference.flatMap { $0.localId == missionId ? $0 : nil }
        let context = reference.map { HostViewContext(host: $0.host, hosts: model.hosts) }
        let client = context.map { $0.hosts.presentationClient($0.host) } ?? model.client
        guard let detail = client.missionDetails[missionId],
              let task = detail.tasks.first(where: { $0.id == taskId }) else { return nil }
        let requests = model.missionTaskRequests
        var entries: [CommandPaletteEntry] = []
        func add(_ key: String, _ title: String, _ icon: PilotIcon, keywords: [String] = [], shortcut: String? = nil,
                 perform: @escaping @MainActor () -> Void) {
            entries.append(CommandPaletteEntry(
                item: CommandPaletteItem(id: "target:task:\(taskId):\(key)", kind: .action, title: title,
                                         keywords: keywords + ["task", "#\(task.number)"]),
                icon: icon, shortcut: shortcut) {
                    // Revalidated when chosen: the task may have gone while the palette was open.
                    guard client.missionDetails[missionId]?.tasks.contains(where: { $0.id == taskId }) == true else { return }
                    perform()
                })
        }
        func write(_ request: MissionTaskWrite) {
            model.missionAction { try await client.updateMissionTask(missionId, taskId: taskId, request) }
        }
        if let sessionId = task.sessionId {
            add("open", "Open chat", .message) { model.navigate(.session, id: sessionId, context: context) }
        } else if task.status.canStart, detail.mission.status == .active {
            add("start", "Start chat…", .compose, keywords: ["start"]) { requests.send(.start, to: taskId) }
        }
        add("edit", "Edit title", .edit, keywords: ["rename"], shortcut: "E") { requests.send(.editTitle, to: taskId) }
        add("up", "Move up", .collapse, keywords: ["reorder"], shortcut: "⌥↑") { requests.send(.moveUp, to: taskId) }
        add("down", "Move down", .disclosureOpen, keywords: ["reorder"], shortcut: "⌥↓") { requests.send(.moveDown, to: taskId) }
        for status in MissionTaskStatus.allCases where status != task.workStatus {
            add("status-\(status.rawValue)", "Status: \(status.label)", .status, keywords: ["status"]) {
                write(MissionTaskWrite(status: status))
            }
        }
        let phases = MissionPhaseIndex(detail)
        if phases.isEditable {
            let current = phases.phaseId(of: task)
            for phase in phases.phases where phase.id != current {
                add("phase-\(phase.id)", "Move to phase: \(phase.name)", .phase, keywords: ["phase"]) {
                    write(MissionTaskWrite(phaseId: .set(phase.id)))
                }
            }
            if current != nil {
                add("phase-none", "Move to no phase", .phase, keywords: ["phase"]) { write(MissionTaskWrite(phaseId: .clear)) }
            }
        }
        add("model", task.preferredModel == nil ? "Set preferred model…" : "Change preferred model…", .model,
            keywords: ["model"]) { requests.send(.model, to: taskId) }
        add("dependencies", task.dependsOn?.isEmpty == false ? "Edit dependencies…" : "Add dependencies…", .tasks,
            keywords: ["depends", "blocked"]) { requests.send(.dependencies, to: taskId) }
        add("link", "Add link…", .link) { requests.send(.link, to: taskId) }
        add("copy", "Copy reference", .copy) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("#\(task.number) \(task.title)", forType: .string)
        }
        return ("Highlighted: #\(task.number) \(task.title)", entries)
    }
}
