import PilotCore
import SwiftUI

/// Replaces the composer in a chat whose work moved to another chat (a switch to another provider's model). The
/// transcript stays readable; nothing here resumes or takes messages. The link opens the chat that took over.
struct ContinuedComposer: View {
    let nextId: String
    /// Only this footer follows the session list, for the new chat's title, so the transcript is not re-rendered.
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Button { AppModel.shared.reveal(session: nextId) } label: {
                    Label(SessionSummary.continuedInLabel(client.session(nextId)?.title), icon: PilotIcon.handoff)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .buttonStyle(.link)
                .font(.pilot(.body, weight: .medium))
                .help("Open the chat that continues this work")
                Text("Read-only. History stays here, and this chat does not resume.")
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.mutedForeground)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .card(radius: Theme.Radius.tray)
        .frame(maxWidth: Theme.column)
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
    }
}

/// One quiet link above a continued chat's transcript, back to the read-only chat it continues.
struct ContinuedFromRow: View {
    let originId: String
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        Button { AppModel.shared.reveal(session: originId) } label: {
            Label(SessionSummary.continuedFromLabel(client.session(originId)?.title), icon: PilotIcon.handoff)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .buttonStyle(.link)
        .font(.pilot(.caption))
        .help("Open the earlier chat. It stays read-only.")
    }
}
