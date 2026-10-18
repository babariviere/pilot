import PilotCore
import SwiftUI

/// A list row's second line, built from `RowLineSegment`s: whole segments with a faint dot only between two
/// shown ones, laid out by `RowLineArrangement`. When the segments do not fit, the line fades out at its
/// trailing edge instead of truncating each one, and never grows past the width it is offered. Every segment,
/// including the ones left out, stays in `segments.accessibilityText` for the row's label and tooltip.
///
/// The sidebar keeps it to one line (`maxLines: 1`) and stops it at `RowLine.cornerGutter`, before the dithered
/// corner's dense cells. Home, Inbox and Overview rows have more room and may wrap it to two lines.
struct RowLine: View {
    let segments: [RowLineSegment]
    var maxLines = 1
    /// Home's quieter rows use `.pilot(.caption)`.
    var font: Font = .pilot(.small)
    /// Opens a mission from its segment. Nil where the whole row is one button (Inbox, Overview): the mission is
    /// then plain text and the row's context menu opens it.
    var openMission: ((String) -> Void)?

    /// Trailing room a sidebar row's second line leaves for its dithered corner. The corner keeps a fixed size at
    /// every sidebar width, so this is a constant measured from renders at 230, 280 and 400 pt: the line's
    /// fade sits over the corner's sparse edge, and full-opacity text stops where fewer than a quarter of the
    /// corner's cells are drawn.
    static let cornerGutter: CGFloat = 26

    var body: some View {
        RowLineLayout(maxLines: maxLines) {
            ForEach(Array(segments.enumerated()), id: \.element.id) { index, segment in
                if index > 0 {
                    Text("·").foregroundStyle(Theme.faintForeground)
                        .layoutValue(key: RowLineSeparatorKey.self, value: true)
                        .accessibilityHidden(true)
                }
                RowLineSegmentView(segment: segment, openMission: openMission)
            }
        }
        .font(font)
        .foregroundStyle(Theme.mutedForeground)
        .mask { RowLineFade() }
    }
}

/// Opaque, then clear over the last `RowLineArrangement.fade` points. Text only reaches the fade when the line has
/// more than fits, so short lines are untouched. Masking also clips anything past the line's bounds.
private struct RowLineFade: View {
    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: RowLineArrangement.fade)
        }
    }
}

struct RowLineSeparatorKey: LayoutValueKey {
    static let defaultValue = false
}

/// Places a row line's segments and separators from their natural sizes. It takes the width it is offered (its
/// natural width when unbounded), so it never sets a row's width, and reads no geometry back from its rows.
struct RowLineLayout: Layout {
    var maxLines = 1
    var spacing: CGFloat = 4
    var lineSpacing: CGFloat = 1

    struct Cache {
        /// Natural sizes of the segments, without separators.
        var sizes: [CGSize] = []
        /// Index into the subviews of each segment, and of the separator before it.
        var segmentIndices: [Int] = []
        var separatorIndices: [Int?] = []
        var separatorWidth: CGFloat = 0
        var lineHeight: CGFloat = 0
    }

    func makeCache(subviews: Subviews) -> Cache {
        var cache = Cache()
        var pendingSeparator: Int?
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            cache.lineHeight = max(cache.lineHeight, size.height)
            if subview[RowLineSeparatorKey.self] {
                pendingSeparator = index
                cache.separatorWidth = max(cache.separatorWidth, size.width)
            } else {
                cache.sizes.append(size)
                cache.segmentIndices.append(index)
                cache.separatorIndices.append(pendingSeparator)
                pendingSeparator = nil
            }
        }
        return cache
    }

    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        cache = makeCache(subviews: subviews)
    }

    private func arrange(_ cache: Cache, width: CGFloat) -> [RowLineArrangement.Placement?] {
        RowLineArrangement.arrange(widths: cache.sizes.map(\.width), separatorWidth: cache.separatorWidth,
                                   spacing: spacing, available: width, maxLines: maxLines)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        guard !cache.sizes.isEmpty else { return .zero }
        guard let width = proposal.width, width.isFinite else {
            let natural = RowLineArrangement.naturalWidth(widths: cache.sizes.map(\.width),
                                                          separatorWidth: cache.separatorWidth, spacing: spacing)
            return CGSize(width: natural, height: cache.lineHeight)
        }
        let lines = CGFloat(RowLineArrangement.lineCount(arrange(cache, width: width)))
        return CGSize(width: width, height: lines * cache.lineHeight + (lines - 1) * lineSpacing)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let placements = arrange(cache, width: bounds.width)
        // Left-out segments go well past the masked bounds, where they draw nothing and take no clicks.
        let away = CGPoint(x: bounds.maxX + 10_000, y: bounds.minY)
        for (segment, placement) in placements.enumerated() {
            let index = cache.segmentIndices[segment]
            let separator = cache.separatorIndices[segment]
            guard let placement else {
                subviews[index].place(at: away, proposal: .unspecified)
                if let separator { subviews[separator].place(at: away, proposal: .unspecified) }
                continue
            }
            let midY = bounds.minY + CGFloat(placement.line) * (cache.lineHeight + lineSpacing) + cache.lineHeight / 2
            subviews[index].place(at: CGPoint(x: bounds.minX + placement.x, y: midY), anchor: .leading,
                                  proposal: ProposedViewSize(cache.sizes[segment]))
            if let separator {
                if let x = placement.separatorX {
                    subviews[separator].place(at: CGPoint(x: bounds.minX + x, y: midY), anchor: .leading,
                                              proposal: .unspecified)
                } else {
                    subviews[separator].place(at: away, proposal: .unspecified)
                }
            }
        }
    }
}

/// One segment, drawn whole at its natural width.
private struct RowLineSegmentView: View {
    let segment: RowLineSegment
    let openMission: ((String) -> Void)?

    var body: some View {
        content
            .lineLimit(1)
            .fixedSize()
    }

    @ViewBuilder private var content: some View {
        switch segment.kind {
        case let .project(name):
            Text(name).fontWeight(.medium)
        case let .ask(source):
            HStack(spacing: 3) {
                PilotSymbol(PilotIcon.askMode)
                Text("Ask · \(source)")
            }
            .fontWeight(.medium)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(segment.accessibilityText)
            .help("Read-only · no isolated workspace")
        case .diagnostics:
            HStack(spacing: 3) {
                PilotSymbol(PilotIcon.bug)
                Text("Diagnostics")
            }
            .fontWeight(.medium)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(segment.accessibilityText)
            .help("Read-only diagnostics · no isolated workspace")
        case .coordinator:
            HStack(spacing: 3) {
                PilotSymbol(PilotIcon.coordinator)
                Text("Coordinator").fontWeight(.semibold)
            }
            .foregroundStyle(Theme.warning)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Coordinator")
        case let .reason(text):
            Text(text)
        case let .pullRequest(pr, stale):
            PullRequestLink(pullRequest: pr, stale: stale)
        case let .dashboardPullRequest(pr):
            InboxPullRequestMark(pr: pr)
        case .pullRequestUnavailable:
            PilotSymbol(PilotIcon.warning)
                .accessibilityLabel(segment.accessibilityText)
        case let .mission(id, title):
            if let id, let openMission {
                Button { openMission(id) } label: { missionLabel(title).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .help("Open mission: \(title)")
                    .accessibilityLabel("Open mission \(title)")
            } else {
                missionLabel(title)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(segment.accessibilityText)
            }
        case let .branch(name):
            Text(name).fontWeight(.medium).accessibilityLabel(segment.accessibilityText)
        case let .text(text):
            Text(text)
        case let .draft(draft):
            HStack(spacing: 3) {
                PilotSymbol(PilotIcon.unsentDraft)
                Text(draft.preview)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(segment.accessibilityText)
        }
    }

    private func missionLabel(_ title: String) -> some View {
        HStack(spacing: 3) {
            PilotSymbol(PilotIcon.mission)
            Text(title)
        }
        .fontWeight(.medium)
    }
}
