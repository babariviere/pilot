import Testing
@testable import PilotCore

@Test func mentionsFindSchemeURLsAndTrimProsePunctuation() {
    let text = """
    See https://example.com/docs. Also (https://github.com/o/r/pull/12), and <https://a.dev/x?y=1&z=2>.
    Wiki: https://en.wikipedia.org/wiki/Foo_(bar)! Not README.md, not xhttp://nope.io, not http://.
    **https://bold.example/path**
    """
    #expect(ChatLinks.mentions(in: text).map(\.url) == [
        "https://example.com/docs",
        "https://github.com/o/r/pull/12",
        "https://a.dev/x?y=1&z=2",
        "https://en.wikipedia.org/wiki/Foo_(bar)",
        "https://bold.example/path",
    ])
}

@Test func markdownLabelsBecomeTitles() {
    let mentions = ChatLinks.mentions(in: "Opened [Fix the thing](https://github.com/o/r/pull/7) and [https://x.io](https://x.io).")
    #expect(mentions == [
        ChatLinkMention(url: "https://github.com/o/r/pull/7", label: "Fix the thing"),
        ChatLinkMention(url: "https://x.io", label: nil),
        ChatLinkMention(url: "https://x.io", label: nil),
    ])
}

@Test func linksAreDeduplicatedNewestFirstAndClassified() {
    let links = ChatLinks.links(from: [
        ChatLinkMention(url: "https://github.com/o/r/pull/7", label: "Fix the thing"),
        ChatLinkMention(url: "https://linear.app/acme/issue/eng-3/do-it", label: nil),
        ChatLinkMention(url: "https://GitHub.com/o/r/pull/7/", label: nil),
        ChatLinkMention(url: "https://acme.slack.com/archives/C1/p1111111111111111", label: nil),
        ChatLinkMention(url: "https://www.example.com/a/", label: nil),
    ])
    #expect(links.map(\.kind) == [.url, .slackThread, .githubPullRequest, .linearIssue])
    #expect(links.map(\.title) == ["example.com/a", "Slack thread", "Fix the thing", "ENG-3"])
    #expect(links[2].mentions == 2)
    #expect(links[2].url == "https://GitHub.com/o/r/pull/7/")
    #expect(ChatLinks.kind(of: "https://github.com/o/r/issues/31") == .githubIssue)
    #expect(ChatLinks.kind(of: "https://linear.app/acme/project/pilot-app-0123abcd") == .linearProject)
}

@Test func indexReadsMessagesOnlyAndRescansChangedRows() {
    var index = ChatLinkIndex()
    let tool = ToolItem(id: "t", name: "web", arguments: .object([:]), status: .done, output: "https://tool.example")
    var rows: [ChatRow] = [
        .user(id: "u1", text: "Look at https://one.example"),
        .thinking(id: "k1", text: "https://thought.example", streaming: false),
        .tools(id: "g1", items: [tool]),
        .text(id: "a1", text: "Working on"),
    ]
    #expect(index.links(in: rows).map(\.url) == ["https://one.example"])
    rows[3] = .text(id: "a1", text: "Working on https://two.example")
    rows.append(.automatic(id: "m1", text: "From mission: https://three.example", origin: .extension))
    #expect(index.links(in: rows).map(\.url) == ["https://three.example", "https://two.example", "https://one.example"])
    rows.append(.event(.automatic(id: "c1", text: "See https://four.example", origin: .coordinator,
                                  sourceSessionId: "source-chat")))
    #expect(index.links(in: rows).map(\.url) == ["https://four.example", "https://three.example", "https://two.example", "https://one.example"])
    #expect(index.links(in: Array(rows.prefix(1))).map(\.url) == ["https://one.example"])
}
