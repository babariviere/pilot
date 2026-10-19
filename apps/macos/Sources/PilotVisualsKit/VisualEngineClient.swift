import Foundation

/// A request to the visual service.
public enum VisualMessage: Sendable {
    case load(id: String, VisualLoadRequest)
    case event(id: String, handler: String, value: Data)
    case probe
}

/// Carries messages to the visual service. VisualXPCTransport is the real one; tests run the engine in process.
public protocol VisualTransport: Sendable {
    func send(_ message: VisualMessage) async -> Result<Data, VisualFailure>
    /// Runs one canvas draw. The data is a drawing ("PD") or an error envelope.
    func draw(_ id: String, _ request: VisualDrawRequest) async -> Result<Data, VisualFailure>
    func release(_ id: String)
}

/// Runs visuals in the sandboxed service and keeps what each live visual needs to start again, so an engine
/// released by the service (least recently used, or lost in a crash) comes back with its saved state on the
/// next event. Requests for one visual run in order.
public actor VisualEngineClient {
    public static let shared = VisualEngineClient(transport: VisualXPCTransport())

    /// Visuals whose load request is kept for restarts; the least recently used is forgotten first.
    static let sessionLimit = 64

    private struct Session {
        var request: VisualLoadRequest
        var used: UInt64
    }

    private let transport: VisualTransport
    private var sessions: [String: Session] = [:]
    private var tails: [String: Task<Void, Never>] = [:]
    private var clock: UInt64 = 0

    public init(transport: VisualTransport) {
        self.transport = transport
    }

    /// Starts visual id (one per live view), replacing a running one with the same id.
    public func load(_ id: String, _ request: VisualLoadRequest) async -> Result<VisualFrame, VisualFailure> {
        await serialized(id) { client in await client.performLoad(id, request) }
    }

    /// Runs one handler with a value and returns the next tree.
    public func event(_ id: String, handler: String, value: VisualValue) async -> Result<VisualFrame, VisualFailure> {
        await serialized(id) { client in await client.performEvent(id, handler: handler, value: value.jsonData) }
    }

    /// Runs a canvas's draw function and returns its commands.
    public func draw(_ id: String, _ request: VisualDrawRequest) async -> Result<VisualDrawing, VisualFailure> {
        await serialized(id) { client in await client.performDraw(id, request) }
    }

    /// Forgets visual id and releases its engine.
    public func release(_ id: String) {
        sessions[id] = nil
        transport.release(id)
    }

    /// The service's engine version and sandbox status, for packaging checks.
    public func probe() async -> Result<VisualValue, VisualFailure> {
        switch await transport.send(.probe) {
        case .success(let data):
            guard let value = try? VisualWire.decode(data) else { return .failure(.invalidReply) }
            return .success(value)
        case .failure(let failure):
            return .failure(failure)
        }
    }

    private func serialized<T: Sendable>(
        _ id: String, _ operation: @escaping @Sendable (VisualEngineClient) async -> T
    ) async -> T {
        let previous = tails[id]
        let task = Task { () -> T in
            await previous?.value
            return await operation(self)
        }
        let tail = Task { _ = await task.value }
        tails[id] = tail
        let result = await task.value
        if tails[id] == tail { tails[id] = nil }
        return result
    }

    private func performLoad(_ id: String, _ request: VisualLoadRequest) async -> Result<VisualFrame, VisualFailure> {
        remember(id, request)
        let result = await send(.load(id: id, request))
        record(id, result)
        return result
    }

    private func performEvent(_ id: String, handler: String, value: Data) async -> Result<VisualFrame, VisualFailure> {
        let result = await send(.event(id: id, handler: handler, value: value))
        guard case .failure(.script(let error)) = result, error.kind == .unloaded else {
            record(id, result)
            return result
        }
        // The service released this engine or relaunched. Start it again from the saved state, then retry once.
        guard let session = sessions[id] else {
            return .failure(.unavailable("This visual is no longer loaded."))
        }
        switch await send(.load(id: id, session.request)) {
        case .success(let frame):
            record(id, .success(frame))
        case .failure(let failure):
            return .failure(failure)
        }
        let retried = await send(.event(id: id, handler: handler, value: value))
        record(id, retried)
        return retried
    }

    private func performDraw(_ id: String, _ request: VisualDrawRequest) async -> Result<VisualDrawing, VisualFailure> {
        let result = await sendDraw(id, request)
        guard case .failure(.script(let error)) = result, error.kind == .unloaded else { return result }
        // As for events: start the engine again from the saved state, then draw once more.
        guard let session = sessions[id] else { return .failure(.unavailable("This visual is no longer loaded.")) }
        switch await send(.load(id: id, session.request)) {
        case .success(let frame): record(id, .success(frame))
        case .failure(let failure): return .failure(failure)
        }
        return await sendDraw(id, request)
    }

    private func sendDraw(_ id: String, _ request: VisualDrawRequest) async -> Result<VisualDrawing, VisualFailure> {
        switch await transport.draw(id, request) {
        case .success(let data):
            if VisualDrawing.isDrawing(data) { return VisualDrawing(data).map { .success($0) } ?? .failure(.invalidReply) }
            switch VisualReply.decode(data) {
            case .success: return .failure(.invalidReply)
            case .failure(let failure): return .failure(failure)
            }
        case .failure(let failure):
            return .failure(failure)
        }
    }

    private func send(_ message: VisualMessage) async -> Result<VisualFrame, VisualFailure> {
        switch await transport.send(message) {
        case .success(let data): return VisualReply.decode(data)
        case .failure(let failure): return .failure(failure)
        }
    }

    private func remember(_ id: String, _ request: VisualLoadRequest) {
        clock += 1
        sessions[id] = Session(request: request, used: clock)
        if sessions.count > Self.sessionLimit,
           let oldest = sessions.min(by: { $0.value.used < $1.value.used })?.key {
            sessions[oldest] = nil
            transport.release(oldest)
        }
    }

    /// Keeps the latest state, so a restart resumes where the reader left the visual.
    private func record(_ id: String, _ result: Result<VisualFrame, VisualFailure>) {
        guard case .success(let frame) = result, var session = sessions[id] else { return }
        clock += 1
        session.request.state = frame.state
        session.used = clock
        sessions[id] = session
    }
}

/// Talks to the PilotVisuals XPC service bundled in Pilot.app. Launch, relaunch after a crash and
/// sandboxing are launchd's; a crash fails the requests in flight with VisualFailure.crashed and never
/// affects Pilot's process.
public final class VisualXPCTransport: VisualTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var connection: NSXPCConnection?
    private var generation = 0
    private let timeout: TimeInterval
    /// Created on the first draw and shared with every connection after it.
    private var ring: VisualDrawRing?

    /// timeout bounds a whole request. The engine interrupts scripts within a second; this catches a stuck
    /// service. It exceeds launchd's 10 second relaunch throttle, so a request sent right after a crash waits for
    /// the relaunch instead of failing.
    public init(timeout: TimeInterval = 15) {
        self.timeout = timeout
    }

    public func send(_ message: VisualMessage) async -> Result<Data, VisualFailure> {
        await request { proxy, reply in
            switch message {
            case .load(let id, let request):
                proxy.load(id, runtime: request.runtime, source: request.source, data: request.data,
                           state: request.state, seed: request.seed, now: request.now, reply: reply)
            case .event(let id, let handler, let value):
                proxy.event(id, handler: handler, value: value, reply: reply)
            case .probe:
                proxy.probe(reply)
            }
        }
    }

    public func draw(_ id: String, _ request: VisualDrawRequest) async -> Result<Data, VisualFailure> {
        let ring = drawRing()
        let slot = ring?.acquire()
        defer { if let slot { ring?.release(slot) } }
        return await self.request { proxy, reply in
            proxy.draw(id, canvas: request.canvas, width: request.width, height: request.height, time: request.time,
                       pointerX: request.pointer?.x ?? 0, pointerY: request.pointer?.y ?? 0,
                       hasPointer: request.pointer != nil, slot: slot ?? -1) { written, data in
                if written > 0, let slot, let copied = ring?.copy(slot: slot, count: written) {
                    reply(copied)
                } else {
                    reply(data ?? Data())
                }
            }
        }
    }

    private func drawRing() -> VisualDrawRing? {
        lock.lock()
        defer { lock.unlock() }
        if ring == nil, let created = VisualDrawRing() {
            ring = created
            // The current connection gets the region now; new connections get it when they are made.
            (connection?.remoteObjectProxyWithErrorHandler { _ in } as? VisualServiceProtocol)?.attach(created.region)
        }
        return ring
    }

    private func request(
        _ body: @escaping (VisualServiceProtocol, @escaping (Data) -> Void) -> Void
    ) async -> Result<Data, VisualFailure> {
        await withCheckedContinuation { continuation in
            let once = VisualOnce(continuation)
            let (connection, generation) = current()
            let proxy = connection.remoteObjectProxyWithErrorHandler { error in
                once.resume(.failure(Self.failure(error)))
            } as? VisualServiceProtocol
            guard let proxy else {
                once.resume(.failure(.unavailable("The visual engine could not be reached.")))
                return
            }
            body(proxy) { data in once.resume(.success(data)) }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { [weak self] in
                if once.resume(.failure(.timedOut)) { self?.reset(generation) }
            }
        }
    }

    public func release(_ id: String) {
        lock.lock()
        let connection = connection
        lock.unlock()
        // Without a connection the service holds no engines from this one, or it relaunched without them.
        (connection?.remoteObjectProxyWithErrorHandler { _ in } as? VisualServiceProtocol)?.release(id)
    }

    private func current() -> (NSXPCConnection, Int) {
        lock.lock()
        defer { lock.unlock() }
        if let connection { return (connection, generation) }
        let connection = NSXPCConnection(serviceName: VisualService.name)
        connection.remoteObjectInterface = NSXPCInterface(with: VisualServiceProtocol.self)
        let generation = generation
        connection.invalidationHandler = { [weak self] in self?.reset(generation) }
        connection.resume()
        if let ring { (connection.remoteObjectProxyWithErrorHandler { _ in } as? VisualServiceProtocol)?.attach(ring.region) }
        self.connection = connection
        return (connection, generation)
    }

    /// Drops the connection of one generation, so the next request makes a new one.
    private func reset(_ generation: Int) {
        lock.lock()
        guard generation == self.generation, let connection else {
            lock.unlock()
            return
        }
        self.connection = nil
        self.generation += 1
        lock.unlock()
        connection.invalidate()
    }

    static func failure(_ error: Error) -> VisualFailure {
        let error = error as NSError
        guard error.domain == NSCocoaErrorDomain else { return .unavailable(error.localizedDescription) }
        switch error.code {
        case NSXPCConnectionInterrupted: return .crashed
        case NSXPCConnectionInvalid: return .unavailable("The visual engine is not available in this build of Pilot.")
        default: return .unavailable(error.localizedDescription)
        }
    }
}

/// Resumes a continuation once, whichever of reply, error or timeout comes first.
final class VisualOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Result<Data, VisualFailure>, Never>?

    init(_ continuation: CheckedContinuation<Result<Data, VisualFailure>, Never>) {
        self.continuation = continuation
    }

    @discardableResult
    func resume(_ result: Result<Data, VisualFailure>) -> Bool {
        lock.lock()
        let continuation = continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: result)
        return continuation != nil
    }
}
