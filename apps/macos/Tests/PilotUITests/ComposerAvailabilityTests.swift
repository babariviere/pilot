import AppKit
import SwiftUI
import Testing
@testable import Pilot

@Suite(.serialized) struct ComposerAvailabilityTests {
@Test @MainActor func disconnectedComposerActionsPreserveTextAndAttachmentsUntilReconnect() {
    let state = ComposerState()
    state.draft = "Message retained"
    let attachmentURL = FileManager.default.temporaryDirectory.appendingPathComponent("composer-offline-test.png")
    defer { try? FileManager.default.removeItem(at: attachmentURL) }
    state.attachments.items = [PastedImage(id: UUID(), url: attachmentURL, preview: NSImage(size: NSSize(width: 1, height: 1)))]
    var sent: [String] = []
    var scheduled = 0

    func composer(available: Bool) -> Composer {
        Composer(state: state, working: false, hostAvailable: available, queuedMessages: [],
                 completionDirectory: nil,
                 onSend: { message, _ in sent.append(message) }, onStop: {},
                 onEditQueuedMessage: { _, _, _ in }, onRemoveQueuedMessage: { _ in },
                 onSchedule: { _, _ in scheduled += 1 })
    }

    var view = composer(available: false)
    let host = NSHostingView(rootView: view.frame(width: 720))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 320),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = host
    window.orderFrontRegardless()
    defer { window.close() }
    window.update()
    host.layoutSubtreeIfNeeded()
    view.send(.steer) // The same submission action called by Return and the Send button.
    view.schedule(ScheduleWhen(trigger: .onBack))
    #expect(sent.isEmpty && scheduled == 0)
    #expect(state.draft == "Message retained" && state.attachments.items.count == 1)

    view = composer(available: true)
    host.rootView = view.frame(width: 720)
    host.layoutSubtreeIfNeeded()
    view.send(.steer)
    #expect(sent.count == 1 && sent[0].contains("Message retained") && sent[0].contains(attachmentURL.path))
    #expect(state.draft == "Message retained" && state.attachments.items.count == 1,
            "The composer retains its local draft until the normal send acknowledgment path handles it")
    view.schedule(ScheduleWhen(trigger: .onBack))
    #expect(scheduled == 1)
}

@Test @MainActor func disconnectedComposerBlocksReturnActionWithoutLosingTextDraft() {
    let state = ComposerState()
    state.draft = "Do not lose this"
    var sends = 0
    let composer = Composer(state: state, working: false, hostAvailable: false, queuedMessages: [],
                            completionDirectory: nil, onSend: { _, _ in sends += 1 }, onStop: {},
                            onEditQueuedMessage: { _, _, _ in }, onRemoveQueuedMessage: { _ in })
    let host = NSHostingView(rootView: composer.frame(width: 720))
    host.layoutSubtreeIfNeeded()
    composer.submit([]) // The production action wired to unmodified Return in ComposerDraftEditor.
    #expect(sends == 0)
    #expect(state.draft == "Do not lose this")
}
}
