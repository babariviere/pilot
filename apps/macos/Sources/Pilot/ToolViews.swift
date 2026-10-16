import PilotCore
import SwiftUI

/// A turn's thinking, notes and tool calls as one quiet line ("Worked for 3 min · read 3 files, ran 2 commands").
/// Open while the turn runs, with its latest steps visible; folded once it ends, unless its last step failed.
/// Steps read as sentences on a thin guide line; done steps draw no mark, running ones show the ellipsis spinner and
/// failed ones are red.
/// Artifacts a step published stay visible while the line is folded.
struct WorkGroupView: View {
    @Environment(\.hostViewContext) private var hostContext
    @Environment(\.pilotFonts) private var fonts
    @Environment(\.transcriptMessageToggled) private var messageToggled
    let group: TurnWork
    var active = false
    var toolExpansions: TranscriptExpansions?
    @StateObject private var expansion: ExpansionState
    @State private var hovered = false

    /// Steps shown while the turn runs, before "Show earlier steps".
    static let liveStepLimit = 4

    init(id: String, group: TurnWork, active: Bool = false, toolExpansions: TranscriptExpansions? = nil,
         expansions: TranscriptExpansions? = nil) {
        self.group = group
        self.active = active
        self.toolExpansions = toolExpansions
        _expansion = StateObject(wrappedValue: expansions?.state(for: id) ?? ExpansionState())
    }

    private var open: Bool { expansion.choice ?? (active || group.endedOnFailure) }

    var body: some View {
        let open = open
        let summary = group.summary(active: active)
        let failures = group.failureCount
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 6) {
                    DisclosureChevron(expanded: open)
                        .frame(width: 10)
                    Text(summary.lead)
                        .foregroundStyle(hovered ? Theme.foreground : Theme.mutedForeground)
                    if let detail = summary.detail {
                        Text("· \(detail)").foregroundStyle(Theme.faintForeground).lineLimit(1)
                    }
                    if failures > 0 {
                        Text("· \(failures) failed").foregroundStyle(Theme.destructive).fixedSize()
                    }
                }
                .font(fonts.chat(fonts.chatSize - 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovered = $0 }
            .accessibilityLabel([summary.lead, summary.detail, failures > 0 ? "\(failures) failed" : nil]
                .compactMap { $0 }.joined(separator: ", "))
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityHint(open ? "Hides the steps" : "Shows the steps")

            if open { steps.padding(.top, 8) }

            ForEach(group.tools.compactMap(\.artifact), id: \.id) { artifact in
                ArtifactCard(reference: artifact, host: hostContext?.host).padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var steps: some View {
        let all = group.steps
        let limited = active && expansion.choice == nil && !expansion.showAllSteps && all.count > Self.liveStepLimit
        let shown = limited ? Array(all.suffix(Self.liveStepLimit)) : all
        VStack(alignment: .leading, spacing: 6) {
            if limited {
                Button("Show \(all.count - shown.count) earlier steps") {
                    messageToggled?()
                    expansion.showAllSteps = true
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.mutedForeground)
                .font(fonts.chat(fonts.chatSize - 1.5))
            }
            ForEach(shown) { step in
                WorkStepView(step: step, active: active, expansions: toolExpansions)
            }
        }
        .padding(.leading, 14)
        .overlay(alignment: .leading) {
            Rectangle().fill(Theme.border).frame(width: 1).padding(.leading, 4)
        }
    }

    private func toggle() {
        // Opening finished work must not trigger Markdown's bottom-follow.
        messageToggled?()
        withAnimation(Theme.Motion.quick) { expansion.choice = !open }
    }
}

/// One step of an open work row.
private struct WorkStepView: View {
    @Environment(\.pilotFonts) private var fonts
    let step: WorkStep
    let active: Bool
    let expansions: TranscriptExpansions?

    var body: some View {
        switch step {
        case let .thinking(_, text, streaming):
            ThinkingStep(text: text, streaming: streaming)
        case let .note(_, text):
            MarkdownView(text: text, textColor: .secondaryLabelColor)
                .foregroundStyle(Theme.mutedForeground)
        case let .tool(item):
            ToolStepRow(item: item, active: active, expansion: expansions?.state(for: item.id))
        case let .reads(_, items):
            ReadsStep(step: step, items: items, active: active, expansions: expansions)
        }
    }
}

/// The leading mark of a step: its tool icon, the ellipsis spinner while it runs, a red cross when it failed.
private struct StepMark: View {
    let icon: PilotIcon
    var status: ToolStatus = .done
    var active = false

    var body: some View {
        Group {
            switch status {
            case .running where active, .pending where active:
                EllipsisSpinner()
            case .error:
                PilotSymbol(PilotIcon.warning).foregroundStyle(Theme.destructive)
            default:
                PilotSymbol(icon).foregroundStyle(Theme.faintForeground)
            }
        }
        .frame(width: 14)
    }
}

/// A step's sentence: the verb, then what it acted on in code type.
private struct StepSentence: View {
    @Environment(\.pilotFonts) private var fonts
    let verb: String
    let subject: String?
    var failed = false
    var highlighted = false

    var body: some View {
        HStack(spacing: 4) {
            Text(verb)
                .foregroundStyle(failed ? Theme.destructive : highlighted ? Theme.foreground : Theme.mutedForeground)
                .layoutPriority(1)
            if let subject, !subject.isEmpty {
                Text(subject)
                    .font(fonts.monoSmall)
                    .foregroundStyle(highlighted ? Theme.foreground : Theme.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .font(fonts.chat(fonts.chatSize - 1))
        .lineLimit(1)
    }
}

private struct ThinkingStep: View {
    let text: String
    let streaming: Bool
    @StateObject private var expansion = ExpansionState()
    @State private var hovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(Theme.Motion.quick) { expansion.expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    StepMark(icon: PilotIcon.thinking)
                    StepSentence(verb: streaming ? "Thinking…" : "Thought", subject: nil, highlighted: hovered)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovered = $0 }
            .accessibilityValue(expansion.expanded ? "Expanded" : "Collapsed")
            if expansion.expanded {
                MarkdownView(text: text, textColor: .secondaryLabelColor)
                    .foregroundStyle(Theme.mutedForeground)
                    .padding(.leading, 21)
            }
        }
    }
}

/// Consecutive reads as one sentence; opening it lists each read, which opens to its output.
private struct ReadsStep: View {
    let step: WorkStep
    let items: [ToolItem]
    let active: Bool
    let expansions: TranscriptExpansions?
    @StateObject private var expansion = ExpansionState()
    @State private var hovered = false

    var body: some View {
        let sentence = step.sentence
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(Theme.Motion.quick) { expansion.expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    StepMark(icon: PilotIcon.document)
                    StepSentence(verb: sentence.verb, subject: sentence.subject, highlighted: hovered)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovered = $0 }
            .help(items.compactMap(\.summary.detail).joined(separator: "\n"))
            .accessibilityValue(expansion.expanded ? "Expanded" : "Collapsed")
            if expansion.expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(items) { item in
                        ToolStepRow(item: item, active: active, expansion: expansions?.state(for: item.id))
                    }
                }
                .padding(.leading, 21)
            }
        }
    }
}

@MainActor
final class ExpansionState: ObservableObject {
    @Published var expanded = false
    /// A work row's open state chosen by the user. Nil follows the turn: open while it runs or after a failure.
    @Published var choice: Bool?
    /// A running work row shows only its latest steps until the user asks for the rest.
    @Published var showAllSteps = false
}

/// Chat-scoped ownership keeps expansion alive when a group moves between the live tail and
/// committed history. Individual rows still observe only their own expansion changes.
@MainActor
final class TranscriptExpansions: ObservableObject {
    private var states: [String: ExpansionState] = [:]
    private var streamingStates: [String: ExpansionState] = [:]
    private var streamingTimestamp: Int?
    @Published private(set) var streamingGeneration = UUID()

    func state(for callID: String) -> ExpansionState {
        if callID.hasPrefix("streaming-") {
            if let state = streamingStates[callID] { return state }
            let state = ExpansionState()
            streamingStates[callID] = state
            return state
        }
        if let state = states[callID] { return state }
        let state = ExpansionState()
        states[callID] = state
        return state
    }

    /// Consume the ordered event batch, not just the final streaming flag: end/start can
    /// arrive in one publication and reuse the same visible streaming row ID.
    func applyMessageEvents(_ events: [JSONValue]) {
        for event in events {
            switch event["type"]?.string {
            case "snapshot":
                let timestamp = event["generation"]?["message"]?["timestamp"]?.int
                if let streamingTimestamp, streamingTimestamp == timestamp { continue }
                // Recovery may skip message_end. Use the assistant's stable timestamp,
                // never its changing text, to reconcile an expanded streamed response.
                if let streamingTimestamp, !streamingStates.isEmpty {
                    for rawEntry in event["entries"]?.array ?? [] {
                        for (index, message) in (rawEntry["model"]?.array ?? []).enumerated()
                            where message["role"]?.string == "assistant" && message["timestamp"]?.int == streamingTimestamp {
                            guard let entry = Entry(json: rawEntry) else { continue }
                            transferStreamingStates(entry: entry, messageIndex: index)
                        }
                    }
                }
                streamingStates = [:]
                streamingTimestamp = timestamp
                streamingGeneration = UUID()
            case "message_start":
                streamingStates = [:]
                streamingTimestamp = event["message"]?["timestamp"]?.int
                streamingGeneration = UUID()
            case "message_end":
                if let entry = event["entry"].flatMap(Entry.init(json:)) {
                    for (messageIndex, message) in entry.messages.enumerated() where message.role == "assistant" {
                        transferStreamingStates(entry: entry, messageIndex: messageIndex)
                    }
                }
                streamingStates = [:]
                streamingTimestamp = nil
            default: break
            }
        }
    }

    private func transferStreamingStates(entry: Entry, messageIndex: Int) {
        for blockIndex in entry.messages[messageIndex].blocks.indices {
            if let state = streamingStates["streaming-\(blockIndex)"] {
                states["\(entry.id)-\(messageIndex)-\(blockIndex)"] = state
            }
        }
    }
}

/// One tool call as a sentence ("Ran pnpm test"). Clicking it shows the command or diff and the output.
struct ToolStepRow: View {
    @Environment(\.pilotFonts) private var fonts
    let item: ToolItem
    var active = false
    @StateObject private var expansion: ExpansionState
    @State private var hovered = false

    init(item: ToolItem, active: Bool = false, expansion: ExpansionState? = nil) {
        self.item = item
        self.active = active
        _expansion = StateObject(wrappedValue: expansion ?? ExpansionState())
    }

    var body: some View {
        let summary = item.summary
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(Theme.Motion.quick) { expansion.expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    StepMark(icon: summary.icon.pilotIcon, status: item.status, active: active)
                    StepSentence(verb: summary.verb, subject: summary.subject, failed: item.status == .error,
                                 highlighted: hovered)
                    if summary.additions + summary.deletions > 0 {
                        Text(summary.deletions > 0 ? "+\(summary.additions) −\(summary.deletions)" : "+\(summary.additions)")
                            .font(.pilot(.caption).monospacedDigit())
                            .foregroundStyle(Theme.faintForeground)
                            .fixedSize()
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovered = $0 }
            .help(summary.detail ?? summary.title)
            .accessibilityLabel([summary.verb, summary.subject, item.status == .error ? "failed" : nil]
                .compactMap { $0 }.joined(separator: " "))
            .accessibilityValue(expansion.expanded ? "Expanded" : "Collapsed")

            if expansion.expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if !summary.diffs.isEmpty {
                        ForEach(summary.diffs) { file in
                            VStack(alignment: .leading, spacing: 0) {
                                Text(file.path)
                                    .font(fonts.monoSmall)
                                    .foregroundStyle(Theme.mutedForeground)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Theme.muted)
                                DiffView(file: file, showNumbers: false, maxLines: 300)
                                    .padding(.vertical, 4)
                            }
                            .background(Theme.code)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
                            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border))
                        }
                    } else if let body = summary.body {
                        CodeBlock(language: item.name == "codemode" ? "javascript" : nil, text: body)
                    } else {
                        CodeBlock(language: "arguments", text: item.arguments.prettyPrinted)
                    }
                    if !item.output.isEmpty {
                        OutputBlock(text: item.output, isError: item.status == .error)
                    }
                }
                .padding(.leading, 21)
            }
        }
    }
}

private struct OutputBlock: View {
    @Environment(\.pilotFonts) private var fonts
    let text: String
    let isError: Bool

    var body: some View {
        ScrollView {
            Text(text)
                .font(fonts.mono)
                .foregroundStyle(isError ? Theme.error : Theme.foreground)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
        .frame(maxHeight: 260)
        .background(Theme.code)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border))
    }
}
