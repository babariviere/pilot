import Foundation

/// Mirrors packages/protocol/src/power.ts. Settings live in pilotd, not the app's UserDefaults.
public struct PowerSettings: Codable, Equatable, Sendable {
    public var keepAwake: Bool
    public var closedLid: Bool
    public init(keepAwake: Bool, closedLid: Bool) { self.keepAwake = keepAwake; self.closedLid = closedLid }
}
public struct PowerStatus: Codable, Equatable, Sendable {
    public var settings: PowerSettings
    public var available: Bool
    public var authorized: Bool
    public var keepingAwake: Bool
    public var closedLidActive: Bool
    public var paused: Bool
    public var connectedToPower: Bool
    public var wifiConnected: Bool
    public var error: String?

    public var summary: String {
        if paused { return "Agents paused. They’ll resume after the next wake with a connection." }
        if !settings.keepAwake { return "Agent-aware sleep is off. This Mac follows its usual sleep settings." }
        if !available { return "Energy management is unavailable. Use the bundled macOS app." }
        if closedLidActive { return "Working with the lid closed is allowed. Power and Wi-Fi are connected." }
        if keepingAwake { return "Keeping this Mac awake while agents work." }
        return "This Mac can sleep. No agents need to keep it awake."
    }
}
