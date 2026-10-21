/// Generic keyboard handling for rows fixed above a native sidebar list.
enum SidebarStickyNavigation {
    enum Step: Equatable {
        /// Let the list move as usual.
        case native
        /// Already at the top: consume the key.
        case stay
        case select(String)
        /// Let the list move up; if it could not (its first row was selected), select this sticky row.
        case nativeOr(String)
    }

    /// `listHasSelection` is whether the native list shows a selected row; a selected Control row leaves it empty.
    static func step(down: Bool, sticky: [String], current: String?, listHasSelection: Bool) -> Step {
        guard let last = sticky.last else { return .native }
        if let current, let index = sticky.firstIndex(of: current) {
            if down { return index + 1 < sticky.count ? .select(sticky[index + 1]) : .native }
            return index > 0 ? .select(sticky[index - 1]) : .stay
        }
        if !listHasSelection { return down ? .select(sticky[0]) : .native }
        return down ? .native : .nativeOr(last)
    }
}
