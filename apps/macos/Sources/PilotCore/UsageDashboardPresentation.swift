import Foundation

/// Presentation only. The store aggregates requests; this never reduces ledger pages or checkpoints.
public enum UsageDashboardPresentation {
    public static let day: Double = 86_400_000
    public static let maximum: Double = 9_007_199_254_740_991

    public static func number(_ metric: UsageMetric?, currency: Bool = false) -> String {
        guard let metric else { return "Unknown" }
        if metric.overflow { return "Overflow" }
        guard let value = metric.value else { return "Unknown" }
        let amount = currency ? estimate(value) : UsageFormatting.tokens(value)
        return amount + (metric.unknown > 0 || metric.partial > 0 ? " · partial" : "")
    }

    public static func estimate(_ micros: Double?) -> String {
        guard let micros else { return "Unknown" }
        return String(format: micros > 0 && micros < 10_000 ? "≈ $%.6f" : "≈ $%.4f", micros / 1_000_000)
    }

    public static func coverage(_ metric: UsageMetric?) -> String {
        guard let metric else { return "No measurement" }
        return "\(metric.known) known · \(metric.unknown) unknown · \(metric.partial) incomplete"
            + (metric.overflow ? " · sum overflow" : "")
    }

    public static func inputOutput(_ aggregate: UsageAggregate) -> Double? {
        guard let input = aggregate.metrics["input"], let output = aggregate.metrics["output"],
              !input.overflow, !output.overflow, let a = input.value, let b = output.value,
              a <= maximum - b else { return nil }
        return a + b
    }

    public static func inputOutputLabel(_ aggregate: UsageAggregate) -> String {
        if aggregate.metrics["input"]?.overflow == true || aggregate.metrics["output"]?.overflow == true { return "Overflow" }
        if let a = aggregate.metrics["input"]?.value, let b = aggregate.metrics["output"]?.value, a > maximum - b { return "Overflow" }
        return UsageFormatting.tokens(inputOutput(aggregate))
    }

    public static func cacheEfficiency(_ aggregate: UsageAggregate) -> String {
        guard let input = aggregate.metrics["input"], let read = aggregate.metrics["cacheRead"],
              [input, read].allSatisfy({ !$0.overflow && $0.unknown == 0 && $0.partial == 0 }),
              let a = input.value, let b = read.value, a <= maximum - b, a + b > 0 else { return "Unknown" }
        return UsageFormatting.percent(100 * b / (a + b))
    }

    public static func utc(_ milliseconds: Double) -> String {
        UsageFormatting.timestamp(Date(timeIntervalSince1970: milliseconds / 1000),
                                  timeZone: TimeZone(secondsFromGMT: 0)!) + " UTC"
    }

    /// Current catalog names decorate exact accounting identities, never replace their filters.
    /// Mission titles are valid only on their canonical home/lineage, not by mission UUID alone.
    public static func displayNames(_ keys: [String], dimension: String, host: HostRef,
                                    projects: [Project], chats: [SessionSummary], missions: [Mission]) -> [String: String] {
        var names: [String: String] = [:]
        for key in keys {
            guard let decoded = group(key, dimension: dimension) else { continue }
            let name: String?
            switch dimension {
            case "project":
                name = projects.first { $0.id.lowercased() == decoded.filters.projectId?.lowercased() }?.name
            case "chat":
                name = chats.first { $0.id.lowercased() == decoded.filters.chatId?.lowercased() }
                    .map { $0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Untitled chat" : $0.title }
            case "mission":
                guard let identity = decoded.filters.mission,
                      identity.homeId.lowercased() == host.daemonId.lowercased(),
                      identity.lineageId.lowercased() == host.lineageId.lowercased() else { continue }
                name = missions.first { $0.id.lowercased() == identity.missionId.lowercased() }?.title
            default: name = nil
            }
            if let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { names[key] = name }
        }
        return names
    }

    public static func attributionKey(_ row: UsageObservation, dimension: String) -> String? {
        let encoder = JSONEncoder()
        let data: Data?
        switch dimension {
        case "project": data = row.attribution?.projectId.flatMap { try? encoder.encode($0.lowercased()) }
        case "chat": data = row.attribution?.chatId.flatMap { try? encoder.encode($0.lowercased()) }
        case "mission": data = row.attribution?.mission.flatMap {
            try? encoder.encode([$0.homeId.lowercased(), $0.lineageId.lowercased(), $0.missionId.lowercased()])
        }
        default: data = nil
        }
        return data.map { String(decoding: $0, as: UTF8.self) }
    }

    /// Full UTC bucket extents: a partial final day must still fit its whole bar inside the plot.
    public static func chartWindow(_ window: UsageDashboardWindow) -> ClosedRange<Date> {
        let first = floor(window.from / day) * day
        let last = max(first + day, ceil(window.to / day) * day)
        return Date(timeIntervalSince1970: first / 1000)...Date(timeIntervalSince1970: last / 1000)
    }

    /// Keys are canonical JSON, not titles or the chat's current model. Unknown is an exact missing filter.
    public static func group(_ key: String, dimension: String,
                             base: UsageQueryFilters = .init()) -> (label: String, filters: UsageQueryFilters)? {
        guard let data = key.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return nil }
        var filters = base
        filters.missing = filters.missing?.filter { $0 != dimension }
        if value is NSNull {
            switch dimension {
            case "project": filters.projectId = nil
            case "chat": filters.chatId = nil
            case "mission": filters.mission = nil
            case "physicalModel": filters.physicalModel = nil
            default: return nil
            }
            filters.missing = (filters.missing ?? []) + [dimension]
            return ("Unattributed \(dimension)", filters)
        }
        if let id = value as? String {
            switch dimension {
            case "project": filters.projectId = id
            case "chat": filters.chatId = id
            case "purpose": filters.purpose = id
            default: return nil
            }
            return (dimension == "purpose" ? purpose(id) : "\(dimension.capitalized) \(id)", filters)
        }
        guard let parts = value as? [String] else { return nil }
        if dimension == "mission", parts.count == 3 {
            filters.mission = .init(homeId: parts[0], lineageId: parts[1], missionId: parts[2])
            return ("Mission \(parts[2]) · home \(parts[0]) / \(parts[1])", filters)
        }
        if dimension == "physicalModel", parts.count == 2 {
            filters.physicalModel = .init(provider: parts[0], model: parts[1])
            return (parts.joined(separator: "/"), filters)
        }
        return nil
    }

    public static func purpose(_ value: String) -> String {
        switch value {
        case "agent": "Agents"
        case "control": "Retained Control work"
        case "follow_up": "Automatic follow-ups"
        case "title": "Chat titles"
        case "triage": "Triage"
        case "classification": "Classification"
        case "memory": "Project memory"
        case "compaction": "Compaction"
        case "other": "Other work"
        default: "Unknown purpose"
        }
    }
}

public struct UsageDashboardWindow: Hashable, Sendable {
    public let from: Double
    public let to: Double
    public init(from: Double, to: Double) { self.from = from; self.to = to }

    public static func preset(days: Int?, now: Date) -> Self {
        let end = floor(now.timeIntervalSince1970 * 1000)
        let today = floor(end / UsageDashboardPresentation.day) * UsageDashboardPresentation.day
        // All means retained history, never an unbounded historical scan.
        return Self(from: today - Double((days ?? 366) - 1) * UsageDashboardPresentation.day, to: end + 1)
    }

    public static func custom(first: Date, last: Date, now: Date) -> Self? {
        let day = UsageDashboardPresentation.day
        let a = floor(min(first, last).timeIntervalSince1970 * 1000 / day) * day
        let b = floor(max(first, last).timeIntervalSince1970 * 1000 / day) * day
        let today = floor(now.timeIntervalSince1970 * 1000 / day) * day
        guard a >= 0, b <= today, b - a < 366 * day else { return nil }
        return Self(from: a, to: min(b + day, floor(now.timeIntervalSince1970 * 1000) + 1))
    }
}
