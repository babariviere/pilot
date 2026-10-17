import Foundation
import PilotCore
import Testing

@Test func featureCatalogIsClosedAndBuildsCoherentStages() {
    #expect(FeatureName.allCases.map(\.rawValue) == ["diagnose_chat", "devbox_chat", "slack_triage"])
    #expect(FeatureEvent.eligibility(.devboxChat, .notConfigured).reason == .notConfigured)
    #expect(FeatureEvent.exposure(.diagnoseChat).stage == .exposure)
    #expect(FeatureEvent.attempt(.slackTriage).stage == .attempt)
    #expect(FeatureEvent.outcome(.diagnoseChat, .success, reason: .none)?.outcome == .success)
    #expect(FeatureEvent.outcome(.diagnoseChat, .failure, reason: .transport)?.reason == .transport)
    #expect(FeatureEvent.outcome(.diagnoseChat, .success, reason: .transport) == nil)
    #expect(FeatureEvent.outcome(.devboxChat, .unavailable, reason: .disconnected)?.outcome == .unavailable)

    let encoded = try? JSONEncoder().encode(FeatureEvent.attempt(.slackTriage))
    let object = encoded.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    #expect(object.map { Set($0.keys) } == Set(["catalogVersion", "feature", "stage"]))
}
