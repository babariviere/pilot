// biome-ignore-all lint/complexity/useLiteralKeys: Exercise startup without a model process.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	configureNodeTelemetry,
	ExportResultCode,
	nodeTelemetry,
	type ReadableSpan,
	type SpanExporter,
} from "@pilot/telemetry";
import { ModelCatalog } from "./models.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("durable sends continue only the executing HTTP attempt into admission", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-durable-trace-"));
	const host = { hostId: "daemon", daemonId: "daemon", lineageId: "lineage" };
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	let hold = false;
	let entered!: () => void;
	let release!: () => void;
	const enteredStart = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const releaseStart = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.mock.method(sessions as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => {
		if (hold) {
			entered();
			await releaseStart;
		}
		return new Map();
	});
	t.after(() => release());
	const targetId = randomUUID();
	await sessions.spawnDurable({ cwd: home, message: "opening" }, targetId, randomUUID());
	sessions["metas"].get(targetId)!.initializing = false;
	const spans: ReadableSpan[] = [];
	const exporter: SpanExporter = {
		export(batch, callback) {
			spans.push(...batch);
			callback({ code: ExportResultCode.SUCCESS });
		},
		forceFlush: async () => undefined,
		shutdown: async () => undefined,
	};
	const settings = {
		serviceName: "pilot.daemon" as const,
		serviceVersion: "1.45.1",
		environment: "test",
		hostKind: "local" as const,
	};
	configureNodeTelemetry({ ...settings, enabled: true, exporter });
	const terminals = new TerminalManager();
	const hello = {
		daemonId: host.daemonId,
		lineageId: host.lineageId,
		daemonVersion: "test",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin" as const,
		arch: "arm64" as const,
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: false,
			independentExecution: true,
		},
	};
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	];
	args[12] = hello;
	const server = createDaemonServer(...args);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		configureNodeTelemetry({ ...settings, enabled: false });
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
		await terminals.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const op = (sequence: number, attached = false) => {
		const request = { message: "secret-message-never-export", mode: "followUp" };
		const payload = JSON.stringify(attached ? { request, attachments: [] } : request);
		return {
			schemaVersion: 1 as const,
			operationId: randomUUID(),
			producerId: "app",
			sequence,
			origin: host,
			destination: host,
			kind: attached ? "chat-send-attached" : "chat-send",
			targetId,
			payload,
			payloadHash: payloadHash(payload),
		};
	};
	const parent = (digit: string) => `00-${digit.repeat(32)}-${digit.repeat(16)}-01`;
	const post = async (path: string, value: unknown, traceparent?: string) => {
		const response = await fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json", ...(traceparent ? { traceparent } : {}) },
			body: JSON.stringify(value),
		});
		assert.equal(response.status, 200);
		return response.json();
	};
	const a = op(1),
		b = op(2, true),
		missing = op(3),
		malformed = op(4);
	const [receiptA, receiptB] = await Promise.all([
		post("/api/operations", a, parent("1")),
		post("/api/operations", b, parent("2")),
	]);
	assert.equal(receiptA.state, "accepted");
	assert.equal(receiptB.state, "accepted");
	assert.deepEqual(await post("/api/operations", a, parent("3")), receiptA);
	assert.deepEqual(await post("/api/operations/receipt", b, parent("4")), receiptB);
	assert.equal((await post("/api/operations", missing)).state, "accepted");
	assert.equal((await post("/api/operations", malformed, "invalid")).state, "accepted");
	const invalidPayload = JSON.stringify({ message: "" });
	const rejected = { ...op(8), payload: invalidPayload, payloadHash: payloadHash(invalidPayload) };
	const rejectedReceipt = await post("/api/operations", rejected, parent("9"));
	assert.equal(rejectedReceipt.state, "rejected");
	assert.deepEqual(await post("/api/operations", rejected, parent("a")), rejectedReceipt);
	await nodeTelemetry().forceFlush();
	const admissions = spans.filter((span) => span.attributes["pilot.phase"] === "admission");
	assert.deepEqual(admissions.map((span) => span.spanContext().traceId).sort(), ["1".repeat(32), "2".repeat(32)]);
	assert.deepEqual(admissions.map((span) => span.parentSpanContext?.spanId).sort(), ["1".repeat(16), "2".repeat(16)]);
	for (const admission of admissions) {
		const startup = spans.find(
			(span) =>
				span.attributes["pilot.phase"] === "startup_wait" &&
				span.spanContext().traceId === admission.spanContext().traceId,
		);
		assert.equal(startup?.parentSpanContext?.spanId, admission.spanContext().spanId);
		assert.deepEqual(Object.keys(admission.attributes).sort(), [
			"pilot.cold",
			"pilot.operation",
			"pilot.outcome",
			"pilot.phase",
			"pilot.queue_depth",
			"pilot.recovered",
		]);
	}
	assert.ok(!JSON.stringify(spans.map((span) => span.attributes)).includes("secret-message-never-export"));
	assert.ok(!JSON.stringify(spans.map((span) => span.attributes)).includes(home));
	const journal = new OperationJournal(join(home, "operations"), host);
	assert.deepEqual(await journal.lookup(a), receiptA);
	assert.equal(receiptA.payloadHash, a.payloadHash);
	const metadata = JSON.parse(await readFile(join(home, "sessions", targetId, "meta.json"), "utf8"));
	assert.equal(metadata.pending.filter((item: { requestId: string }) => item.requestId === a.operationId).length, 1);

	// A fresh journal recovery has no request attempt, even after traced admissions.
	const recovery = op(5);
	await journal.reserve(recovery);
	await new OperationJournal(join(home, "operations"), host).recover(async (operation) => {
		await sessions.sendDurable(
			operation.targetId,
			JSON.parse(operation.payload).message,
			"followUp",
			operation.operationId,
		);
		return { sessionId: operation.targetId };
	});
	await nodeTelemetry().forceFlush();
	assert.equal(spans.filter((span) => span.attributes["pilot.phase"] === "admission").length, 2);
	const pending = op(6);
	hold = true;
	const first = post("/api/operations", pending, parent("6"));
	await enteredStart;
	assert.equal((await post("/api/operations/receipt", pending, parent("7"))).state, "pending");
	const duplicate = post("/api/operations", pending, parent("8"));
	hold = false;
	release();
	assert.deepEqual(await duplicate, await first);
	await nodeTelemetry().forceFlush();
	assert.deepEqual(
		spans
			.filter((span) => span.attributes["pilot.phase"] === "admission")
			.map((span) => span.spanContext().traceId)
			.sort(),
		["1".repeat(32), "2".repeat(32), "6".repeat(32)],
	);

	t.mock.method(nodeTelemetry(), "startSpan", () => {
		throw new Error("telemetry unavailable");
	});
	const failure = op(7);
	assert.equal((await post("/api/operations", failure, parent("5"))).state, "accepted");
});
