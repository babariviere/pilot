import Foundation

/// Fully decoded WebSocket updates, prepared before crossing onto the UI actor.
public enum ServerUpdate: Sendable {
    case power(PowerStatus)
    case mcp(McpStatus)
    case schedules([ScheduledItem])
    case projects([Project])
    case sources([TrackingSource])
    case trackedChanged(projectId: String)
    case sharedContextsChanged
    /// Invalidation only. Refetch the bounded control-chat HTTP pages.
    case watchesChanged
    case controlAuditChanged
    /// The control chat's memory changed (coalesced by pilotd to at most one per second).
    case controlMemoryChanged
    case dashboardChanged
    case sessions([SessionSummary])
    case session(SessionSummary)
    /// `seq` numbers a chat socket's batches, for resuming; absent on the shared socket.
    case events(sessionId: String, events: [JSONValue], seq: Int?)
    /// First frame on every chat socket connection. Not resumed: a snapshot follows.
    case chatStream(sessionId: String, streamId: String, resumed: Bool)
    /// A subagent transcript batch: a snapshot (or empty list) replaces it, entry_appended events extend it.
    case subagentEvents(sessionId: String, name: String, events: [JSONValue])
    case artifacts(ArtifactListMessage)
    /// Every mission, including done and archived ones.
    case missions([Mission])
    /// Full detail for one subscribed mission.
    case mission(MissionDetail)
    /// A subscribed project's dashboard.
    case dashboard(ProjectDashboard)
    /// Sidebar counts for every project.
    case dashboardCounts(ProjectDashboardCounts)
    case terminalData(sessionId: String, data: String)
    case terminalExit(sessionId: String, code: Int)
    case terminalHello(sessionId: String, bootId: String, terminalId: String?)
    case terminalReady(sessionId: String, terminalId: String)
    case error(sessionId: String?, name: String?, message: String)

    public static func decode(_ data: Data) throws -> ServerUpdate? {
        let json = try JSONValue.decode(data)
        switch json["type"]?.string {
        case "power":
            guard let value = json["power"] else { return nil }
            return .power(try value.decode(PowerStatus.self))
        case "mcp":
            guard let value = json["mcp"] else { return nil }
            return .mcp(try value.decode(McpStatus.self))
        case "schedules":
            guard let list = json["schedules"] else { return nil }
            return .schedules(try list.decode([ScheduledItem].self))
        case "sources":
            guard let list = json["sources"] else { return nil }
            return .sources(try list.decode([TrackingSource].self))
        case "tracked.changed":
            guard let id = json["projectId"]?.string else { return nil }
            return .trackedChanged(projectId: id)
        case "shared-contexts.changed":
            return .sharedContextsChanged
        case "watches.changed":
            return .watchesChanged
        case "control-audit.changed":
            return .controlAuditChanged
        case "control-memory.changed":
            return .controlMemoryChanged
        case "dashboard.changed":
            return .dashboardChanged
        case "projects":
            guard let list = json["projects"] else { return nil }
            return .projects(try list.decode([Project].self).sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            })
        case "sessions":
            guard let list = json["sessions"] else { return nil }
            return .sessions(try list.decode([SessionSummary].self).sorted(by: SessionSummary.listPrecedes))
        case "session":
            guard let session = json["session"] else { return nil }
            return .session(try session.decode(SessionSummary.self))
        case "events":
            guard let id = json["sessionId"]?.string, let events = json["events"]?.array else { return nil }
            return .events(sessionId: id, events: events, seq: json["seq"]?.int)
        case "chat.stream":
            guard let id = json["sessionId"]?.string, let stream = json["streamId"]?.string else { return nil }
            return .chatStream(sessionId: id, streamId: stream, resumed: json["resumed"]?.bool ?? false)
        case "subagent.events":
            guard let id = json["sessionId"]?.string, let name = json["name"]?.string,
                  let events = json["events"]?.array else { return nil }
            return .subagentEvents(sessionId: id, name: name, events: events)
        case "artifacts":
            guard let update = ArtifactListMessage.parse(json) else { return nil }
            return .artifacts(update)
        case "missions":
            guard let list = json["missions"] else { return nil }
            return .missions(try list.decode([Mission].self))
        case "mission":
            guard let detail = json["mission"] else { return nil }
            return .mission(try detail.decode(MissionDetail.self))
        case "dashboard":
            guard let dashboard = json["dashboard"] else { return nil }
            return .dashboard(try dashboard.decode(ProjectDashboard.self))
        case "dashboard.counts":
            guard let counts = json["counts"] else { return nil }
            return .dashboardCounts(try counts.decode(ProjectDashboardCounts.self))
        case "terminal.data":
            guard let id = json["sessionId"]?.string, let data = json["data"]?.string else { return nil }
            return .terminalData(sessionId: id, data: data)
        case "terminal.exit":
            guard let id = json["sessionId"]?.string else { return nil }
            return .terminalExit(sessionId: id, code: json["code"]?.int ?? 0)
        case "terminal.hello":
            guard let id = json["sessionId"]?.string, let boot = json["bootId"]?.string else { return nil }
            return .terminalHello(sessionId: id, bootId: boot, terminalId: json["terminalId"]?.string)
        case "terminal.ready":
            guard let id = json["sessionId"]?.string, let terminal = json["terminalId"]?.string else { return nil }
            return .terminalReady(sessionId: id, terminalId: terminal)
        case "error":
            return .error(
                sessionId: json["sessionId"]?.string, name: json["name"]?.string,
                message: json["message"]?.string ?? "Unknown error"
            )
        default:
            return nil
        }
    }
}
