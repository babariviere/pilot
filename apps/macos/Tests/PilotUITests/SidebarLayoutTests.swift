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
    let member = SessionSummary(id: "member", title: session.title, cwd: "/repository", branch: session.branch,
                                createdAt: now, updatedAt: now, state: "idle", pullRequest: session.pullRequest,
                                missionId: "mission")
    let coordinator = SessionSummary(id: "coordinator", title: session.title, cwd: "/repository", createdAt: now,
                                     updatedAt: now, state: "idle", outcome: .question, outcomeAt: now,
                                     outcomeReason: "Should I start every unblocked task in the sidebar milestone now?",
                                     missionId: "mission", activeMissionCoordinator: true)
    let missionJSON = """
    [{"mission":{"id":"mission","projectId":"p","title":"A mission with a long title that has to truncate",
      "goal":"","status":"active","coordinatorSessionId":"coordinator","briefRevision":0,"createdAt":1,"updatedAt":1},
      "decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]}]
    """
    model.client.loadFixture(projects: [], sessions: [session, member, coordinator])
    model.client.loadMissionFixture(try JSONDecoder().decode([MissionDetail].self, from: Data(missionJSON.utf8)))
    model.client.fixtureChangeSummaries = [session.id: summary, member.id: summary]
    for sidebarWidth in [230.0, 280.0, 400.0] {
        for indent in [0.0, 20.0] {
            // Native list row insets, plus the extra inset for projects in folders.
            let rowWidth = sidebarWidth - 32 - indent
            for row in [session, member, coordinator] {
                let rows = sidebarMeasuredSizes(SessionRow(session: row).environmentObject(model), width: rowWidth)
                #expect(!rows.isEmpty)
                #expect(rows.allSatisfy { $0.width <= rowWidth + 0.5 })
                #expect(rows.allSatisfy { $0.height < 60 })
            }
            let lineWidth = rowWidth - RowLine.cornerGutter
            let segments = RowLineSegments.session(member, projectName: "A project with a long name",
                                                   missionId: "mission", missionTitle: "A mission with a long title",
                                                   reason: "Not reviewed: finished 4m ago", branch: member.branch)
            let line = sidebarMeasuredSizes(RowLine(segments: segments).environmentObject(model), width: lineWidth)
            #expect(!line.isEmpty)
            // One line that never widens the row, however much it holds.
            #expect(line.allSatisfy { $0.width <= lineWidth + 0.5 })
            #expect(line.allSatisfy { $0.height < 25 })
            let wrapped = sidebarMeasuredSizes(RowLine(segments: segments, maxLines: 2).environmentObject(model),
                                               width: lineWidth)
            #expect(wrapped.allSatisfy { $0.width <= lineWidth + 0.5 && $0.height < 45 })
        }
    }
    // A branch-only line keeps its branch whole at its natural width when unbounded, and fills a bounded proposal.
    let branchOnly = RowLine(segments: [RowLineSegment(.branch(session.branch ?? ""))])
    let branch = sidebarMeasuredSizes(branchOnly, width: 150)
    #expect(!branch.isEmpty)
    #expect(branch.allSatisfy { $0.width <= 150.5 && $0.height > 0 && $0.height < 25 })
}

@Test @MainActor func activeCoordinatorRowRetainsUnreadWithMergedPRAtNarrowWidths() throws {
    _ = NSApplication.shared
    let suite = "CoordinatorSidebarLayoutTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(projectFolderDefaults: defaults)
    let now = Date().timeIntervalSince1970 * 1000
    for state in ["idle", "working"] {
        let session = SessionSummary(id: UUID().uuidString, title: "Coordinate ongoing work", cwd: "/repository",
                                     createdAt: now, updatedAt: now, state: state, outcome: .done, outcomeAt: now,
                                     pullRequest: SessionPullRequest(number: 1, url: "https://github.com/example/repo/pull/1",
                                                                    title: "Merged work", state: .merged, checkedAt: now),
                                     activeMissionCoordinator: true)
        #expect(model.isUnread(session) == (state == "idle"))
        let sizes = sidebarMeasuredSizes(SessionRow(session: session).environmentObject(model), width: 178)
        #expect(!sizes.isEmpty)
        #expect(sizes.allSatisfy { $0.width <= 178.5 && $0.height < 60 })
    }
}
