import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DiagnosticReadBroker,
	awaitDiagnosticRead,
	diagnosticContextResponse,
	parseDiagnosticContext,
	sanitizeDiagnosticContext,
} from "./diagnostic-context.ts";

const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
test("diagnostic selectors reject forged authority, paths and unbounded queries", () => {
	for (const value of [
		{ action: "chat", role: "diagnostics" },
		{ action: "history", sessionId: "../../secret" },
		{ action: "chats", query: "x".repeat(201) },
		{ action: "chats", host: { ...host, url: "http://evil" } },
		{ action: "chats", limit: 21 },
		{ action: "mission" },
		{ action: "issues" },
		{ action: "chats", before: -1 },
		{ action: "read_file", path: "/secret" },
	])
		assert.throws(() => parseDiagnosticContext(value));
	assert.deepEqual(parseDiagnosticContext({ action: "chats", host, limit: 20 }), { action: "chats", host, limit: 20 });
});
test("metadata and issue text are sanitized and bounded independently from telemetry", () => {
	const input = {
		title: "password=canary",
		reasoning: "hidden-canary",
		attachments: ["image-canary"],
		budget: { limitUsdMicros: 123, informational: true },
		ref: "diagnostic:v1:lifecycle:abc",
		nextCursor: "a".repeat(128),
		body: "x".repeat(100_000),
		tasks: Array(2000).fill({ title: "big" }),
	};
	const result = diagnosticContextResponse(host, input);
	assert.equal(result.status, "partial");
	assert.ok(result.page.truncated);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
	assert.doesNotMatch(JSON.stringify(result), /canary/);
	assert.match(JSON.stringify(result), /123/);
	assert.match(JSON.stringify(result), /diagnostic:v1:lifecycle:abc/);
	assert.match(JSON.stringify(result), new RegExp("a".repeat(128)));
	assert.ok(sanitizeDiagnosticContext(Array(5000).fill({ x: [1, 2, 3] })).truncated);
});
test("native courier is bounded, correlated, cancellable and rejects stale responses", async () => {
	const broker = new DiagnosticReadBroker();
	const dispatches: string[] = [];
	broker.onRead((d) => dispatches.push(d.id));
	const controller = new AbortController();
	const read = broker.read({ action: "hosts" }, controller.signal);
	broker.respond(dispatches[0]!, { hosts: [] });
	assert.deepEqual(await read, { hosts: [] });
	assert.throws(() => broker.respond(dispatches[0]!, {}), /expired/);
	const cancelled = broker.read({ action: "hosts" }, controller.signal);
	controller.abort();
	await assert.rejects(cancelled, /cancelled/);
	const waiting = Array.from({ length: 8 }, () => broker.read({ action: "hosts" }).catch((e) => e));
	await assert.rejects(broker.read({ action: "hosts" }), /busy/);
	broker.close();
	assert.ok((await Promise.all(waiting)).every((v) => v instanceof Error));
	await assert.rejects(broker.read({ action: "hosts" }), /unavailable/);
});

test("diagnostic cancellation releases the caller even if a bounded cold reader is still settling", async () => {
	const controller = new AbortController();
	const read = awaitDiagnosticRead(new Promise(() => undefined), controller.signal);
	controller.abort();
	await assert.rejects(read, /cancelled/);
});
