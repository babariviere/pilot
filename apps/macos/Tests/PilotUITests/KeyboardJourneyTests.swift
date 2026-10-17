import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

/// Keyboard-only journeys through the real main window with fixture data: the SwiftUI views, their AppKit
/// responders and the app's key router, with no daemon, user data or side effects. Synthesized key events go through
/// the router first and then to the window, as AppKit delivers them; menu key equivalents (⌘[, ⌘N) are not part
/// of a hosted window, so those steps call the menu's action.
@MainActor
private final class Journey {
    let model: AppModel
    let window: NSWindow
    let router = KeyboardRouter()

    init() throws {
        _ = NSApplication.shared
        let defaults = try #require(UserDefaults(suiteName: "keyboard-journey-\(UUID())"))
        model = AppModel(projectFolderDefaults: defaults)
        try model.registerLocal(HostRef(hostId: "local", daemonId: "journey", lineageId: "journey"))
        let project = Project(id: "p1", name: "Fixture project", path: "/tmp/keyboard-journey", createdAt: 1)
        model.client.loadFixture(projects: [project], sessions: [
            SessionSummary(id: "c1", title: "First fixture chat", cwd: project.path, projectId: project.id,
                           createdAt: 1, updatedAt: 3, state: "idle"),
            SessionSummary(id: "c2", title: "Second fixture chat", cwd: project.path, projectId: project.id,
                           createdAt: 1, updatedAt: 2, state: "idle"),
        ])
        // Shows pages instead of "Starting pilotd…"; nothing is started or contacted.
        AppModel.shared.daemon.markRunningForSnapshot()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .resizable],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MainWindow().environmentObject(model)
            .environment(\.pilotFonts, model.settings.fonts))
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless()
        // The window's views register their regions with this fixture's keyboard state, not the app's.
        let keyboard = model.keyboard
        router.focus = keyboard
        router.perform = { [model] route in
            switch route {
            case .focusNextRegion: keyboard.cycle(forward: true); return true
            case .focusPreviousRegion: keyboard.cycle(forward: false); return true
            case .focusComposer: return keyboard.focus(.composer)
            default: return model.performKeyboardRoute(route)
            }
        }
    }

    func close() {
        window.contentView = nil
        window.close()
    }

    func settle(_ seconds: Double = 0.1) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            window.contentView?.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
    }

    @discardableResult
    func wait(_ condition: () -> Bool) -> Bool {
        for _ in 0..<100 {
            if condition() { return true }
            settle(0.03)
        }
        return condition()
    }

    /// One key press: the router first, then the window for anything it delivers.
    func press(_ characters: String, keyCode: UInt16, _ modifiers: NSEvent.ModifierFlags = []) {
        guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                                           windowNumber: window.windowNumber, context: nil, characters: characters,
                                           charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode)
        else { return }
        if let delivered = router.handle(event) { window.sendEvent(delivered) }
        settle(0.05)
    }

    var responder: NSResponder? { window.firstResponder }
}

// A busy CI runner makes hosted windows slow to settle; each step still waits at most three seconds.
@Test(.timeLimit(.minutes(3))) @MainActor
func keyboardOnlyStartSwitchTypeAndReturn() throws {
    let journey = try Journey()
    defer { journey.close() }
    let model = journey.model
    let keyboard = model.keyboard
    #expect(journey.wait { keyboard.visibleRegions.contains(.sidebar) && keyboard.visibleRegions.contains(.composer) },
            "Home shows the sidebar, page and new-chat composer regions")
    #expect(model.currentRoute == .home)

    // ⌃⇥ walks the regions in order: sidebar, page, composer.
    journey.press("\t", keyCode: 48, .control)
    #expect(journey.wait { journey.responder is NSTableView }, "the sidebar's outline takes focus")
    #expect(keyboard.currentRegion() == .sidebar)
    journey.press("\t", keyCode: 48, .control)
    #expect(journey.wait { keyboard.currentRegion() == .content })
    journey.press("\t", keyCode: 48, .control)
    #expect(journey.wait { journey.responder is SubmitTextView }, "the new-chat editor takes focus")

    // In the editor, letters are text: G types, and no navigation sequence starts.
    journey.press("g", keyCode: 5)
    #expect(!keyboard.sequenceIsPending)
    #expect(journey.wait { model.newSessionForm.message == "g" })

    // Escape leaves the composer for the page with the draft kept; G then I opens the Inbox.
    journey.press("\u{1b}", keyCode: 53)
    #expect(journey.wait { !(journey.responder is SubmitTextView) })
    journey.press("g", keyCode: 5)
    #expect(keyboard.sequenceIsPending)
    journey.press("i", keyCode: 34)
    #expect(journey.wait { model.showingInbox })
    #expect(model.newSessionForm.message == "g", "navigating never sends or clears the draft")

    // ⌘[ (Go → Back) returns Home; the draft is still there.
    model.navigateBack()
    #expect(journey.wait { model.currentRoute == .home })
    #expect(model.newSessionForm.message == "g")

    // ⌘L from the page puts the caret back in the composer.
    journey.press("l", keyCode: 37, .command)
    #expect(journey.wait { journey.responder is SubmitTextView })
}

// A busy CI runner makes hosted windows slow to settle; each step still waits at most three seconds.
@Test(.timeLimit(.minutes(3))) @MainActor
func keyboardOnlySidebarBrowsingKeepsFocusInTheSidebar() throws {
    let journey = try Journey()
    defer { journey.close() }
    let model = journey.model
    let keyboard = model.keyboard
    #expect(journey.wait { keyboard.visibleRegions.contains(.sidebar) })
    journey.press("\t", keyCode: 48, .control)
    #expect(journey.wait { journey.responder is NSTableView })
    // J moves like Down; arrowing onto a chat opens it, and its composer does not take the focus.
    for _ in 0..<3 where model.selectedSessionId == nil { journey.press("j", keyCode: 38) }
    #expect(journey.wait { model.selectedSessionId != nil }, "J reached a chat row")
    journey.settle(0.4)
    #expect(journey.responder is NSTableView, "browsing keeps focus in the sidebar")
    // ⌘L enters that chat's composer explicitly.
    journey.press("l", keyCode: 37, .command)
    #expect(journey.wait { journey.responder is SubmitTextView })
}
