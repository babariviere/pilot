import Foundation

/// Fully decoded WebSocket updates, prepared before crossing onto the UI actor.
public enum ServerUpdate: Sendable {
    case projects([Project])
    case sessions([SessionSummary])
    case session(SessionSummary)
    case events(sessionId: String, events: [JSONValue])
    /// A subagent transcript batch: a snapshot (or empty list) replaces it, entry_appended events extend it.
    case subagentEvents(sessionId: String, name: String, events: [JSONValue])
    case artifacts(ArtifactListMessage)
    /// Every mission, including done and archived ones.
    case missions([Mission])
    /// Full detail for one subscribed mission.
    case mission(MissionDetail)
    case terminalData(sessionId: String, data: String)
    case terminalExit(sessionId: String, code: Int)
    case error(sessionId: String?, name: String?, message: String)

    public static func decode(_ data: Data) throws -> ServerUpdate? {
        let json = try JSONValue.decode(data)
        switch json["type"]?.string {
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
            return .events(sessionId: id, events: events)
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
        case "terminal.data":
            guard let id = json["sessionId"]?.string, let data = json["data"]?.string else { return nil }
            return .terminalData(sessionId: id, data: data)
        case "terminal.exit":
            guard let id = json["sessionId"]?.string else { return nil }
            return .terminalExit(sessionId: id, code: json["code"]?.int ?? 0)
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
