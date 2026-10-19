import CryptoKit
import Foundation
import PilotCore

/// Pairing owns keys, consent and capability refresh. Courier receives a scoped capability and
/// an opaque signer; it cannot create an enrollment or fall back to native management authority.
@MainActor struct ControlCourierSigning {
    let capability: ControlCourierCapability
    let sign: (Data) async throws -> Data

    func permits(_ request: ControlCourierRequest, on host: HostRef) -> Bool {
        guard capability.scopes.contains(request.scope), capability.home.matches(host) || capability.executor.matches(host) else { return false }
        let path = request.path
        if path == ["operations"] || path == ["operations", "receipt"] {
            guard request.method == "POST", let body = request.body,
                  let operation = try? JSONDecoder().decode(ControlDurableOperation.self, from: body) else { return false }
            return operation.bindingId == capability.bindingId && operation.bindingGeneration == capability.generation
                && operation.origin == capability.home && operation.destination == capability.executor
                && capability.executor.matches(host) && request.scope == (path.count == 1 ? .exchange : .receipts)
        }
        guard path.count >= 2, path[0] == "control-hosts", path[1] == capability.bindingId else { return false }
        let suffix = Array(path.dropFirst(2))
        switch request.scope {
        case .inspect: return request.method == "GET" && [[], ["sync-state"], ["lifecycle"]].contains(suffix)
        case .exchange: return request.method == "POST" && suffix == ["exchange"] && capability.home.matches(host)
        case .receipts: return request.method == "POST" && suffix == ["ack"] && capability.home.matches(host)
        case .events:
            return request.method == "GET" && (suffix == ["events"] || suffix == ["events", "checkpoint"])
                || request.method == "POST" && (suffix == ["events", "import"] || suffix == ["events", "ack"])
        case .status: return request.method == "GET" && suffix == ["status"] || request.method == "POST" && suffix == ["status", "import"]
        case .reads: return request.method == "POST" && [["reads", "exchange"], ["reads", "execute"], ["reads", "import"]].contains(suffix)
        case .archiveRead: return request.method == "GET" && suffix.count >= 2 && suffix[0] == "archives"
        }
    }

    func authentication(method: String, path: String, body: Data?) async throws -> ControlCourierAuthentication {
        let issuedAt = (Date().timeIntervalSince1970 * 1000).rounded(.down)
        guard capability.expiresAt.isFinite, capability.expiresAt > issuedAt,
              let method = ControlCourierRequestProof.Method(rawValue: method) else {
            throw ControlCourierFailure(.authenticationRequired)
        }
        let hash = SHA256.hash(data: body ?? Data()).map { String(format: "%02x", $0) }.joined()
        let proof = ControlCourierRequestProof(capabilityId: capability.id, requestId: UUID().uuidString,
            issuedAt: issuedAt, method: method, path: path, bodyHash: hash)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let bytes = try encoder.encode(proof)
        var signed = Data("courier-v1\n".utf8); signed.append(bytes)
        let signature = try await sign(signed)
        try Task.checkCancellation()
        guard signature.count == 64 else { throw ControlCourierFailure(.authenticationRequired) }
        return ControlCourierAuthentication(signedPayload: String(decoding: bytes, as: UTF8.self), signature: signature.base64EncodedString())
    }
}
