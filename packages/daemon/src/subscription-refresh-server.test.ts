import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { daemonHello } from "./hello.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { SubscriptionRefresh } from "./subscription-refresh.ts";
import { TerminalManager } from "./terminals.ts";

test("subscription refresh is explicit, identity-pinned, coalesced and never starts an agent", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "subscription-refresh-"));
	const projects = new ProjectStore(home),
		sessions = new SessionManager(home, projects),
		terminals = new TerminalManager();
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
	let calls = 0;
	const subscriptions = new SubscriptionRefresh(async (provider) => {
		calls++;
		return {
			outcome: "refreshed",
			usage: { provider, fetchedAt: 1000, windows: [{ label: "5h", usedPercent: 42 }] },
		};
	});
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	];
	args[12] = hello;
	args[22] = subscriptions;
	const server = createDaemonServer(...args);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await sessions.shutdown();
		await terminals.shutdown();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(home, { recursive: true, force: true });
	});
	t.mock.method(sessions, "spawn", async () => assert.fail("refresh cannot start agents"));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const url = (path = "", daemonId = hello.daemonId, provider = "anthropic") =>
		`${origin}/api/subscription-usage${path}?${new URLSearchParams({ daemonId, lineageId: hello.lineageId!, provider })}`;
	assert.equal(
		((await (await fetch(`${origin}/api/hello`)).json()) as typeof hello).capabilities.subscriptionRefresh,
		1,
	);
	const read = await fetch(url());
	assert.equal(read.status, 200);
	assert.equal(read.headers.get("cache-control"), "no-store");
	assert.equal(calls, 0);
	assert.equal((await fetch(url("/refresh"))).status, 404);
	assert.equal((await fetch(url("/refresh", "wrong"), { method: "POST" })).status, 409);
	assert.equal((await fetch(url("/refresh", hello.daemonId, "other"), { method: "POST" })).status, 400);
	assert.equal(
		(await fetch(url("/refresh"), { method: "POST", headers: { origin: "https://external.invalid" } })).status,
		403,
	);
	assert.equal(calls, 0);
	const response = await fetch(url("/refresh"), { method: "POST" });
	assert.deepEqual(await response.json(), {
		provider: "anthropic",
		account: "not_reported",
		state: "refreshed",
		usage: { provider: "anthropic", fetchedAt: 1000, windows: [{ label: "5h", usedPercent: 42 }] },
	});
	assert.equal(calls, 1);
});
