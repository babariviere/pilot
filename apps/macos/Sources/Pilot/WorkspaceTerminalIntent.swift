import Foundation

/// Retained across endpoint replacement. A lost open/restart reply reuses its key and daemon boot.
@MainActor
final class WorkspaceTerminalIntent {
    let requestId = UUID().uuidString
    let restart: Bool
    var bootId: String?
    var terminalId: String?
    init(restart: Bool = false) { self.restart = restart }
}

enum TerminalConnectionState: Equatable {
    case connecting, connected, disconnected, closing, unavailable(String)
}
