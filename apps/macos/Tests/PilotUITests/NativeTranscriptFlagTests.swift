import Testing
@testable import Pilot

@Suite @MainActor
struct NativeTranscriptFlagTests {
    @Test func absentOverridesSelectNative() {
        #expect(NativeTranscriptFlag.resolve(environmentOverride: nil, preference: nil))
    }

    @Test func savedPreferencesRetainBothChoices() {
        #expect(NativeTranscriptFlag.resolve(environmentOverride: nil, preference: true))
        #expect(!NativeTranscriptFlag.resolve(environmentOverride: nil, preference: false))
    }

    @Test func explicitEnvironmentOverridesWinOverEveryPreference() {
        for preference: Bool? in [nil, false, true] {
            #expect(!NativeTranscriptFlag.resolve(environmentOverride: "0", preference: preference))
            #expect(NativeTranscriptFlag.resolve(environmentOverride: "1", preference: preference))
        }
    }

    @Test func unrecognizedEnvironmentValuesDoNotInventAnotherChoice() {
        for value in ["", "true", "false", "native", "legacy"] {
            #expect(NativeTranscriptFlag.resolve(environmentOverride: value, preference: nil))
            #expect(!NativeTranscriptFlag.resolve(environmentOverride: value, preference: false))
            #expect(NativeTranscriptFlag.resolve(environmentOverride: value, preference: true))
        }
    }
}
