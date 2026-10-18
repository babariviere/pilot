import Foundation
import OpenTelemetryProtocolExporterHttp
import OpenTelemetrySdk
import PilotCore
import PilotTelemetry
import Testing

private final class MemorySpanExporter: SpanExporter, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [SpanData] = []

    var spans: [SpanData] { lock.withLock { values } }
    func export(spans: [SpanData], explicitTimeout _: TimeInterval?) -> SpanExporterResultCode {
        lock.withLock { values.append(contentsOf: spans) }
        return .success
    }
    func flush(explicitTimeout _: TimeInterval?) -> SpanExporterResultCode { .success }
    func shutdown(explicitTimeout _: TimeInterval?) {}
}

private final class GatedMemorySpanExporter: SpanExporter, @unchecked Sendable {
    private let condition = NSCondition()
    private var values: [SpanData] = []
    private var exportStarted = false
    private var released = false

    var spans: [SpanData] {
        condition.lock()
        defer { condition.unlock() }
        return values
    }

    func export(spans: [SpanData], explicitTimeout _: TimeInterval?) -> SpanExporterResultCode {
        condition.lock()
        exportStarted = true
        condition.broadcast()
        while !released { condition.wait() }
        values.append(contentsOf: spans)
        condition.broadcast()
        condition.unlock()
        return .success
    }

    func waitForExportStart(timeout: TimeInterval) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !exportStarted {
            guard condition.wait(until: deadline) else { return false }
        }
        return true
    }

    func waitForSpanCount(_ count: Int, timeout: TimeInterval) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while values.count < count {
            guard condition.wait(until: deadline) else { return false }
        }
        return true
    }

    func release() {
        condition.lock()
        released = true
        condition.broadcast()
        condition.unlock()
    }

    func flush(explicitTimeout _: TimeInterval?) -> SpanExporterResultCode { .success }
    func shutdown(explicitTimeout _: TimeInterval?) { release() }
}

private final class BlockingSpanExporter: SpanExporter, @unchecked Sendable {
    private let condition = NSCondition()
    private var blocked = true

    func export(spans _: [SpanData], explicitTimeout _: TimeInterval?) -> SpanExporterResultCode {
        condition.lock()
        while blocked { condition.wait() }
        condition.unlock()
        return .success
    }
    func release() {
        condition.lock(); blocked = false; condition.broadcast(); condition.unlock()
    }
    func flush(explicitTimeout _: TimeInterval?) -> SpanExporterResultCode { .success }
    func shutdown(explicitTimeout _: TimeInterval?) { release() }
}

private final class FailingSpanExporter: SpanExporter, @unchecked Sendable {
    func export(spans _: [SpanData], explicitTimeout _: TimeInterval?) -> SpanExporterResultCode { .failure }
    func flush(explicitTimeout _: TimeInterval?) -> SpanExporterResultCode { .success }
    func shutdown(explicitTimeout _: TimeInterval?) {}
}

private final class CapturingHTTPClient: HTTPClient, @unchecked Sendable {
    private let lock = NSLock()
    private var value: URLRequest?
    var request: URLRequest? { lock.withLock { value } }

    func send(request: URLRequest, completion: @escaping (Result<HTTPURLResponse, Error>) -> Void) {
        lock.withLock { value = request }
        completion(.success(HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!))
    }

    func send(request: URLRequest) async throws -> HTTPURLResponse {
        lock.withLock { value = request }
        return HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    }
}

private func configuration(exporter: any SpanExporter) -> PilotTelemetryConfiguration {
    PilotTelemetryConfiguration(enabled: true, serviceVersion: "1.45.1", environment: .test,
                                hostKind: .local, exporter: exporter)
}

@Test func swiftTelemetryExportsReviewedResourcesAndAttributes() async {
    let exporter = MemorySpanExporter()
    let telemetry = PilotTelemetry(configuration: configuration(exporter: exporter))
    let span = telemetry.startSpan(.messageSend, attributes: [
        .operation(.messageSend), .phase(.api), .queueDepth(2), .frameObservation(.available),
    ])
    #expect(span.recording)
    #expect(span.traceID?.count == 32)
    #expect(span.carrier?.traceparent.count == 55)
    span.finish()
    await telemetry.flush()

    let recorded = exporter.spans.first
    #expect(recorded?.name == "pilot.message.send")
    #expect(recorded?.attributes["pilot.operation"] == .string("message.send"))
    #expect(recorded?.attributes["pilot.outcome"] == .string("success"))
    #expect(recorded?.resource.attributes["service.namespace"] == .string("com.babariviere.pilot"))
    #expect(recorded?.resource.attributes["service.name"] == .string("pilot.app"))
    #expect(recorded?.resource.attributes["pilot.schema.version"] == .int(3))
    #expect(recorded?.resource.attributes["host.name"] == nil)
    await telemetry.shutdown()
}

@Test func featureEventsRequireAnalyticsConsentAndUseAnIsolatedIdentity() async throws {
    let exporter = MemorySpanExporter()
    let telemetry = PilotTelemetry(configuration: PilotTelemetryConfiguration(
        enabled: true, serviceVersion: "1.45.1", environment: .test, hostKind: .local,
        hostID: "host_id_12345678901234", analyticsID: "analytics_123456789012",
        exporter: exporter
    ))
    telemetry.startSpan(.chatOpen).finish()
    telemetry.recordFeature(.eligibility(.diagnoseChat, .available))
    telemetry.recordFeature(.eligibility(.diagnoseChat, .available))
    telemetry.recordFeature(.exposure(.diagnoseChat))
    telemetry.recordFeature(.exposure(.diagnoseChat))
    telemetry.recordFeature(.attempt(.diagnoseChat))
    let success = try #require(FeatureEvent.outcome(.diagnoseChat, .success, reason: .none))
    telemetry.recordFeature(success)
    await telemetry.flush()

    let operational = try #require(exporter.spans.first(where: { $0.name == "pilot.chat.open" }))
    #expect(operational.resource.attributes["pilot.host.id"] == .string("host_id_12345678901234"))
    #expect(operational.resource.attributes["pilot.analytics.id"] == nil)
    let features = exporter.spans.filter { $0.name == "pilot.feature" }
    #expect(features.count == 4)
    #expect(features.allSatisfy { $0.resource.attributes["pilot.analytics.id"] == .string("analytics_123456789012") })
    #expect(features.allSatisfy { $0.resource.attributes["pilot.host.id"] == nil })
    #expect(features.allSatisfy {
        $0.resource.attributes["service.instance.id"] != operational.resource.attributes["service.instance.id"]
    })
    #expect(features.contains { $0.attributes["pilot.feature.stage"] == .string("outcome") &&
        $0.attributes["pilot.feature.outcome"] == .string("success") })
    await telemetry.shutdown()

    let withoutConsent = MemorySpanExporter()
    let disabled = PilotTelemetry(configuration: configuration(exporter: withoutConsent))
    disabled.recordFeature(.exposure(.slackTriage))
    await disabled.flush()
    #expect(withoutConsent.spans.isEmpty)
    await disabled.shutdown()
}

@Test func invalidAnalyticsIdentityFailsClosed() throws {
    let telemetry = PilotTelemetry()
    #expect(throws: PilotTelemetryConfigurationError.invalidAnalyticsID) {
        try telemetry.configure(PilotTelemetryConfiguration(
            enabled: true, serviceVersion: "1.45.1", environment: .test, hostKind: .local,
            analyticsID: "invalid", exporter: MemorySpanExporter()
        ))
    }
    #expect(throws: PilotTelemetryConfigurationError.invalidAnalyticsID) {
        try telemetry.configure(PilotTelemetryConfiguration(
            enabled: true, serviceVersion: "1.45.1", environment: .test, hostKind: .local,
            hostID: "host_id_12345678901234", analyticsID: "host_id_12345678901234",
            exporter: MemorySpanExporter()
        ))
    }
}

@Test func featureEventsRespectTheProcessRateCap() async {
    let exporter = GatedMemorySpanExporter()
    defer { exporter.release() }
    let telemetry = PilotTelemetry(configuration: PilotTelemetryConfiguration(
        enabled: true, serviceVersion: "1.45.1", environment: .test, hostKind: .local,
        analyticsID: "analytics_123456789012", exporter: exporter
    ))
    for _ in 0 ..< featureEventProcessLimit + 2 { telemetry.recordFeature(.attempt(.slackTriage)) }
    #expect(telemetry.stats.dropped == 2)
    await telemetry.flush()
    #expect(exporter.waitForExportStart(timeout: 5), "the batch processor started exporting the accepted events")
    #expect(exporter.spans.isEmpty, "bounded flush can return while an exporter is still working")
    exporter.release()
    #expect(exporter.waitForSpanCount(featureEventProcessLimit, timeout: 10),
            "all rate-cap-accepted feature events eventually reach the exporter")
    await telemetry.flush()
    #expect(exporter.spans.filter { $0.name == "pilot.feature" }.count == featureEventProcessLimit)
    await telemetry.shutdown()
}

@Test func consentRevocationRejectsLateSpanCompletion() async throws {
    let exporter = MemorySpanExporter()
    let telemetry = PilotTelemetry(configuration: configuration(exporter: exporter))
    let active = telemetry.startSpan(.chatOpen)
    try telemetry.configure(.disabled)
    active.finish()
    await Task.yield()
    #expect(telemetry.stats.queued == 0)
    #expect(exporter.spans.isEmpty)
    await telemetry.shutdown()
}

@Test func taskLocalTraceContextPropagatesOnlyTraceparent() async throws {
    let exporter = MemorySpanExporter()
    let telemetry = PilotTelemetry(configuration: configuration(exporter: exporter))
    var parentTraceID: String?
    var childTraceID: String?
    await telemetry.withSpan(.messageSend, attributes: [.operation(.messageSend)]) {
        parentTraceID = PilotTraceContext.current?.traceparent.split(separator: "-").dropFirst().first.map(String.init)
        var request = URLRequest(url: URL(string: "http://127.0.0.1/api")!)
        request.setValue("remove-me", forHTTPHeaderField: "tracestate")
        request.setValue("remove-me", forHTTPHeaderField: "baggage")
        PilotTraceContext.injectCurrent(into: &request)
        #expect(request.value(forHTTPHeaderField: "traceparent") != nil)
        #expect(request.value(forHTTPHeaderField: "tracestate") == nil)
        #expect(request.value(forHTTPHeaderField: "baggage") == nil)
        let child = telemetry.startSpan(.daemonRequest, attributes: [.operation(.daemonRequest)])
        childTraceID = child.traceID
        child.finish()
    }
    #expect(parentTraceID == childTraceID)
    await telemetry.shutdown()
}

@Test func disabledAndInvalidSwiftTelemetryDoesNoExporterWork() async {
    let disabledExporter = MemorySpanExporter()
    let disabled = PilotTelemetry(configuration: PilotTelemetryConfiguration(
        enabled: false, serviceVersion: "1.45.1", environment: .test, hostKind: .local,
        exporter: disabledExporter
    ))
    #expect(!disabled.startSpan(.chatOpen).recording)
    #expect(disabledExporter.spans.isEmpty)

    let exporter = MemorySpanExporter()
    let telemetry = PilotTelemetry(configuration: configuration(exporter: exporter))
    #expect(!telemetry.startSpan(.chatOpen, attributes: [.queueDepth(513)]).recording)
    #expect(!telemetry.startSpan(.chatOpen, attributes: [.phase(.api), .phase(.provider)]).recording)
    #expect(telemetry.stats.invalid == 2)
    #expect(exporter.spans.isEmpty)
    await telemetry.shutdown()
}

@Test func swiftTelemetryShedsAtTheProcessQueueBound() async {
    let exporter = BlockingSpanExporter()
    let telemetry = PilotTelemetry(configuration: configuration(exporter: exporter))
    for _ in 0 ..< 600 { telemetry.startSpan(.daemonRequest).finish() }
    #expect(telemetry.stats.queued == pilotSwiftSpanQueueLimit)
    #expect(telemetry.stats.dropped == 600 - pilotSwiftSpanQueueLimit)
    exporter.release()
    // A bounded flush can return while the released exporter is still draining the full queue on a slow runner.
    let deadline = Date(timeIntervalSinceNow: 15)
    repeat { await telemetry.flush() } while telemetry.stats.queued > 0 && Date() < deadline
    #expect(telemetry.stats.queued == 0)
    await telemetry.shutdown()
}

@Test func swiftTelemetryDropsFailedExportsWithoutRetainingAQueue() async {
    let telemetry = PilotTelemetry(configuration: configuration(exporter: FailingSpanExporter()))
    for _ in 0 ..< pilotSwiftSpanBatchLimit + 1 { telemetry.startSpan(.daemonRequest).finish() }
    await telemetry.flush()
    #expect(telemetry.stats.queued == 0)
    #expect(telemetry.stats.dropped == pilotSwiftSpanBatchLimit + 1)
    #expect(telemetry.stats.exportFailures >= 2)
    await telemetry.shutdown()
}

@Test func sleepEndsActiveSpansAsUnavailable() async {
    let exporter = MemorySpanExporter()
    let telemetry = PilotTelemetry(configuration: configuration(exporter: exporter))
    let span = telemetry.startSpan(.chatOpen, attributes: [.operation(.chatOpen)])
    telemetry.applicationWillSleep()
    #expect(telemetry.stats.active == 0)
    #expect(!telemetry.startSpan(.chatOpen).recording)
    telemetry.applicationDidWake()
    #expect(telemetry.startSpan(.chatOpen).recording)
    span.finish()
    await telemetry.flush()
    let interrupted = exporter.spans.first
    #expect(interrupted?.attributes["pilot.outcome"] == .string("unavailable"))
    #expect(interrupted?.attributes["pilot.reason"] == .string("sleep"))
    await telemetry.shutdown()
}

@Test func swiftOTLPUsesProtobufWithoutEnvironmentHeadersOrRetryState() async throws {
    let client = CapturingHTTPClient()
    let telemetry = PilotTelemetry(configuration: PilotTelemetryConfiguration(
        enabled: true, serviceVersion: "1.45.1", environment: .test, hostKind: .local,
        endpoint: URL(string: "http://127.0.0.1:4318/v1/traces")!, httpClient: client
    ))
    telemetry.startSpan(.chatOpen, attributes: [.operation(.chatOpen)]).finish()
    await telemetry.flush()
    let request = client.request
    #expect(request?.value(forHTTPHeaderField: "content-type") == "application/x-protobuf")
    #expect(request?.value(forHTTPHeaderField: "authorization") == nil)
    #expect((request?.httpBody?.count ?? 0) > 0)
    #expect(request?.httpBody?.range(of: Data("pilot.chat.open".utf8)) != nil)
    await telemetry.shutdown()
}

@Test func swiftOTLPEndpointsRejectUnsafeConfiguration() throws {
    #expect(try PilotTelemetry.validatedEndpoint(URL(string: "http://127.0.0.1:4318")!).path == "/v1/traces")
    #expect(throws: PilotTelemetryConfigurationError.unsafeEndpoint) {
        try PilotTelemetry.validatedEndpoint(URL(string: "http://collector.example/v1/traces")!)
    }
    #expect(throws: PilotTelemetryConfigurationError.unsafeEndpoint) {
        try PilotTelemetry.validatedEndpoint(URL(string: "https://token@collector.example/v1/traces")!)
    }
    #expect(throws: PilotTelemetryConfigurationError.unsafeEndpoint) {
        try PilotTelemetry.validatedEndpoint(URL(string: "https://collector.example/v1/traces?token=secret")!)
    }
}
