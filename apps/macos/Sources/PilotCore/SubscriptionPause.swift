import Foundation

/// A provider window holding a chat at its usage limit. Same fields as `SubscriptionWindow`, plus its provider.
public struct SubscriptionPauseWindow: Codable, Equatable, Hashable, Sendable {
    /// Nil for a provider this build does not know, so a newer daemon never breaks the session list.
    public let provider: SubscriptionProvider?
    public let label: String
    public let usedPercent: Double
    /// ISO 8601 reset timestamp.
    public let resetsAt: String?

    public init(provider: SubscriptionProvider?, label: String, usedPercent: Double, resetsAt: String? = nil) {
        self.provider = provider
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }

    private enum CodingKeys: String, CodingKey { case provider, label, usedPercent, resetsAt }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try? container.decodeIfPresent(SubscriptionProvider.self, forKey: .provider)
        label = try container.decode(String.self, forKey: .label)
        usedPercent = try container.decode(Double.self, forKey: .usedPercent)
        resetsAt = try container.decodeIfPresent(String.self, forKey: .resetsAt)
    }

    /// The plain window, for the shared limit names and reset parsing.
    public var window: SubscriptionWindow { SubscriptionWindow(label: label, usedPercent: usedPercent, resetsAt: resetsAt) }
    public var providerLabel: String { provider?.displayName ?? "Subscription" }
}

/// pilotd holds a chat's work while a provider window is at or above `limitPercent` and resumes it on its own once
/// the window resets below it. `forced` means the user chose to keep working past the limit, so nothing is held.
public struct SubscriptionPause: Codable, Equatable, Hashable, Sendable {
    public static let limitPercent: Double = 99

    public let windows: [SubscriptionPauseWindow]
    public let forced: Bool?

    public init(windows: [SubscriptionPauseWindow], forced: Bool? = nil) {
        self.windows = windows
        self.forced = forced
    }

    public var isForced: Bool { forced ?? false }

    /// The window that decides when work resumes: the latest reset, else the most used window.
    public var decidingWindow: SubscriptionPauseWindow? {
        let dated = windows.filter { $0.window.resetDate != nil }
        if let latest = dated.max(by: { $0.window.resetDate! < $1.window.resetDate! }) { return latest }
        return windows.max { $0.usedPercent < $1.usedPercent }
    }

    /// One line above the composer: "Paused at Claude 5-hour limit · resumes at 18:00", or, when forced,
    /// "Working past usage limit · Claude 5-hour at 97%".
    public func notice(now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current)
        -> SubscriptionNotice {
        let window = decidingWindow
        var text: String
        if isForced {
            text = "Working past usage limit"
            if let window { text += " · \(window.providerLabel) \(window.window.limitName) at \(window.window.percentLabel)" }
        } else {
            text = window.map { "Paused at \($0.providerLabel) \($0.window.limitName) limit" } ?? "Paused at usage limit"
            if let reset = window?.window.resetDate, reset > now {
                text += " · resumes \(UsageFormatting.clock(reset, now: now, locale: locale, timeZone: timeZone))"
            } else {
                text += " · resumes when usage resets"
            }
        }
        return SubscriptionNotice(text: text, help: helpText, limited: !isForced)
    }

    public var helpText: String {
        let limit = UsageFormatting.percent(Self.limitPercent)
        var lines = [isForced
            ? "Working past the \(limit) usage limit. Pause at limit to hold work again until usage resets."
            : "Pilot holds new work at \(limit) of a usage window and resumes on its own once it resets."]
        lines += windows.map { "\($0.providerLabel) \($0.window.helpText)" }
        return lines.joined(separator: "\n")
    }
}

/// POST /api/sessions/:id/subscription-force. Returns the updated `SessionSummary`.
public struct SubscriptionForceRequest: Codable, Equatable, Sendable {
    public let force: Bool
    public init(force: Bool) { self.force = force }
}

/// POST /api/sessions/:id/continue-model. Returns the chat that continues the work: the same chat for a model from
/// the same provider, a new chat for another provider.
public struct ContinueModelRequest: Codable, Equatable, Sendable {
    public let model: String
    public let thinking: String?
    public init(model: String, thinking: String? = nil) {
        self.model = model
        self.thinking = thinking
    }
}

/// How continuing with another model treats the chat. pilotd decides; this explains it before the user confirms.
/// Like pilotd, the same chat needs both the configured and the physical provider to match; anything else is new.
public enum ModelContinuation: Equatable, Sendable {
    /// Same provider: the chat switches model and keeps its history. The same quota still holds it.
    case sameChat
    /// Another provider: a new chat starts from a plain-text handoff. The original becomes read-only.
    case newChat

    /// A model's provider from the catalog, else the "provider/" prefix of its ID.
    public static func provider(of model: String?, in models: ModelList) -> String? {
        guard let model, !model.isEmpty else { return nil }
        if let option = models.models.first(where: { $0.id == model }) { return option.provider }
        guard let slash = model.firstIndex(of: "/") else { return nil }
        return String(model[..<slash])
    }

    /// The catalog provider a subscription bills through, matching pilotd's mapping.
    public static func catalogProvider(_ provider: SubscriptionProvider) -> String {
        switch provider {
        case .anthropic: "anthropic"
        case .openai: "openai-codex"
        }
    }

    /// The same chat only when the current model's configured provider (catalog or ID prefix) matches the target,
    /// and so does `usageProvider`, the session's physical subscription provider, when known. A router-configured
    /// chat therefore starts fresh even if its last physical usage matches, because its pinned context and compaction
    /// may belong to the virtual provider. An unknown configured side is treated as another provider.
    public static func kind(current: String?, usageProvider: SubscriptionProvider? = nil, target: String,
                            models: ModelList) -> ModelContinuation {
        guard let from = provider(of: current, in: models), let to = provider(of: target, in: models), from == to,
              usageProvider.map({ catalogProvider($0) == to }) ?? true
        else { return .newChat }
        return .sameChat
    }

    public var confirmTitle: String {
        switch self {
        case .sameChat: "Switch model"
        case .newChat: "Start new chat"
        }
    }

    /// Every explanation ends with this, so no choice reads as a way around a limit.
    public static let quotaNote = "Usage limits still apply to the new model."

    public func explanation(modelName: String) -> String {
        switch self {
        case .sameChat:
            "Same provider, so the same subscription limit applies. This chat switches to \(modelName) and keeps its "
                + "history and context, but work still waits for the limit to reset unless you force work."
        case .newChat:
            "Different provider. Pilot starts a new chat with \(modelName) and hands it a plain-text summary of this "
                + "one, including the branch, pull requests and tasks. Provider context and compaction are not reused. "
                + "This chat becomes read-only and links to the new one. \(Self.quotaNote)"
        }
    }

    public static let pickerHelp = "A model from the same provider stays in this chat and shares its limit. Another "
        + "provider starts a new chat with a plain-text handoff."
}

extension SessionSummary {
    /// Work is held at a usage limit. A forced pause keeps working and is not paused.
    public var isSubscriptionPaused: Bool { subscriptionPause.map { !$0.isForced } ?? false }
    public var isWorkingPastUsageLimit: Bool { subscriptionPause?.isForced ?? false }
    /// A run is held by the pause: pilotd reports it not working while its durable run is still open. A finished
    /// chat can carry a pause too (a quota warning), and keeps its result and unread state.
    public var isHeldAtUsageLimit: Bool {
        isSubscriptionPaused && !isWorking && (state == "working" || state == "starting")
    }
    /// Work moved to another chat. This one keeps its history, takes no new work and never resumes.
    public var isContinued: Bool { continuedTo != nil }
    /// Archived or continued: history stays readable, nothing new runs here.
    public var isReadOnlyHistory: Bool { isArchived || isContinued }

    /// "Continued in Fix login", for the original chat's read-only footer.
    public static func continuedInLabel(_ title: String?) -> String {
        "Continued in \(title.flatMap { $0.isEmpty ? nil : $0 } ?? "another chat")"
    }

    /// "Continued from Fix login", above the new chat's transcript.
    public static func continuedFromLabel(_ title: String?) -> String {
        "Continued from \(title.flatMap { $0.isEmpty ? nil : $0 } ?? "another chat")"
    }
}
