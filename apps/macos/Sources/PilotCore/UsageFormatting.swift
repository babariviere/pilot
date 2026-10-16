import Foundation

/// A subscription window close to or at its limit, as one line above a chat's composer.
public struct SubscriptionNotice: Equatable, Sendable {
    public let text: String
    public let help: String
    /// A window is used up, so agents on this subscription cannot run until it resets.
    public let limited: Bool
}

/// Shared, testable presentation rules. Missing measurements are never treated as zero.
public enum UsageFormatting {
    public static func gaugeFraction(_ percent: Double?) -> Double? {
        guard let percent, percent.isFinite, percent >= 0 else { return nil }
        return min(percent / 100, 1)
    }
    public static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0 else { return "Unknown" }
        return number(value.rounded()) + "%"
    }

    public static func tokens(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0 else { return "Unknown" }
        if value >= 1_000_000 { return number(value / 1_000_000, decimals: 1) + "M" }
        if value >= 1_000 { return number(value / 1_000, decimals: 1) + "k" }
        return number(value.rounded())
    }

    public static func timestamp(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    public static func resetDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    /// When something happens, for a sentence: "at 18:00", "tomorrow at 09:00", "on Tue at 06:34" within a week,
    /// else "on 20 Oct at 06:34".
    public static func clock(_ date: Date, now: Date = Date(), locale: Locale = .current,
                             timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = locale
        calendar.timeZone = timeZone
        func format(_ template: String) -> String {
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.timeZone = timeZone
            formatter.setLocalizedDateFormatFromTemplate(template)
            return formatter.string(from: date)
        }
        let time = format("jmm")
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now),
                                           to: calendar.startOfDay(for: date)).day ?? 0
        switch days {
        case 0: return "at \(time)"
        case 1: return "tomorrow at \(time)"
        case 2..<7: return "on \(format("EEE")) at \(time)"
        default: return "on \(format("dMMM")) at \(time)"
        }
    }

    private static func number(_ value: Double, decimals: Int = 0) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.maximumFractionDigits = decimals
        return formatter.string(from: NSNumber(value: value)) ?? "Unknown"
    }
}

extension ModelList {
    public func displayName(for model: String?) -> String {
        guard let model, !model.isEmpty else { return "Model" }
        return models.first { $0.id == model }?.name ?? (model.split(separator: "/").last.map(String.init) ?? model)
    }
}

extension ContextUsage {
    public var displayedPercent: Double? {
        if let percent, percent.isFinite, percent >= 0 { return percent }
        guard let tokens, tokens.isFinite, tokens >= 0, contextWindow.isFinite, contextWindow > 0 else { return nil }
        let result = tokens / contextWindow * 100
        return result.isFinite ? result : nil
    }

    /// Only the drawing is clamped. Text retains estimates above the limit.
    public var gaugeFraction: Double? { UsageFormatting.gaugeFraction(displayedPercent) }
    public var percentLabel: String { UsageFormatting.percent(displayedPercent) }
    public var tokenLabel: String {
        "\(UsageFormatting.tokens(tokens))/\(UsageFormatting.tokens(contextWindow > 0 ? contextWindow : nil))"
    }
    public var helpText: String {
        let used = tokens.flatMap { $0.isFinite && $0 >= 0 ? String(format: "%.0f", $0) : nil } ?? "Unknown"
        let window = contextWindow.isFinite && contextWindow > 0 ? String(format: "%.0f", contextWindow) : "Unknown"
        return "Context window: \(percentLabel) used\nTokens: \(used) / \(window)\nContext usage is an estimate."
    }
}

extension SubscriptionProvider {
    public var displayName: String {
        switch self {
        case .anthropic: "Claude"
        case .openai: "Codex"
        }
    }
}

extension SubscriptionUsage {
    /// Chats mention subscription usage only from this share of a window, or once it is limited.
    public static let noticePercent: Double = 80

    /// The one line a chat shows above its composer when a window is past `noticePercent` or used up:
    /// "Claude 5-hour limit at 86% · resets at 18:00". The most used window wins. Windows that already reset and
    /// extra-usage spend are left out. nil when nothing is close to a limit.
    public func notice(now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current)
        -> SubscriptionNotice? {
        let candidates = windows.filter { window in
            guard !window.isExtra, window.usedPercent.isFinite, window.usedPercent >= Self.noticePercent else { return false }
            return window.resetDate.map { $0 > now } ?? true
        }
        guard let window = candidates.max(by: { $0.usedPercent < $1.usedPercent }) else { return nil }
        let limited = window.usedPercent >= 100
        var text = "\(providerLabel) \(window.limitName) limit " + (limited ? "reached" : "at \(window.percentLabel)")
        if let reset = window.resetDate {
            text += " · resets \(UsageFormatting.clock(reset, now: now, locale: locale, timeZone: timeZone))"
        }
        return SubscriptionNotice(text: text, help: displayHelpText(now: now), limited: limited)
    }

    /// The rate-limit windows (5-hour, weekly), not extra-usage spend.
    public var limitWindows: [SubscriptionWindow] { windows.filter { !$0.isExtra && $0.usedPercent.isFinite } }

    /// The windows Home draws as bars: the limits, then extra-usage spend when the provider reports it.
    public var homeWindows: [SubscriptionWindow] { windows.filter { $0.usedPercent.isFinite } }

    /// Home's usage columns across providers, one per window kind: hour limits (shortest first), then weekly,
    /// then any others in the order they first appear, then extra usage. Values are `SubscriptionWindow.columnLabel`s.
    public static func columns(_ usages: [SubscriptionUsage]) -> [String] {
        var ranks: [String: Int] = [:]
        var order: [String] = []
        for window in usages.flatMap(\.homeWindows) where ranks[window.columnLabel] == nil {
            ranks[window.columnLabel] = window.columnRank
            order.append(window.columnLabel)
        }
        return order.enumerated()
            .sorted { (ranks[$0.element]!, $0.offset) < (ranks[$1.element]!, $1.offset) }
            .map(\.element)
    }

    /// This provider's window in a Home column, or nil when it has no window of that kind.
    public func window(inColumn column: String) -> SubscriptionWindow? {
        homeWindows.first { $0.columnLabel == column }
    }

    public var providerLabel: String {
        provider?.displayName ?? "Subscription"
    }

    public var fetchedDate: Date? {
        guard fetchedAt.isFinite, fetchedAt >= 0 else { return nil }
        return Date(timeIntervalSince1970: fetchedAt / 1_000)
    }

    /// The shared snapshot is refreshed every minute while any pi session uses the subscription.
    public static let staleAfter: TimeInterval = 10 * 60

    /// Old snapshots stay visible with their age noted in the help instead of disappearing.
    public func isStale(now: Date = Date()) -> Bool {
        guard let fetchedDate else { return false }
        return now.timeIntervalSince(fetchedDate) > Self.staleAfter
    }

    public func displayHelpText(now: Date = Date()) -> String {
        guard isStale(now: now) else { return helpText }
        return helpText + "\nNot updated recently. Usage refreshes while a session uses this subscription."
    }

    public var helpText: String {
        var lines = ["\(providerLabel) subscription usage"]
        lines.append("Fetched: \(fetchedDate.map { UsageFormatting.timestamp($0) } ?? "Unknown")")
        lines.append("Latest provider snapshot, not a live measurement.")
        if let error { lines.append("Update error: \(error)") }
        if windows.isEmpty { lines.append("No usage windows reported.") }
        lines += windows.map(\.helpText)
        return lines.joined(separator: "\n")
    }
}

extension SubscriptionWindow {
    /// Extra-usage spend parsed from pi's label, "Extra [on] 46.17/200.00" or "Extra [active] 12.00": amounts in
    /// the provider's credits, as reported. `active` means spend is covering a used-up limit right now.
    public struct ExtraUsage: Equatable, Sendable {
        public let spent: String
        public let cap: String?
        public let active: Bool
    }

    public var gaugeFraction: Double? { UsageFormatting.gaugeFraction(usedPercent) }
    public var percentLabel: String { UsageFormatting.percent(usedPercent) }
    /// Extra usage reports spend against a cap, not a rate limit.
    public var isExtra: Bool { label.hasPrefix("Extra") }
    public var resetDate: Date? { resetsAt.flatMap(UsageFormatting.resetDate) }

    public var extraUsage: ExtraUsage? {
        guard isExtra else { return nil }
        var rest = label.dropFirst("Extra".count).trimmingCharacters(in: .whitespaces)
        var status = ""
        if rest.hasPrefix("["), let close = rest.firstIndex(of: "]") {
            status = String(rest[rest.index(after: rest.startIndex)..<close])
            rest = rest[rest.index(after: close)...].trimmingCharacters(in: .whitespaces)
        }
        let parts = rest.split(separator: "/", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let spent = parts.first, !spent.isEmpty else { return nil }
        return ExtraUsage(spent: spent, cap: parts.count > 1 && !parts[1].isEmpty ? parts[1] : nil,
                          active: status == "active")
    }

    /// The value after a bar on Home: the percent for a limit, the spend for extra usage ("46.17/200").
    public var valueLabel: String {
        guard let extra = extraUsage else { return percentLabel }
        func short(_ amount: String) -> String { amount.hasSuffix(".00") ? String(amount.dropLast(3)) : amount }
        return extra.cap.map { "\(short(extra.spent))/\(short($0))" } ?? short(extra.spent)
    }

    /// The limit in a sentence: "5h" is "5-hour", "Week" is "weekly".
    public var limitName: String {
        if isExtra { return "extra usage" }
        if let hours = hours { return "\(hours)-hour" }
        if isWeek { return "weekly" }
        return label.lowercased()
    }

    /// Label before a bar on Home: "5-hour", "Weekly", "Extra".
    public var columnLabel: String {
        if isExtra { return "Extra" }
        if let hours = hours { return "\(hours)-hour" }
        if isWeek { return "Weekly" }
        return label
    }

    /// Column order on Home: hour limits by length, then weekly, then the rest, then extra usage.
    var columnRank: Int {
        if isExtra { return 30_000 }
        if let hours = hours { return hours }
        return isWeek ? 10_000 : 20_000
    }

    private var hours: Int? {
        guard label.count > 1, label.lowercased().hasSuffix("h") else { return nil }
        return Int(label.dropLast())
    }

    private var isWeek: Bool { ["week", "weekly", "7d"].contains(label.lowercased()) }

    public var helpText: String {
        if let extra = extraUsage {
            let spend = extra.cap.map { "\(extra.spent) of \($0)" } ?? extra.spent
            return "Extra usage: \(spend) spent (\(percentLabel))" + (extra.active ? ". In use now." : "")
        }
        let reset: String
        if let resetsAt {
            reset = UsageFormatting.resetDate(resetsAt).map { UsageFormatting.timestamp($0) } ?? "Unknown (\(resetsAt))"
        } else {
            reset = "Unknown"
        }
        return "\(label): \(percentLabel) used. Resets: \(reset)"
    }
}
