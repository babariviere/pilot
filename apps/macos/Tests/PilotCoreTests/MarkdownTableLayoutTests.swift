import CoreGraphics
import Testing
@testable import PilotCore

@Test func tableColumnsKeepIdealWidthsWhenTheyFit() {
    let columns = MarkdownTableColumns(ideal: [40, 120, 80], available: 400, spacing: 21, minimum: 96, overflowMaximum: 240)
    #expect(columns.widths == [40, 120, 80])
    #expect(!columns.overflows)
    #expect(columns.contentWidth(spacing: 21) == 303)
}

@Test func tableColumnsShrinkWideColumnsToFitBeforeOverflowing() {
    // 600 points of text for 400 - 3 × 20 = 340 points: narrow columns stay, wide ones wrap in proportion.
    let columns = MarkdownTableColumns(ideal: [40, 360, 200], available: 400, spacing: 20, minimum: 96, overflowMaximum: 240)
    #expect(!columns.overflows)
    #expect(columns.widths[0] == 40)
    #expect(columns.widths[1] > columns.widths[2])
    #expect(columns.widths.allSatisfy { $0 >= 40 })
    #expect(columns.contentWidth(spacing: 20) == 400)
}

@Test func tableColumnsOverflowOnlyWhenMinimumsDoNotFit() {
    let ideal: [CGFloat] = [300, 300, 300, 300, 50]
    let narrow = MarkdownTableColumns(ideal: ideal, available: 320, spacing: 20, minimum: 96, overflowMaximum: 240)
    #expect(narrow.overflows)
    #expect(narrow.widths == [240, 240, 240, 240, 50])
    #expect(narrow.contentWidth(spacing: 20) > 320)
    let wide = MarkdownTableColumns(ideal: ideal, available: 700, spacing: 20, minimum: 96, overflowMaximum: 240)
    #expect(!wide.overflows)
    #expect(wide.contentWidth(spacing: 20) <= 700)
    // Empty and degenerate input.
    #expect(MarkdownTableColumns(ideal: [], available: 100, spacing: 20, minimum: 96, overflowMaximum: 240).widths.isEmpty)
    #expect(MarkdownTableColumns(ideal: [0, 0], available: 0, spacing: 20, minimum: 96, overflowMaximum: 240).overflows)
}

@Test func tableColumnsAtExactlyTheirMinimumsFitWithoutScrolling() {
    // 234 - 2 × 21 = 192 points of text, exactly two 96-point minimums.
    let exact = MarkdownTableColumns(ideal: [300, 300], available: 234, spacing: 21, minimum: 96, overflowMaximum: 240)
    #expect(exact.widths == [96, 96])
    #expect(!exact.overflows)
    #expect(exact.contentWidth(spacing: 21) == 234)
    // One point less no longer fits the minimums, so the table scrolls.
    let below = MarkdownTableColumns(ideal: [300, 300], available: 233, spacing: 21, minimum: 96, overflowMaximum: 240)
    #expect(below.overflows)
    #expect(below.widths == [240, 240])
    // One point more shrinks to just above the minimums and still fills the width.
    let above = MarkdownTableColumns(ideal: [300, 300], available: 235, spacing: 21, minimum: 96, overflowMaximum: 240)
    #expect(!above.overflows)
    #expect(above.contentWidth(spacing: 21) == 235)
}
