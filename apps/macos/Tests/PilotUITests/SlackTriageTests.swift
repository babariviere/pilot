import Foundation
import PilotCore
import Testing
@testable import Pilot

private let now = Date(timeIntervalSince1970: 1_791_900_000)
private let ms = now.timeIntervalSince1970 * 1000
private let hour = 3_600_000.0

private func message(_ id: String, _ type: SlackMessageType = .bug, _ severity: SlackSeverity = .medium,
                     label: String? = nil, status: SlackLocalStatus = .open, channel: String = "C1",
                     ago: Double = hour, title: String? = nil, replies: Int? = nil,
                     overrides: SlackOverrides = .init()) -> TrackedItem {
    var metadata: [String: JSONValue] = ["channel": .string(channel), "channelName": .string(channel == "C1" ? "bugs" : "support")]
    if let replies { metadata["replies"] = .number(Double(replies)) }
    return TrackedItem(id: id, projectId: "p", kind: .slack, externalId: "\(channel)/\(id)", title: title ?? "Message \(id)",
                       url: "https://example.slack.com/archives/\(channel)/p1", status: "open", metadata: metadata,
                       dismissed: status == .dismissed,
                       slack: SlackTriage(type: type, label: label, severity: severity, status: status, overrides: overrides),
                       createdAt: ms - ago, updatedAt: ms - ago)
}

@Test func triageListsBySeverityThenNewestAndAppliesFilters() {
    let items = [
        message("low", .question, .low, ago: hour),
        message("old-high", .bug, .high, ago: 5 * hour),
        message("new-high", .bug, .high, ago: 2 * hour),
        message("critical", .request, .critical, ago: 9 * hour),
        message("hidden", .request, .medium, label: "Product"),
        message("billing", .bug, .medium, label: "Billing", channel: "C2", title: "Invoice VAT is wrong"),
        message("gone", .bug, .critical, status: .dismissed),
    ]
    let hidden: Set<String> = ["Product"]
    let ids = { (filter: SlackTriageText.Filter, dismissed: Bool) in
        SlackTriageText.visible(items, filter: filter, hidden: hidden, showDismissed: dismissed).map(\.id)
    }
    #expect(ids(.init(), false) == ["critical", "new-high", "old-high", "billing", "low"])
    // Same severity and age: ordered by id.
    #expect(ids(.init(showHidden: true), false) == ["critical", "new-high", "old-high", "billing", "hidden", "low"])
    #expect(ids(.init(), true).first == "gone")
    #expect(ids(.init(type: .bug), false) == ["new-high", "old-high", "billing"])
    #expect(ids(.init(label: .named("Billing")), false) == ["billing"])
    #expect(ids(.init(label: .none), false) == ["critical", "new-high", "old-high", "low"])
    #expect(ids(.init(channel: "C2"), false) == ["billing"])
    #expect(ids(.init(query: " vat "), false) == ["billing"])
    #expect(ids(.init(query: "#support"), false) == ["billing"])
    #expect(SlackTriageText.hiddenCount(items, hidden: hidden, showDismissed: false) == 1)
    #expect(SlackTriageText.Filter(showHidden: true).isNarrowed == false)
    #expect(SlackTriageText.Filter(query: "  ").isNarrowed == false)
    #expect(SlackTriageText.Filter(type: .bug).isNarrowed)
}

@Test func triageBoardGroupsByStatusAndShowsDismissedOnRequest() {
    let items = [message("a"), message("b", status: .inProgress), message("c", status: .done),
                 message("d", status: .dismissed)]
    let board = SlackTriageText.board(items, showDismissed: false)
    #expect(board.map(\.status) == [.open, .inProgress, .done])
    #expect(board.map { $0.items.map(\.id) } == [["a"], ["b"], ["c"]])
    #expect(SlackTriageText.board(items, showDismissed: true).map(\.status) == [.open, .inProgress, .done, .dismissed])
    #expect(SlackTriageText.keyColumns(items, layout: .table, showDismissed: false) == [["a", "b", "c", "d"]])
}

@Test func triageKeyboardMovesWithinAndAcrossColumns() {
    let table = [["a", "b", "c"]]
    #expect(SlackTriageText.move(from: nil, in: table, dy: 1) == "a")
    #expect(SlackTriageText.move(from: "a", in: table, dy: 1) == "b")
    #expect(SlackTriageText.move(from: "c", in: table, dy: 1) == "c")
    #expect(SlackTriageText.move(from: "a", in: table, dy: -1) == "a")
    #expect(SlackTriageText.move(from: "b", in: table, dx: 1) == "b")
    let board = [["a", "b", "c"], [], ["x"]]
    #expect(SlackTriageText.move(from: "c", in: board, dx: 1) == "x")
    #expect(SlackTriageText.move(from: "x", in: board, dx: -1) == "a")
    #expect(SlackTriageText.move(from: "missing", in: [[], ["y"]], dy: 1) == "y")
    #expect(SlackTriageText.successor(of: "b", in: board) == "c")
    #expect(SlackTriageText.successor(of: "c", in: board) == "b")
    #expect(SlackTriageText.successor(of: "x", in: board) == nil)
}

@Test func triageKeysCycleTypesAndLabels() {
    #expect(SlackTriageText.nextType(.bug) == .question)
    #expect(SlackTriageText.nextType(.unknown) == .bug)
    let names = ["Product", "Billing"]
    #expect(SlackTriageText.nextLabel(nil, names: names) == SlackOverrides(label: "Product"))
    #expect(SlackTriageText.nextLabel("Product", names: names) == SlackOverrides(label: "Billing"))
    #expect(SlackTriageText.nextLabel("Billing", names: names) == SlackOverrides(clearLabel: true))
    #expect(SlackTriageText.nextLabel("Renamed", names: names) == SlackOverrides(label: "Product"))
    #expect(SlackTriageText.nextLabel(nil, names: []) == nil)
}

@Test func triageChangesApplyLocallyAsOverrides() {
    let base = SlackTriage(type: .bug, label: "Billing", severity: .low, status: .open)
    let typed = SlackTriageText.applying(SlackOverrides(type: .question), to: base)
    #expect(typed.type == .question && typed.label == "Billing" && typed.overrides.type == .question)
    let cleared = SlackTriageText.applying(SlackOverrides(clearLabel: true), to: typed)
    #expect(cleared.label == nil && cleared.overrides.clearLabel && cleared.overrides.type == .question)
    let relabelled = SlackTriageText.applying(SlackOverrides(label: "Product", status: .dismissed), to: cleared)
    #expect(relabelled.label == "Product" && !relabelled.overrides.clearLabel && relabelled.status == .dismissed)
    let item = message("a").withTriage(relabelled)
    #expect(item.dismissed && item.slack == relabelled && item.title == "Message a")
}

@Test func triageWordingReadsNaturally() {
    #expect(SlackTriageText.meta(message("a", replies: 7), now: now) == "#bugs · 1h ago · 7 replies")
    #expect(SlackTriageText.meta(message("a", replies: 1), now: now) == "#bugs · 1h ago · 1 reply")
    #expect(SlackTriageText.meta(message("a", replies: 0), now: now) == "#bugs · 1h ago")
    #expect(SlackTriageText.overridden(.init()) == nil)
    #expect(SlackTriageText.overridden(SlackOverrides(type: .bug))
        == "You changed the type. Pilot keeps your choice and learns from it.")
    #expect(SlackTriageText.overridden(SlackOverrides(type: .bug, severity: .high, clearLabel: true))
        == "You changed the type, label and severity. Pilot keeps your choice and learns from it.")
    // Status alone is triage, not a correction of the classifier.
    #expect(SlackTriageText.overridden(SlackOverrides(status: .done)) == nil)
    #expect(SlackTriageText.correction(SlackOverrides(type: .bug, clearLabel: true)) == "Bug · No label")
    #expect(SlackTriageText.correction(SlackOverrides(label: "Billing", severity: .high)) == "Billing · High severity")
    #expect(SlackTriageText.count(shown: 23, of: 23) == "23 messages")
    #expect(SlackTriageText.count(shown: 1, of: 1) == "1 message")
    #expect(SlackTriageText.count(shown: 4, of: 23) == "4 of 23 messages")
    #expect(SlackTriageText.labelFilterTitle(.named("Billing")) == "Label: Billing")
    #expect(SlackTriageText.typeFilterTitle(nil) == "Type: All")
    let label = SlackTriageText.accessibilityLabel(message("a", .question, .high, label: "Billing", replies: 2), now: now)
    #expect(label == "Message a, Question, High severity, label Billing, Open, #bugs · 1h ago · 2 replies")
}

@Test func slackRowsAndPromptsFollowTheMessageType() {
    let question = message("q", .question, .high)
    #expect(TrackedItemText.subtitle(question, now: now) == "#bugs · Question · High severity · 1h ago")
    #expect(TrackedItemText.subtitle(message("u", .unknown, .low), now: now) == "#bugs · Low severity · 1h ago")
    #expect(TrackedItemText.chatPrompt(question, prefill: nil).hasPrefix("Please look into this Slack message"))
    #expect(TrackedItemText.chatPrompt(question, prefill: nil).contains(#""type": "question""#))
    #expect(TrackedItemText.chatPrompt(message("b"), prefill: nil).hasPrefix("Please investigate and fix this bug"))
    #expect(TrackedItemText.missionDraft(question, prefill: nil).goal == "Follow up on the message in #bugs: Message q")
    #expect(TrackedItemText.missionDraft(message("b"), prefill: nil).goal == "Fix the bug reported in #bugs: Message b")
}

@Test func triageTableDropsOptionalColumnsAsItNarrows() {
    let wide = SlackTriageColumns(width: 1200)
    #expect(wide.status && wide.channel && wide.replies)
    let medium = SlackTriageColumns(width: 820)
    #expect(medium.status && medium.channel && !medium.replies)
    let narrow = SlackTriageColumns(width: 520)
    #expect(!narrow.status && !narrow.channel && !narrow.replies)
}

@Test @MainActor func projectEditorEditsSlackLabels() {
    let editor = ProjectEditor()
    editor.load(Project(id: "p", name: "Example", path: "/example", tracking: .init(
        slackChannels: ["C1"], slackLabels: [SlackProjectLabel(name: "Billing", description: "Invoices",
                                                               hideFromInbox: false)]), createdAt: 0))
    #expect(!editor.hasChanges)
    editor.addLabel()
    // An unnamed draft is neither saved nor a change to save.
    #expect(!editor.hasChanges)
    #expect(editor.request.tracking?.slackLabels == [SlackProjectLabel(name: "Billing", description: "Invoices")])
    editor.slackLabels[1].name = "  Product-owned "
    editor.slackLabels[1].description = "Feature requests\nand copy"
    editor.slackLabels[1].hideFromInbox = true
    #expect(editor.hasChanges)
    #expect(editor.request.tracking?.slackLabels?.last
        == SlackProjectLabel(name: "Product-owned", description: "Feature requests and copy", hideFromInbox: true))
    editor.removeLabel(editor.slackLabels[0].id)
    editor.removeLabel(editor.slackLabels[0].id)
    #expect(editor.request.tracking?.slackLabels == nil)
}

@Test @MainActor func slackTriageReplacesTheProjectPageUntilAnotherPageOpens() {
    let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "slack-triage-\(UUID())")!)
    app.client.loadFixture(projects: [Project(id: "p", name: "Repo", path: "/repo", createdAt: 1)], sessions: [
        SessionSummary(id: "s", title: "Chat", cwd: "/repo", projectId: "p", createdAt: 1, updatedAt: 1, state: "idle"),
    ])
    app.openSlackTriage("p")
    #expect(app.selectedProjectId == "p" && app.slackTriageProjectId == "p")
    app.openProject("p")
    #expect(app.selectedProjectId == "p" && app.slackTriageProjectId == nil)
    app.openSlackTriage("p")
    app.selectedSessionId = "s"
    #expect(app.selectedProjectId == nil && app.slackTriageProjectId == nil)
}


@Test @MainActor func slackExcerptsAreReadOnceKeptBoundedAndRetriedAfterFailure() async {
    let store = SlackExcerptStore()
    var reads: [String] = []
    #expect(store.state("a") == .loading)
    await store.load("a", settle: .zero) { id in
        reads.append(id)
        return SlackExcerpt(itemId: id, author: "Sam", text: "Export fails")
    }
    #expect(store.state("a") == .loaded(SlackExcerpt(itemId: "a", author: "Sam", text: "Export fails")))
    await store.load("a", settle: .zero) { _ in Issue.record("already shown"); throw ClientError("unused") }
    #expect(reads == ["a"])

    await store.load("b", settle: .zero) { _ in
        throw ClientError("Sign in to Slack to read this message", status: 503)
    }
    #expect(store.state("b") == .unavailable("Sign in to Slack to read this message."))
    await store.load("b", settle: .zero) { id in SlackExcerpt(itemId: id, text: "") }
    #expect(store.state("b") == .loaded(SlackExcerpt(itemId: "b", text: "")), "selecting again retries")

    #expect(SlackExcerptStore.reason(ClientError("Superseded by a newer selection", status: 409))
        == "Couldn't load this message.")
    #expect(SlackExcerptStore.reason(ClientError("internal detail", status: 500)) == "Couldn't load this message.")
    #expect(SlackExcerptStore.reason(URLError(.notConnectedToInternet)) == "Couldn't load this message.")

    for index in 0 ..< SlackExcerptStore.limit {
        await store.load("m\(index)", settle: .zero) { id in SlackExcerpt(itemId: id, text: "x") }
    }
    #expect(store.states.count == SlackExcerptStore.limit)
    #expect(store.state("a") == .loading, "the oldest read is dropped first")
}

@Test @MainActor func cancelledExcerptReadsLeaveNoState() async {
    let store = SlackExcerptStore()
    let task = Task { @MainActor in
        await store.load("a", settle: .seconds(5)) { id in SlackExcerpt(itemId: id, text: "late") }
    }
    task.cancel()
    await task.value
    #expect(store.states.isEmpty)
}
