import SwiftUI

/// Lets the page region's focus (a Go menu destination, Escape from the composer) land on a board or tree that keeps
/// its own keys, such as Slack triage's or the memory tree's arrows.
struct TriageListFocus: ViewModifier {
    var focused: FocusState<Bool>.Binding
    @Environment(\.keyboardFocus) private var keyboard

    func body(content: Content) -> some View {
        content
            .keyboardFocusHandler(.content) {
                focused.wrappedValue = true
                return true
            }
            .onChange(of: focused.wrappedValue) { _, isFocused in
                if isFocused { keyboard.noteFocused(.content) }
            }
    }
}
