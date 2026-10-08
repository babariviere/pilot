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
    #expect(wide.origins == [CGPoint.zero, CGPoint(x: 68, y: 0)])
    let narrow = ResponsiveControlsLayout.Plan(sizes: sizes, width: 107, horizontalSpacing: 8, verticalSpacing: 6)
    #expect(narrow.size == CGSize(width: 60, height: 36))
    #expect(narrow.origins == [CGPoint.zero, CGPoint(x: 0, y: 16)])
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

@Test @MainActor func responsiveUsagePresentationInvalidatesAndPreservesHelp() {
    let state = UsageFooterState()
    let window = SubscriptionWindow(label: "Weekly", usedPercent: 42, resetsAt: "2026-01-01T00:00:00Z")
    let context = ContextUsage(tokens: 1000, contextWindow: 10000)
    let subscription = SubscriptionUsage(fetchedAt: 1000, provider: .anthropic, windows: [window])
    let usage = SessionUsage(context: context, subscription: subscription)
    for _ in 0..<3 {
        let display = state.display(usage: usage, model: "anthropic/model")
        #expect(display.context?.help == context.helpText)
        #expect(display.windows.first?.help == window.helpText)
        #expect(display.subscriptionHelp == subscription.helpText)
    }
    let fallback = state.display(usage: SessionUsage(), model: "openai-codex/model")
    #expect(fallback.windows.isEmpty)
    #expect(fallback.hasSubscription)
    #expect(fallback.subscriptionHelp == SubscriptionProvider.openai.unavailableHelpText)
    let cleared = state.display(usage: SessionUsage(subscription: SubscriptionUsage(fetchedAt: 2000, windows: [])),
                                model: "anthropic/model")
    #expect(!cleared.hasSubscription)
    #expect(cleared.context == nil)
}

@Test @MainActor func responsiveNestedUsageControlsWrapAtNarrowWidths() {
    _ = NSApplication.shared
    let usage = SessionUsage(context: ContextUsage(tokens: 10000, contextWindow: 200000),
                             subscription: SubscriptionUsage(fetchedAt: 1000, provider: .anthropic, windows: [
                                SubscriptionWindow(label: "Session", usedPercent: 12),
                                SubscriptionWindow(label: "Weekly", usedPercent: 45),
                             ]))
    func size(_ width: CGFloat) -> CGSize {
        NSHostingView(rootView: UsageFooter(usage: usage)
            .frame(width: width, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)).fittingSize
    }
    let wide = size(600)
    let narrow = size(145)
    #expect(wide.height > 0)
    #expect(narrow.height > wide.height * 2)
    #expect(abs(narrow.width - 145) < 0.01)
}
