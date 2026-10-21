import Foundation
import PilotCore

/// Every Control conversation is retained history, including the former Mac singleton.
enum RetainedConversation {
    static func isHistory(_ session: SessionSummary, reference: HostResourceRef?, localHost: HostRef?) -> Bool {
        session.isRetainedHistory
    }
}

extension AppModel {
    var isRetainedHistorySelected: Bool {
        guard let session = selectedSession else { return false }
        return RetainedConversation.isHistory(session, reference: hosts.selection, localHost: localHost)
    }

    /// Unknown qualified targets cannot become a writable history during inventory recovery.
    func canMutateSession(_ id: String) -> Bool {
        if client.session(id)?.isRetainedHistory == true { return false }
        guard let reference = resourceRef(id, kind: .session) else { return true }
        if reference.host == localHost { return client.session(reference.localId)?.isRetainedHistory != true }
        guard let session = hosts.sessions.first(where: { $0.ref == reference })?.value else { return false }
        return !RetainedConversation.isHistory(session, reference: reference, localHost: localHost)
    }
}
