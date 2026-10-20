import AppKit

/// Routes real events through a mounted window, without requiring a particular SwiftUI renderer.
@MainActor public enum NativeInput {
    public static func views<T: NSView>(in root: NSView, of type: T.Type) -> [T] {
        (root as? T).map { [$0] } ?? root.subviews.flatMap { views(in: $0, of: type) }
    }

    public static func click(_ geometry: NSView) async throws {
        guard let window = geometry.window else {
            throw NSError(domain: "NativeInput", code: 1, userInfo: [NSLocalizedDescriptionKey: "Control is not mounted"])
        }
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        // Mounting the geometry does not mean SwiftUI has published its hit regions yet.
        await renderingTurn()
        guard !geometry.bounds.isEmpty else {
            throw NSError(domain: "NativeInput", code: 1, userInfo: [NSLocalizedDescriptionKey: "Control has no hit region"])
        }
        let point = geometry.convert(NSPoint(x: geometry.bounds.midX, y: geometry.bounds.midY), to: nil)
        func event(_ type: NSEvent.EventType) throws -> NSEvent {
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) else {
                throw NSError(domain: "NativeInput", code: 2)
            }
            return event
        }
        // Construct chronologically, but queue up first to release synchronous AppKit tracking.
        let down = try event(.leftMouseDown)
        let up = try event(.leftMouseUp)
        guard up.timestamp >= down.timestamp else { throw NSError(domain: "NativeInput", code: 3) }
        NSApp.postEvent(up, atStart: true)
        window.sendEvent(down)
        if let remaining = NSApp.nextEvent(matching: .leftMouseUp, until: Date(), inMode: .default, dequeue: true) {
            window.sendEvent(remaining)
        }
        // Newer renderers defer button actions until after event dispatch returns.
        await renderingTurn()
    }

    private static func renderingTurn() async {
        await withCheckedContinuation { continuation in
            let loop = CFRunLoopGetMain()
            let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue,
                false, CFIndex.max) { _, _ in continuation.resume() }
            CFRunLoopAddObserver(loop, observer, .commonModes)
            CFRunLoopWakeUp(loop)
        }
    }
}
