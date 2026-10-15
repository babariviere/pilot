import PilotCore
import SwiftUI

/// Suggestions are separate from the binding wording. The chat inspector omits resolution actions.
struct DecisionProposalView: View {
    let proposal: MissionDecisionProposal
    let oldText: String
    var resolve: ((Bool, String?) async throws -> Void)?
    @State private var editing = false
    @State private var replacement = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Proposed change").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            if proposal.kind == "remove" {
                Label("Remove this decision", icon: PilotIcon.remove)
                    .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            } else {
                Text(oldText).strikethrough().foregroundStyle(Theme.faintForeground)
                if editing {
                    TextField("Replacement wording", text: $replacement, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                } else {
                    Label(proposal.text ?? "", icon: PilotIcon.proposal)
                        .foregroundStyle(Theme.foreground)
                }
            }
            Text(proposal.reason).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if resolve != nil {
                HStack(spacing: 10) {
                    Button(editing ? "Accept edited wording" : "Accept") {
                        submit(true, editing ? replacement : nil)
                    }
                    .disabled(editing && replacement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if proposal.kind == "edit" {
                        Button(editing ? "Cancel edit" : "Edit and accept") {
                            replacement = proposal.text ?? ""
                            editing.toggle()
                        }
                    }
                    Button("Reject") { submit(false, nil) }
                }
                .controlSize(.small)
            }
            if let error { InlineProblem(error) }
        }
        .font(.pilot(.label))
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.muted, in: RoundedRectangle(cornerRadius: Theme.Radius.row))
        .disabled(busy)
    }

    private func submit(_ accept: Bool, _ text: String?) {
        guard let resolve, !busy else { return }
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await resolve(accept, text) }
            catch { self.error = error.localizedDescription }
        }
    }
}
