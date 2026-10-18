import AppKit
import SwiftUI

// Keyboard-only decoration. Custom keyboard targets (the highlighted row of a page list, the transcript's highlighted
// message) and the row actions they reveal show only while the keyboard is navigating, and hide on any click. This is
// indication only: the highlighted row id, responder focus, real selection and ⌘K targets never change with it, so
// a click keeps the target and the next navigation key shows it again.

/// Whether the keyboard or the pointer drove the last navigation. Only key presses that navigate turn the cue on
/// (`navigates(_:context:fieldEditor:)`); typing into an editor, a focus change, or focus arriving asynchronously
/// after a click never does. Any mouse button press turns it off.
@MainActor
final class KeyboardCue: ObservableObject {
    static let shared = KeyboardCue()

    @Published private(set) var visible = false

    /// A navigation key was pressed.
    func noteKeyboardNavigation() {
        if !visible { visible = true }
    }

    /// The pointer clicked somewhere.
    func notePointer() {
        if visible { visible = false }
    }

    /// Reads one key press before it is delivered.
    func note(_ chord: KeyboardChord, context: KeyboardInputContext, fieldEditor: Bool) {
        if Self.navigates(chord, context: context, fieldEditor: fieldEditor) { noteKeyboardNavigation() }
    }

    /// True when a key press navigates rather than types.
    ///
    /// - ⌃⇥ and ⌃⇧⇥ move between regions from anywhere, even out of terminals and web content.
    /// - Outside text, unmodified and ⌥ navigation keys browse: arrows, Return, Tab, Space, Escape, Home/End and
    ///   Page Up/Down. Letters, digits and menu shortcuts (⌘ or ⌃) do not.
    /// - In text, only leaving the field navigates: Tab out of a single-line field, or Escape back to the page.
    ///   Letters, arrows, Return and the composer's own Tab completion are editing.
    /// - Every other key in terminal or web content is that content's input.
    static func navigates(_ chord: KeyboardChord, context: KeyboardInputContext, fieldEditor: Bool) -> Bool {
        let mods = chord.modifiers
        let tab = chord.keyCode == KeyboardChord.tabKeyCode
        if tab, mods.subtracting(.shift) == [.control] { return true }
        switch context {
        case .embedded:
            return false
        case .text:
            if chord.keyCode == KeyboardChord.escapeKeyCode { return mods.isEmpty }
            return tab && fieldEditor && mods.subtracting(.shift).isEmpty
        case .navigation:
            return mods.isDisjoint(with: [.command, .control]) && navigationKeyCodes.contains(chord.keyCode)
        }
    }

    /// Return, Tab, Space, Escape, keypad Enter, Home, Page Up, End, Page Down and the four arrows.
    static let navigationKeyCodes: Set<UInt16> = [36, 48, 49, 53, 76, 115, 116, 119, 121, 123, 124, 125, 126]
}

private struct KeyboardCueKey: EnvironmentKey {
    /// Scene roots publish the live value with `keyboardCueSource()`; elsewhere, the value when the view is built.
    static var defaultValue: Bool { MainActor.assumeIsolated { KeyboardCue.shared.visible } }
}

extension EnvironmentValues {
    /// Whether keyboard-only decoration shows. See `KeyboardCue`.
    var keyboardCue: Bool {
        get { self[KeyboardCueKey.self] }
        set { self[KeyboardCueKey.self] = newValue }
    }
}

private struct KeyboardCueSource: ViewModifier {
    @ObservedObject var cue: KeyboardCue

    func body(content: Content) -> some View {
        content.environment(\.keyboardCue, cue.visible)
    }
}

extension View {
    /// Publishes `KeyboardCue` to a scene. Only views reading `keyboardCue` update when it changes.
    @MainActor func keyboardCueSource(_ cue: KeyboardCue? = nil) -> some View {
        modifier(KeyboardCueSource(cue: cue ?? .shared))
    }

    /// The keyboard target's quiet fill (`Theme.keyboardHighlight`), behind the view while `shown`. Callers pass
    /// whether the target is highlighted, its list has focus and `keyboardCue` is on. No outline, no accent colour.
    func keyboardHighlight(_ shown: Bool, radius: CGFloat = Theme.Radius.row, outset: CGFloat = 0) -> some View {
        background {
            if shown { KeyboardHighlightFill(radius: radius, outset: outset) }
        }
    }
}

/// The keyboard target's fill. Increased contrast uses the selection fill so the target stays findable.
struct KeyboardHighlightFill: View {
    var radius: CGFloat = Theme.Radius.row
    var outset: CGFloat = 0
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        RoundedRectangle(cornerRadius: radius + outset)
            .fill(contrast == .increased ? Theme.selected : Theme.keyboardHighlight)
            .padding(-outset)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
