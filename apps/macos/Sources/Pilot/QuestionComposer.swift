import PilotCore
import SwiftUI

/// Replaces the composer while the agent waits on an ask_user question.
///
/// Number keys highlight an answer (or tick it, for multi-select) and Return sends, so a stray key never answers.
/// 0 moves to the reply field, Escape returns to the answers. The reply field shares the composer's draft, so text
/// typed before the question stays, and text typed here returns to the composer if the question goes away.
struct QuestionComposer: View {
    let question: AgentQuestion
    @ObservedObject var draft: ComposerDraftState
    /// Sends the reply as the next user message. Throws to keep the question open.
    let onSend: (String) async throws -> Void

    @Environment(\.pilotFonts) private var fonts
    @State private var highlighted: Int?
    @State private var selected: Set<Int> = []
    @State private var sending = false
    @State private var error: String?
    @State private var replyFocus = UUID()
    @FocusState private var choicesFocused: Bool

    private var options: [AgentQuestion.Option] { question.options }

    var body: some View {
        VStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                header
                if !options.isEmpty { choices }
                reply
                hints
            }
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(Theme.tray)
                    .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
            )
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border))
            if let error {
                Text(error).font(.caption).foregroundStyle(Theme.destructive)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: Theme.column)
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .padding(.top, 6)
        .frame(maxWidth: .infinity)
        .onAppear {
            if options.isEmpty { replyFocus = UUID() } else { choicesFocused = true }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "questionmark.bubble.fill")
                .font(.pilot(.label))
                .foregroundStyle(Theme.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(question.question)
                    .font(.pilot(.headline, weight: .semibold))
                    .foregroundStyle(Theme.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if let context = question.context {
                    Text(context)
                        .font(.pilot(.label))
                        .foregroundStyle(Theme.mutedForeground)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 8)
            if question.multiSelect {
                Text("Pick any")
                    .font(.pilot(.small, weight: .medium))
                    .foregroundStyle(Theme.mutedForeground)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Theme.muted))
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Agent question: \(question.question)")
    }

    private var choices: some View {
        VStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                QuestionOptionRow(
                    number: index + 1, option: option, multiSelect: question.multiSelect,
                    highlighted: highlighted == index, checked: selected.contains(index)
                ) {
                    choicesFocused = true
                    pick(index)
                }
            }
        }
        .padding(.horizontal, 6)
        .focusable()
        .focused($choicesFocused)
        .focusEffectDisabled()
        .onKeyPress(phases: .down, action: handleChoiceKey)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(question.multiSelect ? "Answers, pick any" : "Answers")
    }

    private var reply: some View {
        HStack(alignment: .center, spacing: 10) {
            if !options.isEmpty {
                QuestionKeyCap(key: "0", strong: !choicesFocused)
            }
            ZStack(alignment: .topLeading) {
                if draft.draft.isEmpty {
                    Text("Reply in your own words…")
                        .font(fonts.body)
                        .foregroundStyle(Theme.faintForeground)
                        .allowsHitTesting(false)
                }
                ChatTextEditor(
                    text: $draft.draft, height: $draft.height, font: fonts.nsBody, maxLines: 6,
                    focusOnAppear: false, focusToken: replyFocus,
                    onCancel: options.isEmpty ? nil : { choicesFocused = true },
                    completionDirectory: nil
                ) { _ in send(fromChoices: false) }
                    .frame(height: draft.height)
            }
            Button { send(fromChoices: choicesFocused) } label: {
                if sending {
                    ProgressView().controlSize(.small).tint(.white)
                } else {
                    Image(systemName: "arrow.up")
                }
            }
            .buttonStyle(CircleIconButtonStyle())
            .disabled(sending || reply(fromChoices: choicesFocused) == nil)
            .help("Send reply (↩)")
            .accessibilityLabel("Send reply")
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .card(radius: 10)
        .padding(.horizontal, 10)
        .padding(.top, options.isEmpty ? 0 : 8)
    }

    private var hints: some View {
        HStack(spacing: 14) {
            if choicesFocused {
                KeyHint(key: "1–\(options.count)", label: question.multiSelect ? "tick" : "highlight")
                KeyHint(key: "↑↓", label: "move")
                KeyHint(key: "↩", label: question.multiSelect ? "send ticked" : "send")
                KeyHint(key: "0", label: "write")
            } else {
                KeyHint(key: "↩", label: "send")
                KeyHint(key: "⇧↩", label: "new line")
                if !options.isEmpty { KeyHint(key: "esc", label: "back to answers") }
            }
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: - Actions

    private func handleChoiceKey(_ press: KeyPress) -> KeyPress.Result {
        guard press.modifiers.isDisjoint(with: [.command, .control, .option]) else { return .ignored }
        switch press.key {
        case .upArrow:
            move(by: -1)
            return .handled
        case .downArrow:
            move(by: 1)
            return .handled
        case .return:
            send(fromChoices: true)
            return .handled
        case .space:
            if question.multiSelect, let highlighted { toggle(highlighted) }
            return .handled
        default:
            break
        }
        guard let digit = press.characters.first?.wholeNumberValue, press.characters.count == 1 else { return .ignored }
        if digit == 0 {
            replyFocus = UUID()
            return .handled
        }
        guard options.indices.contains(digit - 1) else { return .ignored }
        pick(digit - 1)
        return .handled
    }

    private func pick(_ index: Int) {
        highlighted = index
        if question.multiSelect { toggle(index) }
    }

    private func toggle(_ index: Int) {
        if selected.contains(index) { selected.remove(index) } else { selected.insert(index) }
    }

    private func move(by step: Int) {
        guard !options.isEmpty else { return }
        let start = highlighted ?? (step > 0 ? -1 : options.count)
        highlighted = min(max(start + step, 0), options.count - 1)
    }

    /// What Return or the send button sends. Single choice: the highlighted answer from the answers, the reply text
    /// from the field. Multi-select: the ticked answers plus any text.
    private func reply(fromChoices: Bool) -> (message: String, usesDraft: Bool)? {
        let text = draft.draft
        if question.multiSelect {
            guard let message = question.reply(selected: Array(selected), text: text) else { return nil }
            return (message, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        if fromChoices, let highlighted, let message = question.reply(selected: [highlighted], text: "") {
            return (message, false)
        }
        if let message = question.reply(selected: [], text: text) { return (message, true) }
        if let highlighted, let message = question.reply(selected: [highlighted], text: "") { return (message, false) }
        return nil
    }

    private func send(fromChoices: Bool) {
        guard !sending, let reply = reply(fromChoices: fromChoices) else { return }
        sending = true
        error = nil
        Task {
            do {
                try await onSend(reply.message)
                if reply.usesDraft { draft.draft = "" }
                // Stay busy: the tray leaves once the reply reaches the transcript.
            } catch {
                self.error = error.localizedDescription
                sending = false
            }
        }
    }
}

/// One numbered answer. Single choice shows the number and highlights; multi-select shows a checkbox.
private struct QuestionOptionRow: View {
    let number: Int
    let option: AgentQuestion.Option
    let multiSelect: Bool
    let highlighted: Bool
    let checked: Bool
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if multiSelect {
                    QuestionCheckCap(key: "\(number)", checked: checked)
                } else {
                    QuestionKeyCap(key: "\(number)", strong: highlighted)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(option.label)
                            .font(.pilot(.body, weight: .medium))
                            .foregroundStyle(Theme.foreground)
                            .fixedSize(horizontal: false, vertical: true)
                        if option.suggested {
                            Text("Suggested")
                                .font(.pilot(.small, weight: .medium))
                                .foregroundStyle(Theme.mutedForeground)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Theme.muted))
                        }
                    }
                    if let detail = option.detail {
                        Text(detail)
                            .font(.pilot(.caption))
                            .foregroundStyle(Theme.mutedForeground)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                if highlighted && !multiSelect {
                    KeyHint(key: "↩", label: "send")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(
                highlighted ? Theme.selected : hovered ? Theme.muted : .clear
            ))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .focusable(false)
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .accessibilityLabel(option.label)
        .accessibilityValue(option.detail ?? "")
        .accessibilityHint(multiSelect ? "Press \(number) to tick" : "Press \(number) to highlight, then Return to send")
        .accessibilityAddTraits(highlighted || checked ? .isSelected : [])
    }
}

/// Number key cap for answers. Dark when it is the active choice.
private struct QuestionKeyCap: View {
    let key: String
    let strong: Bool

    var body: some View {
        Text(key)
            .font(.pilot(.small, weight: .semibold).monospacedDigit())
            .foregroundStyle(strong ? Color.white : Theme.mutedForeground)
            .frame(width: 18, height: 18)
            .background(RoundedRectangle(cornerRadius: 5).fill(strong ? Theme.primary : Theme.card))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(strong ? Color.clear : Theme.border))
            .accessibilityHidden(true)
    }
}

/// Checkbox for multi-select answers, showing its number key until ticked.
private struct QuestionCheckCap: View {
    let key: String
    let checked: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 5).fill(checked ? Theme.primary : Theme.card)
            RoundedRectangle(cornerRadius: 5).strokeBorder(checked ? Color.clear : Theme.border)
            if checked {
                Image(systemName: "checkmark").font(.pilot(.micro, weight: .bold)).foregroundStyle(.white)
            } else {
                Text(key).font(.pilot(.small, weight: .semibold).monospacedDigit()).foregroundStyle(Theme.mutedForeground)
            }
        }
        .frame(width: 18, height: 18)
        .accessibilityHidden(true)
    }
}

/// The record of a question in the transcript. The reply follows as a user message.
struct QuestionRow: View {
    let question: AgentQuestion

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "questionmark.bubble")
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.mutedForeground)
                    .accessibilityHidden(true)
                Text(question.question)
                    .font(.pilot(.body, weight: .medium))
                    .foregroundStyle(Theme.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if !question.options.isEmpty {
                Text(question.options.map(\.label).joined(separator: " · "))
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(2)
                    .padding(.leading, 18)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Agent asked: \(question.question)")
    }
}
