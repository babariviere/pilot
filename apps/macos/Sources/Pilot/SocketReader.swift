import Foundation
import PilotCore

/// Reads one WebSocket in order without a main-actor round trip per frame. Frames are decoded on this
/// socket's own serial queue, and the next frame is requested as soon as one is decoded, so a large snapshot
/// on one socket never holds up another socket. Decoded updates reach the main actor in ordered batches.
final class SocketReader: @unchecked Sendable {
    let task: URLSessionWebSocketTask
    private let queue: DispatchQueue
    private let failed: @MainActor (SocketReader) -> Void
    private var batcher: MainBatcher<ServerUpdate?>!
    private let lock = NSLock()
    private var cancelled = false
    private var readsPaused = false
    private var receiveWaiting = false
    private let boundedDelivery: Bool

    /// `deliver` receives `nil` for frames that did not decode, which still prove the socket is live.
    /// `failed` runs after every update received before the failure has been delivered.
    init(
        task: URLSessionWebSocketTask, label: String,
        boundedDelivery: Bool = false,
        deliver: @escaping @MainActor (SocketReader, [ServerUpdate?]) -> Void,
        failed: @escaping @MainActor (SocketReader) -> Void
    ) {
        self.task = task
        self.boundedDelivery = boundedDelivery
        queue = DispatchQueue(label: label, qos: .userInitiated)
        self.failed = failed
        batcher = MainBatcher { [weak self] updates in
            guard let self, !self.isCancelled else { return }
            deliver(self, updates)
        }
    }

    func start() {
        task.resume()
        receive()
    }

    /// No updates or failure are delivered after cancellation.
    func cancel() {
        lock.withLock { cancelled = true }
        task.cancel(with: .goingAway, reason: nil)
    }

    private var isCancelled: Bool { lock.withLock { cancelled } }

    func setReadPaused(_ paused: Bool) {
        let resume = lock.withLock {
            readsPaused = paused
            guard !paused, receiveWaiting, !cancelled else { return false }
            receiveWaiting = false
            return true
        }
        if resume { receive() }
    }

    private func receive() {
        let allowed = lock.withLock {
            guard !cancelled else { return false }
            if readsPaused { receiveWaiting = true; return false }
            receiveWaiting = false
            return true
        }
        guard allowed else { return }
        task.receive { [self] result in
            // URLSession calls back on its shared delegate queue. Decode on this socket's queue instead.
            queue.async { [self] in
                guard !isCancelled else { return }
                switch result {
                case let .success(message):
                    let data: Data
                    switch message {
                    case let .string(text): data = Data(text.utf8)
                    case let .data(value): data = value
                    @unknown default: data = Data()
                    }
                    let message = try? ServerUpdate.decode(data)
                    batcher.append(message)
                    if boundedDelivery {
                        batcher.after { [weak self] in
                            guard let self, !self.isCancelled else { return }
                            self.receive()
                        }
                    } else { receive() }
                case .failure:
                    batcher.after { [self] in
                        if !isCancelled { failed(self) }
                    }
                }
            }
        }
    }
}
