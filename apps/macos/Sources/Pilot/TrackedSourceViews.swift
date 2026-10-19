import AppKit
import PilotCore
import SwiftUI

// Where a chat came from in triage: the Slack message or Linear ticket behind SessionSummary.trackedSource.

extension SessionTrackedSource {
    var mark: PilotMark { kind == .slack ? .slack : .linear }
    var openHelp: String {
        kind == .slack ? "\(summary)\nShow the message in Slack triage" : "\(summary)\nOpen the ticket in Linear"
    }
}

/// The service mark after a sidebar chat's title, so chats started from triage read apart at a glance.
/// Centered on the title's cap height like SessionStatusIcon.
struct TrackedSourceGlyph: View {
    let source: SessionTrackedSource

    var body: some View {
        PilotMarkIcon(mark: source.mark)
            .foregroundStyle(Theme.mutedForeground)
            .alignmentGuide(.firstTextBaseline) { dimensions in
                dimensions[VerticalAlignment.center] + NSFont.systemFont(ofSize: 13).capHeight / 2
            }
            .help(source.summary)
            .accessibilityLabel(source.summary)
    }
}

/// The chat header's source chip: the service mark and the Slack channel or Linear ticket. A Slack message opens
/// selected in its project's triage; a Linear ticket opens in Linear.
struct TrackedSourceBadge: View {
    let source: SessionTrackedSource
    let projectId: String?
    var context: HostViewContext? = nil
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button { model.showTrackedSource(source, projectId: projectId, context: context) } label: {
            HStack(spacing: 4) {
                PilotMarkIcon(mark: source.mark)
                    .accessibilityHidden(true)
                Text(source.label)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 160, alignment: .leading)
            }
            .font(.pilot(.small, weight: .medium))
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.muted))
            .fixedSize()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(source.openHelp)
        .accessibilityLabel(source.summary)
        .accessibilityHint(source.kind == .slack ? "Shows the message in Slack triage" : "Opens the ticket in Linear")
        .contextMenu {
            if source.kind == .slack {
                Button("Show in Slack Triage") { model.showTrackedSource(source, projectId: projectId, context: context) }
            }
            if let url = URL(string: source.url) {
                Button("Open in \(source.serviceName)") { BrowserLinkOpener.shared.open(url) }
            }
        }
    }
}

