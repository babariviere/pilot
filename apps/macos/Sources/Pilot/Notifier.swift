import Foundation
import PilotCore
import UserNotifications

/// Native notifications when a session finishes or fails.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var onOpenSession: ((String) -> Void)?

    /// UserNotifications needs a real app bundle; `swift run` builds have none.
    private var available: Bool { Bundle.main.bundleIdentifier != nil }

    func requestAuthorization() {
        guard available else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func sessionChanged(from previous: SessionSummary?, to session: SessionSummary) {
        guard available, let previous else { return }
        let finished = previous.state == "working" && session.state == "idle"
        let failed = session.state == "failed"
        guard finished || failed else { return }
        let content = UNMutableNotificationContent()
        content.title = failed ? "Session failed" : "Session finished"
        content.body = failed ? (session.error ?? session.title) : session.title
        content.userInfo = ["sessionId": session.id]
        content.sound = .default
        let request = UNNotificationRequest(identifier: "\(session.id)-\(session.updatedAt)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let id = response.notification.request.content.userInfo["sessionId"] as? String
        Task { @MainActor in
            if let id { self.onOpenSession?(id) }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
