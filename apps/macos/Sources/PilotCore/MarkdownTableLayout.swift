import Foundation

/// Text widths of a Markdown table's columns for a given available width.
/// Columns keep their ideal widths (their longest cell, already capped by the caller) when the table fits. Otherwise
/// they shrink in proportion to how much each can give, down to `minimum`, and wrap their text. When even that does
/// not fit, the table overflows: columns take up to `overflowMaximum` and the table scrolls horizontally on its own,
/// never widening the reading column.
public struct MarkdownTableColumns: Equatable, Sendable {
    public let widths: [CGFloat]
    public let overflows: Bool

    /// - Parameters:
    ///   - ideal: Each column's preferred text width.
    ///   - available: Width offered to the whole table.
    ///   - spacing: Width each column adds around its text (cell padding and its separator).
    public init(ideal: [CGFloat], available: CGFloat, spacing: CGFloat, minimum: CGFloat, overflowMaximum: CGFloat) {
        let ideal = ideal.map { max(0, $0) }
        let target = available - spacing * CGFloat(ideal.count)
        let total = ideal.reduce(0, +)
        if total <= target {
            widths = ideal
            overflows = false
            return
        }
        let minimums = ideal.map { min($0, minimum) }
        let floor = minimums.reduce(0, +)
        // Minimums that exactly fill the width still fit: only a table that needs more than the width scrolls.
        if floor > target {
            widths = zip(ideal, minimums).map { max($1, min($0, overflowMaximum)) }
            overflows = true
            return
        }
        // total > target >= floor, so every shrinkable column gives up the same share of what it can give. The widest
        // column takes the rounding remainder, so the table fills the available width exactly.
        let share = (target - floor) / (total - floor)
        var widths = zip(ideal, minimums).map { ideal, minimum in (minimum + (ideal - minimum) * share).rounded(.down) }
        if let widest = widths.indices.max(by: { widths[$0] < widths[$1] }) {
            widths[widest] += target - widths.reduce(0, +)
        }
        self.widths = widths
        overflows = false
    }

    /// The table's width: every column's text plus its spacing.
    public func contentWidth(spacing: CGFloat) -> CGFloat {
        widths.reduce(0, +) + spacing * CGFloat(widths.count)
    }
}
