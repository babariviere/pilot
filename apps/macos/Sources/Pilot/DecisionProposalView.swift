import PilotCore
import SwiftUI

/// A proposed change to a decision, as a quote under it: the binding wording struck through, the suggested wording
/// (editable in place) and the reason. One primary Accept takes the shown wording, edited or not; Edit and Reject stay
/// quiet. Without `resolve` it is read-only.
struct DecisionProposalView: View {
    let proposal: MissionDecisionProposal
    let oldText: String
    var resolve: ((Bool, String?) async throws -> Void)?
    @State private var editing = false
    @State private var replacement = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        QuoteBlock {
            Text("Proposed change").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            if proposal.kind == "remove" {
                Label("Remove this decision", icon: PilotIcon.remove)
                    .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            } else {
                Text(oldText).strikethrough().foregroundStyle(Theme.faintForeground)
                    .fixedSize(horizontal: false, vertical: true)
                if editing {
                    TextField("Replacement wording", text: $replacement, axis: .vertical)
                        .textFieldStyle(.plain)
                        .foregroundStyle(Theme.foreground)
                        .padding(.vertical, 2)
                        .overlay(alignment: .bottom) { HairlineDivider() }
                        .onSubmit(accept)
                        .accessibilityLabel("Replacement wording")
                } else {
                    Text(proposal.text ?? "").foregroundStyle(Theme.foreground)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(proposal.reason).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if resolve != nil {
                HStack(spacing: 12) {
                    Button("Accept", action: accept)
                        .buttonStyle(.borderedProminent)
                        .disabled(editing && trimmed.isEmpty)
                        .help(editing ? "Accept the edited wording" : "Accept this change")
                    if proposal.kind == "edit" {
                        Button(editing ? "Cancel Edit" : "Edit") {
                            replacement = proposal.text ?? ""
                            editing.toggle()
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.mutedForeground)
                    }
                    Button("Reject") { submit(false, nil) }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.mutedForeground)
                }
                .controlSize(.small)
                .padding(.top, 2)
            }
            if let error { InlineProblem(error) }
        }
        .font(.pilot(.label))
        .frame(maxWidth: .infinity, alignment: .leading)
        .disabled(busy)
    }

    private var trimmed: String { replacement.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func accept() {
        guard !editing || !trimmed.isEmpty else { return }
        submit(true, editing ? trimmed : nil)
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
