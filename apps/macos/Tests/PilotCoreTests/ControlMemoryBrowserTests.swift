import Foundation
import PilotCore
import Testing

struct ControlMemoryBrowserTests {
    private func line(_ start: Int, _ n: Int, _ text: String = "s", pending: Bool? = nil) -> ControlMemoryLine {
        ControlMemoryLine(start: start, n: n, text: text, pending: pending)
    }

    private func entry(_ id: Int) -> ControlMemoryLogEntry {
        ControlMemoryLogEntry(id: id, at: Double(id), kind: .user, text: "m\(id)")
    }

    private func page(_ id: Int, _ text: String, next: Int? = nil, format: String? = nil) -> ControlMemoryMessagePage {
        ControlMemoryMessagePage(message: .init(id: id, at: 1, kind: .tool, text: text, name: "read"), format: format,
                                 next: next)
    }

    @Test func treeOpensSummariesIntoHalvesDownToTheMessage() {
        let lines = [line(0, 4), line(4, 1, pending: true)]
        let collapsed = ControlMemoryTree.rows(lines: lines, expanded: [], children: [:], messages: [:])
        #expect(collapsed.map(\.id) == ["0+4", "4+1"])

        let loading = ControlMemoryTree.rows(lines: lines, expanded: ["0+4"], children: [:], messages: [:])
        #expect(loading.map(\.id) == ["0+4", "loading:0+4", "4+1"])
        #expect(loading[1].depth == 1)
        #expect(loading[1].parent == lines[0])

        let children = ["0+4": [line(0, 2), line(2, 2)], "2+2": [line(2, 1), line(3, 1)]]
        let message = ControlMemoryMessageText(page(3, "whole"))
        let open = ControlMemoryTree.rows(lines: lines, expanded: ["0+4", "2+2", "3+1"], children: children,
                                          messages: [3: message], failures: ["4+1": "gone"])
        #expect(open.map(\.id) == ["0+4", "0+2", "2+2", "2+1", "3+1", "message:3", "4+1"])
        #expect(open.map(\.depth) == [0, 1, 1, 2, 2, 3, 0])
        #expect(open[5].kind == .message(message))

        let failed = ControlMemoryTree.rows(lines: lines, expanded: ["4+1"], children: [:], messages: [:],
                                            failures: ["4+1": "gone"])
        #expect(failed.last?.kind == .failed("gone"))
    }

    @Test func messagesPageOnlyFromTheirCursorAndStayBounded() {
        var message = ControlMemoryMessageText(page(1, "ab", next: 2))
        #expect(message.canLoadMore)
        message.append(page(1, "zz", next: 9), offset: 5)
        #expect(message.text == "ab", "a page for another offset is ignored")
        message.append(page(2, "zz"), offset: 2)
        #expect(message.text == "ab", "another message's page is ignored")
        message.append(page(1, "cd"), offset: 2)
        #expect(message.text == "abcd")
        #expect(!message.canLoadMore)
        #expect(!message.truncated)

        let long = ControlMemoryMessageText(page(1, String(repeating: "x", count: ControlMemoryMessageText.maxCharacters),
                                                 next: ControlMemoryMessageText.maxCharacters))
        #expect(!long.canLoadMore)
        #expect(long.truncated)
    }

    @Test func refreshesPutNewRowsOnTopAndKeepOlderPages() {
        let held = [entry(5), entry(4), entry(3)]
        let merged = ControlMemoryLog.merge(held: held, heldNext: 3,
                                            newest: ControlMemoryMessagesResponse(messages: [entry(6), entry(5)], next: 5))
        #expect(merged.entries.map(\.id) == [6, 5, 4, 3])
        #expect(merged.next == 3)

        // A whole page of new rows with more behind it may hide a gap: start over from it.
        let gap = ControlMemoryLog.merge(held: held, heldNext: 3,
                                         newest: ControlMemoryMessagesResponse(messages: [entry(9), entry(8)], next: 8))
        #expect(gap.entries.map(\.id) == [9, 8])
        #expect(gap.next == 8)

        let first = ControlMemoryLog.merge(held: [], heldNext: nil,
                                           newest: ControlMemoryMessagesResponse(messages: [entry(1)], next: nil))
        #expect(first.entries.map(\.id) == [1])

        let older = ControlMemoryLog.append(held: held, older: ControlMemoryMessagesResponse(messages: [entry(3), entry(2)]))
        #expect(older.entries.map(\.id) == [5, 4, 3, 2])
        #expect(older.next == nil)
    }

    @Test func theLogStaysBounded() {
        let held = (0 ..< ControlMemoryLog.cap).reversed().map { entry($0 + 10) }
        let older = ControlMemoryLog.append(held: held, older: ControlMemoryMessagesResponse(messages: [entry(9), entry(8)],
                                                                                             next: 8))
        #expect(older.entries.count == ControlMemoryLog.cap)
        #expect(older.next == older.entries.last?.id)
    }

    @Test func wordsForRangesKindsAndTools() throws {
        #expect(ControlMemoryFormat.range(line(12, 1)) == "Message 12")
        #expect(ControlMemoryFormat.range(line(8, 4)) == "Messages 8–11")
        #expect(ControlMemoryFormat.kind(.echo) == "Tool result")
        #expect(!ControlMemoryFormat.isQuoted(.user))
        #expect(ControlMemoryFormat.isQuoted(.event))
        #expect(ControlMemoryFormat.isQuoted(.assistant))
        #expect(ControlScreenSection.allCases.map(\.title) == ["Summaries", "Log", "Watches & actions", "Health"])

        let tool = ControlMemoryMessageText(page(1, #"{"name":"read","input":{"path":"a"},"text":"ok"}"#, format: "json"))
        let parts = try #require(ControlMemoryFormat.toolParts(tool))
        #expect(parts.name == "read")
        #expect(parts.input?.contains(#""path" : "a""#) == true)
        #expect(parts.text == "ok")
        // Part of a long tool message is not valid JSON yet: shown as text.
        let partial = ControlMemoryMessageText(page(1, #"{"name":"read","input":"#, next: 20, format: "json"))
        #expect(ControlMemoryFormat.toolParts(partial) == nil)
        let plain = ControlMemoryMessageText(page(1, "hello"))
        #expect(ControlMemoryFormat.toolParts(plain) == nil)
    }
}

