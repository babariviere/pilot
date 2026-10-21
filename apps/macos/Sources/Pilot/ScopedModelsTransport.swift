import Foundation
import PilotCore

/// Uses the existing native host-action channel. No capability is retained in app state.
@MainActor struct ScopedModelsTransport {
    let client: PilotClient
    let token: HostConnectionToken
    let validate: () throws -> Void
    let capability: () async throws -> String

    func endpoint() -> LocalModelScope.Endpoint {
        .init(token: token, read: { try await read() }, write: { try await write($0, expectedHash: $1) },
              isCurrent: { (try? validate()) != nil })
    }

    func read() async throws -> ScopedModelsObservation {
        try validate()
        do {
            let scope: ModelScope = try await client.githubRequest("api/model-scope", capability: "",
                body: Optional<ModelScopeUpdateRequest>.none, method: "GET")
            try validate()
            return ScopedModelsObservation(baseline: .init(patterns: scope.enabledModels, hash: scope.scopeHash),
                candidates: scope.candidates.map { .init(id: $0.id, provider: $0.provider, name: $0.name) },
                resolution: scope.resolution.map { .init(pattern: $0.pattern, matches: $0.matches, reason: $0.unresolved?.rawValue) })
        } catch {
            try validate()
            throw Self.failure(error)
        }
    }

    func write(_ selection: ScopedModelsSelection, expectedHash: String) async throws {
        try selection.validate()
        try validate()
        // Every acquisition is host-specific, uncached and fenced before and after its await.
        let value = try await capability()
        try validate()
        do {
            let _: ModelScopeUpdateResponse = try await client.githubRequest("api/model-scope", capability: value,
                body: ModelScopeUpdateRequest(enabledModels: selection.patterns, expectedHash: expectedHash), method: "PUT")
            try validate()
            // Both union arms need literal GET readback. changed:false carries no resolution.
        } catch {
            try validate()
            throw Self.failure(error)
        }
    }

    private static func failure(_ error: Error) -> Error {
        guard let error = error as? ClientError else { return error }
        if error.status == 404 { return ScopedModelsFailure.unsupported }
        if error.status == 409 { return ScopedModelsFailure.conflict }
        switch (error.status, ModelScopeErrorCode(rawValue: error.message)) {
        case (403, .readOnly): return ScopedModelsFailure.readOnly
        case (403, .nativeActionRequired): return ScopedModelsFailure.nativeActionRequired
        case (400, .invalidScope): return ScopedModelsFailure.invalidSelection
        case (422, .settingsUnreadable), (503, .settingsUnreadable): return ScopedModelsFailure.settingsUnreadable
        default: return ScopedModelsFailure.unavailable
        }
    }
}
