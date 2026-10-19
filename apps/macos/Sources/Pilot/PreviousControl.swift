import Foundation
import PilotCore

/// Presentation only. Never changes the stored session, daemon role, watch or permission state.
enum PreviousControl {
    static func isHistory(_ session: SessionSummary, reference: HostResourceRef?, localHost: HostRef?) -> Bool {
        session.isControl && reference.map { $0.kind == .session && $0.host != localHost } == true
    }
}

extension AppModel {
    var previousControlSessions: [Hosted<SessionSummary>] {
        hosts.sessions.filter { PreviousControl.isHistory($0.value, reference: $0.ref, localHost: localHost) }
    }

    var isPreviousControlSelected: Bool {
        guard let session = selectedSession else { return false }
        return PreviousControl.isHistory(session, reference: hosts.selection, localHost: localHost)
    }

    /// Unknown qualified targets cannot become a writable history during inventory recovery.
    func canMutateSession(_ id: String) -> Bool {
        guard let reference = resourceRef(id, kind: .session), reference.host != localHost else { return true }
        guard let session = hosts.sessions.first(where: { $0.ref == reference })?.value else { return false }
        return !PreviousControl.isHistory(session, reference: reference, localHost: localHost)
    }
}
