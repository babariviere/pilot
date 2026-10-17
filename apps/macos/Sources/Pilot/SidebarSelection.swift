import SwiftUI

/// Replace only the native sidebar selection drawing, not List's selection or keyboard handling.
/// The opaque sidebar surface covers AppKit's blue highlight, including its rounded edges. A translucent
/// selected fill alone would let it show through. Keep the inset aligned with the native row's content/corner.
struct SidebarSelectionBackground: View {
    let selected: Bool

    var body: some View {
        Theme.sidebar.overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.row)
                .fill(selected ? Theme.selected : .clear)
                .padding(.horizontal, 10)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
