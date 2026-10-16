import AppKit
import PilotCore
import SwiftUI

// The mission Overview's Linear tickets: each ticket the mission manages, how far its contributing tasks are and what
// Pilot's Linear updates are doing. Contributing tasks nest one level under their ticket, like sub-issues. Tasks that
// only reference the ticket follow as one quiet line, because they never change it.

/// Builds the tickets once per change of the mission's links or tasks, not on every body evaluation.
@MainActor
final class MissionTicketsCache: ObservableObject {
    private var resources: [MissionResource]?
    private var tasks: [MissionTask] = []
    private var cached = MissionTickets(resources: [], tasks: [])
    /// How many times the tickets were rebuilt, for tests.
    private(set) var builds = 0

    func tickets(for detail: MissionDetail) -> MissionTickets {
        if resources == detail.resources, tasks == detail.tasks { return cached }
        resources = detail.resources
        tasks = detail.tasks
        builds += 1
        cached = MissionTickets(detail)
        return cached
    }
}

struct MissionTicketsSection: View {
    let mission: Mission
    let detail: MissionDetail
    @StateObject private var cache = MissionTicketsCache()

    var body: some View {
        let tickets = cache.tickets(for: detail)
        if !tickets.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                PageSectionHeader(title: "Linear tickets", count: tickets.count)
                    .help("Linear tickets this mission delivers. Their contributing tasks move them in Linear.")
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(tickets.tickets.enumerated()), id: \.element.id) { index, ticket in
                        if index > 0 { HairlineDivider(leading: 34) }
                        MissionTicketRow(ticket: ticket, missionId: mission.id, tickets: tickets, tasks: detail.tasks,
                                         editable: mission.status == .active)
                    }
                }
            }
        }
    }
}

// MARK: Actions

/// The one wording for a Linear link's role, in chips, rows, tooltips and VoiceOver.
enum MissionLinearRoleText {
    static let referenceHelp = "Reference only: context for the work. Pilot never changes this ticket from it."
    static func contributionHelp(_ identifier: String) -> String {
        "Counts toward \(identifier): this task's progress moves the ticket in Linear."
    }
}

@MainActor
enum MissionTicketActions {
    static func open(_ url: String) {
        if let url = trackedBrowserURL(url) { BrowserLinkOpener.shared.open(url) }
    }

    static func copy(_ url: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
    }

    /// An explicit role change: manage a ticket, count a task toward it, or keep it as a reference.
    static func setRole(_ role: MissionLinearRole, resourceId: String, missionId: String) {
        let client = AppModel.shared.client
        AppModel.shared.missionAction {
            try await client.updateMissionResource(missionId, resourceId: resourceId, MissionResourceUpdate(linearRole: role))
        }
    }

    /// Counts a task toward a ticket, upgrading the task's reference to it rather than adding a second link.
    static func addContribution(_ candidate: MissionTicketCandidate, to ticket: MissionTicket, missionId: String) {
        if let referenceId = candidate.referenceId {
            setRole(.contribution, resourceId: referenceId, missionId: missionId)
            return
        }
        let client = AppModel.shared.client
        AppModel.shared.missionAction {
            try await client.addMissionResource(missionId, MissionResourceWrite(
                url: ticket.url, title: ticket.resource.title, taskId: candidate.task.id, linearRole: .contribution))
        }
    }

    static func remove(resourceId: String, missionId: String) {
        let client = AppModel.shared.client
        AppModel.shared.missionAction { try await client.deleteMissionResource(missionId, resourceId: resourceId) }
    }

    static func sync(_ action: MissionLinearSyncAction, resourceId: String, missionId: String,
                     done: @escaping @MainActor () -> Void = {}) {
        let client = AppModel.shared.client
        AppModel.shared.missionAction {
            defer { done() }
            try await client.setMissionLinearSync(missionId, resourceId: resourceId, action: action)
        }
    }
}

// MARK: Ticket row

/// One managed ticket: its title (opening Linear), the identifier and task progress, then Pilot's Linear updates in
/// one line when there is something to say. A paused ticket offers Resume and a failed update Retry, in place.
/// Contributing tasks follow, indented under the ticket and collapsible from its "N tasks" count.
struct MissionTicketRow: View {
    let ticket: MissionTicket
    let missionId: String
    let tickets: MissionTickets
    let tasks: [MissionTask]
    var editable = true
    @EnvironmentObject private var model: AppModel
    @State private var expanded = true
    @State private var busy = false

    var body: some View {
        let sync = MissionTicketSyncLine(ticket.resource.linearSync)
        let showsChildren = expanded && (!ticket.contributions.isEmpty || !ticket.references.isEmpty)
        VStack(alignment: .leading, spacing: 0) {
            HoverRow(verticalPadding: 7) { hovered in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    MissionLinkIcon(kind: .linearIssue, size: 12).frame(width: 16)
                    VStack(alignment: .leading, spacing: 2) {
                        Button { MissionTicketActions.open(ticket.url) } label: {
                            Text(ticket.rowTitle).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                                .lineLimit(1).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("Open \(ticket.identifier) in Linear")
                        progress
                        if let sync { syncLine(sync) }
                    }
                    Spacer(minLength: 8)
                    if !ticket.contributions.isEmpty {
                        SubIssueToggle(disclosure: disclosure, parent: ticket.identifier)
                    }
                    Color.clear.frame(width: 20, height: 20)
                        .overlay {
                            if hovered {
                                Menu { menuItems(sync) } label: { PilotSymbol(PilotIcon.more, context: .toolbar) }
                                    .menuStyle(.button)
                                    .rowIconButtonStyle()
                                    .menuIndicator(.hidden)
                                    .fixedSize()
                                    .help("Ticket actions")
                                    .accessibilityLabel("Actions for \(ticket.identifier)")
                            }
                        }
                        .revealed(hovered)
                }
            }
            .overlay {
                if showsChildren {
                    SubIssueConnector(part: .parent).stroke(Theme.border, lineWidth: 1)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .contextMenu { menuItems(sync) }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(accessibilityLabel(sync))
            .accessibilityAction(named: "Open in Linear") { MissionTicketActions.open(ticket.url) }
            if showsChildren {
                ForEach(Array(ticket.contributions.enumerated()), id: \.element.id) { position, contribution in
                    MissionTicketContributionRow(contribution: contribution, ticket: ticket, missionId: missionId,
                                                 canExclude: editable && !isFinal)
                        .padding(.leading, SubIssueLayout.indent)
                        .overlay {
                            SubIssueConnector(part: .child(last: position == ticket.contributions.count - 1
                                    && ticket.references.isEmpty))
                                .stroke(Theme.border, lineWidth: 1)
                                .allowsHitTesting(false).accessibilityHidden(true)
                        }
                }
                if !ticket.references.isEmpty {
                    references
                        .padding(.leading, SubIssueLayout.indent)
                        .overlay {
                            SubIssueConnector(part: .child(last: true)).stroke(Theme.border, lineWidth: 1)
                                .allowsHitTesting(false).accessibilityHidden(true)
                        }
                }
            }
        }
    }

    /// Canceled, duplicated or deployed in Linear: Pilot no longer updates the ticket, so nothing is held open.
    private var isFinal: Bool { ticket.resource.linearSync?.state == .terminal }

    private var disclosure: SubIssueDisclosure {
        SubIssueDisclosure(count: ticket.contributions.count, expanded: expanded, toggle: {
            withAnimation(Theme.Motion.quick) { expanded.toggle() }
        }, noun: ("task", "tasks"))
    }

    /// "ENG-123 · 1 of 3 tasks done · 1 dropped".
    private var progress: some View {
        HStack(spacing: 4) {
            Text(ticket.identifier).monospacedDigit().lineLimit(1).fixedSize()
            Text("·").foregroundStyle(Theme.faintForeground)
            Text(ticket.progressLine).monospacedDigit().lineLimit(1)
        }
        .font(.pilot(.small))
        .foregroundStyle(Theme.mutedForeground)
        .help(isFinal ? "" : ticket.droppedHelp ?? "")
    }

    @ViewBuilder
    private func syncLine(_ sync: MissionTicketSyncLine) -> some View {
        switch sync.tone {
        case .problem:
            InlineProblem(timedText(sync), retrying: busy) { act(.resume) }
                .help(sync.help)
                .padding(.top, 2)
        case .attention:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                PilotSymbol(PilotIcon.paused).foregroundStyle(Theme.blocked).accessibilityHidden(true)
                Text(sync.text).foregroundStyle(Theme.blocked).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if let action = sync.action {
                    Button(action.title) { act(.resume) }
                        .controlSize(.small)
                        .disabled(busy)
                }
            }
            .font(.pilot(.caption))
            .help(sync.help)
            .padding(.top, 2)
        case .quiet:
            Text(timedText(sync))
                .font(.pilot(.caption))
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
                .help(sync.help)
        }
    }

    /// The line with its next automatic attempt: "Moving to Merged in Linear · retrying Today 3:40 PM".
    private func timedText(_ sync: MissionTicketSyncLine) -> String {
        guard let retryAt = sync.retryAt else { return sync.text }
        return "\(sync.text) · retrying \(RelativeDate.upcoming(Date(timeIntervalSince1970: retryAt / 1000)))"
    }

    /// Tasks that link the ticket for context only: "Referenced by #7, #9 · not counted".
    private var references: some View {
        HStack(spacing: 4) {
            Text("Referenced by")
            ForEach(Array(ticket.references.enumerated()), id: \.element.id) { index, reference in
                Button { model.showMissionTask(reference.task.id) } label: {
                    Text("#\(reference.task.number)\(index < ticket.references.count - 1 ? "," : "")").monospacedDigit()
                }
                .buttonStyle(.plain)
                .help("Show #\(reference.task.number) \(reference.task.title)")
                .accessibilityLabel("Show task \(reference.task.number)")
            }
            Text("·").foregroundStyle(Theme.faintForeground)
            Text("not counted")
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.faintForeground)
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.leading, 24)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help("These tasks link the ticket for context only. They never change it in Linear.")
    }

    @ViewBuilder
    private func menuItems(_ sync: MissionTicketSyncLine?) -> some View {
        Button("Open in Linear") { MissionTicketActions.open(ticket.url) }
        Button("Copy Link") { MissionTicketActions.copy(ticket.url) }
        if editable {
            Divider()
            let candidates = tickets.candidates(for: ticket, tasks: tasks)
            Menu("Add Contributing Task") {
                ForEach(candidates) { candidate in
                    Button("#\(candidate.task.number) \(candidate.task.title)") {
                        MissionTicketActions.addContribution(candidate, to: ticket, missionId: missionId)
                    }
                }
                if candidates.isEmpty { Text("Every task already counts toward it") }
            }
            if let sync {
                switch sync.action {
                case .resume: Button("Resume Linear Updates") { act(.resume) }.disabled(busy)
                case .retry: Button("Retry Linear Update") { act(.resume) }.disabled(busy)
                case nil:
                    if sync.canPause { Button("Pause Linear Updates") { act(.pause) }.disabled(busy) }
                }
            }
            Divider()
            // pilotd refuses both while tasks contribute, so a ticket never closes by losing its tasks.
            let blocked = !ticket.contributions.isEmpty
            Button("Keep as Reference Only") {
                MissionTicketActions.setRole(.reference, resourceId: ticket.id, missionId: missionId)
            }
            .disabled(blocked)
            Button("Remove Ticket", role: .destructive) {
                MissionTicketActions.remove(resourceId: ticket.id, missionId: missionId)
            }
            .disabled(blocked)
            if blocked { Text("Remove its contributing tasks first") }
        }
    }

    private func act(_ action: MissionLinearSyncAction) {
        guard !busy else { return }
        busy = true
        MissionTicketActions.sync(action, resourceId: ticket.id, missionId: missionId) { busy = false }
    }

    private func accessibilityLabel(_ sync: MissionTicketSyncLine?) -> String {
        var parts = ["Linear ticket \(ticket.identifier)"]
        if !ticket.title.isEmpty { parts.append(ticket.title) }
        parts.append(ticket.progressLine.replacingOccurrences(of: " · ", with: ", "))
        if let sync { parts.append(sync.tone == .problem ? "Error: \(sync.text)" : sync.text) }
        return parts.joined(separator: ", ")
    }
}

// MARK: Contributing task row

/// A task that counts toward the ticket: its status mark, number, title and status word, and the other tickets it
/// also counts toward. A dropped task keeps the ticket open until it is excluded, so it offers Exclude in place.
/// Clicking shows the task.
struct MissionTicketContributionRow: View {
    let contribution: MissionTicketContribution
    let ticket: MissionTicket
    let missionId: String
    /// Dropped tasks can be excluded while the ticket is still open in Linear.
    var canExclude = true
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let task = contribution.task
        let status = task.workStatus
        HoverRow(verticalPadding: 5) { _ in
            HStack(spacing: 8) {
                Button { model.showMissionTask(task.id) } label: {
                    HStack(spacing: 8) {
                        PilotSymbol(status.icon).foregroundStyle(status.color).frame(width: 16)
                            .accessibilityHidden(true)
                        Text("#\(task.number)").font(.pilot(.caption)).monospacedDigit()
                            .foregroundStyle(Theme.faintForeground)
                            .frame(minWidth: 20, alignment: .leading)
                        Text(task.title).font(.pilot(.body)).lineLimit(1).strikethrough(status.isClosed)
                            .foregroundStyle(status.isClosed ? Theme.mutedForeground : Theme.foreground)
                        Spacer(minLength: 8)
                        if !contribution.alsoCountsToward.isEmpty {
                            MetaText("Also \(contribution.alsoCountsToward.joined(separator: ", "))")
                        }
                        MetaText(task.delegationLabel ?? status.label)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(help)
                if excludable {
                    Button("Exclude", action: exclude)
                        .controlSize(.small)
                        .help("Stop counting this dropped task toward \(ticket.identifier). It stays linked as a reference.")
                }
            }
        }
        .contextMenu {
            Button("Show Task") { model.showMissionTask(task.id) }
            Divider()
            Button(excludable ? "Exclude From \(ticket.identifier)" : "Stop Counting Toward \(ticket.identifier)",
                   action: exclude)
            Button("Remove Link", role: .destructive) {
                MissionTicketActions.remove(resourceId: contribution.resource.id, missionId: missionId)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAction(named: "Show task") { model.showMissionTask(task.id) }
        .accessibilityAction(named: excludable ? "Exclude from ticket" : "Stop counting toward ticket", exclude)
    }

    private var excludable: Bool { canExclude && contribution.task.workStatus == .dropped }

    private var help: String {
        var lines = ["Counts toward \(ticket.identifier)"]
        if !contribution.alsoCountsToward.isEmpty {
            lines.append("Also counts toward \(contribution.alsoCountsToward.joined(separator: ", ")), so it stays open "
                + "while another ticket still needs it.")
        }
        if excludable { lines.append("Dropped: keeps \(ticket.identifier) open until you exclude it.") }
        return lines.joined(separator: "\n")
    }

    private var accessibilityLabel: String {
        let task = contribution.task
        var parts = ["Task \(task.number)", task.title, task.delegationLabel ?? task.workStatus.label,
                     "counts toward \(ticket.identifier)"]
        if !contribution.alsoCountsToward.isEmpty {
            parts.append("also counts toward \(contribution.alsoCountsToward.joined(separator: ", "))")
        }
        if excludable { parts.append("keeps the ticket open until excluded") }
        return parts.joined(separator: ", ")
    }

    private func exclude() {
        MissionTicketActions.setRole(.reference, resourceId: contribution.resource.id, missionId: missionId)
    }
}
