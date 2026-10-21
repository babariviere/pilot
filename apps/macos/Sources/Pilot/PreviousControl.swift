import Foundation
import PilotCore

/// Every Control conversation is retained history, including the former Mac singleton.
enum PreviousControl {
    static func isHistory(_ session: SessionSummary, reference: HostResourceRef?, localHost: HostRef?) -> Bool {
        session.isControl
    }
}

extension AppModel {
    var isPreviousControlSelected: Bool {
        guard let session = selectedSession else { return false }
        return PreviousControl.isHistory(session, reference: hosts.selection, localHost: localHost)
    }

    /// Unknown qualified targets cannot become a writable history during inventory recovery.
    func canMutateSession(_ id: String) -> Bool {
        if client.session(id)?.isControl == true { return false }
        guard let reference = resourceRef(id, kind: .session) else { return true }
        if reference.host == localHost { return client.session(reference.localId)?.isControl != true }
        guard let session = hosts.sessions.first(where: { $0.ref == reference })?.value else { return false }
        return !PreviousControl.isHistory(session, reference: reference, localHost: localHost)
    }
}
