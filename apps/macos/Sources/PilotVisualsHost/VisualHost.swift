import Foundation
import PilotVisualEngine
import PilotVisualsKit

/// The visual service's engines: one QuickJS-NG engine per live visual, each on its own serial executor, at most
/// `capacity` alive. Loading another releases the least recently used; the app restarts it from saved state when
/// it is needed again.
public final class VisualHost: @unchecked Sendable {
    /// The vendored QuickJS-NG release, for example "0.17.0".
    public static var engineVersion: String { String(cString: pv_engine_version()) }

    public struct Configuration: Sendable {
        public var heapBytes = VisualLimits.heapBytes
        public var stackBytes = VisualLimits.stackBytes
        /// Native stack for each engine thread: the JavaScript limit plus room for C frames and the encoder.
        public var threadStackBytes = 4 << 20
        public var setupMilliseconds = VisualLimits.setupMilliseconds
        public var viewMilliseconds = VisualLimits.viewMilliseconds
        public var handlerMilliseconds = VisualLimits.handlerMilliseconds
        public var capacity = VisualLimits.liveEngines

        public init() {}

        var limits: PVLimits {
            PVLimits(heap_bytes: heapBytes, stack_bytes: stackBytes, setup_ms: setupMilliseconds,
                     view_ms: viewMilliseconds, handler_ms: handlerMilliseconds)
        }
    }

    private let configuration: Configuration
    private let lock = NSLock()
    private var engines: [String: Engine] = [:]
    /// Least recently used first.
    private var order: [String] = []
    private var serial = 0

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
    }

    /// Ids of live engines, least recently used first.
    public var liveIDs: [String] {
        lock.lock()
        defer { lock.unlock() }
        return order
    }

    public func load(_ id: String, _ request: VisualLoadRequest, reply: @escaping (Data) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        if let previous = engines.removeValue(forKey: id) {
            order.removeAll { $0 == id }
            previous.close()
        }
        serial += 1
        let engine = Engine(name: "Visual \(serial)", configuration: configuration)
        engines[id] = engine
        order.append(id)
        while order.count > configuration.capacity {
            engines.removeValue(forKey: order.removeFirst())?.close()
        }
        engine.executor.submit { [weak self] in
            let (succeeded, data) = engine.load(request)
            // A visual that failed to start has nothing to run handlers on.
            if !succeeded { self?.discard(id, engine) }
            reply(data)
        }
    }

    public func event(_ id: String, handler: String, value: Data, reply: @escaping (Data) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard let engine = engines[id] else {
            reply(VisualReply.error(.unloaded, "This visual is not loaded."))
            return
        }
        order.removeAll { $0 == id }
        order.append(id)
        engine.executor.submit {
            reply(engine.event(handler: handler, value: value))
        }
    }

    public func release(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let engine = engines.removeValue(forKey: id) else { return }
        order.removeAll { $0 == id }
        engine.close()
    }

    private func discard(_ id: String, _ engine: Engine) {
        lock.lock()
        defer { lock.unlock() }
        guard engines[id] === engine else { return }
        engines[id] = nil
        order.removeAll { $0 == id }
        engine.close()
    }

    /// One engine. Its C state is only touched from its executor's thread.
    final class Engine: @unchecked Sendable {
        let executor: VisualExecutor
        private let configuration: Configuration
        private var engine: OpaquePointer?
        /// Date.now for every call, from the load request.
        private var now: Double = 0

        init(name: String, configuration: Configuration) {
            self.configuration = configuration
            executor = VisualExecutor(name: name, stackSize: configuration.threadStackBytes)
        }

        func close() {
            executor.finish { [self] in
                if let engine { pv_engine_free(engine) }
                engine = nil
            }
        }

        func load(_ request: VisualLoadRequest) -> (Bool, Data) {
            guard let engine = pv_engine_create(configuration.limits) else {
                return (false, VisualReply.error(.memory, "The visual engine could not start."))
            }
            self.engine = engine
            now = request.now
            var buffer = PVBuffer()
            let status = Self.withBytes(Data(request.runtime.utf8)) { runtime, runtimeLength in
                Self.withBytes(Data(request.source.utf8)) { source, sourceLength in
                    Self.withBytes(request.data) { data, dataLength in
                        Self.withBytes(request.state) { state, stateLength in
                            Self.withBytes(Data(request.seed.utf8)) { seed, seedLength in
                                pv_engine_load(engine, runtime, runtimeLength, source, sourceLength, data, dataLength,
                                               state, stateLength, seed, seedLength, request.now, &buffer)
                            }
                        }
                    }
                }
            }
            return (status == 0, Self.take(&buffer))
        }

        func event(handler: String, value: Data) -> Data {
            guard let engine else { return VisualReply.error(.unloaded, "This visual is not loaded.") }
            var buffer = PVBuffer()
            _ = Self.withBytes(Data(handler.utf8)) { handler, handlerLength in
                Self.withBytes(value) { value, valueLength in
                    pv_engine_event(engine, handler, handlerLength, value, valueLength, now, &buffer)
                }
            }
            return Self.take(&buffer)
        }

        private static func take(_ buffer: inout PVBuffer) -> Data {
            defer { pv_buffer_free(&buffer) }
            guard let bytes = buffer.bytes, buffer.length > 0 else {
                return VisualReply.error(.memory, "The visual engine ran out of memory.")
            }
            return Data(bytes: bytes, count: buffer.length)
        }

        /// Passes bytes as a C string pointer and length. A nil value passes NULL.
        private static func withBytes<T>(_ data: Data?, _ body: (UnsafePointer<CChar>?, Int) -> T) -> T {
            guard let data else { return body(nil, 0) }
            // A non-null pointer even for empty data, so the engine can tell empty from absent.
            if data.isEmpty { return "".withCString { body($0, 0) } }
            return data.withUnsafeBytes { raw in
                body(raw.bindMemory(to: CChar.self).baseAddress, raw.count)
            }
        }
    }
}
