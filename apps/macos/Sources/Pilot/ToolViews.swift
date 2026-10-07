import PilotCore
import SwiftUI

/// Consecutive tool calls, as one compact card with a row per call.
struct ToolGroupView: View {
    let items: [ToolItem]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { Divider().opacity(0.5) }
                ToolRowView(item: item)
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

struct ToolRowView: View {
    @Environment(\.pilotFonts) private var fonts
    let item: ToolItem
    @StateObject private var expansion = ExpansionState()

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

            if expansion.expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if let body = summary.body {
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
