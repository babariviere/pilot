import PilotCore
import SwiftUI

/// Consecutive tool calls, as one compact card with a row per call.
struct ToolGroupView: View {
    let items: [ToolItem]
    var expansions: TranscriptToolExpansions? = nil

    var body: some View {
        LazyVStack(spacing: 0) {
            ForEach(items) { item in
                if item.id != items.first?.id { Divider().opacity(0.5) }
                ToolRowView(item: item, expansion: expansions?.state(for: item.id))
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.subtleFill))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.hairline))
    }
}

@MainActor
final class ExpansionState: ObservableObject {
    @Published var expanded = false
}

/// Chat-scoped ownership keeps expansion alive when a group moves between the live tail and
/// committed history. Individual rows still observe only their own expansion changes.
@MainActor
final class TranscriptToolExpansions: ObservableObject {
    private var states: [String: ExpansionState] = [:]

    func state(for callID: String) -> ExpansionState {
        if let state = states[callID] { return state }
        let state = ExpansionState()
        states[callID] = state
        return state
    }
}

struct ToolRowView: View {
    @Environment(\.pilotFonts) private var fonts
    let item: ToolItem
    @StateObject private var expansion = ExpansionState()

    init(item: ToolItem, expansion: ExpansionState? = nil) {
        self.item = item
        _expansion = StateObject(wrappedValue: expansion ?? ExpansionState())
    }

    var body: some View {
        let summary = item.summary
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { expansion.expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    statusIcon.frame(width: 14)
                    Image(systemName: summary.icon)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                    Text(summary.title).font(fonts.chat(fonts.chatSize - 1, weight: .medium))
                    if let detail = summary.detail, !detail.isEmpty {
                        Text(detail)
                            .font(fonts.monoSmall)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 8)
                    if summary.additions + summary.deletions > 0 {
                        DiffStat(additions: summary.additions, deletions: summary.deletions)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expansion.expanded ? 90 : 0))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let artifact = item.artifact {
                ArtifactCard(reference: artifact)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
            }

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
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border))
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
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
        }
    }

    @ViewBuilder private var statusIcon: some View {
        switch item.status {
        case .running:
            ProgressView().controlSize(.mini)
        case .pending:
            Image(systemName: "circle.dotted").font(.system(size: 11)).foregroundStyle(.tertiary)
        case .done:
            Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.green)
        case .error:
            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.red)
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
                .foregroundStyle(isError ? Color.red : Color.primary.opacity(0.85))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
        .frame(maxHeight: 260)
        .background(Color.black.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline))
    }
}
