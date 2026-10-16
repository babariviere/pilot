import Foundation

// Mission-managed Linear tickets and the tasks that count toward them, for the Overview's Linear tickets section and
// task link chips. A managed ticket is work the mission delivers: its contributing tasks drive its Linear status.
// Reference links (the default, and every older link) are context only and never change the ticket.

/// pilotd's canonical Linear issue key ("acme/ENG-123"), to match a URL with a managed ticket before it is saved.
/// Saved links carry the daemon's own key in `MissionResource.linearKey`.
public enum MissionLinearKey {
    public static let maxLength = 256

    public static func key(url raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed), ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              parts.host?.lowercased() == "linear.app" else { return nil }
        // Encoded segments never acquire lifecycle authority, as in pilotd.
        let path = parts.percentEncodedPath.split(separator: "/").map(String.init)
        guard path.count >= 3, path[1] == "issue",
              path[0].range(of: #"^[A-Za-z0-9][A-Za-z0-9-]*$"#, options: .regularExpression) != nil,
              path[2].range(of: #"^[A-Za-z0-9]+-[1-9][0-9]*$"#, options: .regularExpression) != nil else { return nil }
        let key = "\(path[0].lowercased())/\(path[2].uppercased())"
        return key.count <= maxLength ? key : nil
    }
}

public extension MissionResource {
    /// The link's Linear lifecycle role. Links other than Linear issues, and every link from an older daemon, are
    /// references.
    var effectiveLinearRole: MissionLinearRole {
        kind == .linearIssue ? linearRole ?? .reference : .reference
    }
}

/// The user's actions on a managed ticket's Linear updates (POST …/linear-sync).
public enum MissionLinearSyncAction: String, Sendable {
    case pause, resume
}

/// A task that counts toward a managed ticket's completion.
public struct MissionTicketContribution: Identifiable, Equatable, Sendable {
    public let resource: MissionResource
    public let task: MissionTask
    /// Identifiers of the mission's other managed tickets this task also counts toward ("ENG-124"). Canceling one
    /// of them leaves the task open while another still needs it.
    public let alsoCountsToward: [String]

    public var id: String { resource.id }
}

/// A task that links the ticket for context only. It never changes the ticket.
public struct MissionTicketReference: Identifiable, Equatable, Sendable {
    public let resource: MissionResource
    public let task: MissionTask

    public var id: String { resource.id }
}

/// A task that could start counting toward a ticket, with its existing reference to the same ticket, which is
/// upgraded rather than duplicated.
public struct MissionTicketCandidate: Identifiable, Equatable, Sendable {
    public let task: MissionTask
    public let referenceId: String?

    public var id: String { task.id }
}

/// A Linear ticket this mission manages, with its contributing tasks in task order.
public struct MissionTicket: Identifiable, Equatable, Sendable {
    public let resource: MissionResource
    /// "ENG-123".
    public let identifier: String
    /// Saved or derived title. Empty when nothing better than the identifier exists.
    public let title: String
    public let contributions: [MissionTicketContribution]
    public let references: [MissionTicketReference]

    public var id: String { resource.id }
    public var url: String { resource.url }
    public var rowTitle: String { title.isEmpty ? identifier : title }

    public var total: Int { contributions.count }
    public var done: Int { contributions.filter { $0.task.workStatus == .done }.count }
    /// Dropped contributors count in the total: they keep the ticket open until they are excluded, so a dropped
    /// task never reads as delivered work.
    public var dropped: Int { contributions.filter { $0.task.workStatus == .dropped }.count }
    public var holdsForDropped: Bool { dropped > 0 }

    /// "No contributing tasks yet", "1 of 3 tasks done" or "1 of 3 tasks done · 1 dropped".
    public var progressLine: String {
        guard total > 0 else { return "No contributing tasks yet" }
        let noun = total == 1 ? "task" : "tasks"
        let line = "\(done) of \(total) \(noun) done"
        return dropped > 0 ? "\(line) · \(dropped) dropped" : line
    }

    /// The disclosure count: "1 task", "3 tasks".
    public var taskCountTitle: String { total == 1 ? "1 task" : "\(total) tasks" }

    /// Why the ticket is not complete although every other contributor is done.
    public var droppedHelp: String? {
        guard dropped > 0 else { return nil }
        return dropped == 1
            ? "A dropped task keeps this ticket open until you exclude it."
            : "\(dropped) dropped tasks keep this ticket open until you exclude them."
    }
}

/// Every managed ticket of a mission, and the role of each task link, built once per change of its links or tasks.
public struct MissionTickets: Equatable, Sendable {
    public let tickets: [MissionTicket]
    /// Ticket identifier by canonical key, for task chips.
    public let identifiers: [String: String]

    public var isEmpty: Bool { tickets.isEmpty }
    public var count: Int { tickets.count }

    public init(_ detail: MissionDetail) {
        self.init(resources: detail.resources, tasks: detail.tasks)
    }

    public init(resources: [MissionResource], tasks: [MissionTask]) {
        let tasksById = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let managed = resources.filter { $0.taskId == nil && $0.effectiveLinearRole == .managed && $0.linearKey != nil }
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
        var identifiers: [String: String] = [:]
        for resource in managed {
            guard let key = resource.linearKey, identifiers[key] == nil else { continue }
            identifiers[key] = Self.identifier(resource, key: key)
        }
        var contributing: [String: [(MissionResource, MissionTask)]] = [:]
        var referencing: [String: [(MissionResource, MissionTask)]] = [:]
        var keysByTask: [String: [String]] = [:]
        for resource in resources where resource.kind == .linearIssue {
            guard let taskId = resource.taskId, let task = tasksById[taskId],
                  let key = resource.linearKey, identifiers[key] != nil else { continue }
            switch resource.effectiveLinearRole {
            case .contribution:
                contributing[key, default: []].append((resource, task))
                keysByTask[taskId, default: []].append(key)
            case .reference: referencing[key, default: []].append((resource, task))
            case .managed: continue
            }
        }
        func ordered(_ pairs: [(MissionResource, MissionTask)]) -> [(MissionResource, MissionTask)] {
            pairs.sorted { ($0.1.order, $0.1.number, $0.0.id) < ($1.1.order, $1.1.number, $1.0.id) }
        }
        var seen = Set<String>()
        tickets = managed.compactMap { resource in
            guard let key = resource.linearKey, seen.insert(key).inserted else { return nil }
            let contributions = ordered(contributing[key] ?? []).map { link, task in
                MissionTicketContribution(
                    resource: link, task: task,
                    alsoCountsToward: (keysByTask[task.id] ?? []).filter { $0 != key }.compactMap { identifiers[$0] })
            }
            // A task that contributes is not also listed as a reference.
            let contributors = Set(contributions.map(\.task.id))
            let references = ordered(referencing[key] ?? []).filter { !contributors.contains($0.1.id) }
                .map { MissionTicketReference(resource: $0.0, task: $0.1) }
            return MissionTicket(resource: resource, identifier: identifiers[key] ?? key, title: Self.title(resource),
                                 contributions: contributions, references: references)
        }
        self.identifiers = identifiers
    }

    /// The managed ticket a link belongs to, by its canonical key.
    public func ticket(for resource: MissionResource) -> MissionTicket? {
        guard resource.kind == .linearIssue, let key = resource.linearKey else { return nil }
        return tickets.first { $0.resource.linearKey == key }
    }

    /// The ticket's identifier for a URL being added, when this mission manages that ticket.
    public func managedIdentifier(url: String) -> String? {
        MissionLinearKey.key(url: url).flatMap { identifiers[$0] }
    }

    /// Tasks that could start counting toward a ticket: every task not already contributing, except dropped ones.
    public func candidates(for ticket: MissionTicket, tasks: [MissionTask]) -> [MissionTicketCandidate] {
        let contributors = Set(ticket.contributions.map(\.task.id))
        let references = Dictionary(ticket.references.map { ($0.task.id, $0.resource.id) },
                                    uniquingKeysWith: { first, _ in first })
        return MissionTaskOrdering.sorted(tasks)
            .filter { !contributors.contains($0.id) && $0.workStatus != .dropped }
            .map { MissionTicketCandidate(task: $0, referenceId: references[$0.id]) }
    }

    /// What the Overview's Links list shows: everything except managed tickets and task links to them, which the
    /// Linear tickets section lists with their role.
    public static func listedLinks(_ resources: [MissionResource]) -> [MissionResource] {
        let managed = Set(resources.compactMap { resource in
            resource.taskId == nil && resource.effectiveLinearRole == .managed ? resource.linearKey : nil
        })
        guard !managed.isEmpty else { return resources }
        return resources.filter { resource in
            guard resource.kind == .linearIssue, let key = resource.linearKey else { return true }
            return !managed.contains(key)
        }
    }

    private static func identifier(_ resource: MissionResource, key: String) -> String {
        resource.externalId ?? key.split(separator: "/").last.map(String.init) ?? key
    }

    private static func title(_ resource: MissionResource) -> String {
        MissionLinks.display(resource, pullRequest: nil).title
    }
}

/// What adding a Linear issue link offers. Mission links default to managing delivery (a mission-attached ticket is
/// work to deliver); a task link to a ticket the mission manages can count toward it, and is a reference otherwise.
public enum MissionLinearAttachChoice: Equatable, Sendable {
    /// Not a Linear issue with a canonical key, or nothing to choose: added as a plain link.
    case none
    /// Mission scope: manage the ticket's delivery from this mission.
    case manage
    /// Task scope, for a ticket this mission manages: count the task toward it.
    case contribute(identifier: String)

    /// The checkbox's starting state.
    public var defaultOn: Bool { self == .manage }

    public static func choice(url: String, taskId: String?, resources: [MissionResource]) -> MissionLinearAttachChoice {
        guard let key = MissionLinearKey.key(url: url) else { return .none }
        let tickets = MissionTickets(resources: resources, tasks: [])
        if taskId == nil { return tickets.identifiers[key] == nil ? .manage : .none }
        return tickets.identifiers[key].map { .contribute(identifier: $0) } ?? .none
    }
}

/// How the add-link form saves a link: a new link, or an explicit role change of the same ticket's link in the same
/// scope, since pilotd never changes an existing link's role implicitly. Without a chosen role an existing link is
/// left as it is.
public enum MissionLinearAttachPlan: Equatable, Sendable {
    case add(role: MissionLinearRole?)
    case update(resourceId: String, role: MissionLinearRole)
    /// The link already exists with that role.
    case existing

    public static func plan(url: String, taskId: String?, role: MissionLinearRole?,
                            resources: [MissionResource]) -> MissionLinearAttachPlan {
        guard let role, let key = MissionLinearKey.key(url: url),
              let current = resources.first(where: { $0.kind == .linearIssue && $0.taskId == taskId && $0.linearKey == key })
        else { return .add(role: role) }
        return current.effectiveLinearRole == role ? .existing : .update(resourceId: current.id, role: role)
    }
}

/// How a managed ticket's daemon-owned Linear synchronization reads on its row: one short line, a tone and at most
/// one action. Pausing is offered from the menu; the line's button resumes or retries.
public struct MissionTicketSyncLine: Equatable, Sendable {
    public enum Tone: Equatable, Sendable {
        /// Muted metadata: up to date, updating, or a final Linear state.
        case quiet
        /// Waiting on the user's review (paused).
        case attention
        /// A failed write: the error triangle.
        case problem
    }

    public enum Action: Equatable, Sendable {
        case resume, retry

        public var title: String {
            switch self {
            case .resume: "Resume"
            case .retry: "Retry"
            }
        }
    }

    public let text: String
    public let tone: Tone
    public let action: Action?
    /// Epoch milliseconds of the next automatic attempt while a write is pending or backing off after an error.
    public let retryAt: Double?
    public let help: String
    /// Whether the menu offers Pause Linear Updates.
    public let canPause: Bool

    public init?(_ sync: MissionLinearSync?) {
        guard let sync else { return nil }
        let observed = sync.observedStateName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmptyTicketText
        let reason = Self.firstLine(sync.reason)
        let target = sync.target.flatMap { LinearWorkflowStage(rawValue: $0.rawValue) }?.title
        retryAt = sync.state == .pending || sync.state == .error ? sync.retryAt : nil
        switch sync.state {
        case .idle, .synced:
            guard let state = observed ?? (sync.state == .synced ? target : nil) else { return nil }
            text = "\(state) in Linear"
            tone = .quiet
            action = nil
            help = "Pilot moves this ticket as its contributing tasks progress."
            canPause = true
        case .pending:
            text = target.map { "Moving to \($0) in Linear" } ?? "Updating Linear"
            tone = .quiet
            action = nil
            help = Self.firstLine(sync.error).map { "Last attempt failed: \($0)" }
                ?? "Pilot moves this ticket as its contributing tasks progress."
            canPause = true
        case .paused:
            // pilotd's reasons say why, then what to review: the row keeps the why, the tooltip both.
            text = ["Linear updates paused.", Self.firstSentence(reason).map { "\($0)." }]
                .compactMap { $0 }.joined(separator: " ")
            tone = .attention
            action = .resume
            help = [reason, "Resume accepts the ticket's current tasks and Linear status and continues."]
                .compactMap { $0 }.joined(separator: "\n")
            canPause = false
        case .error:
            text = "Couldn't update Linear: \(Self.firstLine(sync.error) ?? reason ?? "unknown error")"
            tone = .problem
            action = .retry
            help = "Retry accepts the ticket's current tasks and Linear status and tries again. Check the team's "
                + "Linear status mappings in the project's settings if it keeps failing."
            canPause = false
        case .terminal:
            let word = observed ?? reason.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "Closed"
            text = "\(word) in Linear"
            tone = .quiet
            action = nil
            let closed = ["canceled", "duplicated"].contains(sync.reason?.lowercased() ?? "")
            help = closed
                ? "Unfinished contributing tasks were dropped; finished ones stay done. Pilot no longer updates this ticket."
                : "Pilot no longer updates this ticket."
            canPause = false
        }
    }

    private static func firstLine(_ text: String?) -> String? {
        text?.split(whereSeparator: \.isNewline).first?.trimmingCharacters(in: .whitespaces).nonEmptyTicketText
    }

    private static func firstSentence(_ text: String?) -> String? {
        guard let text else { return nil }
        let sentence = text.components(separatedBy: ". ").first ?? text
        return sentence.hasSuffix(".") ? String(sentence.dropLast()).nonEmptyTicketText : sentence.nonEmptyTicketText
    }
}

private extension String {
    var nonEmptyTicketText: String? { isEmpty ? nil : self }
}
