import Foundation
import Testing
@testable import Pilot

@Test func workingWaveKeepsWorkingAndRetryLabels() {
    #expect(WorkingIndicator(retry: nil).label == "Working…")
    #expect(WorkingIndicator(retry: "Rate limited").label == "Retrying: Rate limited")
}

@Test func workingWaveSweepsThenPausesAndRepeats() {
    let duration = WorkingIndicator.cycleDuration
    #expect(WorkingIndicator.highlightProgress(at: 0) == 0)
    #expect(abs(WorkingIndicator.highlightProgress(at: duration * 0.4) - 0.5) < 0.0001)
    #expect(WorkingIndicator.highlightProgress(at: duration * 0.8) == 1)
    #expect(WorkingIndicator.highlightProgress(at: duration * 0.9) == 1)
    #expect(WorkingIndicator.highlightProgress(at: duration) == 0)
    #expect(abs(WorkingIndicator.highlightProgress(at: duration * 1.4) - 0.5) < 0.0001)
}
