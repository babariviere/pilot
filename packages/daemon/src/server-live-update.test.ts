import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubSetupService } from "./github-setup.ts";
import { daemonHello } from "./hello.ts";
import { LiveUpdateService } from "./live-update.ts";
import { ModelCatalog } from "./models.ts";
import { durableJSON, OperationJournal } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import type { RuntimeContributor } from "./runtime-admission.ts";
import { RuntimeBackground } from "./runtime-background.ts";
import type { RuntimeOwner } from "./runtime-owner.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { SetupError } from "./setup.ts";
import { TerminalManager } from "./terminals.ts";

const source = "a".repeat(40);
const proposal = {
	schema: 1,
	id: "proposal",
	sessionId: "chat",
	projectId: "project",
	directory: "/synthetic/pilot",
	source,
	build: "1.2",
	summary: "Synthetic update",
	phase: "proposed",
};
async function fixture(
	t: test.TestContext,
	record?: unknown,
	contributor?: RuntimeContributor,
	boot = "initial",
	withJournal = false,
) {
	const home = await mkdtemp(join(tmpdir(), "pilot-server-live-update-"));
	if (record) await durableJSON(join(home, "live-update.json"), record);
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const hello = withJournal
		? await daemonHello(home, {
				independentExecution: true,
				coordinatorIsolation: false,
				powerManagement: false,
				systemSleepEvents: false,
				swiftUIArtifacts: false,
			})
		: undefined;
	let pauses = 0,
		resumes = 0;
	const service = new LiveUpdateService(
		home,
		{ origin: async () => ({ identity: '["github.com","babariviere/pilot"]' }) },
		() => sessions.freezeAdmissions(),
		async () => {
			resumes++;
		},
		{
			runtime: {
				source,
				boot,
				runtimeRoot: "/synthetic/runtime",
				build: {
					schema: 1,
					source,
					version: "1.2",
					protocol: 1,
					platform: "darwin",
					arch: "arm64",
					node: "24.21.0",
				},
			},
			pauseForUpdate: () => {
				pauses++;
				return { ready: true };
			},
		},
	);
	const auth = {
		async authenticate(capability: unknown) {
			if (capability !== "native-fixture") throw new SetupError(403, "Native authority required");
		},
		freezeAdmissions: () => () => {},
		blockers: () => [],
	} as unknown as GitHubSetupService;
	let update!: Parameters<RuntimeOwner["updates"]>[0];
	const http = createServer();
	const owner: RuntimeOwner = {
		server: http,
		identity: () => ({ boot: "synthetic", build: null }),
		install: (handler) => {
			http.on("request", handler);
		},
		ready: () => {},
		updates: (handler) => {
			update = handler;
		},
		close: async () => {},
	};
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
		undefined,
		false,
		undefined,
		undefined,
		auth,
		undefined,
		undefined,
		undefined,
		owner,
		undefined,
		undefined,
		{ service, contributors: contributor ? [contributor] : [] },
	);
	t.after(async () => {
		await service.close();
		await sessions.shutdown();
		await terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runtime-update`;
	const request = (path = "", body?: unknown, authenticated = true) =>
		fetch(base + path, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				...(authenticated ? { "x-pilot-github-capability": "native-fixture" } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { home, service, server, request, update, activity: () => ({ pauses, resumes }) };
}

test("background blockers defer daemon updates, not ordinary GUI reservations", async (t) => {
	const f = await fixture(t, undefined, {
		freezeAdmissions: () => () => {},
		blockers: () => [{ kind: "background", id: "pending" }],
	});
	await f.server.runtimeReady;
	const gui = await f.update("prepare", { operationId: "11111111-1111-1111-1111-111111111111" });
	assert.ok(gui);
	await f.update("cancel", gui);
	await assert.rejects(
		f.update("prepare", {
			operationId: "22222222-2222-2222-2222-222222222222",
			purpose: "daemon-upgrade",
		}),
		/not_idle/,
	);
});

test("terminal persistence never starts journal recovery before explicit post-release recovery", async (t) => {
	const background = new RuntimeBackground("synthetic");
	let scans = 0;
	t.mock.method(OperationJournal.prototype, "recover", async () => {
		assert.equal(background.frozen, false, "journal recovery must follow resource release");
		scans++;
	});
	const f = await fixture(t, proposal, background, "initial", true);
	await f.server.runtimeReady;
	assert.equal(scans, 0, "server assembly does not recover before session metadata loads");
	assert.equal((await f.request("/accept", { id: proposal.id, phase: "proposed" })).status, 200);
	assert.equal(background.frozen, true);
	f.server.recoverOperations();
	assert.equal(scans, 0, "active maintenance suppresses recovery");
	assert.equal((await f.request("/cancel", { id: proposal.id, phase: "draining" })).status, 200);
	assert.equal(background.frozen, false);
	assert.equal(scans, 0, "a terminal persistence event is not post-release authorization");
	f.server.recoverOperations();
	assert.equal(scans, 1, "startup/resume explicitly drives recovery after metadata and release");
});

test("native progress waits for admitted background cleanup and blocks re-entry", async (t) => {
	const background = new RuntimeBackground("synthetic");
	const f = await fixture(t, proposal, background);
	await f.server.runtimeReady;
	const end = background.begin("child-exit");
	assert.equal((await f.request("/accept", { id: proposal.id, phase: "proposed" })).status, 200);
	assert.throws(() => background.begin("new"), /maintenance/);
	const waiting = await f.request("/progress", { id: proposal.id, phase: "draining" });
	assert.equal(waiting.status, 200);
	const status = (await waiting.json()) as { ready: boolean; blockers: unknown[] };
	assert.equal(status.ready, false);
	assert.equal(status.blockers.length, 1);
	end();
	const ready = await f.request("/progress", { id: proposal.id, phase: "draining" });
	assert.equal(((await ready.json()) as { ready: boolean }).ready, true);
	assert.equal((await f.request("/cancel", { id: proposal.id, phase: "proposed" })).status, 409);
	assert.equal((await f.request("/cancel", { id: proposal.id, phase: "draining" })).status, 200);
	assert.equal(background.frozen, false);
	assert.equal(f.activity().resumes, 1);
});

test("private reservations require exact coordinated intent binding", async (t) => {
	const target = {
		guiBuild: proposal.build,
		source,
		runtimeRoot: "/synthetic/next",
		build: {
			schema: 1,
			source,
			version: "1.2",
			protocol: 1,
			platform: "darwin",
			arch: "arm64",
			node: "24.21.0",
		},
	};
	const f = await fixture(t, { ...proposal, phase: "gui-installing", initialBoot: "initial", target });
	await f.server.runtimeReady;
	const operationId = "11111111-1111-1111-1111-111111111111";
	await assert.rejects(f.update("prepare", { operationId }), /does not match/);
	const liveUpdate = { ...target, id: proposal.id };
	await assert.rejects(
		f.update("prepare", { operationId, liveUpdate: { ...liveUpdate, id: "wrong" } }),
		/does not match/,
	);
	await assert.rejects(f.update("prepare", { operationId, liveUpdate, purpose: "daemon-upgrade" }), /does not match/);
	await assert.rejects(
		f.update("prepare", { operationId, liveUpdate: { ...liveUpdate, runtimeRoot: "/foreign" } }),
		/does not match/,
	);
	const receipt = (await f.update("prepare", { operationId, liveUpdate })) as { liveUpdate: unknown };
	assert.deepEqual(receipt.liveUpdate, liveUpdate);
	await assert.rejects(f.update("verify", { ...receipt, liveUpdate: undefined }), /does not match/);
	assert.deepEqual(await f.update("verify", receipt), receipt);
	await f.update("cancel", receipt);
	assert.equal(f.service.frozen, true, "reservation cancellation cannot release coordinated maintenance");
});

test("live update snapshot requires native authentication and remains passive", async (t) => {
	const f = await fixture(t, proposal);
	await f.server.runtimeReady;
	assert.notEqual((await f.request("", undefined, false)).status, 200);
	const response = await f.request();
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { update: proposal, frozen: false });
	assert.deepEqual(f.activity(), { pauses: 0, resumes: 0 });
});

test("native checkpoints bind GUI build and resume only under the replacement daemon", async (t) => {
	const f = await fixture(t, proposal);
	await f.server.runtimeReady;
	assert.equal((await f.request("/accept", { id: proposal.id, phase: "proposed" })).status, 200);
	const target = {
		source,
		guiBuild: proposal.build,
		runtimeRoot: "/synthetic/runtime",
		build: { schema: 1, source, version: "1.2", protocol: 1, platform: "darwin", arch: "arm64", node: "24.21.0" },
	};
	const staged = { id: proposal.id, phase: "draining", target };
	assert.equal((await f.request("/arm-gui", staged, false)).status, 403);
	assert.equal((await f.request("/arm-gui", { ...staged, target: { ...target, guiBuild: "99" } })).status, 409);
	assert.equal((await f.request("/arm-gui", { ...staged, target: { ...target, extra: true } })).status, 409);
	assert.equal((await f.request("/arm-gui", staged)).status, 200);
	const receipt = { ...target, boot: "verified-native-replacement" };
	assert.equal(
		(
			await f.request("/gui-ready", {
				id: proposal.id,
				phase: "gui-installing",
				receipt: { ...receipt, guiBuild: "99" },
			})
		).status,
		409,
	);
	assert.equal((await f.request("/gui-ready", { id: proposal.id, phase: "gui-installing", receipt })).status, 200);
	assert.equal((await f.request("/arm-daemon", { id: proposal.id, phase: "gui-ready" })).status, 200);
	assert.equal((await f.request("/complete", { id: proposal.id, phase: "daemon-installing" })).status, 409);
	const replacement = await fixture(t, f.service.snapshot(), undefined, "replacement-daemon");
	await replacement.server.runtimeReady;
	assert.equal(replacement.service.frozen, true);
	assert.equal((await replacement.request("/complete", { id: proposal.id, phase: "daemon-installing" })).status, 200);
	assert.equal(replacement.service.frozen, false);
	assert.equal(replacement.service.snapshot()?.phase, "completed");
	assert.equal(replacement.activity().resumes, 1);
});

test("live update rejects unbound checkpoints and stale phases", async (t) => {
	const f = await fixture(t, proposal);
	await f.server.runtimeReady;
	assert.equal((await f.request("/accept", { id: proposal.id, phase: "proposed" })).status, 200);
	assert.equal(f.service.frozen, true);
	assert.equal((await f.request("/gui-ready", { id: proposal.id, receipt: { boot: "forged" } })).status, 400);
	assert.equal((await f.request("/arm-gui", { id: proposal.id })).status, 400);
	assert.equal((await f.request("/gui-ready", { id: proposal.id })).status, 400);
	assert.equal((await f.request("/accept", { id: "x".repeat(16384) })).status, 413);
	assert.equal(f.service.snapshot()?.phase, "draining");
	assert.deepEqual(f.activity(), { pauses: 0, resumes: 0 });
});

test("retained maintenance freezes full server resources before recovery", async (t) => {
	const f = await fixture(t, { ...proposal, phase: "draining", initialBoot: "previous" });
	await f.server.runtimeReady;
	assert.equal(f.service.frozen, true);
	// Ordinary mutations are refused by the same full resource assembly used by update readiness.
	assert.equal((await f.request("-not-an-update", { id: proposal.id })).status, 503);
	assert.equal((await f.request()).status, 200);
	assert.deepEqual(f.activity(), { pauses: 0, resumes: 0 });
});

test("unreadable retained maintenance fails startup and keeps admissions frozen", async (t) => {
	const f = await fixture(t, proposal);
	await f.server.runtimeReady;
	// A separate boot must not treat corrupt retained evidence as no maintenance.
	await writeFile(join(f.home, "live-update.json"), "{", { mode: 0o600 });
	let frozen = false;
	const service = new LiveUpdateService(
		f.home,
		{ origin: async () => ({ identity: null }) },
		() => {
			frozen = true;
			return () => {
				frozen = false;
			};
		},
		async () => {},
		{ pauseForUpdate: () => ({ ready: true }) },
	);
	service.attach(f.server.runtimeResources);
	await assert.rejects(service.load());
	assert.equal(frozen, true);
	assert.equal(service.frozen, true);
	await service.close();
});
