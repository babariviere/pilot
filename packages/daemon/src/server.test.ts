import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	AgentEvent,
	DaemonHello,
	ServerMessage,
	SessionDiagnostics,
	SessionSummary,
	SpawnRequest,
} from "@pilot/protocol";
import { WebSocket } from "ws";
import { RepositoryChanges } from "./changes.ts";
import { DATABASE_CONFIG_FILE, DatabaseService } from "./databases.ts";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import { GitHubSetupService } from "./github-setup.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { NotFound, SessionManager } from "./sessions.ts";
import { SourceRegistry } from "./sources.ts";
import { TelemetrySettingsService } from "./telemetry-settings.ts";
import { TerminalManager } from "./terminals.ts";
import { TrackedItemStore } from "./tracked-items.ts";

test("refresh-health native reads are qualified, protected and never trigger a refresh", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "refresh-health-api-"));
	const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, tracking: { slackChannels: [], linearTeam: "ENG" } });
	const items = new TrackedItemStore(join(home, "items.sqlite"));
	await items.load([project.id]);
	let external = 0;
	const tracking = new SourceRegistry(projects, items, {
		async call() {
			external++;
			return {};
		},
	});
	tracking.register("linear", async () => {
		external++;
		return { items: [] };
	});
	const sessions = new SessionManager(home, projects, undefined, {}, {}, { diagnosticHost: host });
	const terminals = new TerminalManager();
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	];
	args[9] = tracking;
	args[18] = {
		authenticate: async (value: unknown) => {
			if (value !== "native-fixture") throw new Conflict("Native only");
		},
	} as unknown as NonNullable<(typeof args)[18]>;
	const server = createDaemonServer(...args);
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await tracking.stop();
		terminals.shutdown();
		await sessions.shutdown();
		await items.close();
		rmSync(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/diagnostics/read`;
	const post = (body: unknown, native = true) =>
		fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(native ? { "x-pilot-github-capability": "native-fixture" } : {}),
			},
			body: JSON.stringify(body),
		});
	const request = { action: "refresh_health", host, projectId: project.id, query: "linear", channelOffset: 0 };
	const denied = await post(request, false);
	assert.equal(denied.status, 409);
	await denied.arrayBuffer();
	const accepted = await post(request);
	assert.equal(accepted.status, 200);
	const response = (await accepted.json()) as {
		host: unknown;
		data: { sources: Array<{ assessment: { state: string } }> };
	};
	assert.deepEqual(response.host, host);
	assert.equal(response.data.sources[0]?.assessment.state, "not_scheduled");
	const wrong = await post({ ...request, host: { ...host, lineageId: "other" } });
	assert.equal(wrong.status, 409);
	await wrong.arrayBuffer();
	const forged = await post({ ...request, role: "diagnostics" });
	assert.equal(forged.status, 409);
	await forged.arrayBuffer();
	assert.equal(external, 0);
	assert.equal(items.checkpoint(`${project.id}:linear`), undefined);
	assert.equal(sessions.list().length, 0);
});

test("native local feature aggregate delivery and diagnostic reads work with export off and survive clear safely", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "native-feature-api-"));
	const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects, undefined, {}, {}, { diagnosticHost: host });
	const telemetry = await TelemetrySettingsService.open(home, {
		daemonId: "daemon",
		lineageId: "lineage",
		daemonVersion: "1.0.0",
	} as DaemonHello);
	const terminals = new TerminalManager();
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	];
	args[17] = telemetry;
	args[18] = {
		authenticate: async (value: unknown) => {
			if (value !== "native-fixture") throw new Conflict("Native only");
		},
	} as unknown as NonNullable<(typeof args)[18]>;
	const server = createDaemonServer(...args);
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		terminals.shutdown();
		await sessions.shutdown();
		await telemetry.featureUsage.close();
		rmSync(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const put = (body: unknown, native = true) =>
		fetch(`${base}/diagnostics/feature-usage`, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				...(native ? { "x-pilot-github-capability": "native-fixture" } : {}),
			},
			body: JSON.stringify(body),
		});
	assert.equal(sessions.appDiagnostics().featureUsage?.status, "disabled");
	await telemetry.update({
		localDiagnostics: false,
		localFeatureUsage: true,
		remoteOperational: false,
		productAnalytics: false,
	});
	const day = new Date().toISOString().slice(0, 10);
	const batch = {
		schemaVersion: 1,
		epoch: telemetry.settings().featureUsageEpoch,
		producer: randomUUID(),
		revision: 1,
		startedAt: new Date().toISOString(),
		observedAt: new Date().toISOString(),
		dropped: 0,
		cells: [{ catalogVersion: 1, feature: "diagnose_chat", stage: "attempt", day, count: 3 }],
	};
	const unauthorized = await put(batch, false);
	assert.equal(unauthorized.status, 409);
	await unauthorized.arrayBuffer();
	for (let i = 0; i < 2; i++) {
		const response = await put(batch);
		assert.equal(response.status, 200);
		await response.arrayBuffer();
	}
	const evidence = await sessions.readDiagnosticContext({
		action: "features",
		query: "diagnose_chat",
		since: day,
		until: day,
	});
	assert.match(JSON.stringify(evidence), /native_ui_observations_across_chats/);
	assert.match(JSON.stringify(evidence), /"count":3/);
	assert.equal(sessions.appDiagnostics().featureUsage?.cells[0]?.count, 3);
	assert.equal(telemetry.settings().remoteOperational, false);
	assert.equal(telemetry.settings().productAnalytics, false);
	const cleared = await fetch(`${base}/diagnostics`, { method: "DELETE" });
	assert.equal(cleared.status, 200);
	await cleared.arrayBuffer();
	const stale = await put(batch);
	assert.equal(stale.status, 409);
	await stale.arrayBuffer();
	assert.deepEqual(sessions.appDiagnostics().featureUsage?.cells, []);
	assert.equal(sessions.appDiagnostics().featureUsage?.reason, "no_producer");
	assert.equal(sessions.list().length, 0);
});

test("project database settings require native authority and fence revisions without exposing URLs", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "pilot-database-api-"));
	const projects = new ProjectStore(home);
	t.mock.method(projects, "require", (id: string) => {
		if (id !== "project") throw new NotFound("Unknown project");
		return { id, name: "Project", path: "/work/project", createdAt: 1 };
	});
	const databases = new DatabaseService(home);
	const sessions = new SessionManager(home, projects, home, {}, {}, { databases });
	const terminals = new TerminalManager();
	const native = new GitHubSetupService(
		home,
		{ hostId: "fixture", daemonId: "fixture", lineageId: "fixture" },
		{ userHome: home, env: {} },
	);
	await assert.rejects(native.authenticate("")); // Await local capability creation, without running a host probe.
	const capability = JSON.parse(readFileSync(join(home, "github-app-capability"), "utf8")).token;
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	];
	args[18] = native;
	const server = createDaemonServer(...args);
	t.after(async () => {
		await sessions.shutdown();
		await terminals.shutdown();
		await native.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const url = `${origin}/api/projects/project/databases`;
	const headers = { "x-pilot-github-capability": capability, "content-type": "application/json" };
	for (const method of ["GET", "PUT"]) {
		const response = await fetch(url, { method });
		assert.equal(response.status, 403);
		await response.arrayBuffer();
	}
	const missing = await fetch(`${origin}/api/projects/other/databases`, { headers });
	assert.equal(missing.status, 404);
	await missing.arrayBuffer();
	const initial = await fetch(url, { headers });
	assert.equal(initial.status, 200);
	assert.equal(initial.headers.get("cache-control"), "no-store");
	assert.deepEqual(await initial.json(), { revision: "missing", environments: [] });
	const update = {
		revision: "missing",
		environments: [{ name: "prod", read: { url: "postgres://ro:secret@db/app?sslpassword=query-secret" } }],
	};
	const saved = await fetch(url, { headers, method: "PUT", body: JSON.stringify(update) });
	assert.equal(saved.status, 200);
	assert.ok(!(await saved.text()).includes("secret"));
	assert.equal(databases.configured("/work/project"), true);
	const stale = await fetch(url, { headers, method: "PUT", body: JSON.stringify(update) });
	assert.equal(stale.status, 409);
	await stale.arrayBuffer();
	writeFileSync(join(home, DATABASE_CONFIG_FILE), "{secret malformed");
	for (const method of ["GET", "PUT"]) {
		const invalid = await fetch(url, {
			headers,
			method,
			...(method === "PUT" ? { body: JSON.stringify(update) } : {}),
		});
		assert.equal(invalid.status, 422);
		assert.ok(!(await invalid.text()).includes("secret"));
	}
	assert.equal(readFileSync(join(home, DATABASE_CONFIG_FILE), "utf8"), "{secret malformed");
});

test("app-wide diagnostic native endpoints require protected capability and reject forged role selectors", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "diagnostic-native-read-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(
		home,
		projects,
		undefined,
		{},
		{},
		{
			diagnosticHost: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
		},
	);
	const terminals = new TerminalManager();
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	];
	args[18] = {
		authenticate: async (token: unknown) => {
			if (token !== "native-fixture") throw new Conflict("Native capability required");
		},
	} as unknown as NonNullable<(typeof args)[18]>;
	const server = createDaemonServer(...args);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
		rmSync(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/diagnostics`;
	const post = (path: string, body: unknown, native = false) =>
		fetch(`${base}/${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(native ? { "x-pilot-github-capability": "native-fixture" } : {}),
			},
			body: JSON.stringify(body),
		});
	const denied = await post("read", { action: "hosts", role: "diagnostics" });
	assert.notEqual(denied.status, 200);
	await denied.arrayBuffer();
	const allowed = await post("read", { action: "hosts" }, true);
	assert.equal(allowed.status, 200);
	assert.match(JSON.stringify(await allowed.json()), /lineage/);
	const forged = await post("read", { action: "hosts", role: "diagnostics" }, true);
	assert.equal(forged.status, 409);
	await forged.arrayBuffer();
	const stale = await post("read-response", { id: randomUUID(), result: {} }, true);
	assert.equal(stale.status, 409);
	await stale.arrayBuffer();
	assert.equal(sessions.list().length, 0, "native evidence reads never create a target or Control chat");
});

test("jobs GET returns the session's read-only running list and routes missing sessions", async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const jobs = [{ id: "tests", name: "Tests", state: "running", startedAt: 1, outputPath: "/tmp/tests.log" }];
	const reads = t.mock.method(sessions, "jobs", async (id: string) => {
		if (id === "missing") throw new NotFound("Unknown session");
		return id === "idle" ? [] : (jobs as Awaited<ReturnType<SessionManager["jobs"]>>);
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions`;
	for (const [id, expected] of [
		["working", jobs],
		["idle", []],
	] as const) {
		const response = await fetch(`${base}/${id}/jobs`);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { jobs: expected });
	}
	for (const [path, options, status] of [
		[`${base}/missing/jobs`, {}, 404],
		[`${base}/working/jobs`, { method: "POST" }, 404],
		[`${base}/working/jobs/extra`, {}, 404],
		[`${base}/working/jobs`, { headers: { origin: "https://example.com" } }, 403],
	] as const) {
		const response = await fetch(path, options);
		assert.equal(response.status, status);
		await response.arrayBuffer();
	}
	assert.equal(reads.mock.callCount(), 3);
});

test("diagnostics GET requires the pinned host identity and remains read-only", async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const hello: DaemonHello = {
		daemonId: "daemon",
		lineageId: "lineage",
		daemonVersion: "1.0.0",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin",
		arch: "arm64",
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: true,
			coordinatorIsolation: true,
			independentExecution: true,
		},
	};
	const diagnostic: SessionDiagnostics = {
		schemaVersion: 1,
		host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
		sessionId: "parked",
		release: "1.0.0",
		collectedAt: "2026-01-01T00:00:00.000Z",
		freshness: "fresh",
		connectivity: { state: "unknown" },
		current: {
			state: "parked",
			working: false,
			pauses: [],
			recovery: "none",
			hasError: false,
			queue: {
				pendingInputs: 0,
				starting: false,
				parking: false,
				workspacePreparing: false,
				runningJobs: 0,
				workingSubagents: 0,
			},
		},
		resources: {},
		sources: [],
		evidence: [],
		truncation: {
			truncated: false,
			returned: 0,
			available: 0,
			dropped: 0,
			invalid: 0,
			encodedBytes: 0,
			maxItems: 12,
			maxBytes: 65_536,
		},
	};
	const reads = t.mock.method(
		sessions,
		"diagnostics",
		async (id: string, options: NonNullable<Parameters<SessionManager["diagnostics"]>[1]>) => ({
			...diagnostic,
			sessionId: id,
			host: options.host!,
		}),
	);
	const handoffs = t.mock.method(
		sessions,
		"diagnosticsHandoff",
		async (
			_specialistId: string,
			request: Parameters<SessionManager["diagnosticsHandoff"]>[1],
			options: NonNullable<Parameters<SessionManager["diagnosticsHandoff"]>[2]>,
		) => ({
			schemaVersion: 1 as const,
			host: options.host!,
			targetSessionId: request.targetSessionId,
			projectId: "project",
			evidence: [],
			proposalId: request.proposalId,
			findings: request.findings,
			uncertainty: request.uncertainty,
			suggestedRepair: request.suggestedRepair,
			regressionTestGuidance: request.regressionTestGuidance,
		}),
	);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
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
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/parked/diagnostics`;
	const response = await fetch(`${base}?hostId=local&daemonId=daemon&lineageId=lineage&limit=12`);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(((await response.json()) as SessionDiagnostics).host, diagnostic.host);
	for (const [query, status] of [
		["", 400],
		["?hostId=local&daemonId=old&lineageId=lineage", 409],
		["?hostId=local&daemonId=daemon&lineageId=old", 409],
		["?hostId=local&daemonId=daemon&lineageId=lineage&limit=129", 400],
	] as const) {
		const denied = await fetch(`${base}${query}`);
		assert.equal(denied.status, status, query);
		await denied.arrayBuffer();
	}
	assert.equal(reads.mock.callCount(), 1);
	assert.deepEqual(reads.mock.calls[0]!.arguments, [
		"parked",
		{ host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" }, limit: 12 },
	]);
	const handoffBody = {
		targetSessionId: "target",
		proposalId: "proposal",
		findings: "Likely cause",
		uncertainty: "medium" as const,
		suggestedRepair: "Suggested repair",
		regressionTestGuidance: "Regression guidance",
	};
	const handoff = await fetch(`${base}/handoff?hostId=local&daemonId=daemon&lineageId=lineage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(handoffBody),
	});
	assert.equal(handoff.status, 200);
	assert.equal(handoff.headers.get("cache-control"), "no-store");
	assert.equal(((await handoff.json()) as { targetSessionId: string }).targetSessionId, "target");
	assert.deepEqual(handoffs.mock.calls[0]!.arguments, [
		"parked",
		handoffBody,
		{ host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" } },
	]);
});

test("dedicated diagnostics and repair operations admit only their matching chat profiles", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "pilot-diagnostic-operations-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const spawned = t.mock.method(
		sessions,
		"spawnDurable",
		async (request: SpawnRequest, targetId: string) =>
			({ id: targetId, role: request.role, mode: request.mode ?? "build" }) as SessionSummary,
	);
	const hello: DaemonHello = {
		daemonId: "daemon",
		lineageId: "lineage",
		daemonVersion: "1.0.0",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin",
		arch: "arm64",
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: true,
			coordinatorIsolation: true,
			independentExecution: true,
		},
	};
	const terminals = new TerminalManager();
	const serverArgs: Parameters<typeof createDaemonServer> = [
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
	];
	serverArgs[18] = {
		authenticate: async (value: unknown) => {
			if (value !== "native-fixture") throw new Conflict("Native only");
		},
	} as unknown as NonNullable<(typeof serverArgs)[18]>;
	const server = createDaemonServer(...serverArgs);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/operations`;
	const operation = (kind: string, body: object, sequence: number) => {
		const payload = JSON.stringify(body);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence,
			origin: { hostId: "origin", daemonId: "origin-daemon", lineageId: "origin-lineage" },
			destination: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
			kind,
			targetId: randomUUID(),
			payload,
			payloadHash: createHash("sha256").update(payload).digest("hex"),
		};
	};
	for (const op of [
		operation(
			"diagnostics-create",
			{
				message: "Diagnose",
				role: "diagnostics",
				diagnosticTarget: {
					host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
					sessionId: "00000000-0000-4000-8000-000000000001",
					chatUrl: "pilot://chat/00000000-0000-4000-8000-000000000001",
				},
			},
			1,
		),
		operation(
			"repair-create",
			{
				message: "Repair",
				mode: "build",
				diagnosticRepair: {
					specialistSessionId: "00000000-0000-4000-8000-000000000002",
					proposalId: "diagnostic-proposal:v1:test",
					target: {
						host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
						sessionId: "00000000-0000-4000-8000-000000000001",
						chatUrl: "pilot://chat/00000000-0000-4000-8000-000000000001",
					},
				},
			},
			2,
		),
	]) {
		if (op.kind === "repair-create") {
			const unconfirmed = await fetch(base, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(op),
			});
			assert.notEqual(
				unconfirmed.status,
				200,
				"a matching role/proposal payload cannot substitute for native confirmation",
			);
			assert.equal(spawned.mock.callCount(), 1);
		}
		const response = await fetch(base, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": "native-fixture" },
			body: JSON.stringify(op),
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json()).state, "accepted");
	}
	const rejected = operation("diagnostics-create", { message: "Ordinary", mode: "build" }, 3);
	const response = await fetch(base, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(rejected),
	});
	assert.equal((await response.json()).state, "rejected");
	assert.equal(spawned.mock.callCount(), 2);
});

test("jobs stop POST stops one running job and routes missing jobs", async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const stops = t.mock.method(sessions, "stopJob", async (id: string, jobId: string) => {
		if (id === "missing") throw new NotFound("Unknown session");
		if (jobId !== "tests/1") throw new NotFound("This job is no longer running");
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions`;
	const stopped = await fetch(`${base}/working/jobs/tests%2F1/stop`, { method: "POST" });
	assert.equal(stopped.status, 202);
	assert.deepEqual(await stopped.json(), { ok: true });
	assert.deepEqual(stops.mock.calls[0]!.arguments, ["working", "tests/1"]);
	for (const [path, options, status] of [
		[`${base}/working/jobs/ended/stop`, { method: "POST" }, 404],
		[`${base}/missing/jobs/tests%2F1/stop`, { method: "POST" }, 404],
		[`${base}/working/jobs/%E0%A4%A/stop`, { method: "POST" }, 400],
		[`${base}/working/jobs/tests/stop`, {}, 404],
		[`${base}/working/jobs/tests/stop`, { method: "POST", headers: { origin: "https://example.com" } }, 403],
	] as const) {
		const response = await fetch(path, options);
		assert.equal(response.status, status, path);
		await response.arrayBuffer();
	}
	assert.equal(stops.mock.callCount(), 3);
});

test("retry-startup POST returns the recovered session and preserves route guards", async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const summary: SessionSummary = {
		id: "failed",
		title: "Recovered",
		cwd: "/work",
		state: "working",
		createdAt: 1,
		updatedAt: 2,
	};
	const retries = t.mock.method(sessions, "retryStartup", async (id: string) => {
		if (id === "missing") throw new NotFound("Unknown session");
		if (id === "idle") throw new Conflict("Session has no retryable worker startup failure");
		return summary;
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions`;
	const response = await fetch(`${base}/failed/retry-startup`, { method: "POST" });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), summary);
	for (const [path, options, status] of [
		[`${base}/missing/retry-startup`, { method: "POST" }, 404],
		[`${base}/idle/retry-startup`, { method: "POST" }, 409],
		[`${base}/failed/retry-startup`, {}, 404],
		[`${base}/failed/retry-startup/extra`, { method: "POST" }, 404],
		[`${base}/failed/retry-startup`, { method: "POST", headers: { origin: "https://example.com" } }, 403],
	] as const) {
		const denied = await fetch(path, options);
		assert.equal(denied.status, status);
		await denied.arrayBuffer();
	}
	assert.equal(retries.mock.callCount(), 3);
});

test("held routes send once or discard all and per row, and reject invalid IDs", async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const calls: unknown[] = [];
	t.mock.method(sessions, "heldMessages", async (...args: unknown[]) => {
		if (args[0] === "missing") throw new NotFound("Unknown session");
		calls.push(args);
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions`;
	for (const [path, method] of [
		["chat/held/send", "POST"],
		["chat/held", "DELETE"],
		["chat/held/42", "DELETE"],
	]) {
		const response = await fetch(`${base}/${path}`, { method });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true });
	}
	assert.deepEqual(calls, [
		["chat", "send"],
		["chat", "discard", undefined],
		["chat", "discard", 42],
	]);
	for (const id of ["0", "-1", "no", "1.5", "9007199254740992"]) {
		const response = await fetch(`${base}/chat/held/${id}`, { method: "DELETE" });
		assert.equal(response.status, 400);
		await response.arrayBuffer();
	}
	const missing = await fetch(`${base}/missing/held`, { method: "DELETE" });
	assert.equal(missing.status, 404);
	await missing.arrayBuffer();
});

test("PR binding routes use the user actor, return summaries and validate request shape", async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const summary: SessionSummary = {
		id: "session-1",
		title: "Chat",
		cwd: "/work",
		state: "idle",
		createdAt: 1,
		updatedAt: 2,
	};
	const calls: unknown[] = [];
	const bind = t.mock.method(sessions, "bindPullRequest", async (...args: unknown[]) => {
		calls.push(["bind", ...args]);
		if (args[0] === "missing") throw new NotFound("Unknown session");
		if (args[1] === "conflict") throw new Conflict("PR belongs to another chat");
		return summary;
	});
	const unbind = t.mock.method(sessions, "unbindPullRequest", async (...args: unknown[]) => {
		calls.push(["unbind", ...args]);
		if (args[0] === "missing") throw new NotFound("Unknown session");
		return summary;
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions`;
	const route = `${base}/session-1/pull-requests`;
	const url = "https://github.com/example/repo/pull/7";
	const request = (method: string, body: unknown) => ({
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	for (const [method, body] of [
		["POST", { url }],
		["POST", { url, taskId: "#3" }],
		["DELETE", { url }],
	] as const) {
		const response = await fetch(route, request(method, body));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), summary);
	}
	assert.deepEqual(calls, [
		["bind", "session-1", url, {}, undefined],
		["bind", "session-1", url, {}, "#3"],
		["unbind", "session-1", url, {}],
	]);
	for (const method of ["POST", "DELETE"]) {
		for (const body of [null, [], {}, { url: 7 }, { url: " " }, { url: "x".repeat(2049) }]) {
			const rejected = await fetch(route, request(method, body));
			assert.equal(rejected.status, 400);
			await rejected.arrayBuffer();
		}
	}
	for (const taskId of [null, 1, "", " ", "x".repeat(129)]) {
		const rejected = await fetch(route, request("POST", { url, taskId }));
		assert.equal(rejected.status, 400);
		await rejected.arrayBuffer();
	}
	for (const [path, options, status] of [
		[route, { method: "POST", body: "{}" }, 415],
		[route, { ...request("POST", {}), body: "{" }, 400],
		[route, { method: "GET" }, 404],
		[route, request("PUT", { url }), 404],
		[`${route}/extra`, request("POST", { url }), 404],
		[
			route,
			{
				...request("POST", { url }),
				headers: { origin: "https://example.com", "content-type": "application/json" },
			},
			403,
		],
	] as const) {
		const rejected = await fetch(path, options);
		assert.equal(rejected.status, status);
		await rejected.arrayBuffer();
	}
	assert.equal(bind.mock.callCount(), 2);
	assert.equal(unbind.mock.callCount(), 1);
	for (const method of ["POST", "DELETE"]) {
		const response = await fetch(`${base}/missing/pull-requests`, request(method, { url }));
		assert.equal(response.status, 404);
		await response.arrayBuffer();
	}
	const conflict = await fetch(route, request("POST", { url: "conflict" }));
	assert.equal(conflict.status, 409);
	assert.deepEqual(await conflict.json(), { error: "PR belongs to another chat" });
});

test("repository invalidation ignores title and quota updates, but preserves work and workspace refreshes", (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const initial: SessionSummary = {
		id: "one",
		cwd: "/work",
		title: "old",
		state: "working",
		createdAt: 1,
		updatedAt: 2,
	};
	t.mock.method(sessions, "list", () => [initial]);
	let updated!: Parameters<SessionManager["onChange"]>[0];
	t.mock.method(sessions, "onChange", (listener: typeof updated) => {
		updated = listener;
		return () => {};
	});
	const invalidated: string[] = [];
	t.mock.method(RepositoryChanges.prototype, "invalidate", (cwd: string) => invalidated.push(cwd));
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		new TerminalManager(),
	);
	t.after(() => server.close());
	updated({ ...initial, title: "generated" });
	updated({ ...initial, usage: { subscription: { fetchedAt: 3, windows: [] } } });
	updated({ ...initial, model: "other/model", thinking: "high" });
	assert.deepEqual(invalidated, [], "metadata-only updates keep repository cache hits, even during work");
	const working = { ...initial, updatedAt: 4 };
	updated(working);
	updated({ ...working, title: "new title" });
	assert.deepEqual(invalidated, ["/work"], "new work invalidates once");
	const completed = { ...working, state: "idle" as const, outcome: "done" as const, outcomeAt: 5 };
	updated(completed);
	updated({ ...completed, usage: { subscription: { fetchedAt: 6, windows: [] } } });
	assert.deepEqual(invalidated, ["/work", "/work"], "completion refreshes repository changes");
	updated({ ...completed, cwd: "/new-work" });
	assert.deepEqual(invalidated, ["/work", "/work", "/work", "/new-work"]);
});

test("project GitHub GET returns a browser URL and preserves route guards", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-server-github-"));
	const projects = new ProjectStore(root, async () => "https://github.com/octo/repo");
	await projects.load();
	const project = await projects.create({ path: root });
	const sessions = new SessionManager(root, projects);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: root, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(root),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
	const url = `${base}/${project.id}/github`;
	const response = await fetch(url);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { url: "https://github.com/octo/repo" });
	for (const [path, options, status] of [
		[`${base}/missing/github`, {}, 404],
		[url, { method: "POST" }, 404],
		[`${url}/extra`, {}, 404],
		[url, { headers: { origin: "https://example.com" } }, 403],
	] as const) {
		const rejected = await fetch(path, options);
		assert.equal(rejected.status, status);
		await rejected.arrayBuffer();
	}
	t.mock.method(projects, "github", async () => {
		throw new ServiceUnavailable("Check remotes");
	});
	const unavailable = await fetch(url);
	assert.equal(unavailable.status, 503);
	assert.deepEqual(await unavailable.json(), { error: "Check remotes" });
});

test("project branches GET returns live origin heads/default, sensible empty lists and clear remote errors", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-server-branches-"));
	const remote = join(root, "remote.git");
	const source = join(root, "source");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	git(root, "init", "--quiet", "--bare", "-b", "main", remote);
	git(root, "clone", "--quiet", remote, source);
	writeFileSync(join(source, "a.txt"), "base\n");
	git(source, "add", ".");
	git(source, "commit", "--quiet", "-m", "base");
	git(source, "push", "--quiet", "origin", "HEAD:main", "HEAD:topic");
	const projects = new ProjectStore(join(root, "home"));
	await projects.load();
	const project = await projects.create({ path: source });
	const noOrigin = await projects.create({ path: root });
	const sessions = new SessionManager(root, projects);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: root, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(root),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
	const url = `${base}/${project.id}/branches`;
	const response = await fetch(url);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { branches: ["main", "topic"], defaultBranch: "main" });
	assert.deepEqual(await (await fetch(`${base}/${noOrigin.id}/branches`)).json(), { branches: [] });
	for (const [path, options, status] of [
		[`${base}/missing/branches`, {}, 404],
		[url, { method: "POST" }, 404],
		[`${url}/extra`, {}, 404],
		[url, { headers: { origin: "https://example.com" } }, 403],
	] as const) {
		const rejected = await fetch(path, options);
		assert.equal(rejected.status, status);
		await rejected.arrayBuffer();
	}
	await projects.update(project.id, { workspace: "direct" });
	rmSync(remote, { recursive: true, force: true });
	assert.deepEqual(await (await fetch(url)).json(), { branches: [] });
	await projects.update(project.id, { workspace: "clone" });
	const unavailable = await fetch(url);
	assert.equal(unavailable.status, 503);
	assert.match(((await unavailable.json()) as { error: string }).error, /Unable to list origin branches/);
});

test("changes summary GET returns only metadata and counts and preserves route guards", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-server-summary-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	git("init", "--quiet", "-b", "main");
	writeFileSync(join(root, "a.txt"), "base\n");
	git("add", ".");
	git("commit", "--quiet", "-m", "base");
	const base = git("rev-parse", "HEAD").trim();
	writeFileSync(join(root, "a.txt"), "changed\n");
	writeFileSync(join(root, "untracked.txt"), "new\n");
	const projects = new ProjectStore(root);
	const sessions = new SessionManager(root, projects);
	let updated!: Parameters<SessionManager["onChange"]>[0];
	t.mock.method(sessions, "onChange", (listener: typeof updated) => {
		updated = listener;
		return () => {};
	});
	const originalChangeBase = sessions.changeBase.bind(sessions);
	let preparing = false;
	const changeBase = t.mock.method(sessions, "changeBase", (id: string) => {
		if (id !== "session-1") return originalChangeBase(id);
		if (preparing) throw new Error("Session workspace is still preparing");
		return { cwd: root, base };
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: root, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(root),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/session-1/changes`;
	const branch = await fetch(`${url}/branch`);
	assert.equal(branch.status, 200);
	assert.deepEqual(await branch.json(), { branch: "main" });
	const response = await fetch(`${url}/summary`);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /application\/json/);
	assert.deepEqual(await response.json(), { base, branch: "main", fileCount: 2, additions: 2, deletions: 1 });
	assert.deepEqual(changeBase.mock.calls[0]?.arguments, ["session-1"]);
	const full = await fetch(url);
	assert.equal(full.status, 200);
	const changes = (await full.json()) as { base: string; files: unknown[]; diff: string };
	assert.equal(changes.base, base);
	assert.equal(changes.files.length, 2);
	assert.match(changes.diff, /\+changed/);
	for (const [path, options, status] of [
		[`${url}/summary`, { method: "POST" }, 404],
		[`${url}/summary/extra`, {}, 404],
		[`${url}/summary`, { headers: { origin: "https://example.com" } }, 403],
		[`${url}/branch`, { method: "POST" }, 404],
		[`${url}/branch/extra`, {}, 404],
		[`${url}/branch`, { headers: { origin: "https://example.com" } }, 403],
	] as const) {
		const rejected = await fetch(path, options);
		assert.equal(rejected.status, status);
		await rejected.arrayBuffer();
	}
	assert.equal(changeBase.mock.callCount(), 3, "method, path and origin guards run before resolving the session");
	writeFileSync(join(root, "untracked.txt"), "new\nexternal edit\n");
	updated({ id: "session-1", title: "test", cwd: root, createdAt: 0, updatedAt: 1, state: "idle" });
	const invalidated = await fetch(`${url}/summary`);
	assert.equal(invalidated.status, 200);
	assert.deepEqual(await invalidated.json(), { base, branch: "main", fileCount: 2, additions: 3, deletions: 1 });
	const invalidatedFull = await fetch(url);
	assert.match(((await invalidatedFull.json()) as { diff: string }).diff, /\+external edit/);
	const missing = await fetch(`${url.replace("session-1", "missing")}/summary`);
	assert.equal(missing.status, 404);
	assert.match(((await missing.json()) as { error: string }).error, /Unknown session/);
	preparing = true;
	const pending = await fetch(`${url}/summary`);
	assert.equal(pending.status, 400);
	assert.deepEqual(await pending.json(), { error: "Session workspace is still preparing" });
	const pendingBranch = await fetch(`${url}/branch`);
	assert.equal(pendingBranch.status, 400);
	const missingBranch = await fetch(`${url.replace("session-1", "missing")}/branch`);
	assert.equal(missingBranch.status, 404);
});

test("chat sockets stream one session each, isolate overload and resume only the missed batches", {
	timeout: 30_000,
}, async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const snapshot: AgentEvent = {
		type: "snapshot",
		entries: [],
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
	};
	const deliver = new Map<string, Parameters<SessionManager["subscribe"]>[1]>();
	const unsubscribed: string[] = [];
	t.mock.method(sessions, "subscribe", (id: string, listener: Parameters<SessionManager["subscribe"]>[1]) => {
		if (id === "missing") throw new NotFound(`Unknown session: ${id}`);
		deliver.set(id, listener);
		listener([snapshot]);
		return () => {
			unsubscribed.push(id);
		};
	});
	t.mock.method(sessions, "artifacts", async () => []);
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		new TerminalManager(),
	);
	const sockets: WebSocket[] = [];
	t.after(async () => {
		for (const socket of sockets) socket.terminate();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const open = (path: string) => {
		const socket = new WebSocket(`${base}${path}`);
		sockets.push(socket);
		const messages: ServerMessage[] = [];
		socket.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
		const until = async (predicate: (message: ServerMessage) => boolean) => {
			while (!messages.some(predicate)) await new Promise((resolve) => setTimeout(resolve, 5));
			return messages.find(predicate)!;
		};
		return { socket, messages, until };
	};

	const a = open("/api/sessions/session-a/ws");
	const b = open(`/api/sessions/${encodeURIComponent("session b")}/ws`);
	const hello = (await a.until((m) => m.type === "chat.stream")) as Extract<ServerMessage, { type: "chat.stream" }>;
	assert.equal(hello.resumed, false);
	assert.deepEqual(await a.until((m) => m.type === "events"), {
		type: "events",
		sessionId: "session-a",
		events: [{ ...snapshot, historyCount: 0 }],
		seq: 1,
	});
	assert.deepEqual(await b.until((m) => m.type === "events"), {
		type: "events",
		sessionId: "session b",
		events: [{ ...snapshot, historyCount: 0 }],
		seq: 1,
	});
	assert.deepEqual(await a.until((m) => m.type === "artifacts"), {
		type: "artifacts",
		sessionId: "session-a",
		artifacts: [],
	});

	// Overload on one chat socket closes only that chat. Its stream stays subscribed for a resume.
	const closed = once(a.socket, "close");
	const buffered = t.mock.getter(WebSocket.prototype, "bufferedAmount", () => 128 * 1024 * 1024);
	deliver.get("session-a")!([{ type: "queue_update", items: [] }]);
	buffered.mock.restore();
	const [code, reason] = await closed;
	assert.equal(code, 1013);
	assert.match(String(reason), /Reconnect.*snapshot/);
	deliver.get("session b")!([{ type: "queue_update", items: [] }]);
	assert.deepEqual(await b.until((m) => m.type === "events" && m.events[0]?.type === "queue_update"), {
		type: "events",
		sessionId: "session b",
		events: [{ type: "queue_update", items: [] }],
		seq: 2,
	});
	// The reconnect replays the batch the overloaded socket missed, without a new snapshot or subscription.
	const resumed = open(`/api/sessions/session-a/ws?stream=${hello.streamId}&after=1`);
	assert.deepEqual(await resumed.until((m) => m.type === "events"), {
		type: "events",
		sessionId: "session-a",
		events: [{ type: "queue_update", items: [] }],
		seq: 2,
	});
	assert.deepEqual(resumed.messages[0], { ...hello, resumed: true });
	assert.deepEqual(unsubscribed, []);

	// An unknown session is final, and a malformed path never upgrades.
	const missing = open("/api/sessions/missing/ws");
	const [missingCode] = await once(missing.socket, "close");
	assert.equal(missingCode, 4404);
	assert.deepEqual(missing.messages, [{ type: "error", sessionId: "missing", message: "Unknown session: missing" }]);
	const invalid = open("/api/sessions/a/b/ws");
	await once(invalid.socket, "error");

	// The control socket no longer streams transcripts.
	const control = open("/api/ws");
	await once(control.socket, "open");
	control.socket.send(JSON.stringify({ type: "subscribe", sessionId: "session-a" }));
	assert.deepEqual(await control.until((m) => m.type === "error"), {
		type: "error",
		message: "Invalid client message",
	});
	assert.equal(
		control.messages.some((m) => m.type === "events"),
		false,
	);
});

test("terminal and subagent sockets stream one target each and accept only their own messages", {
	timeout: 30_000,
}, async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const terminals = new TerminalManager();
	const writable = t.mock.method(sessions, "assertWritable", (id: string) => {
		if (id === "ask") throw new Conflict("Ask sessions are read-only");
		if (id === "missing") throw new NotFound(`Unknown session: ${id}`);
	});
	t.mock.method(sessions, "changeBase", () => ({ cwd: "/tmp" }));
	let output!: { data(data: string): void; exit(code: number): void };
	const terminalId = randomUUID();
	let detached = 0;
	const attach = t.mock.method(
		terminals,
		"attach",
		(_id: string, _cwd: string, _cols: number, _rows: number, listener: typeof output) => {
			output = listener;
			(listener as typeof listener & { ready(id: string): void }).ready(terminalId);
			listener.data("scrollback");
			return () => {
				detached++;
			};
		},
	);
	const write = t.mock.method(terminals, "write", () => {});
	const resize = t.mock.method(terminals, "resize", () => {});
	const closeTerminal = t.mock.method(terminals, "close", () => {});
	let watcher!: { events(events: AgentEvent[]): void; error(message: string): void };
	let unwatched = 0;
	t.mock.method(sessions, "watchSubagent", (_id: string, name: string, listener: typeof watcher) => {
		if (name === "missing") throw new NotFound("No subagent named missing");
		watcher = listener;
		listener.events([]);
		return () => {
			unwatched++;
		};
	});
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	const sockets: WebSocket[] = [];
	t.after(async () => {
		for (const socket of sockets) socket.terminate();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const open = (path: string) => {
		const socket = new WebSocket(`${base}${path}`);
		sockets.push(socket);
		const messages: ServerMessage[] = [];
		socket.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
		const until = async (predicate: (message: ServerMessage) => boolean) => {
			while (!messages.some(predicate)) await new Promise((resolve) => setTimeout(resolve, 5));
			return messages.find(predicate)!;
		};
		return { socket, messages, until };
	};

	const terminal = open("/api/sessions/session-1/terminal/ws?protocol=2&cols=100&rows=30");
	await terminal.until((m) => m.type === "terminal.hello");
	terminal.socket.send(
		JSON.stringify({ type: "terminal.open", bootId: terminals.bootId, requestId: randomUUID(), restart: true }),
	);
	assert.deepEqual(await terminal.until((m) => m.type === "terminal.data"), {
		type: "terminal.data",
		sessionId: "session-1",
		data: "scrollback",
	});
	assert.deepEqual(attach.mock.calls[0]?.arguments.slice(0, 4), ["session-1", "/tmp", 100, 30]);
	assert.equal(attach.mock.calls[0]?.arguments[5], true);
	terminal.socket.send(JSON.stringify({ type: "terminal.input", terminalId, data: "ls\r" }));
	terminal.socket.send(JSON.stringify({ type: "terminal.resize", terminalId, cols: 120, rows: 40 }));
	terminal.socket.send(JSON.stringify({ type: "terminal.close" }));
	assert.deepEqual(await terminal.until((m) => m.type === "error"), {
		type: "error",
		sessionId: "session-1",
		message: "Invalid terminal message",
	});
	assert.deepEqual(write.mock.calls[0]?.arguments, ["session-1", "ls\r", terminalId]);
	assert.deepEqual(resize.mock.calls[0]?.arguments, ["session-1", 120, 40, terminalId]);
	terminal.socket.send(JSON.stringify({ type: "terminal.close", terminalId }));
	const terminalPong = once(terminal.socket, "pong");
	terminal.socket.ping();
	await terminalPong;
	output.exit(0);
	await terminal.until((m) => m.type === "terminal.exit");
	assert.deepEqual(closeTerminal.mock.calls[0]?.arguments, ["session-1", terminalId]);
	terminal.socket.close();
	await once(terminal.socket, "close");
	while (!detached) await new Promise((resolve) => setTimeout(resolve, 5));

	for (const [path, expected] of [
		["/api/sessions/ask/terminal/ws?cols=80&rows=24", 4409],
		["/api/sessions/missing/terminal/ws?cols=80&rows=24", 4404],
		["/api/sessions/session-1/terminal/ws?cols=0&rows=24", 4409],
		["/api/sessions/session-1/terminal/ws?cols=80&rows=24", 4409],
	] as const) {
		const refused = open(path);
		const [code] = await once(refused.socket, "close");
		assert.equal(code, expected, path);
		assert.equal(refused.messages[0]?.type, "error");
	}
	assert.ok(writable.mock.callCount() >= 3);

	const subagent = open(`/api/sessions/session-1/subagents/${encodeURIComponent("code review/1")}/ws`);
	assert.deepEqual(await subagent.until((m) => m.type === "subagent.events"), {
		type: "subagent.events",
		sessionId: "session-1",
		name: "code review/1",
		events: [],
	});
	watcher.error("reader failed");
	assert.deepEqual(await subagent.until((m) => m.type === "error"), {
		type: "error",
		sessionId: "session-1",
		name: "code review/1",
		message: "reader failed",
	});
	subagent.socket.close();
	await once(subagent.socket, "close");
	while (!unwatched) await new Promise((resolve) => setTimeout(resolve, 5));
	const missing = open("/api/sessions/session-1/subagents/missing/ws");
	const [missingCode] = await once(missing.socket, "close");
	assert.equal(missingCode, 4404);
});

test("queued message PATCH forwards the message ID and content and reports stale edits", async (t) => {
	const projects = new ProjectStore("/tmp/pilot-server-test-unused");
	const sessions = new SessionManager("/tmp/pilot-server-test-unused", projects);
	const terminals = new TerminalManager();
	let stale = false;
	const edit = t.mock.method(sessions, "editQueuedMessage", async () => {
		if (stale) throw new Error("Message is no longer queued. Your edit has not been sent.");
	});
	const server = createDaemonServer(
		{ home: "/tmp/pilot-server-test-unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/tmp/pilot-server-test-unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/session-1/queue/42`;
	const request = {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "Edited\nDetails" }),
	};
	const response = await fetch(url, request);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	assert.deepEqual(edit.mock.calls[0]?.arguments, ["session-1", 42, "Edited\nDetails", undefined]);
	const withMode = await fetch(url, { ...request, body: JSON.stringify({ message: "Now steer", mode: "steer" }) });
	assert.equal(withMode.status, 200);
	await withMode.arrayBuffer();
	assert.deepEqual(edit.mock.calls[1]?.arguments, ["session-1", 42, "Now steer", "steer"]);
	const badMode = await fetch(url, { ...request, body: JSON.stringify({ message: "x", mode: "write" }) });
	assert.equal(badMode.status, 400);
	await badMode.arrayBuffer();
	stale = true;
	const rejected = await fetch(url, request);
	assert.equal(rejected.status, 400);
	assert.deepEqual(await rejected.json(), { error: "Message is no longer queued. Your edit has not been sent." });
	assert.equal(edit.mock.callCount(), 3, "a stale edit must not fall back to sending a new message");
	const wrongMethod = await fetch(url, { ...request, method: "POST" });
	assert.equal(wrongMethod.status, 404);
	await wrongMethod.arrayBuffer();
	const malformed = await fetch(url, { ...request, body: "{" });
	assert.equal(malformed.status, 400);
	await malformed.arrayBuffer();
	const wrongContentType = await fetch(url, { ...request, headers: { "content-type": "text/plain" } });
	assert.equal(wrongContentType.status, 415);
	await wrongContentType.arrayBuffer();
	const browser = await fetch(url, { ...request, headers: { ...request.headers, origin: "https://example.com" } });
	assert.equal(browser.status, 403);
	await browser.arrayBuffer();
	assert.equal(edit.mock.callCount(), 3);
});

test("prepare uses the origin-protected route and paused admissions return HTTP 503", async () => {
	// Isolated ephemeral HTTP server. No stores are loaded, workers forked, or terminals started.
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		new TerminalManager(),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	try {
		const browser = await fetch(`${base}/update/prepare`, {
			method: "POST",
			headers: { origin: "http://localhost" },
		});
		assert.equal(browser.status, 403);
		// Rejected browser preparation did not freeze admission.
		await assert.rejects(sessions.send("missing", "hello"), /Unknown session/);
		assert.equal((await fetch(`${base}/update/prepare`)).status, 404);
		const ready = await fetch(`${base}/update/prepare`, { method: "POST" });
		assert.equal(ready.status, 200);
		assert.deepEqual(await ready.json(), { ready: true });
		for (const [path, method] of [
			["sessions", "POST"],
			["sessions/missing/messages", "POST"],
			["sessions/missing/queue/42", "PATCH"],
			["sessions/missing/queue/42", "DELETE"],
		]) {
			const response = await fetch(`${base}/${path}`, {
				method,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd: "/unused", message: "hello" }),
			});
			assert.equal(response.status, 503);
			assert.match(((await response.json()) as { error: string }).error, /temporarily paused/);
		}
		// Preparation never stops the server; existing read endpoints still work.
		assert.equal((await fetch(`${base}/sessions`)).status, 200);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});

test("queued message DELETE forwards only the ID, reports stale removal, and rejects invalid IDs and origins", async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const terminals = new TerminalManager();
	let stale = false;
	const remove = t.mock.method(sessions, "removeQueuedMessage", async () => {
		if (stale) throw new Error("Message is no longer queued. It has not been removed.");
	});
	const send = t.mock.method(sessions, "send", async () => assert.fail("removal must never submit input"));
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/session-1/queue`;
	const response = await fetch(`${base}/42`, { method: "DELETE" });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	assert.deepEqual(remove.mock.calls[0]?.arguments, ["session-1", 42]);
	stale = true;
	const rejected = await fetch(`${base}/42`, { method: "DELETE" });
	assert.equal(rejected.status, 400);
	assert.deepEqual(await rejected.json(), { error: "Message is no longer queued. It has not been removed." });
	for (const id of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1e2", "0x2a", "42oops"]) {
		const invalid = await fetch(`${base}/${id}`, { method: "DELETE" });
		assert.equal(invalid.status, 400);
		assert.deepEqual(await invalid.json(), { error: "Invalid queued message ID" });
	}
	const browser = await fetch(`${base}/42`, { method: "DELETE", headers: { origin: "https://example.com" } });
	assert.equal(browser.status, 403);
	await browser.arrayBuffer();
	assert.equal(remove.mock.callCount(), 2);
	assert.equal(send.mock.callCount(), 0);
});

test("history route validates its cursor and limit and forwards the page request", async (t) => {
	const projects = new ProjectStore("/tmp/pilot-server-test-unused");
	const sessions = new SessionManager("/tmp/pilot-server-test-unused", projects);
	const terminals = new TerminalManager();
	const history = t.mock.method(sessions, "history", async () => ({ entries: [], more: false }));
	const server = createDaemonServer(
		{ home: "/tmp/pilot-server-test-unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/tmp/pilot-server-test-unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/session-1/history`;
	const read = await fetch(`${base}?before=42`);
	assert.equal(read.status, 200);
	assert.deepEqual(await read.json(), { entries: [], more: false });
	assert.deepEqual(history.mock.calls[0]?.arguments, ["session-1", 42, 100]);
	const limited = await fetch(`${base}?before=42&limit=500`);
	assert.equal(limited.status, 200);
	await limited.arrayBuffer();
	assert.deepEqual(history.mock.calls[1]?.arguments, ["session-1", 42, 500]);
	for (const query of ["", "?before=-1", "?before=x", "?before=4&limit=0", "?before=4&limit=501"]) {
		const bad = await fetch(base + query);
		assert.equal(bad.status, 400, query);
		await bad.arrayBuffer();
	}
	assert.equal(history.mock.callCount(), 2);
});

test("subagent routes decode names, validate bodies and forward transcript, message and stop requests", async (t) => {
	const projects = new ProjectStore("/tmp/pilot-server-test-unused");
	const sessions = new SessionManager("/tmp/pilot-server-test-unused", projects);
	const terminals = new TerminalManager();
	const transcript = t.mock.method(
		sessions,
		"subagentTranscript",
		async (_id: string, name: string, options: { after?: number; ifNoneMatch?: string } = {}) =>
			options.ifNoneMatch === "8/full/1:2"
				? { signature: "8/full/1:2", unchanged: true }
				: { signature: "8/full/1:2", transcript: { name, full: true, events: [] } },
	);
	const command = t.mock.method(sessions, "subagentCommand", async () => {});
	const server = createDaemonServer(
		{ home: "/tmp/pilot-server-test-unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/tmp/pilot-server-test-unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/session-1/subagents`;
	const name = encodeURIComponent("code review/1");
	const read = await fetch(`${base}/${name}/transcript`);
	assert.equal(read.status, 200);
	assert.equal(read.headers.get("etag"), '"8/full/1:2"');
	assert.deepEqual(await read.json(), { name: "code review/1", full: true, events: [] });
	assert.deepEqual(transcript.mock.calls[0]?.arguments, ["session-1", "code review/1", {}]);
	const cached = await fetch(`${base}/${name}/transcript?after=12`, { headers: { "if-none-match": '"8/full/1:2"' } });
	assert.equal(cached.status, 304);
	await cached.arrayBuffer();
	assert.deepEqual(transcript.mock.calls[1]?.arguments, [
		"session-1",
		"code review/1",
		{ after: 12, ifNoneMatch: "8/full/1:2" },
	]);
	const badCursor = await fetch(`${base}/${name}/transcript?after=-1`);
	assert.equal(badCursor.status, 400);
	await badCursor.arrayBuffer();

	const post = (path: string, body: unknown) =>
		fetch(`${base}/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const sent = await post(`${name}/messages`, { message: "focus", mode: "followUp", requestId: "r-1" });
	assert.equal(sent.status, 202);
	await sent.arrayBuffer();
	assert.deepEqual(command.mock.calls[0]?.arguments, [
		"session-1",
		"code review/1",
		{ action: "send", message: "focus", mode: "followUp", requestId: "r-1" },
	]);
	const stopped = await post(`${name}/stop`, {});
	assert.equal(stopped.status, 202);
	await stopped.arrayBuffer();
	assert.deepEqual(command.mock.calls[1]?.arguments, ["session-1", "code review/1", { action: "stop" }]);
	for (const [path, body] of [
		[`${name}/messages`, { message: " " }],
		[`${name}/messages`, { message: "x", mode: "later" }],
		[`${name}/messages`, { message: "x", requestId: "../bad" }],
		["%E0%A4%A/messages", { message: "x" }],
	] as const) {
		const rejected = await post(path, body);
		assert.equal(rejected.status, 400);
		await rejected.arrayBuffer();
	}
	assert.equal(command.mock.callCount(), 2);
});
