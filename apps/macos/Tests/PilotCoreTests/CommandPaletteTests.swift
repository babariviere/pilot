import Testing
@testable import PilotCore

private func chat(_ id: String, _ title: String, project: String = "pilot", branch: String? = nil,
                  prs: [Int] = [], suggested: Bool = false) -> CommandPaletteItem {
    CommandPaletteItem(id: id, kind: .chat, title: title, keywords: [project] + (branch.map { [$0] } ?? []),
                       pullRequestNumbers: prs, suggested: suggested)
}

private func task(_ id: String, _ number: Int, _ title: String, prs: [Int] = []) -> CommandPaletteItem {
    CommandPaletteItem(id: id, kind: .task, title: title, keywords: ["#\(number)", "Pilot Redesign"],
                       pullRequestNumbers: prs, taskNumber: number)
}

private func ids(_ sections: [CommandPaletteSection]) -> [[String]] {
    sections.map { $0.items.map(\.id) }
}

@Test func paletteReadsPullRequestAndTaskNumbers() {
    #expect(CommandPalette.number(in: "406") == 406)
    #expect(CommandPalette.number(in: " #406 ") == 406)
    #expect(CommandPalette.number(in: "#") == nil)
    #expect(CommandPalette.number(in: "0") == nil)
    #expect(CommandPalette.number(in: "4o6") == nil)
    #expect(CommandPalette.number(in: "##406") == nil)
    #expect(CommandPalette.number(in: "pr 406") == nil)
    #expect(CommandPalette.number(in: "１２") == nil)
    #expect(CommandPalette.number(in: "12345678901") == nil)
}

@Test func paletteReadsPullRequestNumbersFromLinks() {
    #expect(CommandPalette.pullRequestNumber(fromURL: "https://github.com/o/r/pull/406") == 406)
    #expect(CommandPalette.pullRequestNumber(fromURL: "https://github.example.com/o/r/pull/12/files?x=1") == 12)
    #expect(CommandPalette.pullRequestNumber(fromURL: "https://github.com/o/r/issues/406") == nil)
    #expect(CommandPalette.pullRequestNumber(fromURL: "https://github.com/pull/406") == nil)
    #expect(CommandPalette.pullRequestNumber(fromURL: "javascript:/o/r/pull/1") == nil)
    #expect(CommandPalette.pullRequestNumber(fromURL: "https://github.com/o/r/pull/") == nil)
}

@Test func pullRequestNumberOpensItsChatThenItsActions() {
    let items = [
        chat("a", "Inbox project filter", prs: [405]),
        chat("b", "Home subscription bars", prs: [406, 407]),
        task("t", 406, "Something numbered 406"),
        task("linked", 12, "Usage bars", prs: [406]),
        CommandPaletteItem(id: "home", kind: .page, title: "Home"),
    ]
    for query in ["406", "#406"] {
        let sections = CommandPalette.results(for: query, items: items) { chatId in
            [CommandPaletteItem(id: "open-pr-\(chatId)", kind: .action, title: "Open PR #406 on GitHub"),
             CommandPaletteItem(id: "pin-\(chatId)", kind: .action, title: "Pin")]
        }
        #expect(sections.map(\.title) == ["Pull request #406", "Actions", "Tasks"])
        #expect(ids(sections) == [["b"], ["open-pr-b", "pin-b"], ["t"]])
    }
}

@Test func pullRequestFallsBackToTheLinkedMissionTask() {
    let items = [chat("a", "Inbox project filter", prs: [405]), task("t25", 25, "Secondary pages"),
                 task("linked", 7, "Usage bars", prs: [25])]
    let sections = CommandPalette.results(for: "#25", items: items) { _ in
        [CommandPaletteItem(id: "pin", kind: .action, title: "Pin")]
    }
    #expect(sections.map(\.title) == ["Pull request #25", "Tasks"])
    #expect(ids(sections) == [["linked"], ["t25"]])
}

@Test func taskNumberLeadsWhenNothingOwnsThePullRequest() {
    let items = [chat("a", "Retry 25 times"), task("t25", 25, "Secondary pages"), task("t3", 3, "Dark mode")]
    let sections = CommandPalette.results(for: "#25", items: items)
    #expect(sections.map(\.title) == ["Tasks", "Chats"])
    #expect(ids(sections) == [["t25"], ["a"]])
}

@Test func pullRequestOwnedByTwoChatsListsBothWithoutActions() {
    let items = [chat("a", "First", prs: [9]), chat("b", "Second", prs: [9])]
    var asked = false
    let sections = CommandPalette.results(for: "9", items: items) { _ in
        asked = true
        return [CommandPaletteItem(id: "pin", kind: .action, title: "Pin")]
    }
    #expect(!asked)
    #expect(ids(sections) == [["a", "b"]])
}

@Test func emptyFieldListsSuggestionsInGroupOrder() {
    let items = [
        CommandPaletteItem(id: "new", kind: .action, title: "New chat", suggested: true),
        chat("a", "Inbox project filter", suggested: true),
        chat("old", "Old chat"),
        CommandPaletteItem(id: "home", kind: .page, title: "Home", suggested: true),
        chat("b", "Home subscription bars", suggested: true),
    ]
    let sections = CommandPalette.results(for: "  ", items: items)
    #expect(sections.map(\.title) == ["Recent chats", "Pages", "Actions"])
    #expect(ids(sections) == [["a", "b"], ["home"], ["new"]])
}

@Test func titleStartRanksAboveWordStartAboveInsideAWord() {
    let items = [
        chat("inside", "Unpinned rows"),
        chat("word", "Sidebar pin group"),
        chat("start", "Pinned chats"),
    ]
    let sections = CommandPalette.results(for: "pin", items: items)
    #expect(ids(sections) == [["start", "word", "inside"]])
}

@Test func everyWordMustMatchAndTitlesOutweighKeywords() {
    let items = [
        chat("branch", "Fix export", branch: "feat/palette"),
        chat("title", "Command palette"),
        chat("other", "Unrelated"),
    ]
    #expect(ids(CommandPalette.results(for: "palette", items: items)) == [["title", "branch"]])
    #expect(ids(CommandPalette.results(for: "fix palette", items: items)) == [["branch"]])
    #expect(CommandPalette.results(for: "nothing here", items: items).isEmpty)
}

@Test func matchingIgnoresCaseAndAccents() {
    let items = [chat("a", "Résumé export", project: "Stoïk")]
    #expect(ids(CommandPalette.results(for: "RESUME", items: items)) == [["a"]])
    #expect(ids(CommandPalette.results(for: "stoik", items: items)) == [["a"]])
}

@Test func groupsFollowTheirBestMatch() {
    let items = [
        chat("chat", "Claims export retry", project: "stoik-api"),
        CommandPaletteItem(id: "switch", kind: .project, title: "Switch to stoik-api", keywords: ["stoik-api"]),
        CommandPaletteItem(id: "overview", kind: .page, title: "Overview", keywords: ["stoik-api"]),
        CommandPaletteItem(id: "linear", kind: .linear, title: "Broker export times out",
                           keywords: ["ENG-1412", "stoik-api"]),
    ]
    let sections = CommandPalette.results(for: "stoik", items: items)
    // The project's title holds the word; the others match it only as a keyword, then tie in group order.
    #expect(sections.map(\.title) == ["Projects", "Chats", "Pages", "Linear"])
    #expect(ids(CommandPalette.results(for: "eng-1412", items: items)) == [["linear"]])
}

@Test func equalScoresKeepTheGivenOrderAndGroupsAreCapped() {
    let items = (0 ..< 10).map { chat("c\($0)", "Chat \($0)") }
    let sections = CommandPalette.results(for: "chat", items: items)
    #expect(ids(sections) == [(0 ..< CommandPalette.limit).map { "c\($0)" }])
}

@Test func exactTitleWinsOverLongerTitles() {
    let items = [chat("long", "Inbox filter menu"), CommandPaletteItem(id: "inbox", kind: .page, title: "Inbox")]
    let sections = CommandPalette.results(for: "inbox", items: items)
    #expect(sections.first?.items.first?.id == "inbox")
}
