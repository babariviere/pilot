import Foundation
import Testing
@testable import PilotCore

private let mac = HostRef(hostId: "local", daemonId: "d-mac", lineageId: "l1")
private let devbox = HostRef(hostId: "devbox", daemonId: "d-box", lineageId: "l1")
private let spare = HostRef(hostId: "spare", daemonId: "d-spare", lineageId: "l1")

private func needs(_ kind: DashboardNeedsYouKind, _ id: String, at: Double, project: String = "p1") -> InboxNeedsYouItem {
    InboxNeedsYouItem(projectId: project, item: DashboardNeedsYouItem(kind: kind, id: id, title: id, at: at))
}
private func ready(_ url: String, checkedAt: Double, project: String = "p1") -> InboxReadyToMergeItem {
    InboxReadyToMergeItem(projectId: project, pullRequest: DashboardPullRequest(
        number: 1, url: url, title: url, sessionId: "s", sessionTitle: "s", checkedAt: checkedAt,
        readiness: DashboardPullRequestReadiness(state: .ready)))
}
private func linear(_ id: String, started: Bool = false, priority: Double? = nil, updated: Double = 1) -> TrackedItem {
    var metadata: [String: JSONValue] = ["statusType": .string(started ? "started" : "unstarted")]
    if let priority { metadata["priority"] = .number(priority) }
    return TrackedItem(id: id, projectId: "p1", kind: .linear, externalId: id, title: id, url: "https://x/\(id)",
                       status: "open", metadata: metadata, createdAt: 1, updatedAt: updated)
}
private func slack(_ id: String, _ severity: SlackSeverity, override: SlackSeverity? = nil, updated: Double = 1) -> TrackedItem {
    TrackedItem(id: id, projectId: "p1", kind: .slack, externalId: id, title: id, url: "https://x/\(id)", status: "open",
                slack: SlackTriage(type: .bug, severity: severity, status: .open, overrides: SlackOverrides(severity: override)),
                createdAt: 1, updatedAt: updated)
}
private func inbox(needs: [InboxNeedsYouItem] = [], needsTotal: Int? = nil, ready: [InboxReadyToMergeItem] = [],
                   linear: [TrackedItem]? = nil, linearTotal: Int? = nil, slack: [TrackedItem]? = nil,
                   slackTotal: Int? = nil, hidden: [InboxHiddenLabel] = []) -> Inbox {
    Inbox(needsYou: DashboardSection(total: needsTotal ?? needs.count, items: needs),
          readyToMerge: DashboardSection(total: ready.count, items: ready),
          linear: linear.map { DashboardSection(total: linearTotal ?? $0.count, items: $0) },
          slack: slack.map { InboxSlackSection(total: slackTotal ?? $0.count, items: $0, hidden: hidden) })
}

@Test func aNewerUnreadResultNeverOutranksAFailureOrQuestionBecauseOfItsID() {
    // "a" sorts before every other ID, and the unread row is the newest. The old ID-only order put it first.
    let page = UnifiedInboxPresentation([
        mac: inbox(needs: [needs(.unread, "a-unread", at: 900), needs(.failed, "z-failed", at: 1)]),
        devbox: inbox(needs: [needs(.question, "b-question", at: 5), needs(.scheduledFailed, "c-sched", at: 800)]),
    ])
    #expect(page.needsYou.rows.map(\.value.item.id) == ["z-failed", "b-question", "c-sched", "a-unread"])
    #expect(page.needsYou.total == 4)
}

@Test func needsYouFollowsTheDaemonRankThenNewestThenStableTieBreaks() {
    let kinds: [DashboardNeedsYouKind] = [.failed, .question, .scheduledFailed, .toolStall, .longJob, .mcp, .prStuck, .unread]
    let rows = kinds.reversed().map { needs($0, $0.rawValue, at: 1) }
    let page = UnifiedInboxPresentation([mac: inbox(needs: rows)])
    #expect(page.needsYou.rows.map(\.value.item.kind) == kinds)
    // Same kind: newest first; same time: project, then local ID, then host.
    let ties = UnifiedInboxPresentation([
        devbox: inbox(needs: [needs(.failed, "x", at: 5), needs(.failed, "x", at: 9, project: "p2")]),
        mac: inbox(needs: [needs(.failed, "x", at: 5), needs(.failed, "w", at: 5, project: "p2")]),
    ])
    #expect(ties.needsYou.rows.map { "\($0.ref.host.hostId):\($0.value.projectId):\($0.value.item.id)" }
        == ["devbox:p2:x", "devbox:p1:x", "local:p1:x", "local:p2:w"])
}

@Test func shuffledHostArrivalProducesTheSameOrderInEverySection() {
    let one = inbox(needs: [needs(.unread, "same", at: 3), needs(.failed, "same", at: 2)], ready: [ready("u1", checkedAt: 4)],
                    linear: [linear("L1", priority: 2), linear("L2", started: true, priority: 4)],
                    slack: [slack("S1", .low), slack("S2", .high)], hidden: [InboxHiddenLabel(label: "Ops", count: 1)])
    let two = inbox(needs: [needs(.unread, "same", at: 3), needs(.failed, "same", at: 2)], ready: [ready("u1", checkedAt: 4)],
                    linear: [linear("L1", priority: 2), linear("L2", started: true, priority: 4)],
                    slack: [slack("S1", .low), slack("S2", .high)], hidden: [InboxHiddenLabel(label: "Ops", count: 2)])
    let three = inbox(needs: [needs(.unread, "same", at: 3)], slack: [slack("S1", .low)])
    let pairs = [(mac, one), (devbox, two), (spare, three)]
    func fingerprint(_ page: UnifiedInboxPresentation) -> [String] {
        page.needsYou.rows.map { "n \($0.ref.storageKey)" } + page.readyToMerge.rows.map { "r \($0.ref.storageKey)" }
            + page.linear.rows.map { "l \($0.ref.storageKey)" } + page.slack.rows.map { "s \($0.ref.storageKey)" }
            + page.hidden.map { "h \($0.label) \($0.count)" }
    }
    let expected = fingerprint(UnifiedInboxPresentation(Dictionary(uniqueKeysWithValues: pairs)))
    let orders: [[Int]] = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2], [0, 2, 1], [2, 0, 1]]
    for order in orders {
        var shuffled: [HostRef: Inbox] = [:]
        for index in order { shuffled[pairs[index].0] = pairs[index].1 }
        #expect(fingerprint(UnifiedInboxPresentation(shuffled)) == expected)
    }
}

@Test func sameLocalIDsOnTwoHostsStayTwoHostQualifiedRows() {
    let page = UnifiedInboxPresentation([
        mac: inbox(needs: [needs(.failed, "session:1", at: 5)], ready: [ready("https://github.com/o/r/pull/1", checkedAt: 1)],
                   linear: [linear("t1")]),
        devbox: inbox(needs: [needs(.failed, "session:1", at: 5)], ready: [ready("https://github.com/o/r/pull/1", checkedAt: 1)],
                      linear: [linear("t1")]),
    ])
    for hosts in [page.needsYou.rows.map(\.ref.host), page.readyToMerge.rows.map(\.ref.host), page.linear.rows.map(\.ref.host)] {
        #expect(hosts == [devbox, mac], "hosts never merge, and ties fall to the host identity")
    }
    #expect(Set(page.needsYou.rows.map(\.id)).count == 2, "ForEach identity includes the owning host")
    #expect(page.needsYou.rows.allSatisfy { $0.ref.localId == $0.value.id && $0.ref.kind == .project })
    #expect(page.needsYou.total == 2 && page.readyToMerge.total == 2 && page.linear.total == 2)
    // Lineage is part of the identity: a re-enrolled host is not the old one.
    let rebuilt = HostRef(hostId: mac.hostId, daemonId: mac.daemonId, lineageId: "l2")
    let both = UnifiedInboxPresentation([mac: inbox(needs: [needs(.failed, "x", at: 1)]), rebuilt: inbox(needs: [needs(.failed, "x", at: 1)])])
    #expect(Set(both.needsYou.rows.map(\.ref.host)) == [mac, rebuilt])
}

@Test func readyToMergeAndTrackedSectionsUseTheDaemonOrderAcrossHosts() {
    let page = UnifiedInboxPresentation([
        mac: inbox(ready: [ready("https://a", checkedAt: 1), ready("https://c", checkedAt: 9)],
                   linear: [linear("L-low", priority: 4, updated: 9), linear("L-started", started: true, priority: 4, updated: 1)],
                   slack: [slack("S-new-low", .low, updated: 9), slack("S-old-high", .high, updated: 1)]),
        devbox: inbox(ready: [ready("https://b", checkedAt: 9)],
                      linear: [linear("L-urgent", priority: 1, updated: 1), linear("L-none", updated: 99)],
                      slack: [slack("S-crit-by-override", .low, override: .critical, updated: 0)]),
    ])
    #expect(page.readyToMerge.rows.map(\.value.pullRequest.url) == ["https://b", "https://c", "https://a"])
    #expect(page.linear.rows.map(\.value.id) == ["L-started", "L-urgent", "L-low", "L-none"])
    #expect(page.slack.rows.map(\.value.id) == ["S-crit-by-override", "S-old-high", "S-new-low"])
}

@Test func cappedHostsKeepHonestTotalsAndExplainTheCap() {
    let rows = (0..<50).map { needs(.unread, "u\($0)", at: Double($0)) }
    let page = UnifiedInboxPresentation([
        mac: inbox(needs: rows, needsTotal: 72, linear: [linear("L1")], linearTotal: 130, slack: [], slackTotal: 0),
        devbox: inbox(needs: [needs(.failed, "f", at: 1)], slack: [slack("S", .low)], slackTotal: 3),
    ])
    #expect(page.needsYou.total == 73 && page.needsYou.rows.count == 51 && page.needsYou.hiddenCount == 22)
    #expect(page.needsYou.rows.first?.value.item.id == "f", "a failure on the second host still leads")
    #expect(page.linear.total == 130 && page.linear.hiddenCount == 129)
    #expect(page.slack.total == 3 && page.slack.rows.count == 1)
    #expect(UnifiedInboxPresentation.capNote(shown: 51, total: 73) == "Showing 51 of 73. Filter by project to see the rest.")
    #expect(UnifiedInboxPresentation.capNote(shown: 5, total: 5) == nil)
    #expect(!page.isEmpty)
}

@Test func hostsWithoutRowsStillCountAndAnEmptyInboxIsEmpty() {
    #expect(UnifiedInboxPresentation([:]).isEmpty)
    #expect(UnifiedInboxPresentation([mac: Inbox(), devbox: Inbox()]).isEmpty)
    // A total with no rows sent is still something waiting.
    let counted = UnifiedInboxPresentation([mac: inbox(needs: [], needsTotal: 4)])
    #expect(!counted.isEmpty && counted.needsYou.total == 4 && counted.needsYou.hiddenCount == 4)
}

@Test func hiddenSlackLabelsAreSummedAcrossHostsWithoutMixingClosedAndHidden() {
    let page = UnifiedInboxPresentation([
        mac: inbox(slack: [], hidden: [InboxHiddenLabel(label: "Ops", count: 1), InboxHiddenLabel(label: "Ops", count: 2, closed: true)]),
        devbox: inbox(slack: [], hidden: [InboxHiddenLabel(label: "Ops", count: 3)]),
    ])
    #expect(page.hidden == [InboxHiddenLabel(label: "Ops", count: 4), InboxHiddenLabel(label: "Ops", count: 2, closed: true)])
    #expect(InboxText.hiddenFooter(page.hidden) == "Hidden: 4 Slack messages labelled Ops. Closed: 2 labelled Ops.")
}

@Test func anUnreachableHostSaysWhetherItsRowsAreLastKnown() {
    #expect(UnifiedInboxPresentation.unavailableNote(host: "devbox", hasLastKnownRows: true)
        == "Can't reach devbox. Its rows here are as of the last check. Reconnect to refresh.")
    #expect(UnifiedInboxPresentation.unavailableNote(host: "devbox", hasLastKnownRows: false).hasPrefix("Reconnect to devbox"))
    // A host's last-known rows keep their urgency while another host answers.
    let page = UnifiedInboxPresentation([mac: inbox(needs: [needs(.unread, "u", at: 9)]), devbox: inbox(needs: [needs(.failed, "f", at: 1)])])
    #expect(page.needsYou.rows.map(\.ref.host) == [devbox, mac])
}

@Test func removedHostsLoseRowsAndFailureMarkersButOfflineHostsKeepLastKnownRows() {
    let rows = [mac: inbox(needs: [needs(.failed, "m", at: 1)]), devbox: inbox(needs: [needs(.failed, "d", at: 1)])]
    // spare failed its first read (a marker, no rows) and was then removed; devbox is saved but offline.
    let kept = UnifiedInboxPresentation.retained(values: rows, errors: [spare, devbox], known: [mac, devbox])
    #expect(kept.errors == [devbox], "a removed host's failure marker never outlives it, with or without rows")
    #expect(Set(kept.values.keys) == [mac, devbox], "an offline saved host keeps its last-known rows")
    // Removing a host that has rows drops them too.
    let removed = UnifiedInboxPresentation.retained(values: rows, errors: [], known: [mac])
    #expect(Set(removed.values.keys) == [mac] && removed.errors.isEmpty)
    #expect(UnifiedInboxPresentation(removed.values).needsYou.rows.map(\.ref.host) == [mac])
}
