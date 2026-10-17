import Foundation
import PilotCore
import Testing

@Test func telemetrySettingsDecodeIndependentHostScopedControls() throws {
    let data = Data(#"""
    {"schemaVersion":1,"hostKind":"devbox","hostId":"abcdefghijklmnopqrstuv",
     "localDiagnostics":true,"remoteOperational":false,"productAnalytics":true,
     "endpoint":"https://collector.example/v1/traces","updatedAt":"2026-10-17T10:00:00.000Z"}
    """#.utf8)
    let settings = try JSONDecoder().decode(TelemetrySettings.self, from: data)
    #expect(settings.hostKind == .devbox)
    #expect(settings.localDiagnostics)
    #expect(!settings.remoteOperational)
    #expect(settings.productAnalytics)
    #expect(settings.analyticsId == nil)
}

@Test func telemetryPatchEncodesOnlyReviewedFields() throws {
    let patch = TelemetrySettingsPatch(localDiagnostics: false, remoteOperational: false,
                                       productAnalytics: false, endpoint: nil)
    let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
    #expect(Set(object.keys) == ["localDiagnostics", "remoteOperational", "productAnalytics"])
}
