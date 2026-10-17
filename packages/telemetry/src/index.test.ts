import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
	ExportResultCode,
	NodeTelemetry,
	type ReadableSpan,
	type SpanExporter,
	type TelemetryInFlightEvent,
	traceCarrier,
	validateOtlpEndpoint,
} from "./index.ts";

class MemoryExporter implements SpanExporter {
	readonly spans: ReadableSpan[] = [];
	export(spans: ReadableSpan[], done: (result: { code: ExportResultCode }) => void): void {
		this.spans.push(...spans);
		done({ code: ExportResultCode.SUCCESS });
	}
	async shutdown(): Promise<void> {}
}

class BlockingExporter implements SpanExporter {
	private readonly waiting: Array<(result: { code: ExportResultCode }) => void> = [];
	private blocked = true;
	export(_spans: ReadableSpan[], done: (result: { code: ExportResultCode }) => void): void {
		if (this.blocked) this.waiting.push(done);
		else done({ code: ExportResultCode.SUCCESS });
	}
	release(): void {
		this.blocked = false;
		for (const done of this.waiting.splice(0)) done({ code: ExportResultCode.SUCCESS });
	}
	async shutdown(): Promise<void> {
		this.release();
	}
}

function options(exporter: SpanExporter, enabled = true) {
	return {
		enabled,
		serviceName: "pilot.daemon" as const,
		serviceVersion: "1.45.1",
		environment: "test" as const,
		hostKind: "local" as const,
		exporter,
	};
}

test("exports only reviewed span and resource fields", async () => {
	const exporter = new MemoryExporter();
	const telemetry = new NodeTelemetry(options(exporter));
	const span = telemetry.startSpan("pilot.daemon.request", {
		"pilot.operation": "daemon.request",
		"pilot.outcome": "success",
		"pilot.queue_depth": 2,
	});
	span.end();
	assert.equal(await telemetry.forceFlush(), true);

	assert.equal(exporter.spans.length, 1);
	const [recorded] = exporter.spans;
	assert.equal(recorded?.name, "pilot.daemon.request");
	assert.deepEqual(recorded?.attributes, {
		"pilot.operation": "daemon.request",
		"pilot.outcome": "success",
		"pilot.queue_depth": 2,
	});
	assert.equal(recorded?.resource.attributes["service.namespace"], "com.babariviere.pilot");
	assert.equal(recorded?.resource.attributes["service.name"], "pilot.daemon");
	assert.equal(recorded?.resource.attributes["pilot.schema.version"], 1);
	assert.equal(typeof recorded?.resource.attributes["service.instance.id"], "string");
	assert.equal(recorded?.resource.attributes["host.name"], undefined);
	await telemetry.shutdown();
});

test("end preserves an explicitly recorded outcome", async () => {
	const exporter = new MemoryExporter();
	const observed: TelemetryInFlightEvent[] = [];
	const telemetry = new NodeTelemetry({
		...options(exporter),
		observeInFlight: (event) => observed.push(event),
	});
	telemetry.recordSpan("pilot.kernel.request", 5, {
		"pilot.operation": "kernel.request",
		"pilot.outcome": "failure",
	});
	await telemetry.forceFlush();
	assert.equal(exporter.spans[0]?.attributes["pilot.outcome"], "failure");
	const finished = observed.at(-1);
	assert.equal(finished?.kind, "finished");
	assert.equal(finished?.kind === "finished" ? finished.outcome : undefined, "failed");
	await telemetry.shutdown();
});

test("rejects arbitrary fields and malformed trace carriers before recording", async () => {
	const exporter = new MemoryExporter();
	const telemetry = new NodeTelemetry(options(exporter));
	const invalid = telemetry.startSpan("pilot.kernel.request", {
		"pilot.outcome": "success",
		prompt: "private",
	} as never);
	assert.equal(invalid.recording, false);
	assert.equal(telemetry.stats.invalid, 1);
	assert.equal(traceCarrier({ traceparent: "not-a-trace", tracestate: "vendor=value" }), undefined);
	assert.equal(await telemetry.forceFlush(), true);
	assert.equal(exporter.spans.length, 0);
	await telemetry.shutdown();
});

test("propagates W3C traceparent without baggage or tracestate", async () => {
	const exporter = new MemoryExporter();
	const telemetry = new NodeTelemetry(options(exporter));
	const parent = telemetry.startSpan("pilot.daemon.request");
	const carrier = parent.carrier();
	assert.ok(carrier);
	assert.deepEqual(Object.keys(carrier), ["traceparent"]);
	const child = telemetry.startSpan("pilot.kernel.request", {}, { parent: carrier });
	child.end();
	parent.end();
	await telemetry.forceFlush();

	assert.equal(child.traceId, parent.traceId);
	assert.equal(exporter.spans.length, 2);
	await telemetry.shutdown();
});

test("disabled telemetry creates no spans or exporter work", async () => {
	const exporter = new MemoryExporter();
	const telemetry = new NodeTelemetry(options(exporter, false));
	const span = telemetry.startSpan("pilot.daemon.request", { "pilot.operation": "daemon.request" });
	assert.equal(span.recording, false);
	span.end();
	await telemetry.forceFlush();
	assert.equal(exporter.spans.length, 0);
	assert.deepEqual(telemetry.stats, { started: 0, invalid: 0, queued: 0, dropped: 0, exportFailures: 0 });
});

test("sheds new spans at the process queue bound", async () => {
	const exporter = new BlockingExporter();
	const telemetry = new NodeTelemetry(options(exporter));
	for (let index = 0; index < 600; index++) telemetry.startSpan("pilot.daemon.request").end();
	assert.equal(telemetry.stats.queued, 512);
	assert.equal(telemetry.stats.dropped, 88);
	exporter.release();
	assert.equal(await telemetry.forceFlush(), true);
	assert.equal(telemetry.stats.queued, 0);
	await telemetry.shutdown();
});

test("local in-flight hooks distinguish useful progress from liveness with export disabled", () => {
	const events: TelemetryInFlightEvent[] = [];
	const telemetry = new NodeTelemetry({
		...options(new MemoryExporter(), false),
		observeInFlight: (event) => events.push(event),
	});
	const span = telemetry.startSpan("pilot.kernel.request", { "pilot.operation": "kernel.request" });
	assert.equal(span.recording, true);
	assert.ok(span.carrier());
	span.heartbeat();
	span.progress();
	assert.deepEqual(
		events.map((event) => event.kind),
		["started", "heartbeat", "progress"],
	);
	assert.equal(
		events.some((event) => event.kind === "finished"),
		false,
	);
	span.finish("interrupted");
	const finished = events.at(-1);
	assert.equal(finished?.kind, "finished");
	assert.equal(finished?.kind === "finished" ? finished.outcome : undefined, "interrupted");
	assert.equal(new Set(events.map((event) => event.spanId)).size, 1);
	assert.equal(new Set(events.map((event) => event.traceId)).size, 1);
});

test("an in-flight observer cannot affect the observed operation", () => {
	const telemetry = new NodeTelemetry({
		...options(new MemoryExporter(), false),
		observeInFlight: () => {
			throw new Error("observer failed");
		},
	});
	const span = telemetry.startSpan("pilot.daemon.request");
	assert.doesNotThrow(() => {
		span.heartbeat();
		span.progress();
		span.end();
	});
});

test("uses OTLP HTTP protobuf against a local receiver", async (context) => {
	let contentType: string | undefined;
	let authorization: string | undefined;
	let body = Buffer.alloc(0);
	const server = createServer((request, response) => {
		contentType = request.headers["content-type"];
		authorization = request.headers.authorization;
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			body = Buffer.concat(chunks);
			response.writeHead(200, { "content-type": "application/x-protobuf" });
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	context.after(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const previousHeader = process.env.OTEL_EXPORTER_OTLP_HEADERS;
	process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=private";
	context.after(() => {
		if (previousHeader === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
		else process.env.OTEL_EXPORTER_OTLP_HEADERS = previousHeader;
	});
	const telemetry = new NodeTelemetry({
		...options(new MemoryExporter()),
		exporter: undefined,
		endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
	});
	context.after(() => telemetry.shutdown());
	telemetry.startSpan("pilot.event_loop.stall", { "pilot.operation": "event_loop.stall" }).end();
	assert.equal(await telemetry.forceFlush(), true);
	assert.match(contentType ?? "", /^application\/x-protobuf/);
	assert.equal(authorization, undefined);
	assert.ok(body.length > 0);
	assert.equal(body.includes(Buffer.from("pilot.event_loop.stall")), true);
	assert.equal(body.includes(Buffer.from("com.babariviere.pilot")), true);
});

test("OTLP endpoints reject unsafe transports and URL secrets", () => {
	assert.equal(validateOtlpEndpoint("http://127.0.0.1:4318"), "http://127.0.0.1:4318/v1/traces");
	assert.throws(() => validateOtlpEndpoint("http://collector.example/v1/traces"), /HTTPS or loopback/);
	assert.throws(() => validateOtlpEndpoint("https://token@collector.example/v1/traces"), /credentials/);
	assert.throws(() => validateOtlpEndpoint("https://collector.example/v1/traces?token=secret"), /query/);
});
