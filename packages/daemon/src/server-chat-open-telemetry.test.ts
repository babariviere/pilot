import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "@pilot/protocol";
import {
	configureNodeTelemetry,
	ExportResultCode,
	nodeTelemetry,
	type ReadableSpan,
	type SpanExporter,
} from "@pilot/telemetry";
import { WebSocket } from "ws";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("chat socket continues trace context through cold history without content attributes", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-chat-open-trace-"));
	const id = randomUUID();
	const snapshot = {
		type: "snapshot",
		entries: Array.from({ length: 150 }, (_, index) => ({ id: index + 1 })),
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
	} as unknown as AgentEvent;
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects, undefined, {
		snapshot: async () => ({ events: [snapshot] }),
	});
	const terminals = new TerminalManager();
	await sessions.load();
	await mkdir(join(home, "sessions", id), { recursive: true });
	await (
		sessions as unknown as {
			save(meta: { id: string; title: string; cwd: string; createdAt: number; updatedAt: number }): Promise<void>;
		}
	).save({ id, title: "Chat", cwd: home, createdAt: 1, updatedAt: 1 });
	const spans: ReadableSpan[] = [];
	const exporter: SpanExporter = {
		export(batch, callback) {
			spans.push(...batch);
			callback({ code: ExportResultCode.SUCCESS });
		},
		forceFlush: async () => undefined,
		shutdown: async () => undefined,
	};
	configureNodeTelemetry({
		enabled: true,
		serviceName: "pilot.daemon",
		serviceVersion: "1.45.1",
		environment: "test",
		hostKind: "local",
		exporter,
	});
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		configureNodeTelemetry({
			enabled: false,
			serviceName: "pilot.daemon",
			serviceVersion: "1.45.1",
			environment: "test",
			hostKind: "local",
		});
		await sessions.shutdown();
		await terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});

	const root = nodeTelemetry().startSpan("pilot.chat.open", { "pilot.operation": "chat.open" });
	const port = (server.address() as AddressInfo).port;
	const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/ws`, {
		headers: { traceparent: root.carrier()!.traceparent },
	});
	await new Promise<void>((resolve, reject) => {
		socket.on("message", (data) => {
			const message = JSON.parse(String(data)) as { type?: string };
			if (message.type === "events") resolve();
		});
		socket.on("error", reject);
	});
	socket.close();
	root.end();
	await nodeTelemetry().forceFlush();

	const api = spans.find((span) => span.attributes["pilot.phase"] === "api");
	const history = spans.find((span) => span.attributes["pilot.phase"] === "history_read");
	assert.equal(api?.spanContext().traceId, root.traceId);
	assert.equal(history?.spanContext().traceId, root.traceId);
	assert.equal(history?.attributes["pilot.cold"], true);
	assert.equal(history?.attributes["pilot.history_bucket"], "101-1000");
	assert.deepEqual(Object.keys(history?.attributes ?? {}).sort(), [
		"pilot.cold",
		"pilot.history_bucket",
		"pilot.operation",
		"pilot.outcome",
		"pilot.phase",
		"pilot.recovered",
	]);
});
