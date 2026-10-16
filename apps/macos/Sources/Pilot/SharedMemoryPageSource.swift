import Foundation
import PilotCore
import SwiftUI

/// Feeds the existing native tree/search/detail layout from an explicitly enrolled source.
@MainActor final class SharedMemoryPageSource: ObservableObject, ProjectMemoryClient {
    let context: HostViewContext?
    @Published private(set) var binding: SharedContextBinding?
    @Published private(set) var proposals: [SharedMemoryProposal] = []
    private let local: PilotClient

    init(context: HostViewContext?, local: PilotClient) { self.context = context; self.local = local }

    func select(_ binding: SharedContextBinding?) { self.binding = binding; proposals = [] }

    func memoryTree(_ projectId: String, range: MemoryRange?, depth: Int, reveal: [Int]) async throws -> MemoryTree {
        if let binding, let context {
            let result = try await context.hosts.sharedMemoryTree(binding, on: context.host, range: range, depth: depth, reveal: reveal)
            guard self.binding == binding, !Task.isCancelled else { throw CancellationError() }
            proposals = result.proposals
            return result.value
        }
        if let context { return try await HostProjectMemoryClient(context: context).memoryTree(projectId, range: range, depth: depth, reveal: reveal) }
        return try await local.memoryTree(projectId, range: range, depth: depth, reveal: reveal)
    }

    func memoryRecall(_ projectId: String, regex: String) async throws -> MemoryRecall {
        if let binding, let context {
            let result = try await context.hosts.sharedMemoryRecall(binding, on: context.host, regex: regex)
            guard self.binding == binding, !Task.isCancelled, case let .recall(value) = result.value else { throw CancellationError() }
            proposals = result.proposals
            return value
        }
        if let context { return try await HostProjectMemoryClient(context: context).memoryRecall(projectId, regex: regex) }
        return try await local.memoryRecall(projectId, regex: regex)
    }

    func forgetMemory(_ projectId: String, lo: Int, hi: Int) async throws {
        guard binding == nil else { throw ClientError("Shared summaries are read-only here. Make changes at the memory home.") }
        if let context { try await HostProjectMemoryClient(context: context).forgetMemory(projectId, lo: lo, hi: hi) }
        else { try await local.forgetMemory(projectId, lo: lo, hi: hi) }
    }
}

private struct SharedMemoryReadOnlyKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var sharedMemoryReadOnly: Bool {
        get { self[SharedMemoryReadOnlyKey.self] }
        set { self[SharedMemoryReadOnlyKey.self] = newValue }
    }
}

struct SharedMemoryContributionRows: View {
    let proposals: [SharedMemoryProposal]
    @State private var expanded = false
    var body: some View {
        if !proposals.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                PageSectionHeader(title: "Contributions", count: proposals.count)
                ForEach(expanded ? proposals : Array(proposals.prefix(5)), id: \.mutation.operationId) { proposal in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(proposal.state == .pending ? "Pending sharing" : "Conflicting edits")
                            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        Text(proposal.mutation.text).font(.pilot(.body)).lineLimit(6).textSelection(.enabled)
                        if proposal.state != .pending {
                            Text("Kept separately from saved memory. Review at the memory home.")
                                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        }
                    }
                    HairlineDivider()
                }
                if proposals.count > 5 { Button(expanded ? "Show fewer" : "Show all contributions") { expanded.toggle() } }
            }.padding(.top, 16)
        }
    }
}
