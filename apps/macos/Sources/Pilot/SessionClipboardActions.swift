import AppKit
import PilotCore
import SwiftUI

/// Host-bound, cached metadata used by the two explicit copy actions. It performs no lookup or I/O.
struct SessionClipboardTarget: Equatable {
    let reference: HostResourceRef
    let sessionPath: String?
    let chatURL: String?

    init?(session: SessionSummary, reference: HostResourceRef) {
        guard reference.kind == .session, reference.localId == session.id else { return nil }
        self.reference = reference
        if let path = session.sessionPath, NSString(string: path).isAbsolutePath {
            sessionPath = path
        } else {
            sessionPath = nil
        }
        chatURL = DiagnosticTargetReference(host: reference.host, sessionId: session.id)?.chatURL
    }

    func copyPath(to pasteboard: NSPasteboard = .general) -> Bool {
        guard let sessionPath else { return false }
        return Self.copy(sessionPath, to: pasteboard)
    }

    func copyLink(to pasteboard: NSPasteboard = .general) -> Bool {
        guard let chatURL else { return false }
        return Self.copy(chatURL, to: pasteboard)
    }

    private static func copy(_ value: String, to pasteboard: NSPasteboard) -> Bool {
        pasteboard.clearContents()
        return pasteboard.setString(value, forType: .string)
    }
}

/// Shared by chat-row context menus and the toolbar's More chat actions menu.
struct SessionClipboardActions: View {
    @Environment(\.hostViewContext) private var hostContext
    @EnvironmentObject private var model: AppModel
    let session: SessionSummary

    private var target: SessionClipboardTarget? {
        guard let host = hostContext?.host ?? model.localHost else { return nil }
        return SessionClipboardTarget(session: session,
                                      reference: HostResourceRef(host: host, kind: .session, localId: session.id))
    }

    var body: some View {
        Button {
            if target?.copyPath() != true { model.sessionActionError = Self.pathUnavailable }
        } label: {
            Label(target?.sessionPath == nil ? "Copy session path (Unavailable)" : "Copy session path",
                  icon: PilotIcon.copy)
        }
        .disabled(target?.sessionPath == nil)
        .help(target?.sessionPath == nil ? Self.pathUnavailable : "Copy the session storage folder")

        Button {
            if target?.copyLink() != true { model.sessionActionError = Self.linkUnavailable }
        } label: {
            Label(target?.chatURL == nil ? "Copy session link (Unavailable)" : "Copy session link",
                  icon: PilotIcon.copy)
        }
        .disabled(target?.chatURL == nil)
        .help(target?.chatURL == nil ? Self.linkUnavailable : "Copy a Pilot link to this chat")
    }

    static let pathUnavailable = "The authoritative session folder is not available in cached metadata."
    static let linkUnavailable = "This chat does not have a canonical Pilot link."
}
