import PilotCore
import SwiftUI

/// Compact mode context, kept visible for Ask sessions without a Changes pane.
struct SessionContextBadge: View {
    let session: SessionSummary

    var body: some View {
        ViewThatFits(in: .horizontal) {
            context(longTitle)
            context(shortTitle)
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
        .help(help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private func context(_ title: String) -> some View {
        HStack(spacing: 5) {
            PilotSymbol(icon)
                .accessibilityHidden(true)
            Text(title)
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private var shortTitle: String {
        session.isDiagnosticsSpecialist ? "Diagnostics" : session.isAsk ? "Ask" : "Build"
    }
    private var longTitle: String {
        session.isDiagnosticsSpecialist ? "Diagnostics · Read-only" : session.isAsk ? "Ask · Read-only" : session.workspaceLabel
    }
    private var icon: PilotIcon {
        session.isDiagnosticsSpecialist ? .bug : session.isAsk ? .askMode : .buildMode
    }
    private var help: String {
        let role = session.isDiagnosticsSpecialist ? "Read-only diagnostics" : session.workspaceLabel
        return "\(role)\n\(session.workspaceHelp)"
    }
    private var accessibilityLabel: String {
        "\(shortTitle) · \(session.workspaceLabel)"
    }
}
