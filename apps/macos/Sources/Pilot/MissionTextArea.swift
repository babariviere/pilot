import SwiftUI

/// Multi-line text field for mission forms and sheets. Return inserts a newline and Command-Return
/// calls `onSubmit` (show the shortcut on the sheet's button). IME composition never submits.
/// Single-line fields stay plain `TextField`s with `.onSubmit`. Escape reaches the sheet's Cancel button.
struct MissionTextArea: View {
    let prompt: String
    @Binding var text: String
    var minLines = 1
    var maxLines = 6
    var label: String
    var onSubmit: () -> Void
    @State private var height: CGFloat = 20
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(prompt).font(fonts.body).foregroundStyle(Theme.faintForeground).allowsHitTesting(false)
            }
            ChatTextEditor(text: $text, height: $height, font: fonts.nsBody, minLines: minLines, maxLines: maxLines,
                           focusOnAppear: false, returnInsertsNewline: true, completionDirectory: nil) { _ in onSubmit() }
                .frame(height: height)
                .accessibilityLabel(label)
        }
    }
}
