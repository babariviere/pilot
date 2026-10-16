import PilotCore

/// Ordinary, unlinked memory still belongs to its chosen project endpoint.
@MainActor struct HostProjectMemoryClient: ProjectMemoryClient {
    let context: HostViewContext
    func memoryTree(_ projectId: String, range: MemoryRange?, depth: Int, reveal: [Int]) async throws -> MemoryTree {
        try await context.perform(.project, projectId) { client, id in try await client.memoryTree(id, range: range, depth: depth, reveal: reveal) }
    }
    func memoryRecall(_ projectId: String, regex: String) async throws -> MemoryRecall {
        try await context.perform(.project, projectId) { client, id in try await client.memoryRecall(id, regex: regex) }
    }
    func forgetMemory(_ projectId: String, lo: Int, hi: Int) async throws {
        try await context.perform(.project, projectId) { client, id in try await client.forgetMemory(id, lo: lo, hi: hi) }
    }
}
