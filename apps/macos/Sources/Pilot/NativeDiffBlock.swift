import AppKit
import PilotCore
import SwiftUI

/// Tool edit details keep the existing 300-line display limit, colours, copy and horizontal scrolling.
/// One native text region draws glyphs; one document draws only the visible lines' full-width fills.
final class NativeDiffBlock: NSView {
    private let header = NSTextField(labelWithString: "")
    private let headerFill = NSView()
    private let scroll = MarkdownTableScrollView()
    private let document = NativeDiffDocument()
    private let text = MessageSelectionTextView.makeReadOnly()
    private var file: FileDiff?
    private var fonts: PilotFonts?
    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = Theme.Radius.control
        layer?.borderWidth = 1
        layer?.masksToBounds = true
        headerFill.wantsLayer = true
        header.textColor = NSColor(Theme.mutedForeground)
        header.lineBreakMode = .byTruncatingMiddle
        header.setAccessibilityRole(.staticText)
        text.unwrapped = true
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false
        scroll.hasVerticalScroller = false
        scroll.verticalScrollElasticity = .none
        scroll.documentView = document
        document.addSubview(text)
        addSubview(headerFill)
        addSubview(header)
        addSubview(scroll)
        setAccessibilityElement(false)
        document.setAccessibilityElement(false)
        scroll.setAccessibilityElement(false)
        scroll.contentView.setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func update(_ file: FileDiff, fonts: PilotFonts) {
        guard self.file != file || self.fonts != fonts else { return }
        self.file = file; self.fonts = fonts
        let font = fonts.nsMono.withSize(CGFloat(fonts.codeSize - 0.5))
        let lineHeight = ceil(font.ascender - font.descender + font.leading) + 1
        header.stringValue = file.path
        header.font = font
        let result = NSMutableAttributedString(string: "")
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        let shown = Array(file.lines.prefix(300))
        var kinds: [DiffLineKind] = []
        for (index, line) in shown.enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n")) }
            let marker = line.kind == .addition ? "+" : line.kind == .deletion ? "−" : " "
            let ink = line.kind == .addition ? Theme.success : line.kind == .deletion ? Theme.destructive : Theme.faintForeground
            result.append(NSAttributedString(string: marker + " ", attributes: [
                .font: font, .foregroundColor: NSColor(ink), .paragraphStyle: paragraph,
            ]))
            result.append(NSAttributedString(string: line.text.isEmpty ? " " : line.text, attributes: [
                .font: font, .foregroundColor: NSColor(line.kind == .hunk || line.kind == .note ? Theme.mutedForeground : Theme.foreground),
                .paragraphStyle: paragraph,
            ]))
            kinds.append(line.kind)
        }
        if file.lines.count > 300 {
            result.append(NSAttributedString(string: "\n… \(file.lines.count - 300) more lines", attributes: [
                .font: font, .foregroundColor: NSColor(Theme.mutedForeground), .paragraphStyle: paragraph,
            ]))
            kinds.append(.note)
        }
        text.textStorage?.setAttributedString(result)
        text.invalidateMeasurements()
        document.kinds = kinds
        document.lineHeight = lineHeight
        document.needsDisplay = true
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        let size = text.measure(width: 1_000_000, unwrapped: true)
        let height = max(size.height, CGFloat(document.kinds.count) * document.lineHeight)
        headerFill.frame = NSRect(x: 0, y: 0, width: width, height: 26)
        header.frame = NSRect(x: 10, y: 5, width: max(1, width - 20), height: 18)
        document.frame = NSRect(x: 0, y: 0, width: max(width, size.width + 12), height: height)
        text.frame = NSRect(x: 0, y: 0, width: max(width, size.width + 12), height: height)
        scroll.frame = NSRect(x: 0, y: 30, width: width, height: height)
        return 34 + height
    }

    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor(Theme.code).cgColor
            layer?.borderColor = NSColor(Theme.border).cgColor
            headerFill.layer?.backgroundColor = NSColor(Theme.muted).cgColor
        }
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true; document.needsDisplay = true
    }
}

private final class NativeDiffDocument: NSView {
    var kinds: [DiffLineKind] = []
    var lineHeight: CGFloat = 1
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard !kinds.isEmpty else { return }
        let first = max(0, Int(floor(dirtyRect.minY / lineHeight)))
        let end = min(kinds.count, Int(ceil(dirtyRect.maxY / lineHeight)))
        guard end > first else { return }
        for index in first..<end {
            let color: NSColor
            switch kinds[index] {
            case .addition: color = NSColor(Theme.success).withAlphaComponent(0.10)
            case .deletion: color = NSColor(Theme.destructive).withAlphaComponent(0.09)
            case .hunk: color = NSColor(Theme.muted)
            default: continue
            }
            color.setFill()
            NSRect(x: 0, y: CGFloat(index) * lineHeight, width: bounds.width, height: lineHeight).fill()
        }
    }
}
