import PilotCore
import SwiftUI

/// Colored line diff in the code font. Long lines scroll horizontally rather than wrap.
struct DiffView: View {
    let file: FileDiff
    var showNumbers = true
    var maxLines = 600
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        let lines = Array(file.lines.prefix(maxLines))
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    row(line)
                }
                if file.lines.count > maxLines {
                    Text("… \(file.lines.count - maxLines) more lines")
                        .font(fonts.monoSmall)
                        .foregroundStyle(Theme.mutedForeground)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                }
            }
            .frame(minWidth: 0, alignment: .leading)
        }
        .textSelection(.enabled)
    }

    @ViewBuilder private func row(_ line: DiffLine) -> some View {
        HStack(spacing: 0) {
            if showNumbers {
                number(line.oldNumber)
                number(line.newNumber)
            }
            Text(marker(line.kind))
                .frame(width: 16, alignment: .center)
                .foregroundStyle(color(line.kind))
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .hunk || line.kind == .note ? Theme.mutedForeground : Theme.foreground)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.trailing, 12)
        }
        .font(fonts.monoSmall)
        .padding(.vertical, 0.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background(line.kind))
    }

    private func number(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "")
            .frame(width: 34, alignment: .trailing)
            .padding(.trailing, 6)
            .foregroundStyle(Theme.faintForeground)
    }

    private func marker(_ kind: DiffLineKind) -> String {
        switch kind {
        case .addition: "+"
        case .deletion: "−"
        default: ""
        }
    }

    private func color(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .addition: Theme.success
        case .deletion: Theme.destructive
        default: Theme.faintForeground
        }
    }

    private func background(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .addition: Theme.success.opacity(0.10)
        case .deletion: Theme.destructive.opacity(0.09)
        case .hunk: Theme.info.opacity(0.06)
        default: .clear
        }
    }
}

/// "+12 −3" in green and red.
struct DiffStat: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            if additions > 0 { Text("+\(additions)").foregroundStyle(Theme.success) }
            if deletions > 0 { Text("−\(deletions)").foregroundStyle(Theme.destructive) }
        }
        .font(.system(size: 11, weight: .medium).monospacedDigit())
    }
}
