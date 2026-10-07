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
        if focusToken != context.coordinator.lastFocusToken {
            context.coordinator.lastFocusToken = focusToken
            DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        }
        textView.completionDirectory = completionDirectory
        var changed = false
        if textView.string != text {
            textView.string = text
            changed = true
        }
        if textView.font != font {
            textView.font = font
            changed = true
        }
        if changed { context.coordinator.recalculate(textView) }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatTextEditor
        var lastFocusToken: UUID?

        init(parent: ChatTextEditor) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            recalculate(textView)
        }

        func recalculate(_ textView: NSTextView) {
            guard let layout = textView.layoutManager, let container = textView.textContainer else { return }
            layout.ensureLayout(for: container)
            let line = layout.defaultLineHeight(for: parent.font)
            let used = layout.usedRect(for: container).height
            let height = min(max(used, line * CGFloat(parent.minLines)), line * CGFloat(parent.maxLines)).rounded(.up)
            if abs(parent.height - height) > 0.5 {
                let binding = parent.$height
                DispatchQueue.main.async { binding.wrappedValue = height }
            }
        }
    }
}

final class SubmitTextView: NSTextView {
    var onSubmit: ((NSEvent.ModifierFlags) -> Void)?
    var onNavigateQueue: ((QueueNavigationDirection) -> Bool)?
    var onCancel: (() -> Bool)?
    var completionDirectory = FileManager.default.homeDirectoryForCurrentUser.path
    private var keyFlags: NSEvent.ModifierFlags?
    private var isReturnKey = false
    private var handledReturn = false

    private var inputFlags: NSEvent.ModifierFlags {
        keyFlags ?? NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if !hasMarkedText() {
            if flags.contains(.option), flags.intersection([.shift, .command, .control]).isEmpty,
               event.keyCode == 126 || event.keyCode == 125,
               onNavigateQueue?(event.keyCode == 126 ? .up : .down) == true { return }
            if event.keyCode == 53, onCancel?() == true { return }
        }
        keyFlags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        isReturnKey = (event.keyCode == 36 || event.keyCode == 76) && !hasMarkedText()
        handledReturn = false
        defer { keyFlags = nil; isReturnKey = false }
        // Let AppKit handle its completion menu before interpreting Return as a submission.
        super.keyDown(with: event)
        // Some modified Returns (for example Command-Return) have no text command binding.
        if isReturnKey, !handledReturn, !hasMarkedText() {
            if inputFlags.contains(.shift) { super.insertNewlineIgnoringFieldEditor(nil) }
            else { onSubmit?(inputFlags) }
        }
    }

    override func insertNewline(_ sender: Any?) {
        if !submitReturn() { super.insertNewline(sender) }
    }

    override func insertNewlineIgnoringFieldEditor(_ sender: Any?) {
        if !submitReturn() { super.insertNewlineIgnoringFieldEditor(sender) }
    }

    override func insertLineBreak(_ sender: Any?) {
        if !submitReturn() { super.insertLineBreak(sender) }
    }

    private func submitReturn() -> Bool {
        guard isReturnKey, !hasMarkedText() else { return false }
        handledReturn = true
        guard !inputFlags.contains(.shift) else { return false }
        onSubmit?(inputFlags)
        return true
    }

    override func insertCompletion(_ word: String, forPartialWordRange charRange: NSRange, movement: Int, isFinal flag: Bool) {
        if isReturnKey { handledReturn = true }
        super.insertCompletion(word, forPartialWordRange: charRange, movement: movement, isFinal: flag)
    }

    override var rangeForUserCompletion: NSRange {
        PathCompletion.range(in: string, selection: selectedRange()) ?? NSRange(location: NSNotFound, length: 0)
    }

    override func completions(forPartialWordRange charRange: NSRange, indexOfSelectedItem index: UnsafeMutablePointer<Int>) -> [String]? {
        index.pointee = -1
        return PathCompletion.candidates(in: string, range: charRange, directory: completionDirectory)
    }

    override func insertTab(_ sender: Any?) {
        let flags = inputFlags
        if !hasMarkedText(), flags.intersection([.shift, .control, .option, .command]).isEmpty,
           let range = PathCompletion.range(in: string, selection: selectedRange()) {
            let candidates = PathCompletion.candidates(in: string, range: range, directory: completionDirectory)
            if candidates.count == 1 {
                insertText(candidates[0], replacementRange: range)
                return
            }
            if !candidates.isEmpty {
                complete(sender)
                return
            }
        }
        super.insertTab(sender)
    }
}
