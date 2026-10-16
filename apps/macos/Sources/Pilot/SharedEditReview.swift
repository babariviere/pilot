import PilotCore
import SwiftUI

/// A home-authority review, not an optimistic edit of the displayed mission.
struct SharedEditReview: View {
    let context: SharedProjectContext
    let proposal: SharedMissionProposal
    var onResolved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: SharedProjectModel
    @State private var confirmed = false
    @State private var savedText = "Loading saved content…"
    @State private var proposedText = "Loading proposed edit…"
    @State private var previewComplete = false
    @State private var previewGeneration = 0

    init(context: SharedProjectContext, proposal: SharedMissionProposal, onResolved: @escaping () -> Void = {}) {
        self.context = context; self.proposal = proposal; self.onResolved = onResolved
        _model = StateObject(wrappedValue: SharedProjectModel(context: context))
    }

    private var current: SharedEntity? {
        model.mission?.snapshot.entities.first {
            $0.id == proposal.entityId && $0.kind == (proposal.action == "brief" ? .brief : proposal.action == "decide" ? .decision : .task)
        }
    }
    private var reviewComputer: String {
        (try? context.host(for: context.binding.missionHome)) == nil
            ? "the computer that saves this mission" : context.name(context.binding.missionHome)
    }
    private func formatted<Value: Encodable & Sendable>(_ value: Value) async -> (String, Bool) {
        await Task.detached(priority: .utility) {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            guard let data = try? encoder.encode(value) else { return ("Unavailable", false) }
            let complete = data.count <= 32 * 1024
            return (String(decoding: data.prefix(32 * 1024), as: UTF8.self), complete)
        }.value
    }

    var body: some View {
        SheetScaffold("Review conflicting edits", subtitle: "Review on \(reviewComputer). Saved content is unchanged until you confirm.", error: model.error,
                      primary: SheetPrimaryAction(title: model.busy ? "Saving…" : "Use proposed edit",
                                                  enabled: confirmed && previewComplete && !model.busy && model.reviewRevision(proposal) != nil,
                                                  action: resolve), width: 600) {
            VStack(alignment: .leading, spacing: 12) {
                Text("This edit was based on saved revision \(proposal.expectedRevision). The earlier text is not available in this review.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        PageSectionHeader(title: "Saved here")
                        Text(savedText)
                            .font(.pilot(.body)).textSelection(.enabled)
                        HairlineDivider()
                        PageSectionHeader(title: "Proposed edit")
                        Text(proposedText).font(.pilot(.body)).textSelection(.enabled)
                    }
                }.frame(maxHeight: 320)
                if model.reviewRevision(proposal) == nil, !model.busy {
                    Text("Review on \(reviewComputer) after refreshing the saved content. Removed or unknown items cannot be overwritten here.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                if !previewComplete, !model.busy {
                    Text("This edit cannot be fully reviewed here. Keep it unchanged and review its complete content on \(reviewComputer).")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                Toggle("I reviewed the saved content and want to apply this proposed edit", isOn: $confirmed)
                    .font(.pilot(.body)).disabled(!previewComplete || model.reviewRevision(proposal) == nil)
                Button("Refresh saved content") {
                    confirmed = false
                    Task { await load() }
                }.disabled(model.busy)
            }.foregroundStyle(Theme.foreground)
        }
        .task { await load() }
        .onDisappear { model.stop() }
    }

    private func load() async {
        previewGeneration += 1
        let generation = previewGeneration
        previewComplete = false; confirmed = false
        await model.loadMission(proposal.missionId)
        guard generation == previewGeneration, !Task.isCancelled else { return }
        let incoming = await formatted(proposal.args)
        let saved: (String, Bool)
        if let value = current?.value { saved = await formatted(value) }
        else { saved = (current?.deleted == true ? "This item was removed." : "No saved item.", model.reviewRevision(proposal) == 0) }
        guard generation == previewGeneration, !Task.isCancelled else { return }
        proposedText = incoming.0; savedText = saved.0; previewComplete = incoming.1 && saved.1
    }

    private func resolve() {
        guard previewComplete else { return }
        Task {
            if await model.resolve(proposal) { onResolved(); dismiss() }
            else { confirmed = false }
        }
    }
}

/// Reusable rows for the lead's existing mission/task content. Proposals are never
/// folded into the committed detail, including while disconnected.
struct SharedMissionContributions: View {
    let context: SharedProjectContext
    let proposals: [SharedMissionProposal]
    var onResolved: () -> Void = {}
    @State private var reviewing: SharedMissionProposal?
    @State private var showAll = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !proposals.isEmpty {
                PageSectionHeader(title: "Contributions", count: proposals.count)
                ForEach(showAll ? proposals : Array(proposals.prefix(5)), id: \.proposalId) { proposal in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(proposal.state == .pending ? SharedSaveState.pending.rawValue
                                 : proposal.state == .committed ? SharedSaveState.saved.rawValue : SharedSaveState.conflict.rawValue)
                                .font(.pilot(.body))
                            Text("\(proposal.action.capitalized) edit, kept separately from saved content")
                                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        }
                        Spacer()
                        if proposal.state == .conflict {
                            Button("Review on \(context.name(context.binding.missionHome))") { reviewing = proposal }
                                .disabled((try? context.host(for: context.binding.missionHome)) == nil)
                        }
                    }
                    HairlineDivider()
                }
                if proposals.count > 5 { Button(showAll ? "Show fewer" : "Show all \(proposals.count)") { showAll.toggle() } }
            }
        }
        .foregroundStyle(Theme.foreground)
        .sheet(isPresented: Binding(get: { reviewing != nil }, set: { if !$0 { reviewing = nil } })) {
            if let reviewing, let home = try? context.host(for: context.binding.missionHome) {
                SharedEditReview(context: SharedProjectContext(binding: context.binding, readingHost: home, hosts: context.hosts),
                                 proposal: reviewing, onResolved: onResolved)
            }
        }
    }
}
