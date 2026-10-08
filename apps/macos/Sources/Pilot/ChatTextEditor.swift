import AppKit
import PilotCore
import SwiftUI

/// Multi-line text input that distinguishes Return, Option-Return and Shift-Return, which
/// SwiftUI's TextField cannot do reliably. Shift-Return inserts a line; the others submit.
struct ChatTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    var font: NSFont
    var minLines = 1
    var maxLines = 10
    var focusOnAppear = true
    var isEditable = true
    var focusToken: UUID?
    var onNavigateQueue: ((QueueNavigationDirection) -> Bool)?
    var onCancel: (() -> Void)?
    var onRemoveQueuedMessage: (() -> Void)?
    var onPasteImages: ((NSPasteboard) -> Bool)?
    var completionDirectory = FileManager.default.homeDirectoryForCurrentUser.path
    var onSubmit: (NSEvent.ModifierFlags) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder

        let textView = SubmitTextView()
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.font = font
        textView.isEditable = isEditable
        textView.onRemoveQueuedMessage = onRemoveQueuedMessage
        textView.onPasteImages = onPasteImages
        textView.textColor = .labelColor
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.string = text
        textView.completionDirectory = completionDirectory
        textView.onSubmit = { [weak coordinator = context.coordinator] flags in coordinator?.parent.onSubmit(flags) }
        textView.onNavigateQueue = { [weak coordinator = context.coordinator] direction in
            coordinator?.parent.onNavigateQueue?(direction) ?? false
        }
        textView.onCancel = { [weak coordinator = context.coordinator] in
            guard let onCancel = coordinator?.parent.onCancel else { return false }
            onCancel()
            return true
        }
        textView.onLayoutWidthChange = { [weak coordinator = context.coordinator] textView in
            coordinator?.recalculate(textView, contentChanged: false)
        }
        scroll.documentView = textView

        if focusOnAppear {
            DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        }
        context.coordinator.lastFocusToken = focusToken
        context.coordinator.recalculate(textView)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scroll.documentView as? SubmitTextView else { return }
        textView.isEditable = isEditable
        textView.onRemoveQueuedMessage = onRemoveQueuedMessage
        textView.onPasteImages = onPasteImages
        if focusToken != context.coordinator.lastFocusToken {
            context.coordinator.lastFocusToken = focusToken
            DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        }
        textView.completionDirectory = completionDirectory
        var changed = false
        if textView.string != text {
            textView.dismissPathPicker()
            textView.string = text
            changed = true
        }
        if textView.font != font {
            textView.font = font
            changed = true
        }
        context.coordinator.recalculate(textView, contentChanged: changed)
    }

    static func dismantleNSView(_ scroll: NSScrollView, coordinator: Coordinator) {
        coordinator.cancelMeasurement()
        guard let textView = scroll.documentView as? SubmitTextView else { return }
        textView.onLayoutWidthChange = nil
        textView.delegate = nil
        textView.dismissPathPicker()
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatTextEditor
        var lastFocusToken: UUID?
        private weak var pendingTextView: NSTextView?
        private var measurementScheduled = false
        private var cancelled = false
        private var revision = 0
        private var lastMeasurement: MeasurementKey?

        private struct MeasurementKey: Equatable {
            let revision: Int
            let width: CGFloat
            let font: NSFont
            let minLines: Int
            let maxLines: Int
        }

        init(parent: ChatTextEditor) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            recalculate(textView)
        }

        /// Coalesce editing, representable updates, and resize notifications into one
        /// bounded measurement on the next main turn. Always use the latest parent/binding.
        func recalculate(_ textView: NSTextView, contentChanged: Bool = true) {
            guard !cancelled else { return }
            if contentChanged { revision += 1 }
            pendingTextView = textView
            guard !measurementScheduled else { return }
            measurementScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.cancelled else { return }
                self.measurementScheduled = false
                guard let textView = self.pendingTextView else { return }
                self.pendingTextView = nil
                self.measure(textView)
            }
        }

        func cancelMeasurement() {
            cancelled = true
            pendingTextView = nil
        }

        private func measure(_ textView: NSTextView) {
            guard let layout = textView.layoutManager, let container = textView.textContainer,
                  container.size.width.isFinite, container.size.width > 0 else { return }
            let key = MeasurementKey(revision: revision, width: container.size.width, font: parent.font,
                                     minLines: parent.minLines, maxLines: parent.maxLines)
            guard key != lastMeasurement else { return }
            lastMeasurement = key
            let line = layout.defaultLineHeight(for: parent.font)
            let minimum = line * CGFloat(max(1, parent.minLines))
            let maximum = line * CGFloat(max(parent.minLines, parent.maxLines, 1))
            // Do not lay out an entire pasted document just to discover that it exceeds
            // the height cap. AppKit remains responsible for layout while scrolling.
            layout.ensureLayout(forBoundingRect: CGRect(x: 0, y: 0, width: container.size.width,
                                                        height: maximum + line), in: container)
            let used = max(layout.usedRect(for: container).height,
                           layout.extraLineFragmentTextContainer === container ? layout.extraLineFragmentRect.maxY : 0)
            let height = min(max(used, minimum), maximum).rounded(.up)
            if abs(parent.height - height) > 0.5 { parent.height = height }
        }
    }
}

final class SubmitTextView: NSTextView {
    var onLayoutWidthChange: ((NSTextView) -> Void)?

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = frame.width != newSize.width
        super.setFrameSize(newSize)
        if widthChanged { onLayoutWidthChange?(self) }
    }

    var onSubmit: ((NSEvent.ModifierFlags) -> Void)?
    var onNavigateQueue: ((QueueNavigationDirection) -> Bool)?
    var onCancel: (() -> Bool)?
    var onRemoveQueuedMessage: (() -> Void)?
    var onPasteImages: ((NSPasteboard) -> Bool)?

    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        guard onPasteImages != nil else { return super.readablePasteboardTypes }
        return ImageAttachments.pasteboardTypes + [.fileURL] + super.readablePasteboardTypes
    }

    func canPasteImageData(from pasteboard: NSPasteboard) -> Bool {
        isEditable && onPasteImages != nil && pasteboard.availableType(from: ImageAttachments.pasteboardTypes) != nil
    }

    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(pasteAsPlainText(_:)), canPasteImageData(from: .general) { return true }
        return super.validateUserInterfaceItem(item)
    }

    override func paste(_ sender: Any?) {
        guard isEditable else { return }
        dismissPathPicker()
        if onPasteImages?(NSPasteboard.general) == true { return }
        super.paste(sender)
    }

    override func pasteAsPlainText(_ sender: Any?) {
        guard isEditable else { return }
        dismissPathPicker()
        if onPasteImages?(NSPasteboard.general) == true { return }
        super.pasteAsPlainText(sender)
    }

    override func readSelection(from pasteboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        guard isEditable else { return false }
        if onPasteImages?(pasteboard) == true {
            dismissPathPicker()
            return true
        }
        if type == .fileURL, onPasteImages != nil, pasteboard.availableType(from: [.string]) != nil {
            return super.readSelection(from: pasteboard, type: .string)
        }
        return super.readSelection(from: pasteboard, type: type)
    }
    var completionDirectory = FileManager.default.homeDirectoryForCurrentUser.path {
        didSet { if oldValue != completionDirectory { dismissPathPicker() } }
    }
    private(set) var pathPicker: PathCompletionPicker?
    private var keyFlags: NSEvent.ModifierFlags?

    private var inputFlags: NSEvent.ModifierFlags {
        keyFlags ?? NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []
    }

    override func keyDown(with event: NSEvent) {
        keyFlags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        defer { keyFlags = nil }
        let navigation = inputFlags.intersection([.command, .control, .option]).isEmpty
        if let picker = pathPicker, !hasMarkedText() {
            switch event.keyCode {
            case 125 where navigation: picker.model.move(1); return
            case 126 where navigation: picker.model.move(-1); return
            case 48 where navigation && inputFlags.contains(.shift): picker.model.move(-1); return
            case 48 where navigation: picker.model.choose?(picker.model.selected); return
            case 36, 76: picker.model.choose?(picker.model.selected); return
            case 53: dismissPathPicker(); return
            default: dismissPathPicker()
            }
        }
        // Picker navigation and Escape take precedence over queue editing shortcuts.
        if !hasMarkedText() {
            if event.keyCode == 51, inputFlags.intersection([.command, .control, .option, .shift]) == .command,
               let onRemoveQueuedMessage {
                // Only queue editors install this handler. Keep normal Command-Delete elsewhere,
                // and consume repeats/busy edits without modifying the queued draft.
                if isEditable, !event.isARepeat { onRemoveQueuedMessage() }
                return
            }
            if inputFlags.contains(.option), inputFlags.intersection([.shift, .command, .control]).isEmpty,
               event.keyCode == 126 || event.keyCode == 125,
               onNavigateQueue?(event.keyCode == 126 ? .up : .down) == true { return }
            if event.keyCode == 53, onCancel?() == true { return }
        }
        let isReturn = event.keyCode == 36 || event.keyCode == 76
        if isReturn, !hasMarkedText() {
            if inputFlags.contains(.shift) { super.insertNewlineIgnoringFieldEditor(nil) }
            else { onSubmit?(inputFlags) }
            return
        }
        super.keyDown(with: event)
    }

    override func insertTab(_ sender: Any?) {
        let flags = inputFlags
        if flags.intersection([.shift, .control, .option, .command]).isEmpty, completePath() { return }
        super.insertTab(sender)
    }

    override func complete(_ sender: Any?) { _ = completePath() }

    private func completePath() -> Bool {
        guard !hasMarkedText(), let range = PathCompletion.range(in: string, selection: selectedRange()) else { return false }
        let candidates = PathCompletion.candidates(in: string, range: range, directory: completionDirectory)
        guard !candidates.isEmpty else { return false }
        if candidates.count == 1 { insertText(candidates[0], replacementRange: range) }
        else { showPathPicker(candidates: candidates, range: range) }
        return true
    }

    override func didChangeText() {
        dismissPathPicker()
        super.didChangeText()
    }

    override func resignFirstResponder() -> Bool {
        dismissPathPicker()
        return super.resignFirstResponder()
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        dismissPathPicker()
        super.viewWillMove(toWindow: newWindow)
    }

    func dismissPathPicker() {
        pathPicker?.close()
        pathPicker = nil
    }

    private func showPathPicker(candidates: [String], range: NSRange) {
        dismissPathPicker()
        let original = string
        let selection = selectedRange()
        let picker = PathCompletionPicker(candidates: candidates) { [weak self] index in
            guard let self else { return }
            self.dismissPathPicker()
            guard self.string == original, self.selectedRange() == selection else { return }
            self.insertText(candidates[index], replacementRange: range)
        } onDismiss: { [weak self] in self?.dismissPathPicker() }
        pathPicker = picker
        picker.show(for: self)
    }
}
