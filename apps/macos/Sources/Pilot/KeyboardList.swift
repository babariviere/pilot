import AppKit
import SwiftUI

// One keyboard entry for a long page: the page's list takes focus once (⌃⇥, a G destination, or a click), then
// arrows or J/K move a highlight through its rows and Return opens the highlighted row. Tab is not needed per row.
// Rows report themselves through a preference, in view order, so lists keep their existing layout and lazy parts.

/// A row the page's keyboard list can highlight and open.
struct KeyboardListItem: Equatable {
    let id: String
    /// What ⌘K offers actions for while this row is highlighted.
    var target: KeyboardTarget?
    let activate: @MainActor () -> Void

    static func == (lhs: KeyboardListItem, rhs: KeyboardListItem) -> Bool {
        lhs.id == rhs.id && lhs.target == rhs.target
    }
}

struct KeyboardListItemsKey: PreferenceKey {
    static let defaultValue: [KeyboardListItem] = []
    static func reduce(value: inout [KeyboardListItem], nextValue: () -> [KeyboardListItem]) {
        value.append(contentsOf: nextValue())
    }
}

/// The highlighted row, and whether its list owns keyboard focus (which shows the focus ring).
struct KeyboardListHighlight: Equatable {
    var id: String?
    var focused = false
}

private struct KeyboardListHighlightKey: EnvironmentKey {
    static let defaultValue = KeyboardListHighlight()
}

extension EnvironmentValues {
    var keyboardListHighlight: KeyboardListHighlight {
        get { self[KeyboardListHighlightKey.self] }
        set { self[KeyboardListHighlightKey.self] = newValue }
    }
}

/// Highlight and row order for one list, by stable row id.
@MainActor
final class KeyboardListState: ObservableObject {
    @Published var highlighted: String?
    private(set) var items: [KeyboardListItem] = []
    private var highlightedIndex: Int?
    /// A highlight saved for this page, applied once its row arrives.
    private var pendingRestore: String?
    /// Set when a restored highlight should scroll into view without the list having focus.
    private(set) var scrollsToRestored = false

    /// Highlights `id` once a refresh lists it, as when Back returns to this page.
    func restore(_ id: String) {
        pendingRestore = id
        if items.contains(where: { $0.id == id }) { apply(restored: id) }
    }

    private func apply(restored id: String) {
        pendingRestore = nil
        highlightedIndex = items.firstIndex { $0.id == id }
        scrollsToRestored = true
        highlighted = id
    }

    func consumeRestoredScroll() -> Bool {
        defer { scrollsToRestored = false }
        return scrollsToRestored
    }

    /// New rows from a refresh. The highlight follows its row by id; when the row is gone, the nearest surviving
    /// row takes it, without running anything.
    func update(_ rows: [KeyboardListItem]) {
        var seen = Set<String>()
        items = rows.filter { seen.insert($0.id).inserted }
        if let pendingRestore, items.contains(where: { $0.id == pendingRestore }) {
            apply(restored: pendingRestore)
            return
        }
        guard let highlighted else { return }
        if let index = items.firstIndex(where: { $0.id == highlighted }) {
            highlightedIndex = index
        } else if items.isEmpty {
            self.highlighted = nil
            highlightedIndex = nil
        } else {
            let index = min(highlightedIndex ?? 0, items.count - 1)
            highlightedIndex = index
            self.highlighted = items[index].id
        }
    }

    /// Moves the highlight, stopping at either end. With nothing highlighted, the first row (or the last, upward).
    func move(by offset: Int) {
        guard !items.isEmpty else { return }
        let current = highlighted.flatMap { id in items.firstIndex { $0.id == id } }
        let index = current.map { min(max($0 + offset, 0), items.count - 1) } ?? (offset < 0 ? items.count - 1 : 0)
        select(index)
    }

    func moveToEnd(_ last: Bool) {
        guard !items.isEmpty else { return }
        select(last ? items.count - 1 : 0)
    }

    /// Highlights the first row when the list gains focus with nothing highlighted.
    func highlightFirstIfNeeded() {
        if highlighted == nil || !items.contains(where: { $0.id == highlighted }) { moveToEnd(false) }
    }

    var highlightedItem: KeyboardListItem? { highlighted.flatMap { id in items.first { $0.id == id } } }

    private func select(_ index: Int) {
        highlightedIndex = index
        if highlighted != items[index].id { highlighted = items[index].id }
    }
}

extension View {
    /// A row of the enclosing `keyboardList`. Return runs `activate`, the row's ordinary click action.
    func keyboardListItem(_ id: String, target: KeyboardTarget? = nil,
                          activate: @escaping @MainActor () -> Void) -> some View {
        modifier(KeyboardListItemModifier(item: KeyboardListItem(id: id, target: target, activate: activate)))
    }

    /// The page's main list: one focus stop for the region's keyboard entry, with arrow, J/K, Home/End and Return
    /// handling. Put it inside the page's ScrollView so highlighted rows scroll into view.
    /// Pass `native: true` for a SwiftUI List, which already takes focus as a table. Preferences do not leave
    /// List rows, nor report unrealized rows of a lazy stack, so such a list's owner passes `suppliesRows` and
    /// updates `state` with every row itself. `focusOnAppear` is for lists opened by an explicit command, and
    /// `onEscape` lets one close itself.
    func keyboardList(region: KeyboardRegion? = .content, state: KeyboardListState? = nil, native: Bool = false,
                      suppliesRows: Bool = false, focusOnAppear: Bool = false,
                      onEscape: (() -> Void)? = nil) -> some View {
        modifier(KeyboardListModifier(region: region, external: state, native: native,
                                      suppliesRows: suppliesRows || native, focusOnAppear: focusOnAppear,
                                      onEscape: onEscape))
    }
}

private struct KeyboardListItemModifier: ViewModifier {
    let item: KeyboardListItem
    @Environment(\.keyboardListHighlight) private var highlight

    func body(content: Content) -> some View {
        let highlighted = highlight.id == item.id
        content
            .background {
                if highlighted {
                    RoundedRectangle(cornerRadius: Theme.Radius.row).fill(Theme.selected)
                        .allowsHitTesting(false)
                }
            }
            .focusRing(highlighted && highlight.focused)
            .id(item.id)
            .preference(key: KeyboardListItemsKey.self, value: [item])
            .accessibilityAddTraits(highlighted ? .isSelected : [])
    }
}

private struct KeyboardListModifier: ViewModifier {
    let region: KeyboardRegion?
    let external: KeyboardListState?
    let native: Bool
    let suppliesRows: Bool
    let focusOnAppear: Bool
    let onEscape: (() -> Void)?
    @StateObject private var own = KeyboardListState()
    @FocusState private var focused: Bool

    private var list: KeyboardListState { external ?? own }

    func body(content: Content) -> some View {
        KeyboardListBody(content: content, list: list, region: region, native: native, suppliesRows: suppliesRows,
                         focusOnAppear: focusOnAppear, onEscape: onEscape, focused: $focused)
    }
}

private struct FocusStop: ViewModifier {
    let native: Bool

    func body(content: Content) -> some View {
        if native { content } else { content.focusable() }
    }
}

private struct OptionalRegionHandler: ViewModifier {
    let region: KeyboardRegion?
    let perform: () -> Bool

    func body(content: Content) -> some View {
        if let region { content.keyboardFocusHandler(region, perform: perform) } else { content }
    }
}

private struct KeyboardListBody<Content: View>: View {
    let content: Content
    @ObservedObject var list: KeyboardListState
    let region: KeyboardRegion?
    let native: Bool
    let suppliesRows: Bool
    let focusOnAppear: Bool
    let onEscape: (() -> Void)?
    var focused: FocusState<Bool>.Binding
    /// The page this list belongs to, for restoring its highlight after Back.
    @State private var routeKey: String?

    var body: some View {
        ScrollViewReader { proxy in
            content
                .environment(\.keyboardListHighlight, KeyboardListHighlight(id: list.highlighted, focused: focused.wrappedValue))
                .onPreferenceChange(KeyboardListItemsKey.self) { rows in
                    MainActor.assumeIsolated { if !suppliesRows { list.update(rows) } }
                }
                .modifier(FocusStop(native: native))
                .focused(focused)
                .focusEffectDisabled()
                .onKeyPress(keys: [.upArrow, .downArrow, .home, .end, .return, .escape]) { press in
                    // Arrow keys carry keypad and function flags; only real modifiers opt out.
                    guard press.modifiers.isDisjoint(with: [.command, .control, .option]) else { return .ignored }
                    switch press.key {
                    case .upArrow: list.move(by: -1)
                    case .downArrow: list.move(by: 1)
                    case .home: list.moveToEnd(false)
                    case .end: list.moveToEnd(true)
                    case .escape:
                        guard let onEscape else { return .ignored }
                        onEscape()
                    default:
                        guard let item = list.highlightedItem else { return .ignored }
                        item.activate()
                        return .handled
                    }
                    return .handled
                }
                .onChange(of: focused.wrappedValue) { _, isFocused in
                    guard isFocused else { return }
                    if let region { AppModel.shared.keyboard.noteFocused(region) }
                    list.highlightFirstIfNeeded()
                    AppModel.shared.keyboardTarget = list.highlightedItem?.target
                }
                .onChange(of: list.highlighted) { _, id in
                    if focused.wrappedValue { AppModel.shared.keyboardTarget = list.highlightedItem?.target }
                    if let id, let routeKey {
                        // Bounded: one short id per visited page.
                        if AppModel.shared.keyboardListHighlights.count > 200 { AppModel.shared.keyboardListHighlights.removeAll() }
                        AppModel.shared.keyboardListHighlights[routeKey] = id
                    }
                    // Moving, or a refresh that removed the row, keeps the highlight on screen while the list has
                    // focus. A highlight restored by Back scrolls back into view too.
                    if let id, list.consumeRestoredScroll() || focused.wrappedValue { proxy.scrollTo(id, anchor: .center) }
                }
                .onAppear {
                    routeKey = AppModel.shared.currentRoute.key
                    if let routeKey, let saved = AppModel.shared.keyboardListHighlights[routeKey] { list.restore(saved) }
                    if focusOnAppear { DispatchQueue.main.async { focused.wrappedValue = true } }
                }
                .modifier(OptionalRegionHandler(region: region) {
                    focused.wrappedValue = true
                    return true
                })
                .onDisappear {
                    if let target = list.highlightedItem?.target, AppModel.shared.keyboardTarget == target {
                        AppModel.shared.keyboardTarget = nil
                    }
                }
        }
    }
}
