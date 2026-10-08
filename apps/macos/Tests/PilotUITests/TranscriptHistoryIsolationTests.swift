import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func transcriptHistorySubtreeIgnoresLiveTextButRefreshesCommittedRows() async throws {
    let processor = TranscriptProcessor()
    let entries: [JSONValue] = (1...1000).map { index in
        .object([
            "id": .number(Double(index)), "kind": .string("pi.user"),
            "model": .array([.object(["role": .string("user"), "content": .string("entry \(index)")])]),
        ])
    }
    let first = try await processor.apply([.object(["type": .string("snapshot"), "entries": .array(entries)])])
    let history = TranscriptHistoryRows(revision: first.historyRevision, rows: first.rows.prefix(first.historyRowCount))
    _ = try await processor.apply([.object([
        "type": .string("message_start"),
        "message": .object(["role": .string("assistant"), "content": .array([.object([
            "type": .string("text"), "text": .string(""),
        ])])]),
    ])])
    let streamed = try await processor.apply([.object([
        "type": .string("message_update"), "changes": .array([.object([
            "type": .string("text_delta"), "contentIndex": .number(0), "delta": .string("live"),
        ])]),
    ])])
    #expect(streamed.rows.count == 1001 && streamed.historyRowCount == 1000)
    #expect(history == TranscriptHistoryRows(revision: streamed.historyRevision,
        rows: streamed.rows.prefix(streamed.historyRowCount)))
    let committed = try await processor.apply([.object([
        "type": .string("message_end"), "entry": .object([
            "id": .number(1001), "kind": .string("pi.assistant"),
            "model": .array([.object(["role": .string("assistant"), "content": .string("live")])]),
        ]),
    ])])
    #expect(history != TranscriptHistoryRows(revision: committed.historyRevision,
        rows: committed.rows.prefix(committed.historyRowCount)))
}

@Test @MainActor func transcriptToolExpansionSurvivesMovingFromTailToHistory() async throws {
    _ = NSApplication.shared
    let processor = TranscriptProcessor()
    let first = try await processor.apply([.object([
        "type": .string("snapshot"), "entries": .array([.object([
            "id": .number(1), "kind": .string("pi.assistant"), "model": .array([.object([
                "role": .string("assistant"), "content": .array([.object([
                    "type": .string("toolCall"), "id": .string("c"), "name": .string("bash"),
                    "arguments": .object(["command": .string(String(repeating: "echo expanded\n", count: 12))]),
                ])]),
            ])]),
        ])]),
    ])])
    #expect(first.historyRowCount == 0 && first.liveRows.count == 1)
    let owner = TranscriptExpansions()
    let expansion = owner.state(for: "c")
    expansion.expanded = true
    let committed = try await processor.apply([.object([
        "type": .string("entry_appended"), "entry": .object([
            "id": .number(2), "kind": .string("pi.assistant"),
            "model": .array([.object(["role": .string("assistant"), "content": .string("Finished")])]),
        ]),
    ])])
    #expect(committed.historyRowCount == 2 && committed.liveRows.isEmpty)
    #expect(owner.state(for: "c") === expansion && expansion.expanded)

    // Exercise the actual historical RowView -> ToolGroupView -> ToolRowView ownership chain.
    // A fresh owner renders the same tool collapsed, while the moved group stays expanded.
    func height(owner: TranscriptExpansions) -> CGFloat {
        let view = NSHostingView(rootView: TranscriptHistoryRows(revision: committed.historyRevision,
            rows: committed.historyRows[...], toolExpansions: owner)
            .fixedSize(horizontal: false, vertical: true).frame(width: 500))
        view.frame = NSRect(x: 0, y: 0, width: 500, height: 600)
        view.layoutSubtreeIfNeeded()
        return view.fittingSize.height
    }
    #expect(height(owner: owner) > height(owner: TranscriptExpansions()) + 40)
}
