import AppKit
import SwiftUI
import Testing
@testable import Pilot

private final class ResponsiveHeightLayoutManager: NSLayoutManager {
    var measuredRects: [CGRect] = []
    override func ensureLayout(forBoundingRect bounds: NSRect, in container: NSTextContainer) {
        measuredRects.append(bounds)
        super.ensureLayout(forBoundingRect: bounds, in: container)
    }
}

@MainActor private func responsiveHeightNextTurn() async {
    await withCheckedContinuation { continuation in
        DispatchQueue.main.async { continuation.resume() }
    }
}

@MainActor private func responsiveHeightTextView() -> (NSTextView, ResponsiveHeightLayoutManager) {
    _ = NSApplication.shared
    let storage = NSTextStorage()
    let layout = ResponsiveHeightLayoutManager()
    storage.addLayoutManager(layout)
    let container = NSTextContainer(size: CGSize(width: 240, height: CGFloat.greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    layout.addTextContainer(container)
    let view = NSTextView(frame: CGRect(x: 0, y: 0, width: 240, height: 18), textContainer: container)
    view.font = .systemFont(ofSize: 14)
    return (view, layout)
}

@Test @MainActor func responsiveEditorHeightCoalescesAndBoundsLargePastes() async {
    let (view, layout) = responsiveHeightTextView()
    var measuredHeight: CGFloat = 0
    var publications = 0
    let editor = ChatTextEditor(text: .constant(""), height: Binding(get: { measuredHeight }, set: {
        measuredHeight = $0
        publications += 1
    }), font: .systemFont(ofSize: 14), maxLines: 4, onSubmit: { _ in })
    let coordinator = editor.makeCoordinator()
    view.string = String(repeating: "Pasted line of text\n", count: 10000)
    layout.measuredRects = []
    for _ in 0..<50 { coordinator.recalculate(view) }
    #expect(layout.measuredRects.isEmpty)
    await responsiveHeightNextTurn()
    #expect(layout.measuredRects.count == 1)
    let line = layout.defaultLineHeight(for: editor.font)
    #expect(layout.measuredRects.first?.height == line * 5)
    #expect(measuredHeight == (line * 4).rounded(.up))
    #expect(publications == 1)
    coordinator.recalculate(view, contentChanged: false)
    await responsiveHeightNextTurn()
    #expect(layout.measuredRects.count == 1)
    #expect(publications == 1)
    view.string = "Short"
    coordinator.recalculate(view)
    await responsiveHeightNextTurn()
    #expect(measuredHeight == line.rounded(.up))
    view.string = "Short\n"
    coordinator.recalculate(view)
    await responsiveHeightNextTurn()
    #expect(measuredHeight == (line * 2).rounded(.up))
}

@Test @MainActor func responsiveEditorHeightUsesLatestBindingAndResizeWidth() async {
    let (view, layout) = responsiveHeightTextView()
    var oldWrites = 0
    var height: CGFloat = 0
    var editor = ChatTextEditor(text: .constant(""), height: Binding(get: { 0 }, set: { _ in oldWrites += 1 }),
                                font: .systemFont(ofSize: 14), maxLines: 20, onSubmit: { _ in })
    let coordinator = editor.makeCoordinator()
    view.string = "One two three four five six seven eight nine ten"
    coordinator.recalculate(view)
    editor = ChatTextEditor(text: .constant(""), height: Binding(get: { height }, set: { height = $0 }),
                            font: editor.font, maxLines: 20, onSubmit: { _ in })
    coordinator.parent = editor
    await responsiveHeightNextTurn()
    #expect(oldWrites == 0)
    let wideHeight = height
    view.textContainer?.size.width = 80
    coordinator.recalculate(view, contentChanged: false)
    await responsiveHeightNextTurn()
    #expect(height > wideHeight)
    #expect(layout.measuredRects.last?.width == 80)
    #expect(oldWrites == 0)
}

@Test @MainActor func responsiveEditorHeightCancellationSuppressesPendingPublication() async {
    let (view, layout) = responsiveHeightTextView()
    var writes = 0
    let editor = ChatTextEditor(text: .constant(""), height: Binding(get: { 0 }, set: { _ in writes += 1 }),
                                font: .systemFont(ofSize: 14), onSubmit: { _ in })
    let coordinator = editor.makeCoordinator()
    coordinator.recalculate(view)
    coordinator.cancelMeasurement()
    await responsiveHeightNextTurn()
    #expect(writes == 0)
    #expect(layout.measuredRects.isEmpty)
}

@Test @MainActor func responsiveEditorResizeNotifiesOnlyWidthChanges() {
    _ = NSApplication.shared
    let view = SubmitTextView(frame: CGRect(x: 0, y: 0, width: 240, height: 18))
    var widths: [CGFloat] = []
    view.onLayoutWidthChange = { widths.append($0.frame.width) }
    view.setFrameSize(CGSize(width: 240, height: 72))
    view.setFrameSize(CGSize(width: 120, height: 72))
    view.setFrameSize(CGSize(width: 120, height: 18))
    view.setFrameSize(CGSize(width: 360, height: 18))
    #expect(widths == [120, 360])
}
