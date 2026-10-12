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
    var completionDirectory: String? = FileManager.default.homeDirectoryForCurrentUser.path
    /// Slash command menu entries; nil disables the menu.
    var slashCommands: [SlashCommand]?
    /// Called when the menu opens, so the owner can load the session's commands lazily.
    var onSlashCommandsNeeded: (() -> Void)?
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
        textView.slashCommands = slashCommands
        textView.onSlashCommandsNeeded = { [weak coordinator = context.coordinator] in
            coordinator?.parent.onSlashCommandsNeeded?()
        }
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
            textView.dismissCompletionPicker()
            textView.string = text
            changed = true
        }
        textView.slashCommands = slashCommands
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
        textView.dismissCompletionPicker()
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
        dismissCompletionPicker()
        if onPasteImages?(NSPasteboard.general) == true { return }
        super.paste(sender)
    }

    override func pasteAsPlainText(_ sender: Any?) {
        guard isEditable else { return }
        dismissCompletionPicker()
        if onPasteImages?(NSPasteboard.general) == true { return }
        super.pasteAsPlainText(sender)
    }

    override func readSelection(from pasteboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        guard isEditable else { return false }
        if onPasteImages?(pasteboard) == true {
            dismissCompletionPicker()
            return true
        }
        if type == .fileURL, onPasteImages != nil, pasteboard.availableType(from: [.string]) != nil {
            return super.readSelection(from: pasteboard, type: .string)
        }
        return super.readSelection(from: pasteboard, type: type)
    }
    var completionDirectory: String? = FileManager.default.homeDirectoryForCurrentUser.path {
        didSet { if oldValue != completionDirectory, pickerMode == .path { dismissCompletionPicker() } }
    }
    var slashCommands: [SlashCommand]? {
        didSet { if oldValue != slashCommands, pickerMode == .slash || slashCommands == nil { updateSlashPicker() } }
    }
    var onSlashCommandsNeeded: (() -> Void)?
    private enum PickerMode { case path, slash }
    private(set) var completionPicker: CompletionPicker?
    private var pickerMode: PickerMode?
    /// The slash command token the open menu completes, and its matching commands.
    private var slashRange: NSRange?
    private var slashMatches: [SlashCommand] = []
    private var insertingCompletion = false
    private var keyFlags: NSEvent.ModifierFlags?

    private var inputFlags: NSEvent.ModifierFlags {
        keyFlags ?? NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []
    }

    override func keyDown(with event: NSEvent) {
        keyFlags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        defer { keyFlags = nil }
        let navigation = inputFlags.intersection([.command, .control, .option]).isEmpty
        if let picker = completionPicker, !hasMarkedText() {
            let slash = pickerMode == .slash
            switch event.keyCode {
            case 125 where navigation: picker.model.move(1); return
            case 126 where navigation: picker.model.move(-1); return
            case 48 where navigation && inputFlags.contains(.shift): picker.model.move(-1); return
            case 48 where navigation: picker.model.choose?(picker.model.selected); return
            case 36 where slash && !inputFlags.contains(.shift), 76 where slash && !inputFlags.contains(.shift):
                if runSlashCommand(picker.model.selected) { onSubmit?(inputFlags) }
                return
            case 36 where !slash, 76 where !slash: picker.model.choose?(picker.model.selected); return
            case 53: dismissCompletionPicker(); return
            // Typing refines the slash menu; didChangeText or the caret check below updates it.
            default: if !slash { dismissCompletionPicker() }
            }
        }
        defer { if pickerMode == .slash { updateSlashPicker() } }
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
        guard let completionDirectory, !hasMarkedText(), let range = PathCompletion.range(in: string, selection: selectedRange()) else { return false }
        let candidates = PathCompletion.candidates(in: string, range: range, directory: completionDirectory)
        guard !candidates.isEmpty else { return false }
        if candidates.count == 1 { insertText(candidates[0], replacementRange: range) }
        else { showPathPicker(candidates: candidates, range: range) }
        return true
    }

    override func didChangeText() {
        if pickerMode == .path { dismissCompletionPicker() }
        super.didChangeText()
        updateSlashPicker()
    }

    override func resignFirstResponder() -> Bool {
        dismissCompletionPicker()
        return super.resignFirstResponder()
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        dismissCompletionPicker()
        super.viewWillMove(toWindow: newWindow)
    }

    func dismissCompletionPicker() {
        completionPicker?.close()
        completionPicker = nil
        pickerMode = nil
        slashRange = nil
        slashMatches = []
    }

    private func showPathPicker(candidates: [String], range: NSRange) {
        dismissCompletionPicker()
        let original = string
        let selection = selectedRange()
        let picker = CompletionPicker(items: candidates.map(CompletionItem.path)) { [weak self] index in
            guard let self else { return }
            self.dismissCompletionPicker()
            guard self.string == original, self.selectedRange() == selection else { return }
            self.insertText(candidates[index], replacementRange: range)
        } onDismiss: { [weak self] in self?.dismissCompletionPicker() }
        completionPicker = picker
        pickerMode = .path
        picker.show(for: self)
    }

    /// Open, refine or close the slash command menu for the token at the caret. Cheap enough to run per keystroke:
    /// filtering is bounded, and the open panel is updated in place rather than recreated.
    private func updateSlashPicker() {
        guard !insertingCompletion, pickerMode != .path else { return }
        guard let commands = slashCommands, isEditable, !hasMarkedText(),
              let range = SlashCommands.range(in: string, selection: selectedRange()) else {
            if pickerMode == .slash { dismissCompletionPicker() }
            return
        }
        if pickerMode == nil { onSlashCommandsNeeded?() }
        let query = (string as NSString).substring(with: NSRange(location: 1, length: range.length - 1))
        let matches = SlashCommands.matches(query, in: commands)
        guard !matches.isEmpty else {
            if pickerMode == .slash { dismissCompletionPicker() }
            return
        }
        slashRange = range
        slashMatches = matches
        let items = matches.map(CompletionItem.command)
        if let picker = completionPicker {
            picker.update(items, for: self)
            return
        }
        let picker = CompletionPicker(
            items: items, width: 440,
            hints: [CompletionPicker.Hint(key: "⇥", label: "complete"), CompletionPicker.Hint(key: "↩", label: "run")]
        ) { [weak self] index in
            self?.insertSlashCommand(index, trailingSpace: true)
        } onDismiss: { [weak self] in self?.dismissCompletionPicker() }
        picker.anchor = range.location
        completionPicker = picker
        pickerMode = .slash
        picker.show(for: self)
    }

    /// Replace the typed token with the chosen command. Returns false when the menu is stale.
    @discardableResult
    private func insertSlashCommand(_ index: Int, trailingSpace: Bool) -> Bool {
        guard let range = slashRange, slashMatches.indices.contains(index),
              range.upperBound <= (string as NSString).length else {
            dismissCompletionPicker()
            return false
        }
        let command = slashMatches[index]
        dismissCompletionPicker()
        let replacement = command.invocation + (trailingSpace ? " " : "")
        if (string as NSString).substring(with: range) != replacement {
            insertingCompletion = true
            defer { insertingCompletion = false }
            insertText(replacement, replacementRange: range)
        }
        return true
    }

    /// Return runs the chosen command, except a prompt template expecting arguments, which is completed instead.
    private func runSlashCommand(_ index: Int) -> Bool {
        guard slashMatches.indices.contains(index) else {
            dismissCompletionPicker()
            return false
        }
        let needsArguments = slashMatches[index].kind == .prompt && slashMatches[index].argumentHint != nil
        return insertSlashCommand(index, trailingSpace: needsArguments) && !needsArguments
    }
}
