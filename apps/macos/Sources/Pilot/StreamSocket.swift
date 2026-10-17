import Foundation
import PilotCore
import PilotTelemetry

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
    static func task(_ url: URL, traceparent: String? = nil) -> URLSessionWebSocketTask {
        var request = URLRequest(url: url)
        if let traceparent, PilotTraceCarrier(traceparent: traceparent) != nil {
            request.setValue(traceparent, forHTTPHeaderField: "traceparent")
        }
        let task = session.webSocketTask(with: request)
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
    private let terminalBudget: Bool
    private let unavailable: @MainActor () -> Void
    private var pending: [String] = []
    private var pendingBytes = 0
    private var sending = false
    private var readsPaused = false
    /// Consumed by the first handshake only. A later reconnect is not the original open journey.
    private var traceparent: String?

    /// `url` is read on every connection, so it can carry resume state. `willConnect` runs just before.
    init(
        url: @escaping @MainActor () -> URL?,
        traceparent: String? = nil,
        willConnect: @escaping @MainActor () -> Void = {},
        terminalBudget: Bool = false,
        unavailable: @escaping @MainActor () -> Void = {},
        receive: @escaping @MainActor ([ServerUpdate]) -> Void
    ) {
        self.url = url
        self.traceparent = traceparent
        self.willConnect = willConnect
        self.receive = receive
        self.terminalBudget = terminalBudget
        self.unavailable = unavailable
    }

    func connect() {
        reconnect?.cancel()
        reconnect = nil
        reader?.cancel()
        reader = nil
        clearSends()
        guard !closed, let url = url() else { return }
        willConnect()
        let task = Self.task(url, traceparent: traceparent)
        traceparent = nil
        if terminalBudget { task.maximumMessageSize = 128 * 1024 }
        let reader = SocketReader(
            task: task, label: "pilot.stream-socket", boundedDelivery: terminalBudget,
            deliver: { [weak self] reader, updates in
                guard let self, self.reader === reader else { return }
                self.retry = 0
                self.receive(updates.compactMap { $0 })
            },
            failed: { [weak self] reader in
                guard let self, self.reader === reader else { return }
                self.reader = nil
                self.clearSends()
                self.unavailable()
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
        reader.setReadPaused(readsPaused)
        reader.start()
    }

    /// Reconnect now if disconnected, for example once pilotd is reachable again.
    func retryNow() {
        guard reader == nil, !closed else { return }
        retry = 0
        connect()
    }

    /// Dropped while disconnected, like input to a closed terminal.
    @discardableResult func send(_ message: [String: JSONValue]) -> Bool {
        guard reader != nil, let data = try? JSONEncoder().encode(JSONValue.object(message)),
              data.count <= (terminalBudget ? 128 * 1024 : 1024 * 1024),
              pending.count < 64, pendingBytes + data.count <= 256 * 1024 else { return false }
        pending.append(String(decoding: data, as: UTF8.self))
        pendingBytes += data.count
        pump()
        return true
    }

    private func pump() {
        guard !sending, let reader, let frame = pending.first else { return }
        sending = true
        reader.task.send(.string(frame)) { [weak self, weak reader] error in
            Task { @MainActor in
                guard let self, let reader, self.reader === reader else { return }
                self.sending = false
                if error != nil {
                    self.clearSends(); self.unavailable()
                    reader.task.cancel(with: .goingAway, reason: nil)
                    return
                }
                self.pending.removeFirst()
                self.pendingBytes -= frame.utf8.count
                self.pump()
            }
        }
    }

    private func clearSends() {
        pending.removeAll(); pendingBytes = 0; sending = false
    }
    func setReadPaused(_ paused: Bool) {
        readsPaused = paused
        reader?.setReadPaused(paused)
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
        clearSends()
    }
}
