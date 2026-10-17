import Foundation
import PilotCore
import Testing

@Test func failedStartupKeepsStopAvailableWithoutWorkingChildren() throws {
    let data = Data("""
    {"id":"failed","title":"Failed restart","cwd":"/tmp","createdAt":0,"updatedAt":1,
     "state":"failed","working":false,"canRetryStartup":true,"error":"Session startup: Credential broker busy"}
    """.utf8)
    let session = try JSONDecoder().decode(SessionSummary.self, from: data)
    #expect(!session.isWorking)
    #expect(session.canStop)
    #expect(session.status == .failed)
    #expect(TranscriptPresentation().failureBannerText(for: session) == session.error)
    let archivedData = Data(String(decoding: data, as: UTF8.self).replacingOccurrences(
        of: "\"state\":\"failed\"", with: "\"archivedAt\":2,\"state\":\"failed\"").utf8)
    let archived = try JSONDecoder().decode(SessionSummary.self, from: archivedData)
    #expect(!archived.canStop)

    let idle = SessionSummary(id: "idle", title: "Stopped recovery", cwd: "/tmp", createdAt: 0,
        updatedAt: 1, state: "parked", working: false)
    #expect(!idle.canStop)
}
