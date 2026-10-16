import Foundation
import PilotCore

/// A private, explicit attachment to an existing pre-chat PTY. No retry, transcript or output replay.
/// Closing the attachment does not cancel the independent host-owned helper.
@MainActor
final class SetupTerminalConnection {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private let isCurrent: () -> Bool
    private let receive: (SetupServerMessage) -> Void
    private let onClose: () -> Void
    private var reader: Task<Void, Never>?
    private var challenge: SetupChallenge?
    private var closed = false
    private var inputBytes = 0
    private var outputBytes = 0

    deinit {
        reader?.cancel()
        socket.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }

    init(url: URL, configuration: URLSessionConfiguration, isCurrent: @escaping () -> Bool,
         receive: @escaping (SetupServerMessage) -> Void, onClose: @escaping () -> Void) {
        let session = URLSession(configuration: configuration)
        let socket = session.webSocketTask(with: url)
        self.session = session; self.socket = socket
        self.isCurrent = isCurrent; self.receive = receive
        self.onClose = onClose
        socket.maximumMessageSize = 16 * 1024
        socket.resume()
        reader = Task { [weak self, socket] in
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard let self, !self.closed, self.isCurrent() else { self?.close(); return }
                    let data: Data
                    switch message {
                    case let .data(bytes): data = bytes
                    case let .string(text): data = Data(text.utf8)
                    @unknown default: self.close(); return
                    }
                    guard data.count <= 16 * 1024 else { self.close(); return }
                    self.outputBytes += data.count
                    guard self.outputBytes <= 64 * 1024 else { self.close(); return }
                    let update = try JSONDecoder().decode(SetupServerMessage.self, from: data)
                    switch update {
                    case let .challenge(value): self.challenge = value
                    case let .state(run) where run.state != .waiting: self.challenge = nil
                    default: break
                    }
                    self.receive(update)
                }
            } catch {
                guard let self, !self.closed else { return }
                if self.isCurrent() { self.receive(.error("Setup connection interrupted. Reattach explicitly on the selected host.")) }
                self.close()
            }
        }
    }

    /// A whole hidden challenge answer. Never automatically replay after send failure or reconnect.
    func answer(challengeId: String, answer: String) async throws {
        guard !closed, isCurrent(), let challenge, challenge.type == .manualCode,
              challenge.id == challengeId, answer.utf8.count <= 4096 else {
            throw HostRoutingError.staleGeneration
        }
        let data = try JSONEncoder().encode(Answer(type: "setup.answer", challengeId: challengeId, answer: answer))
        guard inputBytes + data.count <= 16 * 1024 else { close(); throw HostRoutingError.invalidReference }
        inputBytes += data.count
        self.challenge = nil
        do { try await socket.send(.data(data)) }
        catch { close(); throw HostRoutingError.disconnected }
        guard isCurrent() else { close(); throw HostRoutingError.staleGeneration }
    }

    func resize(cols: Int, rows: Int) async throws {
        guard !closed, isCurrent(), (1 ... 500).contains(cols), (1 ... 500).contains(rows) else {
            throw HostRoutingError.invalidReference
        }
        let data = try JSONEncoder().encode(Resize(type: "setup.resize", cols: cols, rows: rows))
        // Also bound the client's own enqueued control traffic over the entire attachment lifetime.
        guard inputBytes + data.count <= 16 * 1024 else { close(); throw HostRoutingError.invalidReference }
        inputBytes += data.count
        do { try await socket.send(.data(data)) }
        catch { close(); throw HostRoutingError.disconnected }
    }

    func close() {
        guard !closed else { return }
        closed = true; challenge = nil
        reader?.cancel(); reader = nil
        socket.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
        onClose()
    }

    private struct Answer: Encodable { let type: String; let challengeId: String; let answer: String }
    private struct Resize: Encodable { let type: String; let cols: Int; let rows: Int }
}
