import Foundation
import PilotCore
import PilotTelemetry
import Testing
@testable import Pilot

@Test func chatOpenHistoryBucketsStayBoundedAndContentFree() {
    #expect(ChatOpenTelemetry.historyBucket(entryCount: 0) == .empty)
    #expect(ChatOpenTelemetry.historyBucket(entryCount: 100) == .small)
    #expect(ChatOpenTelemetry.historyBucket(entryCount: 101) == .medium)
    #expect(ChatOpenTelemetry.historyBucket(entryCount: 1_001) == .large)

    let event: JSONValue = .object([
        "type": .string("snapshot"),
        "historyCount": .number(1_240),
        "entries": .array([.object(["private": .string("never inspect this")])]),
    ])
    #expect(ChatOpenTelemetry.historyBucket(events: [event]) == .large)
}

@Test func chatSocketHandshakeCarriesOnlyAValidTraceparent() {
    let value = "00-11111111111111111111111111111111-2222222222222222-01"
    let task = StreamSocket.task(URL(string: "ws://127.0.0.1/chat")!, traceparent: value)
    #expect(task.originalRequest?.value(forHTTPHeaderField: "traceparent") == value)
    #expect(task.originalRequest?.value(forHTTPHeaderField: "tracestate") == nil)
    #expect(task.originalRequest?.value(forHTTPHeaderField: "baggage") == nil)
    task.cancel()

    let invalid = StreamSocket.task(URL(string: "ws://127.0.0.1/chat")!, traceparent: "private")
    #expect(invalid.originalRequest?.value(forHTTPHeaderField: "traceparent") == nil)
    invalid.cancel()
}
