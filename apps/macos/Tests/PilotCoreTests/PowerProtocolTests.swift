import Foundation
import PilotCore
import Testing

struct PowerProtocolTests {
    @Test func powerStatusPushDecodes() throws {
        let data = Data(#"{"type":"power","power":{"settings":{"keepAwake":true,"closedLid":false},"available":true,"authorized":false,"keepingAwake":true,"closedLidActive":false,"paused":false,"connectedToPower":true,"wifiConnected":true}}"#.utf8)
        guard case let .power(status) = try ServerUpdate.decode(data) else { Issue.record("Missing power update"); return }
        #expect(status.settings.keepAwake)
        #expect(!status.settings.closedLid)
        #expect(status.keepingAwake)
        #expect(status.summary == "Keeping this Mac awake while agents work.")
    }

    @Test func pausedWorkIsQuietAndOldDaemonsRemainCompatible() throws {
        let base = #"{"id":"chat","title":"Work","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"parked","outcome":"done","outcomeAt":2}"#
        let old = try JSONDecoder().decode(SessionSummary.self, from: Data(base.utf8))
        #expect(old.sleepPaused == nil)
        #expect(old.status == .done)
        let paused = base.dropLast() + #", "sleepPaused":true, "working":true}"#
        let chat = try JSONDecoder().decode(SessionSummary.self, from: Data(paused.utf8))
        #expect(chat.status == .paused)
        #expect(!chat.isWorking)
        #expect(chat.visibleOutcomeAt == nil)
        let suite = "power-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let attention = SessionAttention(defaults: defaults)
        #expect(!attention.isUnread(chat))
        #expect(attention.observe([chat], snapshot: true).isEmpty)
    }
}
