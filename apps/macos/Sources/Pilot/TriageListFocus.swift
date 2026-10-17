import SwiftUI

/// Lets the page region's focus (⌃⇥, a G destination, Escape from the composer) land on a board or tree that keeps
/// its own keys, such as Slack triage's arrows and T/L/D or the memory tree's arrows.
struct TriageListFocus: ViewModifier {
    var focused: FocusState<Bool>.Binding

    func body(content: Content) -> some View {
        content
            .keyboardFocusHandler(.content) {
                focused.wrappedValue = true
                return true
            }
            .onChange(of: focused.wrappedValue) { _, isFocused in
                if isFocused { AppModel.shared.keyboard.noteFocused(.content) }
            }
    }
}
