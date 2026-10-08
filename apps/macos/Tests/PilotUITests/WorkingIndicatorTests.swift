import AppKit
import QuartzCore
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

@Test @MainActor func workingWaveLayerMatchesSweepAndPauseWithoutATimeline() {
    let animation = WorkingHighlightView.waveAnimation(width: 100)
    #expect(animation.keyPath == "transform.translation.x")
    #expect(animation.values?.compactMap { ($0 as? NSNumber)?.doubleValue } == [-200, 0, 0])
    #expect(animation.keyTimes == [0, 0.8, 1])
    #expect(animation.duration == WorkingIndicator.cycleDuration)
    #expect(animation.repeatCount == .infinity)
    #expect(animation.calculationMode == .linear)
}

@Test @MainActor func workingWaveDetachedViewsDoNotAnimateAndDisposeIsSafe() {
    _ = NSApplication.shared
    let view = WorkingHighlightView(frame: NSRect(x: 0, y: 0, width: 100, height: 20))
    view.setVisible(true)
    view.layout()
    let gradient = view.layer?.sublayers?.first as? CAGradientLayer
    #expect(gradient?.frame.width == 300)
    #expect(gradient?.locations == [0, 0.40, 0.46, 0.50, 0.54, 0.60, 1])
    #expect(gradient?.animation(forKey: WorkingHighlightView.animationKey) == nil)
    let originalBounds = gradient?.bounds
    let originalPosition = gradient?.position
    for _ in 0..<10 { view.layout() }
    #expect(gradient?.bounds == originalBounds)
    #expect(gradient?.position == originalPosition)
    #expect(gradient?.transform.m41 == -200)
    view.setFrameSize(NSSize(width: 150, height: 24))
    for _ in 0..<10 { view.layout() }
    #expect(gradient?.bounds == CGRect(x: 0, y: 0, width: 450, height: 24))
    #expect(gradient?.position == CGPoint.zero)
    #expect(gradient?.transform.m41 == -300)
    view.setVisible(false)
    view.dispose()
    view.dispose()
    #expect(gradient?.animation(forKey: WorkingHighlightView.animationKey) == nil)
}
