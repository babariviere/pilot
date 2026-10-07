import Foundation
import PilotCore
import UserNotifications

/// Native delivery. PilotCore's SessionAttention owns completion-version deduplication.
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

    func deliver(_ notification: SessionOutcomeNotification) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.userInfo = ["sessionId": notification.sessionId]
        content.sound = .default
        let request = UNNotificationRequest(identifier: notification.identifier, content: content, trigger: nil)
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
