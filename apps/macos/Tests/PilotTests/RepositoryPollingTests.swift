import Foundation
import Testing
@testable import Pilot

@Test func repositoryPollingPausesHiddenOccludedAndMinimizedWindows() {
    #expect(RepositoryPolling.visible(appHidden: false, windowVisible: true, miniaturized: false, occluded: false))
    #expect(!RepositoryPolling.visible(appHidden: true, windowVisible: true, miniaturized: false, occluded: false))
    #expect(!RepositoryPolling.visible(appHidden: false, windowVisible: false, miniaturized: false, occluded: false))
    #expect(!RepositoryPolling.visible(appHidden: false, windowVisible: true, miniaturized: true, occluded: false))
    #expect(!RepositoryPolling.visible(appHidden: false, windowVisible: true, miniaturized: false, occluded: true))
}

@Test func repositoryPollingKeepsActiveCadenceButBacksOffIdleWorkspaces() {
    #expect(RepositoryPolling.interval(working: true, fullDiff: false) == 10)
    #expect(RepositoryPolling.interval(working: false, fullDiff: false) == 60)
    #expect(RepositoryPolling.interval(working: true, fullDiff: true) == 4)
    #expect(RepositoryPolling.interval(working: false, fullDiff: true) == 30)
}

@Test func repositoryPollingRefreshesOnReturnAndActivityNotQuotaUpdates() {
    let idle = RepositoryPollingKey(visible: true, state: "idle", updatedAt: 1)
    #expect(idle.enabled)
    let hidden = RepositoryPollingKey(visible: false, state: "idle", updatedAt: 1)
    #expect(!hidden.enabled)
    #expect(hidden != idle) // Returning restarts the task with an immediate read.
    #expect(!RepositoryPollingKey(visible: true, state: "starting", updatedAt: 1).enabled)
    #expect(RepositoryPollingKey(visible: true, state: "working", updatedAt: 1) != idle)
    #expect(RepositoryPollingKey(visible: true, state: "idle", updatedAt: 2) != idle)
    #expect(RepositoryPollingKey(visible: true, state: "idle", updatedAt: 1) == idle)
}
