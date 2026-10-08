import SwiftUI

/// One click target over passive chat content. The expanded viewer owns interaction.
struct EmbeddedPreviewButton: View {
    let title: String
    let help: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            Color.clear.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .help(help)
    }
}
