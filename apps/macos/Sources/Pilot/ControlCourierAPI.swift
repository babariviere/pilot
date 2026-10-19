import Foundation
import PilotCore

/// App-only request description. The shared protocol owns every body/response; this is not an
/// operation producer, approval channel or alternate daemon router.
struct ControlCourierRequest {
    let path: [String]
    var method = "GET"
    var body: Data?
    var query: [URLQueryItem] = []
    let scope: ControlCourierCapability.Scope
    var maximumBytes = 64 * 1024
}

struct ControlCourierFailure: Error {
    enum Kind { case unavailable, incompatible, reconciliationRequired, authenticationRequired }
    let kind: Kind
    let status: Int?
    let code: ControlHostErrorResponse.Code?
    init(_ kind: Kind, status: Int? = nil, code: ControlHostErrorResponse.Code? = nil) {
        self.kind = kind; self.status = status; self.code = code
    }
}

@MainActor struct ControlCourierAPI {
    static let maximumCounter = 9_007_199_254_740_991
    let token: HostConnectionToken
    let isCurrent: () -> Bool
    let send: (ControlCourierRequest) async throws -> Data

    func get<Response: Decodable & Sendable>(_ binding: String, _ path: [String],
        scope: ControlCourierCapability.Scope = .inspect, query: [URLQueryItem] = [],
        maximumBytes: Int = 64 * 1024) async throws -> Response {
        try await request(ControlCourierRequest(path: ["control-hosts", binding] + path,
            query: query, scope: scope, maximumBytes: maximumBytes))
    }

    func post<Body: Encodable, Response: Decodable & Sendable>(_ binding: String, _ path: [String],
        _ body: Body, scope: ControlCourierCapability.Scope, maximumBytes: Int = 64 * 1024) async throws -> Response {
        try await request(ControlCourierRequest(path: ["control-hosts", binding] + path, method: "POST",
            body: JSONEncoder().encode(body), scope: scope, maximumBytes: maximumBytes))
    }

    func operation(_ operation: ControlDurableOperation, lookup: Bool) async throws -> OperationDelivery {
        let data = try await sendChecked(ControlCourierRequest(path: lookup ? ["operations", "receipt"] : ["operations"],
            method: "POST", body: JSONEncoder().encode(operation), scope: lookup ? .receipts : .exchange))
        if try JSONValue.decode(data)["state"]?.string == "unknown" { return .unknown }
        let receipt = try JSONDecoder().decode(OperationReceipt.self, from: data)
        try receipt.validate(operation.durableOperation)
        return .receipt(receipt)
    }

    private func request<Response: Decodable & Sendable>(_ request: ControlCourierRequest) async throws -> Response {
        let data = try await sendChecked(request)
        let value = try await Task.detached(priority: .utility) { try JSONDecoder().decode(Response.self, from: data) }.value
        try check()
        return value
    }

    private func sendChecked(_ request: ControlCourierRequest) async throws -> Data {
        try check()
        guard (request.body?.count ?? 0) <= 2 * 1024 * 1024 else { throw HostRoutingError.invalidReference }
        let data = try await send(request)
        try check()
        guard data.count <= request.maximumBytes else { throw CocoaError(.fileReadTooLarge) }
        return data
    }

    func check() throws {
        try Task.checkCancellation()
        guard isCurrent() else { throw HostRoutingError.staleGeneration }
    }

    /// Existing response-only DTOs intentionally lack public memberwise initializers.
    static func value<T: Decodable>(_ type: T.Type, _ fields: [String: JSONValue]) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(fields))
    }
}
