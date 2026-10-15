import SwiftUI

/// Replace only the native sidebar selection drawing, not List's selection or keyboard handling.
/// The opaque sidebar surface covers AppKit's blue highlight, including its rounded edges. A translucent
/// selected fill alone would let it show through. Keep the inset aligned with the native row's content/corner.
struct SidebarSelectionBackground: View {
    let selected: Bool
    let focused: Bool
    @Environment(\.controlActiveState) private var controlActiveState

    var body: some View {
        Theme.sidebar.overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.row)
                .fill(selected ? Theme.selected : .clear)
                .focusRing(selected && focused && controlActiveState != .inactive)
                .padding(.horizontal, 10)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
