import AppKit
import PilotCore
import SwiftUI

/// Native disclosure chrome shared by work, thinking, read groups and individual tools.
final class NativeWorkLine: NSView {
    private let mark = NSImageView()
    private let spinner = EllipsisSpinnerView()
    private let verb = NSTextField(labelWithString: "")
    private let subject = NSTextField(labelWithString: "")
    private let badge = NSTextField(labelWithString: "")
    private let button = NativeTranscriptButton()
    private var shimmer: ShimmerView?
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        for field in [verb, subject, badge] { field.usesSingleLineMode = true }
        for field in [verb, subject, badge] { field.setAccessibilityElement(false) }
        subject.lineBreakMode = .byTruncatingMiddle
        badge.font = .monospacedDigitSystemFont(ofSize: Theme.TextRole.caption.size, weight: .regular)
        mark.setAccessibilityElement(false)
        for view in [mark, spinner, verb, subject, badge, button] { addSubview(view) }
        setAccessibilityElement(false)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func update(verb: String, subject: String?, icon: PilotIcon, expanded: Bool? = nil,
                running: Bool = false, failed: Bool = false, badge: String? = nil, summary: Bool = false,
                environment: EnvironmentValues, action: @escaping () -> Void) {
        let fonts = environment.pilotFonts
        self.verb.stringValue = verb
        self.verb.font = fonts.nsChat(fonts.chatSize - 1)
        self.verb.textColor = NSColor(failed && !summary ? Theme.destructive : running ? Theme.foreground : Theme.mutedForeground)
        self.subject.stringValue = subject ?? ""
        self.subject.font = summary ? fonts.nsChat(fonts.chatSize - 1) : fonts.nsMono.withSize(CGFloat(fonts.codeSize - 0.5))
        self.subject.textColor = NSColor(summary ? Theme.faintForeground : running ? Theme.foreground : Theme.mutedForeground)
        self.badge.stringValue = badge ?? ""
        self.badge.textColor = NSColor(failed ? Theme.destructive : Theme.faintForeground)
        mark.image = (expanded.map { $0 ? PilotIcon.disclosureOpen : PilotIcon.disclosure } ?? (failed ? PilotIcon.warning : icon)).menuImage
        mark.contentTintColor = NSColor(failed && !summary ? Theme.destructive : Theme.faintForeground)
        mark.isHidden = running
        spinner.isHidden = !running
        spinner.animates = running && !environment.accessibilityReduceMotion
        if running && !environment.accessibilityReduceMotion {
            if shimmer == nil {
                let view = ShimmerView()
                shimmer = view; addSubview(view, positioned: .below, relativeTo: button)
            }
        } else { shimmer?.removeFromSuperview(); shimmer = nil }
        button.onPress = action
        button.setAccessibilityLabel([verb, subject, failed ? "failed" : nil, badge].compactMap { $0 }.joined(separator: " "))
        if let expanded { button.setAccessibilityValue(expanded ? "Expanded" : "Collapsed") }
        else { button.setAccessibilityValue(nil) }
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        let height = max(18, ceil(verb.intrinsicContentSize.height))
        mark.frame = NSRect(x: 0, y: (height - 12) / 2, width: 14, height: 12)
        spinner.frame = NSRect(x: 0, y: (height - 14) / 2, width: 14, height: 14)
        // Intrinsic width excludes the text cell's horizontal padding. Using it as the frame
        // width makes AppKit truncate even when the row has plenty of room.
        func naturalWidth(_ field: NSTextField) -> CGFloat {
            ceil(field.cell?.cellSize.width ?? field.intrinsicContentSize.width)
        }
        let badgeWidth = badge.stringValue.isEmpty ? 0 : min(max(0, width - 21), naturalWidth(badge) + 6)
        let available = max(1, width - 21 - badgeWidth)
        let verbWidth = min(available, naturalWidth(verb))
        verb.frame = NSRect(x: 21, y: 0, width: verbWidth, height: height)
        let subjectWidth = subject.stringValue.isEmpty ? 0 : min(max(0, available - verbWidth - 4), naturalWidth(subject))
        subject.frame = NSRect(x: 25 + verbWidth, y: 0, width: subjectWidth, height: height)
        badge.frame = NSRect(x: min(width - badgeWidth, 25 + verbWidth + subjectWidth + 6),
                             y: 0, width: badgeWidth, height: height)
        button.frame = NSRect(x: 0, y: 0, width: width, height: height)
        shimmer?.frame = NSRect(x: 21, y: 0, width: max(1, verbWidth + 4 + subjectWidth), height: height)
        return height
    }
    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    func stopMotion() { spinner.animates = false; shimmer?.removeFromSuperview(); shimmer = nil }
}

final class NativeWorkGroup: NSView, NativeRowContent {
    private let line = NativeWorkLine()
    private let earlier = NativeTranscriptButton()
    private let guide = NativeWorkGuide()
    private var steps: [String: NativeWorkStep] = [:]
    private var shown: [WorkStep] = []
    private var artifacts: [ArtifactReference: NativeArtifactRow] = [:]
    private var artifactOrder: [ArtifactReference] = []
    private let observation = NativeRowObservation()
    private var group = TurnWork(rows: [])
    private var context: NativeRowContext?
    private var expansion: ExpansionState?
    private var rowID = ""
    private var open = false
    private var limited = false
    private var reveal: RevealCoverView?
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        earlier.onPress = { [weak self] in
            self?.context?.environment.transcriptMessageToggled?()
            self?.expansion?.markOpened()
            self?.expansion?.showAllSteps = true
        }
        for view in [guide, line, earlier] { addSubview(view) }
        setAccessibilityElement(true); setAccessibilityRole(.group); setAccessibilityLabel("Work")
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func bind(_ row: ChatRow, context: NativeRowContext) {
        if rowID != row.id {
            for step in steps.values { step.stop() }; steps = [:]
            reveal?.removeFromSuperview(); reveal = nil
        }
        rowID = row.id; self.context = context
        if case let .work(_, group) = row { self.group = group } else { group = TurnWork(rows: [row]) }
        expansion = context.messageExpansions.state(for: row.id)
        observation.bind(expansion.map { [$0.objectWillChange] } ?? []) { [weak self] in
            self?.rebuild(); self?.context?.changed()
        }
        rebuild()
    }

    private func rebuild() {
        guard let context else { return }
        open = expansion?.choice ?? (context.active || group.endedOnFailure)
        let summary = group.summary(active: context.active)
        line.update(verb: summary.lead, subject: summary.detail.map { "· " + $0 }, icon: PilotIcon.disclosure,
                    expanded: open, failed: group.failureCount > 0,
                    badge: group.failureCount > 0 ? "· \(group.failureCount) failed" : nil, summary: true,
                    environment: context.environment, action: { [weak self] in self?.toggle() })
        let all = open ? group.steps : []
        limited = open && context.active && expansion?.choice == nil && expansion?.showAllSteps != true
            && all.count > WorkGroupView.liveStepLimit
        shown = limited ? Array(all.suffix(WorkGroupView.liveStepLimit)) : all
        earlier.title = "Show \(all.count - shown.count) earlier steps"
        earlier.isHidden = !limited
        guide.isHidden = !open
        let retained = Set(shown.map(\.id))
        for id in Array(steps.keys) where !retained.contains(id) { steps.removeValue(forKey: id)?.stop() }
        for step in shown {
            let view = steps[step.id] ?? NativeWorkStep()
            if steps[step.id] == nil { steps[step.id] = view; addSubview(view) }
            view.bind(step, context: context)
        }
        artifactOrder = []
        for reference in group.tools.compactMap(\.artifact) where !artifactOrder.contains(reference) {
            artifactOrder.append(reference)
        }
        let retainedArtifacts = Set(artifactOrder)
        for key in Array(artifacts.keys) where !retainedArtifacts.contains(key) { artifacts.removeValue(forKey: key)?.stop() }
        for reference in artifactOrder {
            let view = artifacts[reference] ?? NativeArtifactRow()
            if artifacts[reference] == nil { artifacts[reference] = view; addSubview(view) }
            view.update(reference: reference, context: context)
        }
        if open, expansion?.justOpened() == true, !context.environment.accessibilityReduceMotion, reveal == nil {
            let view = RevealCoverView()
            reveal = view; addSubview(view)
        } else if !open { reveal?.removeFromSuperview(); reveal = nil }
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        let header = line.measure(width: width)
        line.frame = NSRect(x: 0, y: 0, width: width, height: header)
        var y = header
        let stepStart = y + 8
        if open {
            y += 8
            if limited {
                earlier.frame = NSRect(x: 14, y: y, width: max(1, width - 14), height: 20)
                y += 26
            }
            for (index, step) in shown.enumerated() {
                if index > 0 { y += 6 }
                guard let view = steps[step.id] else { continue }
                let height = view.measure(width: max(1, width - 14))
                view.frame = NSRect(x: 14, y: y, width: max(1, width - 14), height: height)
                y += height
            }
        }
        guide.frame = NSRect(x: 4, y: stepStart, width: 1, height: max(0, y - stepStart))
        reveal?.frame = NSRect(x: 14, y: stepStart, width: max(1, width - 14), height: max(0, y - stepStart))
        for reference in artifactOrder {
            guard let view = artifacts[reference] else { continue }
            y += 8
            let height = view.measure(width: width)
            view.frame = NSRect(x: 0, y: y, width: width, height: height)
            y += height
        }
        return y
    }
    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    private func toggle() {
        context?.environment.transcriptMessageToggled?()
        if !open { expansion?.markOpened() }
        expansion?.choice = !open
    }
    func activate() -> Bool { toggle(); return true }
    func stop() {
        observation.stop()
        for step in steps.values { step.stop() }; steps = [:]; shown = []
        for artifact in artifacts.values { artifact.stop() }; artifacts = [:]; artifactOrder = []
        reveal?.removeFromSuperview(); reveal = nil
        context = nil; expansion = nil; group = TurnWork(rows: [])
        removeFromSuperview()
    }
}

private final class NativeWorkStep: NSView {
    private let line = NativeWorkLine()
    private var message: NativeMarkdownMessage?
    private var code: NativeCodeBlock?
    private var output: NativeToolOutput?
    private var diffs: [String: NativeDiffBlock] = [:]
    private var reads: [String: NativeWorkStep] = [:]
    private let observation = NativeRowObservation()
    private var step: WorkStep?
    private var context: NativeRowContext?
    private var expansion: ExpansionState?
    private var open = false
    private var reveal: RevealCoverView?
    private var kind = -1
    override var isFlipped: Bool { true }

    override init(frame: NSRect) { super.init(frame: frame); addSubview(line) }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func bind(_ step: WorkStep, context: NativeRowContext) {
        let kind: Int
        switch step { case .thinking: kind = 0; case .note: kind = 1; case .tool: kind = 2; case .reads: kind = 3 }
        if self.step?.id != step.id || self.kind != kind { clearDetails() }
        self.kind = kind
        self.step = step; self.context = context
        switch step {
        case let .tool(item): expansion = context.toolExpansions.state(for: item.id)
        case .thinking: expansion = context.messageExpansions.state(for: "thinking:" + step.id)
        case .reads: expansion = context.messageExpansions.state(for: "reads:" + step.id)
        case .note: expansion = nil
        }
        observation.bind(expansion.map { [$0.objectWillChange] } ?? []) { [weak self] in
            self?.rebuild(); self?.context?.changed()
        }
        rebuild()
    }

    private func rebuild() {
        guard let step, let context else { return }
        open = expansion?.expanded == true
        if case let .note(_, text) = step {
            line.isHidden = true
            line.stopMotion()
            setMessage(text)
            return
        }
        line.isHidden = false
        var running = false
        var failed = false
        var icon = PilotIcon.thinking
        var badge: String?
        switch step {
        case let .thinking(_, _, streaming): running = streaming
        case let .tool(item):
            running = item.status.isLive(active: context.active)
            failed = item.status == .error
            icon = item.summary.icon.pilotIcon
            if item.summary.additions + item.summary.deletions > 0 {
                badge = "+\(item.summary.additions)" + (item.summary.deletions > 0 ? " −\(item.summary.deletions)" : "")
            }
            line.toolTip = item.summary.detail ?? item.summary.title
        case .reads: icon = PilotIcon.document
        case .note: break
        }
        line.update(verb: step.sentence.verb, subject: step.sentence.subject, icon: icon, running: running, failed: failed,
                    badge: badge, environment: context.environment, action: { [weak self] in
                        self?.context?.environment.transcriptMessageToggled?()
                        self?.expansion?.toggleExpanded()
                    })
        if !open { clearDetails(); return }
        switch step {
        case let .thinking(_, text, _): setMessage(text)
        case let .tool(item):
            let summary = item.summary
            if !summary.diffs.isEmpty {
                code?.stop(); code = nil
                let retained = Set(summary.diffs.map(\.path))
                for path in Array(diffs.keys) where !retained.contains(path) { diffs.removeValue(forKey: path)?.removeFromSuperview() }
                for file in summary.diffs {
                    let view = diffs[file.path] ?? NativeDiffBlock()
                    if diffs[file.path] == nil { diffs[file.path] = view; addSubview(view) }
                    view.update(file, fonts: context.environment.pilotFonts)
                }
            } else {
                for diff in diffs.values { diff.removeFromSuperview() }; diffs = [:]
                let view = code ?? NativeCodeBlock()
                if code == nil { code = view; addSubview(view) }
                view.update(source: summary.body ?? item.arguments.prettyPrinted,
                    language: summary.body == nil ? "arguments" : item.name == "codemode" ? "javascript" : nil,
                    prepared: nil, fonts: context.environment.pilotFonts, openURL: context.environment.openURL,
                    changed: { [weak self] in self?.context?.changed() })
            }
            if !item.output.isEmpty {
                let view = output ?? NativeToolOutput()
                if output == nil { output = view; addSubview(view) }
                view.update(item.output, failed: failed, fonts: context.environment.pilotFonts)
            } else { output?.removeFromSuperview(); output = nil }
        case let .reads(_, items):
            let retained = Set(items.map(\.id))
            for id in Array(reads.keys) where !retained.contains(id) { reads.removeValue(forKey: id)?.stop() }
            for item in items {
                let view = reads[item.id] ?? NativeWorkStep()
                if reads[item.id] == nil { reads[item.id] = view; addSubview(view) }
                view.bind(.tool(item), context: context)
            }
        case .note: break
        }
        if expansion?.justOpened() == true, !context.environment.accessibilityReduceMotion, reveal == nil {
            let view = RevealCoverView(); reveal = view; addSubview(view)
        }
        needsLayout = true
    }

    private func setMessage(_ source: String) {
        guard let context, let step else { return }
        let view = message ?? NativeMarkdownMessage()
        if message == nil { message = view; view.showsActions = false; addSubview(view) }
        view.update(source: source, timestamp: nil, streaming: false, selection: context.selection(step.id),
                    environment: context.environment, color: NSColor(Theme.mutedForeground),
                    changed: { [weak self] in self?.context?.changed() })
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        guard let step else { return 1 }
        if case .note = step, let message {
            let height = message.measure(width: width)
            message.frame = NSRect(x: 0, y: 0, width: width, height: height)
            return height
        }
        let header = line.measure(width: width)
        line.frame = NSRect(x: 0, y: 0, width: width, height: header)
        var y = header
        guard open else { return y }
        let detailWidth = max(1, width - 21)
        func place(_ view: NSView, height: CGFloat, gap: CGFloat = 8) {
            y += gap; view.frame = NSRect(x: 21, y: y, width: detailWidth, height: height); y += height
        }
        if let message { place(message, height: message.measure(width: detailWidth), gap: 6) }
        if let code { place(code, height: code.measure(width: detailWidth).height, gap: 6) }
        if case let .tool(item) = step {
            for file in item.summary.diffs {
                if let view = diffs[file.path] { place(view, height: view.measure(width: detailWidth)) }
            }
        }
        if let output { place(output, height: output.measure(width: detailWidth)) }
        if case let .reads(_, items) = step {
            for item in items { if let view = reads[item.id] { place(view, height: view.measure(width: detailWidth), gap: 5) } }
        }
        reveal?.frame = NSRect(x: 21, y: header + 6, width: detailWidth, height: max(0, y - header - 6))
        return y
    }
    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    private func clearDetails() {
        message?.stop(); message = nil
        code?.stop(); code = nil
        output?.removeFromSuperview(); output = nil
        for diff in diffs.values { diff.removeFromSuperview() }; diffs = [:]
        for read in reads.values { read.stop() }; reads = [:]
        reveal?.removeFromSuperview(); reveal = nil
    }
    func stop() { observation.stop(); clearDetails(); context = nil; step = nil; expansion = nil; removeFromSuperview() }
}

private final class NativeToolOutput: NSScrollView {
    private let text = MessageSelectionTextView.makeReadOnly()
    private var source = ""
    private var font: NSFont?
    private var failed = false
    override init(frame: NSRect) {
        super.init(frame: frame)
        drawsBackground = false; hasVerticalScroller = true; autohidesScrollers = true
        wantsLayer = true; layer?.cornerRadius = Theme.Radius.control; layer?.borderWidth = 1
        documentView = text
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    func update(_ source: String, failed: Bool, fonts: PilotFonts) {
        guard self.source != source || self.font != fonts.nsMono || self.failed != failed else { return }
        self.source = source; self.failed = failed; font = fonts.nsMono
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 0
        text.textStorage?.setAttributedString(NSAttributedString(string: source, attributes: [
            .font: fonts.nsMono, .foregroundColor: NSColor(failed ? Theme.error : Theme.foreground), .paragraphStyle: paragraph,
        ]))
        text.textContainerInset = NSSize(width: 10, height: 10)
        text.invalidateMeasurements()
        needsDisplay = true
    }
    func measure(width: CGFloat) -> CGFloat {
        let size = text.measure(width: max(1, width - 20), unwrapped: false)
        text.frame = NSRect(x: 0, y: 0, width: width, height: size.height + 20)
        return min(260, size.height + 20)
    }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor(Theme.code).cgColor
            layer?.borderColor = NSColor(Theme.border).cgColor
        }
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
}

private final class NativeWorkGuide: NSView {
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true; setAccessibilityElement(false) }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = NSColor(Theme.border).cgColor }
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
