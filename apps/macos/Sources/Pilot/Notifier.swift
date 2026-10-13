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

    func deliverReadyPullRequest(sessionId: String, title: String, number: Int) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = "Ready to merge"
        content.body = "\(title) · PR #\(number)"
        content.userInfo = ["sessionId": sessionId]
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "pr-ready-\(sessionId)-\(number)", content: content, trigger: nil)
        )
    }

    /// A scheduled chat or follow-up started or could not start. Opens its chat when there is one.
    func deliverScheduled(id: String, title: String, body: String, sessionId: String?) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let sessionId { content.userInfo = ["sessionId": sessionId] }
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "schedule-\(id)", content: content, trigger: nil)
        )
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
