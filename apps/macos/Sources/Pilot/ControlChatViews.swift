import PilotCore
import SwiftUI

/// Top of the control chat's transcript: its symbol, title and scope, then one sentence on what it can see and do.
/// Quiet type without a card, like a page header, so the conversation below stays the focus. The title is the
/// chat's own (pilotd names it), never a second copy here.
struct ControlChatHeader: View {
    let title: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            PilotSymbol(PilotIcon.controlChat)
                .foregroundStyle(Theme.mutedForeground)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(title)
                        .font(.pilot(.body, weight: .semibold))
                        .foregroundStyle(Theme.foreground)
                        .accessibilityAddTraits(.isHeader)
                    MetaText(ControlChatIdentity.scope)
                }
                Text(ControlChatIdentity.summary)
                    .font(.pilot(.label))
                    .foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
