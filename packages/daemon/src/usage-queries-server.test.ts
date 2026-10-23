import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UsageAnalyticsQuery, UsageAnalyticsResult } from "@pilot/protocol";
import { daemonHello } from "./hello.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { UsageQueryCapacityError } from "./usage-history.ts";

test("versioned GET query/page boundary is read-only, bounded, host-fenced and content-free", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "usage-api-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const hello = await daemonHello(
		home,
		{
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: false,
			independentExecution: true,
		},
		{},
	);
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		hello,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await sessions.shutdown();
		await terminals.shutdown();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(home, { recursive: true, force: true });
	});
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const now = Date.now();
	const query: UsageAnalyticsQuery = { version: 1, from: now - 86400000, to: now + 1, view: "summary" };
	const url = (body: unknown, path = "query", daemonId = hello.daemonId) =>
		`${origin}/api/usage-history/${path}?` +
		new URLSearchParams({ query: JSON.stringify(body), daemonId, lineageId: hello.lineageId! });
	t.mock.method(sessions, "list", () => assert.fail("accounting must not open/list sessions"));
	t.mock.method(sessions, "spawn", async () => assert.fail("accounting must not wake kernel workers"));
	assert.equal(hello.capabilities.usageQueries, 1);
	const response = await fetch(url(query));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const result = (await response.json()) as UsageAnalyticsResult;
	assert.equal(result.total.records, 0);
	assert.equal(result.total.metrics.input.value, undefined);
	const ranked = await fetch(
		url({ ...query, view: "breakdown", dimension: "chat", sort: "estimatedUsdMicros", direction: "desc" }),
	);
	assert.equal(ranked.status, 200);
	assert.deepEqual(((await ranked.json()) as UsageAnalyticsResult).groups, []);
	assert.equal((await fetch(url({ kind: "checkpoint", from: query.from, to: query.to }, "page"))).status, 200);
	assert.equal((await fetch(url(query, "query", "different"))).status, 409);
	assert.equal((await fetch(url(query), { headers: { origin: "https://external.invalid" } })).status, 403);
	assert.equal((await fetch(url(query), { method: "POST" })).status, 404);
	for (const invalid of [
		{ ...query, limit: 101 },
		{ ...query, version: 2 },
		{ ...query, sort: "input" },
		{ ...query, view: "breakdown", dimension: "chat", sort: "title" },
		{ ...query, filters: { mission: { missionId: "incomplete" } } },
	])
		assert.equal((await fetch(url(invalid))).status, 400);
	assert.equal((await fetch(url({ padding: "x".repeat(4100) }))).status, 400);
	const badPage = await fetch(url({ kind: "request", from: query.from, to: query.to, limit: 101 }, "page"));
	assert.equal(badPage.status, 400);
	assert.doesNotMatch(await badPage.text(), /SELECT|sqlite|operationId|tokens|\/Users\//);
	const busy = t.mock.method(sessions.usageHistory, "analytics", async () => {
		throw new UsageQueryCapacityError();
	});
	assert.equal((await fetch(url(query))).status, 429);
	busy.mock.restore();
});
