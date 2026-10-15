import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
import { daemonHello, daemonIdentity } from "./hello.ts";
import { forkMainViewWorker } from "./main-view.ts";
import { ModelCatalog } from "./models.ts";
import { detectPlatformCapabilities } from "./platform.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("Linux capability detection never probes Mac helpers or offers unrestricted isolation", async () => {
	const unexpected = async () => assert.fail("Linux must not touch Mac helpers/toolchains");
	assert.deepEqual(
		await detectPlatformCapabilities("linux", unexpected, unexpected, async () => ({ available: false })),
		{
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: false,
			independentExecution: true,
		},
	);
	if (process.platform === "linux")
		await assert.rejects(
			forkMainViewWorker("/unused", { scratch: "/tmp", protectedPaths: ["/tmp/protected"] }),
			/refusing an unrestricted/,
		);
	assert.equal(loadConfig({ PILOT_HOST: "0.0.0.0" }).host, "127.0.0.1");
	assert.equal(
		(await detectPlatformCapabilities("linux", unexpected, unexpected, async () => ({ available: true })))
			.coordinatorIsolation,
		true,
	);
});

test("Darwin capabilities reflect installed helpers and compiler, not just an OS name", async () => {
	const absent = await detectPlatformCapabilities(
		"darwin",
		async () => false,
		async () => assert.fail("no sandbox"),
	);
	assert.equal(absent.powerManagement, false);
	assert.equal(absent.swiftUIArtifacts, false);
	const installed = await detectPlatformCapabilities(
		"darwin",
		async () => true,
		async () => false,
	);
	assert.equal(installed.powerManagement, true);
	assert.equal(installed.systemSleepEvents, true);
	assert.equal(installed.coordinatorIsolation, true);
	assert.equal(installed.swiftUIArtifacts, false);
});

test("daemon identity survives concurrent starts/restarts and never replaces damaged identity", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-identity-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const ids = await Promise.all(Array.from({ length: 8 }, () => daemonIdentity(home)));
	assert.equal(new Set(ids).size, 1);
	assert.equal(await daemonIdentity(home), ids[0]);
	assert.equal((await stat(join(home, "daemon-id"))).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(home), ["daemon-id"]);
	const other = await daemonIdentity(join(home, "other"));
	assert.notEqual(other, ids[0]);
	await writeFile(join(home, "daemon-id"), "damaged\n");
	await assert.rejects(daemonIdentity(home), /Invalid daemon identity/);
	assert.equal(await readFile(join(home, "daemon-id"), "utf8"), "damaged\n");
});

test("hello is a bounded no-store read with origin protection and no account/path data", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-hello-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const hello = await daemonHello(home, await detectPlatformCapabilities("linux"));
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
	t.after(async () => {
		await terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/hello`;
	const response = await fetch(base);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), hello);
	assert.ok(!JSON.stringify(hello).includes(home));
	assert.equal(hello.protocolVersion, 1);
	assert.equal(hello.minimumClientProtocolVersion, 1);
	assert.match(hello.daemonVersion, /^\d+\.\d+\.\d+/);
	for (const [path, options, status] of [
		[base, { headers: { origin: "https://example.com" } }, 403],
		[base, { method: "POST" }, 405],
		[`${base}/extra`, {}, 404],
	] as const) {
		const denied = await fetch(path, options);
		assert.equal(denied.status, status);
		await denied.arrayBuffer();
	}
});
