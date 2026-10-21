import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@MainActor private func nativeRowFixture(active: Bool = false) -> NativeRowContext {
    let owner = MessageTextSelection()
    let configuration = NativeTranscript(presentation: TranscriptPresentation(), historyLimit: 40,
        resource: NativeTranscriptResource(sessionID: "native-row-fixture", host: nil), scroll: TranscriptScrollState(),
        toolExpansions: TranscriptExpansions(), messageExpansions: TranscriptExpansions(), environment: EnvironmentValues(),
        header: NativeTranscriptHeader(), footer: NativeTranscriptFooter(), loadEarlier: {})
    return NativeRowContext(configuration: configuration, selection: { _ in owner }, active: active, changed: {})
}

@MainActor private func hasConversationHost(_ view: NSView) -> Bool {
    if view is NSHostingView<AnyView> { return true }
    return view.subviews.contains { hasConversationHost($0) }
}

@MainActor private func awaitNativeSource(_ message: NativeMarkdownMessage, _ source: String) async throws {
    await message.preparation?.value
    try #require(message.preparedSource == source)
}

@Test @MainActor func nativeConversationAndChromeKindsDoNotMountSwiftUIRows() async {
    _ = NSApplication.shared
    let source = "An **assistant** response."
    await MarkdownView.prewarm(source)
    let context = nativeRowFixture()
    let rows: [ChatRow] = [
        .text(id: "reply", text: source),
        .user(id: "user", text: "Hello"),
        .notice(id: "notice", text: "An automatic event"),
        .error(id: "error", text: "A failed request"),
        .work(id: "work", group: TurnWork(rows: [.thinking(id: "thought", text: "Private thought", streaming: false)])),
        .artifact(id: "artifact", reference: ArtifactReference(id: "not-loaded", sessionId: "fixture", title: "Artifact", revision: 1)),
    ]
    let cell = NativeTranscriptCell()
    let native = NativeTranscript(presentation: TranscriptPresentation(), historyLimit: 40, resource: context.resource,
        scroll: TranscriptScrollState(), toolExpansions: context.toolExpansions, messageExpansions: context.messageExpansions,
        environment: context.environment, header: NativeTranscriptHeader(), footer: NativeTranscriptFooter(), loadEarlier: {})
    for row in rows {
        let owner = MessageTextSelection()
        cell.bind(item: .row(row.id), width: 760, row: row, configuration: native, selection: { _ in owner }, changed: {})
        let height = cell.measure(width: 760)
        #expect(height.isFinite && height > 0)
        #expect(!hasConversationHost(cell))
    }
    for item: NativeTranscriptItem in [.header, .earlier, .footer] {
        cell.bind(item: item, width: 760, row: nil, configuration: native,
                  selection: { _ in MessageTextSelection() }, changed: {})
        #expect(cell.measure(width: 760) >= 1)
        #expect(!hasConversationHost(cell))
    }
    cell.unbind()
}

@Test @MainActor func nativeUserBubbleHugsProseButCodeUsesTheAvailableBubbleWidth() async {
    _ = NSApplication.shared
    let short = "Hello **world**"
    let fence = String(repeating: "\u{0060}", count: 3)
    let code = fence + "swift\nlet value = 1\n" + fence
    await MarkdownView.prewarm(short)
    await MarkdownView.prewarm(code)
    let view = NativeUserMessage()
    view.bind(.user(id: "short", text: short), context: nativeRowFixture())
    _ = view.measure(width: 760)
    #expect(view.message.frame.width < 300)
    view.bind(.user(id: "code", text: code), context: nativeRowFixture())
    _ = view.measure(width: 760)
    #expect(view.message.frame.width == 660)
    #expect(!hasConversationHost(view))
    view.stop()
}

@Test @MainActor func nativeLongUserMessageDoesNotPrepareFullMarkdownUntilExpanded() async throws {
    _ = NSApplication.shared
    let source = String(repeating: "A long user message.\n", count: 70)
    let context = nativeRowFixture()
    let view = NativeUserMessage()
    view.bind(.user(id: "long-user", text: source), context: context)
    let folded = view.measure(width: 760)
    #expect(view.message.nativeTextViews.isEmpty)
    #expect(view.message.preparedSource == nil)
    let activated = view.activate()
    #expect(activated)
    try await Task.sleep(for: .milliseconds(20))
    try await awaitNativeSource(view.message, source)
    #expect(view.measure(width: 760) > folded)
    let owner = context.selection("long-user")
    owner.selectAll()
    #expect(owner.selectedText == source)
    view.stop()
}

@Test @MainActor func nativeActiveWorkDisclosureClosesOnTheFirstActivation() async throws {
    _ = NSApplication.shared
    let context = nativeRowFixture(active: true)
    let note = "A note inside the work group."
    await MarkdownView.prewarm(note)
    let view = NativeWorkGroup()
    view.bind(.work(id: "work", group: TurnWork(rows: [
        .thinking(id: "thought", text: "Thinking", streaming: true),
        .text(id: "note", text: note),
    ])), context: context)
    let initial = view.measure(width: 760)
    #expect(initial > 30)
    let closed = view.activate()
    #expect(closed)
    try await Task.sleep(for: .milliseconds(20))
    #expect(context.messageExpansions.state(for: "work").choice == false)
    #expect(view.measure(width: 760) < initial)
    #expect(!hasConversationHost(view))
    view.stop()
}

@Test @MainActor func nativeRowObservationFencesQueuedChangesFromThePreviousBinding() async throws {
    let first = ExpansionState()
    let second = ExpansionState()
    let observation = NativeRowObservation()
    var oldChanges = 0
    var newChanges = 0
    observation.bind([first.objectWillChange]) { oldChanges += 1 }
    first.expanded = true
    observation.bind([second.objectWillChange]) { newChanges += 1 }
    try await Task.sleep(for: .milliseconds(20))
    #expect(oldChanges == 0 && newChanges == 0)
    second.expanded = true
    try await Task.sleep(for: .milliseconds(20))
    #expect(oldChanges == 0 && newChanges == 1)
    observation.stop()
}

@Test @MainActor func nativeMarkdownLinksUseTheCurrentSurfaceActionAfterReuse() async throws {
    _ = NSApplication.shared
    let source = "[A link](https://example.com)"
    let url = try #require(URL(string: "https://example.com"))
    let message = NativeMarkdownMessage()
    var first = 0
    var second = 0
    var environment = EnvironmentValues()
    environment.openURL = OpenURLAction { _ in first += 1; return .handled }
    message.update(source: source, timestamp: nil, streaming: false, selection: MessageTextSelection(),
                   environment: environment, changed: {})
    try await awaitNativeSource(message, source)
    let text = try #require(message.nativeTextViews.first)
    let handled = text.textView(text, clickedOnLink: url, at: 0)
    #expect(handled && first == 1 && second == 0)
    environment.openURL = OpenURLAction { _ in second += 1; return .handled }
    message.update(source: source, timestamp: nil, streaming: false, selection: MessageTextSelection(),
                   environment: environment, changed: {})
    let rebound = text.textView(text, clickedOnLink: url, at: 0)
    #expect(rebound && first == 1 && second == 1)
    message.stop()
}
