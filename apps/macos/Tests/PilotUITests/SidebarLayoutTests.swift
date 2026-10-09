import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private final class SidebarMeasurement {
    var sizes: [CGSize] = []
}

/// Observe the child's actual response to a finite proposal, not a fixed wrapper's width.
private struct SidebarMeasuringLayout: Layout {
    let measurement: SidebarMeasurement

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let size = subviews[0].sizeThatFits(proposal)
        if let width = proposal.width, width > 0, width.isFinite {
            measurement.sizes.append(size)
        }
        return size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews[0].place(at: bounds.origin, anchor: .topLeading, proposal: proposal)
    }
}

@MainActor
private func sidebarMeasuredSizes<V: View>(_ view: V, width: CGFloat) -> [CGSize] {
    let measurement = SidebarMeasurement()
    let hosting = NSHostingView(rootView: SidebarMeasuringLayout(measurement: measurement) { view }
        .frame(width: width, alignment: .leading))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 100),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    window.orderFrontRegardless()
    for _ in 0..<8 {
        hosting.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    return measurement.sizes
}

@Test @MainActor func sidebarRowsAndMetadataRespectNarrowWidthProposals() throws {
    _ = NSApplication.shared
    let suite = "SidebarLayoutTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(projectFolderDefaults: defaults)
    let now = Date().timeIntervalSince1970 * 1000
    let session = SessionSummary(id: "session", title: "A long title that must yield to the timestamp", cwd: "/repository",
                                 branch: "fix/a-very-long-branch-name-for-sidebar-layout", createdAt: now,
                                 updatedAt: now - 14 * 3_600_000, state: "idle", outcome: .done,
                                 pullRequest: SessionPullRequest(number: 12345, url: "https://github.com/example/repo/pull/12345",
                                                                title: "A large change", state: .merged, checkedAt: now), pinned: true)
    let summary = SessionChangeSummary(base: "origin/main", branch: session.branch,
                                       fileCount: 1234, additions: 123456, deletions: 98765)
    model.client.loadFixture(projects: [], sessions: [session])
    model.client.fixtureChangeSummaries = [session.id: summary]
    for sidebarWidth in [230.0, 280.0, 400.0] {
        for indent in [0.0, 20.0] {
            // Native list row insets, plus the extra inset for projects in folders.
            let rowWidth = sidebarWidth - 32 - indent
            for isCoordinator in [false, true] {
                let rows = sidebarMeasuredSizes(
                    SessionRow(session: session, showsMission: !isCoordinator, isCoordinator: isCoordinator)
                        .environmentObject(model), width: rowWidth)
                #expect(!rows.isEmpty)
                #expect(rows.allSatisfy { $0.width <= rowWidth + 0.5 })
                #expect(rows.allSatisfy { $0.height < 60 })
            }
            let metadataWidth = rowWidth - 22 // Status column and spacing.
            let metadata = sidebarMeasuredSizes(
                SessionRepositoryMetadataContent(session: session, summary: summary, branch: session.branch, error: nil),
                width: metadataWidth)
            #expect(!metadata.isEmpty)
            #expect(metadata.allSatisfy { $0.width <= metadataWidth + 0.5 })
            #expect(metadata.allSatisfy { $0.height < 25 })
        }
    }
    // Branch-only rows must truncate rather than disappear or impose their intrinsic width.
    let branchOnly = SessionSummary(id: "branch", title: "Branch", cwd: "/repository", branch: session.branch,
                                    createdAt: now, updatedAt: now, state: "starting")
    let branch = sidebarMeasuredSizes(
        SessionRepositoryMetadataContent(session: branchOnly, summary: nil, branch: branchOnly.branch, error: "Offline"),
        width: 150)
    #expect(!branch.isEmpty)
    #expect(branch.allSatisfy { $0.width <= 150.5 && $0.height > 0 && $0.height < 25 })
}
