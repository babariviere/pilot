import AppKit
import Combine
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test func responsiveControlsPlanWrapsAtTheSpacingBoundary() {
    let sizes = [CGSize(width: 60, height: 10), CGSize(width: 40, height: 20)]
    let wide = ResponsiveControlsLayout.Plan(sizes: sizes, width: 108, horizontalSpacing: 8, verticalSpacing: 6)
    #expect(wide.size == CGSize(width: 108, height: 20))
    // Items are vertically centered within their row.
    #expect(wide.origins == [CGPoint(x: 0, y: 5), CGPoint(x: 68, y: 0)])
    #expect(wide.firstRowHeight == 20)
    let narrow = ResponsiveControlsLayout.Plan(sizes: sizes, width: 107, horizontalSpacing: 8, verticalSpacing: 6)
    #expect(narrow.size == CGSize(width: 60, height: 36))
    #expect(narrow.origins == [CGPoint.zero, CGPoint(x: 0, y: 16)])
    #expect(narrow.firstRowHeight == 10)
    let empty = ResponsiveControlsLayout.Plan(sizes: [], width: 0, horizontalSpacing: 8, verticalSpacing: 6)
    #expect(empty.size == .zero)
}

@Test @MainActor func responsiveComposerDraftDoesNotPublishToStaticControls() {
    let composer = ComposerState()
    var controlsChanges = 0
    var editorChanges = 0
    let controls = composer.objectWillChange.sink { controlsChanges += 1 }
    let editor = composer.draftState.objectWillChange.sink { editorChanges += 1 }
    composer.draft = "  Send this  \n"
    composer.editorHeight = 72
    #expect(controlsChanges == 0)
    #expect(editorChanges == 2)
    #expect(composer.draftState.draft == composer.draft)
    #expect(composer.trimmed == "Send this")
    #expect(composer.canSend(changingModel: false))
    composer.draftState.draft = " \n "
    #expect(!composer.canSend(changingModel: false))
    composer.error = "Failure"
    #expect(controlsChanges == 1)
    withExtendedLifetime((controls, editor)) {}
}

@Test @MainActor func responsiveModelPresentationTracksCatalogReplacement() {
    let picker = ChatModelPickerState()
    #expect(picker.displayName(for: "provider/model") == "model")
    picker.models = ModelList(models: [
        ModelOption(id: "provider/model", provider: "provider", name: "New model", thinkingLevels: ["low", "high"]),
        ModelOption(id: "another/model", provider: "another", name: "Another"),
    ])
    #expect(picker.displayName(for: "provider/model") == "New model")
    #expect(picker.providers == ["another", "provider"])
    #expect(picker.modelsByProvider["provider"]?.count == 1)
    let session = SessionSummary(id: "s", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                                 state: "idle", model: "provider/model")
    #expect(picker.thinkingLevels(for: session) == ["low", "high"])
    picker.models = ModelList(models: [])
    #expect(picker.displayName(for: session.model) == "model")
    #expect(picker.thinkingLevels(for: session).isEmpty)
    #expect(picker.providers.isEmpty)
}

@Test @MainActor func composerUsagePresentationCachesAndShowsOnlyWhatMatters() {
    let state = ComposerUsageState()
    let now = Date()
    let context = ContextUsage(tokens: 1000, contextWindow: 10000)
    // A recent snapshot: stale ones add an age note to the help (covered by UsageTests).
    let quiet = SubscriptionUsage(fetchedAt: now.timeIntervalSince1970 * 1_000, provider: .anthropic,
                                  windows: [SubscriptionWindow(label: "Week", usedPercent: 42)])
    for _ in 0..<3 {
        let display = state.display(usage: SessionUsage(context: context, subscription: quiet), now: now)
        #expect(display.context?.help == context.helpText)
        #expect(display.context?.label == "10%")
        #expect(display.notice == nil)
    }
    let busy = SubscriptionUsage(fetchedAt: now.timeIntervalSince1970 * 1_000, provider: .anthropic,
                                 windows: [SubscriptionWindow(label: "5h", usedPercent: 86)])
    let display = state.display(usage: SessionUsage(subscription: busy), now: now)
    #expect(display.context == nil)
    #expect(display.notice?.text == "Claude 5-hour limit at 86%")
    #expect(display.notice?.help == busy.helpText)
    #expect(state.display(usage: SessionUsage(), now: now) == ComposerUsageState.Display())
}

@Test @MainActor func subscriptionNoticeTakesNoRoomUntilItMatters() {
    _ = NSApplication.shared
    func height(_ percent: Double) -> CGFloat {
        let usage = SessionUsage(subscription: SubscriptionUsage(
            fetchedAt: Date().timeIntervalSince1970 * 1_000, provider: .anthropic,
            windows: [SubscriptionWindow(label: "5h", usedPercent: percent)]))
        return NSHostingView(rootView: VStack(spacing: 8) {
            SubscriptionUsageNotice(usage: usage)
            Color.clear.frame(height: 10)
        }.frame(width: 400)).fittingSize.height
    }
    #expect(height(40) == 10)
    #expect(height(86) > 18)
}
