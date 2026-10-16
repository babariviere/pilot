import PilotCore
import SwiftUI

/// Retained edits sit beside the existing mission content, never applied speculatively.
struct SharedMissionPageSection: View {
    let mission: HostResourceRef
    @ObservedObject var hosts: HostClients
    @State private var contributions: [(SharedContextBinding, SharedMissionRead)] = []
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(contributions, id: \.0.bindingId) { binding, read in
                SharedMissionContributions(
                    context: SharedProjectContext(binding: binding, readingHost: mission.host, hosts: hosts),
                    proposals: read.proposals, onResolved: { Task { await load() } })
            }
            if let error { InlineProblem(error) { Task { await load() } } }
        }
        .task(id: "\(mission.storageKey):\(hosts.sharedRevision)") { await load() }
    }

    private func load() async {
        do {
            let bindings = try await hosts.sharedContexts(on: mission.host).map(\.binding).filter {
                $0.state == .active && $0.missionIds.contains(mission.localId)
            }
            var next: [(SharedContextBinding, SharedMissionRead)] = []
            for binding in bindings {
                try Task.checkCancellation()
                let read = try await hosts.sharedMission(binding, on: mission.host, missionId: mission.localId)
                if !read.proposals.isEmpty { next.append((binding, read)) }
            }
            guard !Task.isCancelled else { return }
            contributions = next; error = nil
        } catch {
            guard !Task.isCancelled else { return }
            if !contributions.isEmpty { self.error = "Reconnect to check shared edits. Showing the last saved view." }
        }
    }
}
