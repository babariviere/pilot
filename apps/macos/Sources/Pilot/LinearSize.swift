import PilotCore
import SwiftUI

// Linear issue size: Pilot's estimate (Quick fix, Needs planning or Unknown) from a ticket's title and description,
// which the user can correct from the row. Corrections teach the project's triage guide. A size never starts work:
// Needs planning only makes Start mission the row's suggested action.

extension LinearSize {
    /// Picker order.
    static let choices: [LinearSize] = [.quickFix, .needsPlanning, .unknown]

    var title: String {
        switch self {
        case .quickFix: "Quick fix"
        case .needsPlanning: "Needs planning"
        case .unknown: "Unknown"
        }
    }
}

extension TrackedItemText {
    /// The size chip a Linear row shows, or nil when it has nothing to say: Unknown, not estimated yet, or a done or
    /// canceled issue, which recedes.
    static func shownSize(_ size: LinearSize?, item: TrackedItem) -> LinearSize? {
        guard item.kind == .linear, linearGroup(item) != .done, let size, size != .unknown else { return nil }
        return size
    }

    /// Needs planning makes Start mission the row's primary action, marked Suggested. Never automatic.
    static func suggestsMission(_ size: LinearSize?, item: TrackedItem) -> Bool {
        shownSize(size, item: item) == .needsPlanning
    }

    static func sizeHelp(_ size: LinearSize, setByUser: Bool) -> String {
        let source = setByUser ? "\(size.title), set by you." : "\(size.title), estimated by Pilot from the ticket."
        return "\(source) Click to correct it. Corrections help Pilot size similar tickets."
    }

    /// Tells a chat started from a ticket its size, and to propose a mission rather than start one. Nil when the size
    /// is unknown.
    static func sizeNote(_ size: LinearSize?) -> String? {
        let confirm = "suggest a mission before implementing it, and don't start one without my confirmation."
        switch size {
        case .quickFix: return "Estimated size: Quick fix. If it turns out to need planning, \(confirm)"
        case .needsPlanning: return "Estimated size: Needs planning. Before you start, \(confirm)"
        case .unknown, nil: return nil
        }
    }
}

/// A Linear row's size as a quiet hairline tag (the same shape as Slack's label tag) that opens the size picker.
struct LinearSizeChip: View {
    let size: LinearSize
    /// The user corrected Pilot's estimate.
    let setByUser: Bool
    /// A correction is being saved.
    var saving = false
    let select: (LinearSize) -> Void

    var body: some View {
        Menu {
            LinearSizeOptions(size: size, setByUser: setByUser, select: select)
        } label: {
            Text(size.title)
                .font(.pilot(.caption))
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.small).strokeBorder(Theme.border))
                .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.small))
                .opacity(saving ? 0.6 : 1)
        }
        .chipMenuStyle()
        .fixedSize()
        .disabled(saving)
        .help(TrackedItemText.sizeHelp(size, setByUser: setByUser))
        .accessibilityLabel("Size")
        .accessibilityValue(size.title)
        .accessibilityHint("Shows sizes to correct it")
    }
}

/// Checked size choices, shared by the chip and the row's Size menu, with where the current size came from.
struct LinearSizeOptions: View {
    let size: LinearSize?
    let setByUser: Bool
    let select: (LinearSize) -> Void

    var body: some View {
        Picker("Size", selection: Binding(get: { size ?? .unknown }, set: select)) {
            ForEach(LinearSize.choices, id: \.self) { choice in
                Text(choice.title).tag(choice)
            }
        }
        .pickerStyle(.inline)
        Divider()
        Text(setByUser ? "Set by you" : size == nil ? "Not estimated yet" : "Estimated by Pilot")
    }
}
