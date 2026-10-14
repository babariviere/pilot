import Foundation
import Combine
import PilotCore

@MainActor
protocol ProjectMemoryClient {
    func memoryWake(_ projectId: String) async throws -> MemoryView
    func memoryZoom(_ projectId: String, lo: Int, hi: Int) async throws -> [MemoryNode]
    func memoryRecall(_ projectId: String, regex: String) async throws -> MemoryRecall
    func forgetMemory(_ projectId: String, lo: Int, hi: Int) async throws
}

extension PilotClient: ProjectMemoryClient {}

@MainActor
final class ProjectMemoryBrowserModel: ObservableObject {
    @Published private(set) var roots: [MemoryNode] = []
    @Published private(set) var children: [String: [MemoryNode]] = [:]
    @Published private(set) var expanded = Set<String>()
    @Published var query = ""
    @Published private(set) var results: [MemoryEntry] = []
    @Published private(set) var resultCount: Int?
    @Published private(set) var error: String?
    @Published private(set) var loading = true
    @Published private(set) var busy = false
    @Published private(set) var forgetting: MemoryNode?

    private let projectId: String
    private let client: any ProjectMemoryClient

    init(projectId: String, client: any ProjectMemoryClient) {
        self.projectId = projectId
        self.client = client
    }

    func load() async {
        loading = true
        error = nil
        do {
            roots = try await client.memoryWake(projectId).nodes
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    func expand(_ node: MemoryNode) async {
        if expanded.contains(node.key) {
            expanded.remove(node.key)
            return
        }
        busy = true
        error = nil
        do {
            children[node.key] = try await client.memoryZoom(projectId, lo: node.lo, hi: node.hi)
            expanded.insert(node.key)
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    func search() async {
        guard !query.isEmpty else { resultCount = nil; return }
        busy = true
        error = nil
        do {
            let recall = try await client.memoryRecall(projectId, regex: query)
            results = recall.entries
            resultCount = recall.matches
            if recall.truncated { error = "Showing the newest matching notes; narrow the search for more." }
        } catch {
            self.error = error.localizedDescription
            resultCount = nil
        }
        busy = false
    }

    func requestForget(_ node: MemoryNode) {
        guard node.canForget else { return }
        forgetting = node
    }
    func cancelForget() { forgetting = nil }

    func confirmForget() async {
        guard let node = forgetting else { return }
        forgetting = nil
        busy = true
        error = nil
        do {
            try await client.forgetMemory(projectId, lo: node.lo, hi: node.hi)
            children.removeAll()
            expanded.removeAll()
            resultCount = nil
            await load()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
