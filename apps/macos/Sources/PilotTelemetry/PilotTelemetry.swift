import Foundation
import OpenTelemetryApi
import OpenTelemetryProtocolExporterCommon
import OpenTelemetryProtocolExporterHttp
import OpenTelemetrySdk

public let pilotSwiftSpanQueueLimit = 256
public let pilotSwiftSpanBatchLimit = 64
public let pilotSwiftSpanScheduleDelay: TimeInterval = 5
public let pilotSwiftSpanExportTimeout: TimeInterval = 3

public enum PilotTelemetryEnvironment: String, Sendable { case release, development, test }
public enum PilotTelemetryHostKind: String, Sendable { case local, devbox }
public enum PilotTelemetrySpanName: String, Sendable {
    case messageSend = "pilot.message.send"
    case chatOpen = "pilot.chat.open"
    case daemonRequest = "pilot.daemon.request"
    case kernelRequest = "pilot.kernel.request"
    case eventLoopStall = "pilot.event_loop.stall"
    case feature = "pilot.feature"
}

public enum PilotTelemetryOperation: String, Sendable {
    case messageSend = "message.send"
    case chatOpen = "chat.open"
    case daemonRequest = "daemon.request"
    case kernelRequest = "kernel.request"
    case eventLoopStall = "event_loop.stall"
}

public enum PilotTelemetryPhase: String, Sendable {
    case api, admission, startupWait = "startup_wait", preparation, provider, publication
    case firstVisible = "first_visible"
    case historyRead = "history_read"
    case reduction
    case firstTranscript = "first_transcript"
}

public enum PilotTelemetryOutcome: String, Equatable, Sendable {
    case completed, failed, timeout, cancelled, interrupted, unavailable

    fileprivate var exported: String {
        switch self {
        case .completed: "success"
        case .failed, .interrupted: "failure"
        case .timeout: "timeout"
        case .cancelled: "cancelled"
        case .unavailable: "unavailable"
        }
    }
}

public enum PilotTelemetryReason: String, Sendable {
    case none, user, sleep, update, quota
    case usageLimit = "usage_limit"
    case connectivity
    case startupTimeout = "startup_timeout"
    case processExit = "process_exit"
    case recoveryBackoff = "recovery_backoff"
    case parkedIdle = "parked_idle"
    case synchronousWork = "synchronous_work"
    case waiting, unknown
}

public enum PilotHistoryBucket: String, Sendable { case empty = "0", small = "1-100", medium = "101-1000", large = "1001+" }
public enum PilotProgressKind: String, Equatable, Sendable { case thinking, text, tool, none }
public enum PilotFrameObservation: String, Sendable { case available, occluded, asleep, unsupported }

/// Closed attributes only. Adding a case requires updating the reviewed telemetry contract and privacy fixtures.
public enum PilotTelemetryAttribute: Sendable {
    case operation(PilotTelemetryOperation)
    case phase(PilotTelemetryPhase)
    case outcome(PilotTelemetryOutcome)
    case reason(PilotTelemetryReason)
    case cold(Bool)
    case recovered(Bool)
    case retryCount(Int)
    case queueDepth(Int)
    case historyBucket(PilotHistoryBucket)
    case progressKind(PilotProgressKind)
    case frameObservation(PilotFrameObservation)

    fileprivate var pair: (String, AttributeValue)? {
        switch self {
        case let .operation(value): ("pilot.operation", .string(value.rawValue))
        case let .phase(value): ("pilot.phase", .string(value.rawValue))
        case let .outcome(value): ("pilot.outcome", .string(value.exported))
        case let .reason(value): ("pilot.reason", .string(value.rawValue))
        case let .cold(value): ("pilot.cold", .bool(value))
        case let .recovered(value): ("pilot.recovered", .bool(value))
        case let .retryCount(value): (0 ... 8).contains(value) ? ("pilot.retry_count", .int(value)) : nil
        case let .queueDepth(value): (0 ... 512).contains(value) ? ("pilot.queue_depth", .int(value)) : nil
        case let .historyBucket(value): ("pilot.history_bucket", .string(value.rawValue))
        case let .progressKind(value): ("pilot.progress_kind", .string(value.rawValue))
        case let .frameObservation(value): ("pilot.frame_observation", .string(value.rawValue))
        }
    }
}

public struct PilotTraceCarrier: Equatable, Sendable {
    public let traceparent: String

    public init?(traceparent: String) {
        let parts = traceparent.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 4, parts[0] == "00", parts[1].count == 32, parts[2].count == 16,
              parts[3] == "00" || parts[3] == "01",
              Self.lowerHex(parts[1]), Self.lowerHex(parts[2]),
              parts[1].contains(where: { $0 != "0" }), parts[2].contains(where: { $0 != "0" }) else { return nil }
        self.traceparent = traceparent
    }

    private static func lowerHex(_ value: Substring) -> Bool {
        value.allSatisfy { ("0" ... "9").contains($0) || ("a" ... "f").contains($0) }
    }
}

public enum PilotTraceContext {
    @TaskLocal public static var current: PilotTraceCarrier?

    public static func injectCurrent(into request: inout URLRequest) {
        guard let current else { return }
        request.setValue(current.traceparent, forHTTPHeaderField: "traceparent")
        request.setValue(nil, forHTTPHeaderField: "tracestate")
        request.setValue(nil, forHTTPHeaderField: "baggage")
    }
}

public struct PilotTelemetryStats: Equatable, Sendable {
    public let started: Int
    public let invalid: Int
    public let queued: Int
    public let dropped: Int
    public let exportFailures: Int
    public let active: Int
}

public struct PilotTelemetryConfiguration {
    public let enabled: Bool
    public let serviceVersion: String
    public let environment: PilotTelemetryEnvironment
    public let hostKind: PilotTelemetryHostKind
    public let hostID: String?
    public let endpoint: URL?
    public let exporter: (any SpanExporter)?
    public let httpClient: (any HTTPClient)?

    public init(enabled: Bool, serviceVersion: String, environment: PilotTelemetryEnvironment,
                hostKind: PilotTelemetryHostKind, hostID: String? = nil, endpoint: URL? = nil,
                exporter: (any SpanExporter)? = nil, httpClient: (any HTTPClient)? = nil) {
        self.enabled = enabled
        self.serviceVersion = serviceVersion
        self.environment = environment
        self.hostKind = hostKind
        self.hostID = hostID
        self.endpoint = endpoint
        self.exporter = exporter
        self.httpClient = httpClient
    }

    public static let disabled = PilotTelemetryConfiguration(
        enabled: false, serviceVersion: "0.0.0", environment: .development, hostKind: .local
    )
}

public enum PilotTelemetryConfigurationError: Error, Equatable {
    case invalidServiceVersion, invalidHostID, unsafeEndpoint
}

private final class TelemetryCounters: @unchecked Sendable {
    private let lock = NSLock()
    private var started = 0
    private var invalid = 0
    private var queued = 0
    private var dropped = 0
    private var failures = 0

    func recordStarted() { lock.withLock { started += 1 } }
    func recordInvalid() { lock.withLock { invalid += 1 } }
    func enqueue() -> Bool {
        lock.withLock {
            guard queued < pilotSwiftSpanQueueLimit else { dropped += 1; return false }
            queued += 1
            return true
        }
    }
    func exported(_ count: Int, success: Bool) {
        lock.withLock {
            queued = max(0, queued - count)
            if !success { dropped += count; failures += 1 }
        }
    }
    func revoke() {
        lock.withLock { dropped += queued; queued = 0 }
    }
    func snapshot(active: Int) -> PilotTelemetryStats {
        lock.withLock {
            PilotTelemetryStats(started: started, invalid: invalid, queued: queued, dropped: dropped,
                                exportFailures: failures, active: active)
        }
    }
}

private final class CountedSpanExporter: SpanExporter, @unchecked Sendable {
    private let sink: any SpanExporter
    private let counters: TelemetryCounters
    private let lock = NSLock()
    private var revoked = false

    init(sink: any SpanExporter, counters: TelemetryCounters) {
        self.sink = sink
        self.counters = counters
    }

    func export(spans: [SpanData], explicitTimeout: TimeInterval?) -> SpanExporterResultCode {
        if lock.withLock({ revoked }) { return .success }
        let result = sink.export(spans: spans, explicitTimeout: explicitTimeout)
        if !lock.withLock({ revoked }) { counters.exported(spans.count, success: result == .success) }
        return result
    }

    func flush(explicitTimeout: TimeInterval?) -> SpanExporterResultCode {
        lock.withLock({ revoked }) ? .success : sink.flush(explicitTimeout: explicitTimeout)
    }

    func shutdown(explicitTimeout: TimeInterval?) {
        sink.shutdown(explicitTimeout: explicitTimeout)
    }

    func revoke() {
        let changed = lock.withLock { guard !revoked else { return false }; revoked = true; return true }
        if changed { counters.revoke() }
    }
}

private final class BoundedSpanProcessor: SpanProcessor, @unchecked Sendable {
    private var batch: BatchSpanProcessor
    private let counters: TelemetryCounters
    private let exporter: CountedSpanExporter

    init(exporter: any SpanExporter, counters: TelemetryCounters) {
        self.counters = counters
        self.exporter = CountedSpanExporter(sink: exporter, counters: counters)
        batch = BatchSpanProcessor(
            spanExporter: self.exporter,
            scheduleDelay: pilotSwiftSpanScheduleDelay,
            exportTimeout: pilotSwiftSpanExportTimeout,
            maxQueueSize: pilotSwiftSpanQueueLimit,
            maxExportBatchSize: pilotSwiftSpanBatchLimit
        )
    }

    let isStartRequired = false
    let isEndRequired = true
    func onStart(parentContext _: SpanContext?, span _: ReadableSpan) {}
    func onEnd(span: ReadableSpan) {
        guard counters.enqueue() else { return }
        batch.onEnd(span: span)
    }
    func shutdown(explicitTimeout: TimeInterval?) { batch.shutdown(explicitTimeout: explicitTimeout) }
    func forceFlush(timeout: TimeInterval?) { batch.forceFlush(timeout: timeout) }
    func revoke() { exporter.revoke() }
}

private final class TelemetryRuntime: @unchecked Sendable {
    let provider: TracerProviderSdk
    let tracer: any Tracer
    let processor: BoundedSpanProcessor

    init(provider: TracerProviderSdk, tracer: any Tracer, processor: BoundedSpanProcessor) {
        self.provider = provider
        self.tracer = tracer
        self.processor = processor
    }
}

private struct TraceSetter: Setter {
    func set(carrier: inout [String: String], key: String, value: String) {
        if key == "traceparent", PilotTraceCarrier(traceparent: value) != nil { carrier[key] = value }
    }
}

private struct TraceGetter: Getter {
    func get(carrier: [String: String], key: String) -> [String]? {
        key == "traceparent" ? carrier[key].map { [$0] } : nil
    }
}

public final class PilotTelemetrySpan: @unchecked Sendable {
    public static let noop = PilotTelemetrySpan()
    public let recording: Bool
    public let traceID: String?
    public let carrier: PilotTraceCarrier?
    private let span: (any Span)?
    private let lock = NSLock()
    private var ended = false
    private let didFinish: (@Sendable () -> Void)?

    private init() {
        recording = false
        traceID = nil
        carrier = nil
        span = nil
        didFinish = nil
    }

    fileprivate init(span: any Span, carrier: PilotTraceCarrier, didFinish: @escaping @Sendable () -> Void) {
        recording = true
        traceID = span.context.traceId.hexString
        self.carrier = carrier
        self.span = span
        self.didFinish = didFinish
    }

    /// Add one reviewed attribute while the span is active. Arbitrary keys and values remain impossible.
    public func setAttribute(_ attribute: PilotTelemetryAttribute) {
        guard let (key, value) = attribute.pair, lock.withLock({ !ended }) else { return }
        span?.setAttribute(key: key, value: value)
    }

    public func finish(_ outcome: PilotTelemetryOutcome = .completed,
                       reason: PilotTelemetryReason? = nil, at: Date? = nil) {
        let shouldFinish = lock.withLock {
            guard !ended else { return false }
            ended = true
            return true
        }
        guard shouldFinish, let span else { return }
        span.setAttribute(key: "pilot.outcome", value: outcome.exported)
        if let reason { span.setAttribute(key: "pilot.reason", value: reason.rawValue) }
        if outcome == .failed || outcome == .interrupted || outcome == .timeout {
            span.status = .error(description: "")
        }
        if let at { span.end(time: at) } else { span.end() }
        didFinish?()
    }
}

public final class PilotTelemetry: @unchecked Sendable {
    public static let shared = PilotTelemetry()
    private let lock = NSLock()
    private let counters = TelemetryCounters()
    private var runtime: TelemetryRuntime?
    private var active: [UUID: PilotTelemetrySpan] = [:]
    private var sleeping = false
    private let propagator = W3CTraceContextPropagator()

    public init(configuration: PilotTelemetryConfiguration = .disabled) {
        runtime = try? Self.makeRuntime(configuration, counters: counters)
    }

    public func configure(_ configuration: PilotTelemetryConfiguration) throws {
        let next = try Self.makeRuntime(configuration, counters: counters)
        let previous = lock.withLock { let value = runtime; runtime = next; return value }
        if let previous {
            previous.processor.revoke()
            DispatchQueue.global(qos: .utility).async { previous.provider.shutdown() }
        }
    }

    public var stats: PilotTelemetryStats {
        let count = lock.withLock { active.count }
        return counters.snapshot(active: count)
    }

    public func startSpan(_ name: PilotTelemetrySpanName,
                          attributes: [PilotTelemetryAttribute] = [],
                          parent explicitParent: PilotTraceCarrier? = nil) -> PilotTelemetrySpan {
        let snapshot = lock.withLock { sleeping ? nil : runtime }
        guard let snapshot else { return .noop }
        guard let safe = validatedAttributes(attributes) else { counters.recordInvalid(); return .noop }
        let builder = snapshot.tracer.spanBuilder(spanName: name.rawValue).setNoParent()
        let parent = explicitParent ?? PilotTraceContext.current
        if let parent,
           let context = propagator.extract(carrier: ["traceparent": parent.traceparent], getter: TraceGetter()) {
            builder.setParent(context)
        }
        for (key, value) in safe { builder.setAttribute(key: key, value: value) }
        let span = builder.startSpan()
        var values: [String: String] = [:]
        propagator.inject(spanContext: span.context, carrier: &values, setter: TraceSetter())
        guard let value = values["traceparent"], let carrier = PilotTraceCarrier(traceparent: value) else {
            span.end()
            counters.recordInvalid()
            return .noop
        }
        counters.recordStarted()
        let id = UUID()
        let wrapped = PilotTelemetrySpan(span: span, carrier: carrier) { [weak self] in
            self?.lock.withLock { self?.active[id] = nil }
        }
        lock.withLock {
            if active.count < pilotSwiftSpanQueueLimit { active[id] = wrapped }
        }
        return wrapped
    }

    public func withSpan<Value>(_ name: PilotTelemetrySpanName,
                                attributes: [PilotTelemetryAttribute] = [],
                                operation: () async throws -> Value) async rethrows -> Value {
        let span = startSpan(name, attributes: attributes)
        return try await PilotTraceContext.$current.withValue(span.carrier ?? PilotTraceContext.current) {
            do {
                let value = try await operation()
                span.finish()
                return value
            } catch {
                span.finish(error is CancellationError ? .cancelled : .failed)
                throw error
            }
        }
    }

    /// Ends interaction spans before system sleep so wall-clock suspension is never reported as active work.
    public func applicationWillSleep() {
        let spans = lock.withLock { sleeping = true; return Array(active.values) }
        for span in spans { span.finish(.unavailable, reason: .sleep) }
    }

    public func applicationDidWake() { lock.withLock { sleeping = false } }

    public func flush(timeout: TimeInterval = 1) async {
        guard let runtime = lock.withLock({ runtime }) else { return }
        await Self.runBounded(timeout: timeout) { runtime.provider.forceFlush(timeout: timeout) }
    }

    public func shutdown(timeout: TimeInterval = 1) async {
        let state = lock.withLock { () -> (TelemetryRuntime?, [PilotTelemetrySpan]) in
            let value = runtime
            runtime = nil
            let spans = Array(active.values)
            return (value, spans)
        }
        for span in state.1 { span.finish(.interrupted, reason: .processExit) }
        guard let runtime = state.0 else { return }
        await Self.runBounded(timeout: timeout) { runtime.provider.shutdown() }
    }

    public static func validatedEndpoint(_ endpoint: URL) throws -> URL {
        guard var parts = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased() else {
            throw PilotTelemetryConfigurationError.unsafeEndpoint
        }
        let loopback = host == "127.0.0.1" || host == "::1"
        guard scheme == "https" || (scheme == "http" && loopback) else {
            throw PilotTelemetryConfigurationError.unsafeEndpoint
        }
        if parts.path.isEmpty || parts.path == "/" { parts.path = "/v1/traces" }
        guard let result = parts.url else { throw PilotTelemetryConfigurationError.unsafeEndpoint }
        return result
    }

    private func validatedAttributes(_ attributes: [PilotTelemetryAttribute]) -> [String: AttributeValue]? {
        guard attributes.count <= 24 else { return nil }
        var result: [String: AttributeValue] = [:]
        for attribute in attributes {
            guard let (key, value) = attribute.pair, result[key] == nil else { return nil }
            if case let .string(text) = value, text.utf8.count > 64 { return nil }
            result[key] = value
        }
        return result
    }

    private static func makeRuntime(_ configuration: PilotTelemetryConfiguration,
                                    counters: TelemetryCounters) throws -> TelemetryRuntime? {
        guard configuration.enabled else { return nil }
        guard numericVersion(configuration.serviceVersion) else {
            throw PilotTelemetryConfigurationError.invalidServiceVersion
        }
        if let hostID = configuration.hostID,
           hostID.count != 22 || !hostID.allSatisfy({ $0.isLowercase || $0.isNumber || $0 == "_" || $0 == "-" }) {
            throw PilotTelemetryConfigurationError.invalidHostID
        }
        let sink: any SpanExporter
        if let exporter = configuration.exporter {
            sink = exporter
        } else if let endpoint = configuration.endpoint {
            sink = OtlpHttpTraceExporter(
                endpoint: try validatedEndpoint(endpoint),
                config: OtlpConfiguration(timeout: pilotSwiftSpanExportTimeout, compression: .none,
                                          headers: nil, exportAsJson: false),
                httpClient: configuration.httpClient ?? BaseHTTPClient(),
                envVarHeaders: nil,
                requeueOnFailure: false
            )
        } else {
            return nil
        }
        var resource: [String: AttributeValue] = [
            "service.namespace": .string("com.babariviere.pilot"),
            "service.name": .string("pilot.app"),
            "service.version": .string(configuration.serviceVersion),
            "service.instance.id": .string(UUID().uuidString.lowercased()),
            "deployment.environment.name": .string(configuration.environment.rawValue),
            "os.type": .string("darwin"),
            "process.runtime.name": .string("swift"),
            "process.runtime.version": .string(swiftVersion),
            "pilot.schema.version": .int(1),
            "pilot.host.kind": .string(configuration.hostKind.rawValue),
        ]
        if let hostID = configuration.hostID { resource["pilot.host.id"] = .string(hostID) }
        let limits = SpanLimits()
            .settingAttributeCountLimit(24)
            .settingAttributeValueLengthLimit(64)
            .settingEventCountLimit(16)
            .settingAttributePerEventCountLimit(0)
            .settingLinkCountLimit(0)
            .settingAttributePerLinkCountLimit(0)
        let processor = BoundedSpanProcessor(exporter: sink, counters: counters)
        let provider = TracerProviderSdk(
            resource: Resource(attributes: resource), spanLimits: limits, sampler: Samplers.alwaysOn,
            spanProcessors: [processor]
        )
        return TelemetryRuntime(
            provider: provider,
            tracer: provider.get(instrumentationName: "pilot.app", instrumentationVersion: configuration.serviceVersion),
            processor: processor
        )
    }

    private static func numericVersion(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return (2 ... 4).contains(parts.count) && parts.allSatisfy { !$0.isEmpty && $0.allSatisfy(\.isNumber) }
    }

    private static var swiftVersion: String {
        #if swift(>=6.2)
        "6.2"
        #elseif swift(>=6.1)
        "6.1"
        #elseif swift(>=6.0)
        "6.0"
        #else
        "5.0"
        #endif
    }

    private static func runBounded(timeout: TimeInterval, work: @escaping @Sendable () -> Void) async {
        await withCheckedContinuation { continuation in
            let completion = OneShotCompletion { continuation.resume() }
            DispatchQueue.global(qos: .utility).async { work(); completion.finish() }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + max(0.001, min(timeout, 1))) {
                completion.finish()
            }
        }
    }
}

private final class OneShotCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private let action: @Sendable () -> Void

    init(action: @escaping @Sendable () -> Void) { self.action = action }
    func finish() {
        let run = lock.withLock { guard !completed else { return false }; completed = true; return true }
        if run { action() }
    }
}
