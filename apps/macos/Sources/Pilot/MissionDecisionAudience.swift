import PilotCore
import SwiftUI

extension MissionDecisionAudience {
    var label: String {
        switch self {
        case .all: "All chats"
        case .coordinator: "Coordinator only"
        case .reference: "Reference"
        }
    }

    var explanation: String {
        switch self {
        case .all: "Included in every mission chat's context."
        case .coordinator: "Included in the coordinator's context only, unless pinned to a task."
        case .reference: "Available on request, or included when pinned to a task."
        }
    }
}

/// Quiet metadata, not an attention badge.
struct DecisionAudienceTag: View {
    let audience: MissionDecisionAudience

    var body: some View {
        Text(audience.label)
            .font(.pilot(.small))
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(Theme.muted))
            .fixedSize()
            .help(audience.explanation)
            .accessibilityLabel("Audience: \(audience.label)")
    }
}

/// Native checked choices, shared by the form chip and row context menu.
struct DecisionAudienceOptions: View {
    @Binding var selection: MissionDecisionAudience

    var body: some View {
        Picker("Audience", selection: $selection) {
            ForEach(MissionDecisionAudience.allCases, id: \.self) { audience in
                Text(audience.label).tag(audience)
            }
        }
        .pickerStyle(.inline)
    }
}

struct DecisionAudiencePicker: View {
    @Binding var selection: MissionDecisionAudience

    var body: some View {
        Menu {
            DecisionAudienceOptions(selection: $selection)
        } label: {
            ChipLabel(title: selection.label, icon: PilotIcon.subagents)
        }
        .chipMenuStyle()
        .fixedSize()
        .help(selection.explanation)
        .accessibilityLabel("Decision audience")
        .accessibilityValue(selection.label)
    }
}
