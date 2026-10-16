import Foundation
import PilotCore

/// A reconnecting dedicated WebSocket for one stream: a chat, a terminal or a subagent transcript. Each stream
/// has its own connection, reader and backoff, so a large or slow stream never delays another.
@MainActor
final class StreamSocket {
    /// Shared by all of the app's WebSockets. Allows one connection per open stream, not six per host.
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpMaximumConnectionsPerHost = 64
        return URLSession(configuration: configuration)
    }()

    /// A new task for `url`. Snapshots of long transcripts exceed the 1 MiB default message size.
    static func task(_ url: URL) -> URLSessionWebSocketTask {
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 64 * 1024 * 1024
        return task
    }

    private let url: @MainActor () -> URL?
    private let willConnect: @MainActor () -> Void
    private let receive: @MainActor ([ServerUpdate]) -> Void
    private var reader: SocketReader?
    private var retry = 0
    private var reconnect: Task<Void, Never>?
    private var closed = false

    /// `url` is read on every connection, so it can carry resume state. `willConnect` runs just before.
    init(
        url: @escaping @MainActor () -> URL?,
        willConnect: @escaping @MainActor () -> Void = {},
        receive: @escaping @MainActor ([ServerUpdate]) -> Void
    ) {
        self.url = url
        self.willConnect = willConnect
        self.receive = receive
    }

    func connect() {
        reconnect?.cancel()
        reconnect = nil
        reader?.cancel()
        reader = nil
        guard !closed, let url = url() else { return }
        willConnect()
        let reader = SocketReader(
            task: Self.task(url), label: "pilot.stream-socket",
            deliver: { [weak self] reader, updates in
                guard let self, self.reader === reader else { return }
                self.retry = 0
                self.receive(updates.compactMap { $0 })
            },
            failed: { [weak self] reader in
                guard let self, self.reader === reader else { return }
                self.reader = nil
                // 4400–4499: pilotd refused this stream for good (unknown target, read-only session).
                if (4400..<4500).contains(reader.task.closeCode.rawValue) { return }
                let delay = min(10.0, 0.5 * pow(2.0, Double(self.retry)))
                self.retry += 1
                self.reconnect = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled, let self, self.reader == nil else { return }
                    self.connect()
                }
            }
        )
        self.reader = reader
        reader.start()
    }

    /// Reconnect now if disconnected, for example once pilotd is reachable again.
    func retryNow() {
        guard reader == nil, !closed else { return }
        retry = 0
        connect()
    }

    /// Dropped while disconnected, like input to a closed terminal.
    func send(_ message: [String: JSONValue]) {
        guard let reader, let data = try? JSONEncoder().encode(JSONValue.object(message)) else { return }
        reader.task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    }

    func close() {
        closed = true
        suspend()
    }

    /// The control connection lost its identity/availability gate. Retain subscriptions, not sockets.
    func suspend() {
        reconnect?.cancel()
        reconnect = nil
        reader?.cancel()
        reader = nil
    }
}
