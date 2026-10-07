import Foundation

/// Shared, testable presentation rules. Missing measurements are never treated as zero.
public enum UsageFormatting {
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

    private static func number(_ value: Double, decimals: Int = 0) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.maximumFractionDigits = decimals
        return formatter.string(from: NSNumber(value: value)) ?? "Unknown"
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
    public var gaugeFraction: Double? { displayedPercent.map { min($0 / 100, 1) } }
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

extension SubscriptionUsage {
    /// A providerless empty snapshot clears old limits after switching to an unsupported model.
    public var hasDisplayData: Bool { provider != nil || !windows.isEmpty || error != nil }

    public var providerLabel: String {
        switch provider {
        case .anthropic: "Claude"
        case .openai: "Codex"
        case nil: "Subscription"
        }
    }

    public var availabilityLabel: String? {
        if error != nil { return windows.isEmpty ? "Unavailable" : "Update failed" }
        return windows.isEmpty ? "No limits reported" : nil
    }

    public var fetchedDate: Date? {
        guard fetchedAt.isFinite, fetchedAt >= 0 else { return nil }
        return Date(timeIntervalSince1970: fetchedAt / 1_000)
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

extension SessionUsage {
    public var hasDisplayData: Bool { context != nil || subscription?.hasDisplayData == true }
}

extension SubscriptionWindow {
    public var percentLabel: String { UsageFormatting.percent(usedPercent) }
    public var helpText: String {
        let reset: String
        if let resetsAt {
            reset = UsageFormatting.resetDate(resetsAt).map { UsageFormatting.timestamp($0) } ?? "Unknown (\(resetsAt))"
        } else {
            reset = "Unknown"
        }
        return "\(label): \(percentLabel) used. Resets: \(reset)"
    }
}
