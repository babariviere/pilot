import Foundation

/// Evidence selectors are not access grants. The native courier uses only verified, already-linked endpoints.
public struct DiagnosticContextRequest: Codable, Sendable {
    public let action: String
    public let host: HostRef?
    public let sessionId: String?
    public let projectId: String?
    public let missionId: String?
    public let query: String?
    public let since: String?
    public let until: String?
    public let after: String?
    public let before: Int?
    public let limit: Int?
    public let log: JSONValue?
}
public struct DiagnosticReadDispatch: Codable, Sendable {
    public let id: String
    public let request: DiagnosticContextRequest
}
public struct DiagnosticContextResponse: Codable, Sendable {
    public let schemaVersion: Int
    public let host: HostRef
    public let collectedAt: String
    public let status: String
    public let reason: String?
    public let data: JSONValue?
    public let page: JSONValue
}
