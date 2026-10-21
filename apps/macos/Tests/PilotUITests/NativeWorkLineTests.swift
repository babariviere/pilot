import AppKit
import SwiftUI
import Testing
@testable import Pilot

@Test(arguments: [true, false]) @MainActor
func nativeWorkLineFitsItsTextCellPaddingAndRecoversAfterNarrowLayout(summary: Bool) throws {
    let line = NativeWorkLine()
    defer { line.stopMotion() }
    let verb = summary ? "Worked for 6s" : "Read"
    let subject = summary ? "· ran 1 script" : "NativeWorkRows.swift"
    line.update(verb: verb, subject: subject, icon: .disclosure,
                expanded: false, summary: summary, environment: EnvironmentValues(), action: {})
    let labels = line.subviews.compactMap { $0 as? NSTextField }
    let lead = try #require(labels.first { $0.stringValue == verb })
    let detail = try #require(labels.first { $0.stringValue == subject })
    for width: CGFloat in [760, 160, 760] {
        line.frame.size.width = width
        _ = line.measure(width: width)
        line.layoutSubtreeIfNeeded()
        #expect(lead.frame.maxX <= detail.frame.minX)
        #expect(detail.frame.maxX <= width)
        if width == 760 {
            for label in [lead, detail] {
                let cell = try #require(label.cell)
                #expect(label.frame.width >= ceil(cell.cellSize.width))
            }
        } else {
            let cell = try #require(detail.cell)
            #expect(detail.frame.width < cell.cellSize.width)
            #expect(detail.lineBreakMode == .byTruncatingMiddle)
        }
    }
}

@Test @MainActor func nativeWorkLineReservesBadgeWidthWithoutClippingShortSummary() throws {
    let line = NativeWorkLine()
    defer { line.stopMotion() }
    line.update(verb: "Worked for 6s", subject: "· ran 1 script", icon: .disclosure,
                expanded: false, failed: true, badge: "· 1 failed", summary: true,
                environment: EnvironmentValues(), action: {})
    for width: CGFloat in [760, 240, 760] {
        line.frame.size.width = width
        _ = line.measure(width: width)
        line.layoutSubtreeIfNeeded()
        let labels = line.subviews.compactMap { $0 as? NSTextField }
        #expect(labels.count == 3)
        for (index, label) in labels.enumerated() {
            #expect(label.frame.maxX <= width)
            if index > 0 { #expect(labels[index - 1].frame.maxX <= label.frame.minX) }
            if width == 760 {
                let cell = try #require(label.cell)
                #expect(label.frame.width >= ceil(cell.cellSize.width))
            }
        }
    }
}
