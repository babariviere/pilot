import Foundation
import Testing
@testable import PilotCore

@Test func memoryModelsRoundTripAndDecodeDashboardProvider() throws {
    let entry = MemoryEntry(index: 7, id: "uuid", deviceId: "device", at: 12, sessionId: "chat", text: "Lasting fact é")
    let summary = ProjectMemorySummary(count: 8, recent: [entry], compaction: .init(state: .backoff, pending: 2, error: "offline", retryAt: 30))
    let dashboard = ProjectDashboard(projectId: "p", memory: summary)
    let decoded = try JSONDecoder().decode(ProjectDashboard.self, from: JSONEncoder().encode(dashboard))
    #expect(decoded.memory == summary)
    #expect(decoded.memory?.recent[0].deviceId == "device")
    let view = MemoryView(count: 8, nodes: [.init(lo: 0, hi: 3, pending: true), .init(lo: 7, hi: 7, text: entry.text, entry: entry)], omittedBefore: 0, text: "#7 Lasting fact")
    #expect(try JSONDecoder().decode(MemoryView.self, from: JSONEncoder().encode(view)) == view)
    let recall = MemoryRecall(count: 8, matches: 8, entries: [entry], truncated: true)
    #expect(try JSONDecoder().decode(MemoryRecall.self, from: JSONEncoder().encode(recall)) == recall)
    let range = MemoryRange(lo: 0, hi: 3)
    #expect(try JSONDecoder().decode(MemoryRange.self, from: JSONEncoder().encode(range)) == range)
    let request = MemoryNoteRequest(text: "A fact", sessionId: "chat")
    #expect(try JSONDecoder().decode(MemoryNoteRequest.self, from: JSONEncoder().encode(request)) == request)
}
