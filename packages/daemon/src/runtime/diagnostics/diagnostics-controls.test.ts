import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { DiagnosticsControlsPayload, DurableOperation, SessionSummary } from "@pilot/protocol";
import { DiagnosticsControls, isDiagnosticsRevocation, validateDiagnosticsIntent } from "./diagnostics-controls.ts";
import { GitHubSetupService } from "../../sources/github/github-setup.ts";
import { ModelCatalog } from "../../models/models.ts";
import { nativePlanningFixture } from "../../missions/planning/native-mission-planning.fixture.ts";
import { OperationJournal, payloadHash } from "../../transport/operations/operation-journal.ts";
import { TelemetrySettingsService } from "../telemetry/telemetry-settings.ts";
import { TerminalManager } from "../../sessions/terminals/terminals.ts";
import { createDaemonFixtureServer as createDaemonServer } from "../../testing/daemon-server.ts";

const privacy = {
	localDiagnostics: false,
	localFeatureUsage: false,
	remoteOperational: false,
	productAnalytics: false,
};

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("native privacy saves independently, rejects stale CAS, clears and only looks up lost ACKs", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const telemetry = await TelemetrySettingsService.open(f.home, f.hello);
	let clearCount = 0;
	const controls = new DiagnosticsControls(
		telemetry,
		{ listTaskModels: async () => ({ models: [] }) },
		{
			list: () => [],
			spawnDurable: async () => {
				throw new Error("forbidden");
			},
			sendDurable: async () => {
				throw new Error("forbidden");
			},
			clearDiagnostics: async () => {
				clearCount++;
			},
		},
		f.home,
		f.journal.destination,
		async () => {},
		async () => {},
	);
	const before = await controls.read();
	const op = f.operation(
		"global-diagnostics",
		{
			purpose: "diagnostics-controls",
			binding: before.binding,
			action: "save",
			value: { ...privacy, localFeatureUsage: true },
		},
		before.binding,
	);
	const receipt = await f.journal.execute(op, (op, entry) => controls.admit(op, entry.firstEntry));
	assert.equal(receipt.state, "accepted");
	assert.equal(telemetry.settings().localFeatureUsage, true);
	assert.equal(telemetry.settings().remoteOperational, false);
	assert.equal(telemetry.settings().localDiagnostics, false);
	assert.deepEqual(await new OperationJournal(join(f.home, "operations"), f.journal.destination).lookup(op), receipt);
	const stale = { ...op, operationId: randomUUID(), producerId: randomUUID() };
	assert.equal((await f.journal.execute(stale, (op, e) => controls.admit(op, e.firstEntry))).state, "rejected");
	const now = await controls.read();
	const clear = f.operation(
		"global-diagnostics",
		{ purpose: "diagnostics-controls", binding: now.binding, action: "clear", value: null },
		now.binding,
	);
	const cleared = await f.journal.execute(clear, (op, e) => controls.admit(op, e.firstEntry));
	assert.equal(cleared.state, "accepted");
	assert.equal(clearCount, 1);
	await f.journal.execute(clear, () => {
		throw new Error("must not repeat");
	});
	assert.equal(clearCount, 1);
	assert.match(JSON.stringify(cleared.result), /stdout.*OS logs.*exports.*agent history.*GPUI/);
	assert.equal((await TelemetrySettingsService.open(f.home, f.hello)).settings().localDiagnostics, false);
});

test("diagnostics start pins explicit eligible model and UUID; followups enforce app host scope", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const telemetry = await TelemetrySettingsService.open(f.home, f.hello);
	const host = f.journal.destination;
	const chats: SessionSummary[] = [];
	let sent = 0;
	const controls = new DiagnosticsControls(
		telemetry,
		{
			listTaskModels: async () => ({
				models: [{ id: "faux/exact", provider: "faux", name: "Exact", thinkingLevels: ["off"] }],
			}),
		},
		{
			list: () => chats,
			clearDiagnostics: async () => {},
			spawnDurable: async (request, id) => {
				assert.equal(request.role, "diagnostics");
				assert.equal(request.mode, "ask");
				assert.equal(request.model, "faux/exact");
				assert.equal(request.thinking, "off");
				assert.equal(request.diagnosticScope, "app");
				assert.deepEqual(request.diagnosticHost, host);
				assert.equal(request.diagnosticHistoryAccess, undefined);
				assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
				const session: SessionSummary = {
					id,
					cwd: f.home,
					role: "diagnostics",
					diagnosticScope: "app",
					diagnosticHost: host,
					title: "Diagnosis",
					state: "idle",
					mode: "ask",
					model: request.model,
					thinking: request.thinking,
					createdAt: 1,
					updatedAt: 1,
				};
				chats.push(session);
				return session;
			},
			sendDurable: async () => {
				sent++;
			},
		},
		f.home,
		host,
		async () => {},
		async () => {},
	);
	const run = async (value: Omit<DiagnosticsControlsPayload, "binding">) => {
		const read = await controls.read();
		const op = f.operation("global-diagnostics", { ...value, binding: read.binding }, read.binding);
		return f.journal.execute(op, (op, e) => controls.admit(op, e.firstEntry));
	};
	assert.equal(
		(
			await run({
				purpose: "diagnostics-controls",
				action: "start",
				value: { model: "faux/missing", thinking: "off", question: "Why?" },
			})
		).state,
		"rejected",
	);
	assert.equal(
		(
			await run({
				purpose: "diagnostics-controls",
				action: "start",
				value: { model: "faux/exact", thinking: "off", question: "Why?" },
			})
		).state,
		"accepted",
	);
	assert.equal(chats.length, 1);
	assert.equal(
		(
			await run({
				purpose: "diagnostics-controls",
				action: "send",
				value: { sessionId: chats[0]!.id, message: "More?" },
			})
		).state,
		"accepted",
	);
	assert.equal(sent, 1);
	chats[0]!.diagnosticHost = { ...host, lineageId: "other" };
	assert.equal(
		(
			await run({
				purpose: "diagnostics-controls",
				action: "send",
				value: { sessionId: chats[0]!.id, message: "More?" },
			})
		).state,
		"rejected",
	);
	assert.equal(sent, 1);
	assert.equal((await controls.read()).chats.items.length, 0);
});

test("HTTP native capability and pre-journal endpoint validation keep secrets out of durable records", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const telemetry = await TelemetrySettingsService.open(f.home, f.hello);
	const native = new GitHubSetupService(
		f.home,
		{ ...f.journal.destination, hostId: "local" },
		{ userHome: f.home, env: {} },
	);
	await native.status();
	t.after(() => native.close());
	const capability = JSON.parse(await readFile(join(f.home, "github-app-capability"), "utf8")).token;
	const models = new ModelCatalog(f.home);
	t.mock.method(models, "listTaskModels", async () => ({ models: [] }));
	const server = createDaemonServer({
		config: { home: f.home, host: "127.0.0.1", port: 0 },
		sessions: f.sessions,
		projects: f.projects,
		models,
		terminals: new TerminalManager(),
		hello: f.hello,
		telemetry,
		githubSetup: native,
		nativeAuthority: native.nativeAuthority,
	});
	await server.runtimeReady;
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await server.closeServices();
	});
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	assert.notEqual((await fetch(`${root}/diagnostics-controls`)).status, 200);
	const headers = { "x-pilot-github-capability": capability, "content-type": "application/json" };
	const read = await (await fetch(`${root}/diagnostics-controls`, { headers })).json();
	const before = await readdir(join(f.home, "operations"));
	for (const endpoint of [
		"https://secret@collector.example/",
		"https://collector.example/secret",
		"https://collector.example/v1/traces?token=secret",
		"https://collector.example/a/../v1/traces",
		"https://collector.example/" + "a".repeat(513),
	]) {
		const op = f.operation(
			"global-diagnostics",
			{ purpose: "diagnostics-controls", binding: read.binding, action: "save", value: { ...privacy, endpoint } },
			read.binding,
		);
		assert.throws(() => validateDiagnosticsIntent(op, f.journal.destination));
		assert.equal(
			(await fetch(`${root}/operations`, { method: "POST", headers, body: JSON.stringify(op) })).status,
			400,
		);
	}
	assert.deepEqual(await readdir(join(f.home, "operations")), before);
	const op: DurableOperation = f.operation(
		"global-diagnostics",
		{ purpose: "diagnostics-controls", binding: read.binding, action: "save", value: privacy },
		read.binding,
	);
	for (const hostile of [
		{ ...op, secret: "envelope-secret" },
		{ ...op, origin: { ...op.origin, secret: "origin-secret" } },
		{ ...op, destination: { ...op.destination, secret: "destination-secret" } },
	]) {
		assert.equal(
			(await fetch(`${root}/operations`, { method: "POST", headers, body: JSON.stringify(hostile) })).status,
			400,
		);
		assert.deepEqual(await readdir(join(f.home, "operations")), before);
	}
	assert.notEqual(
		(
			await fetch(`${root}/operations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(op),
			})
		).status,
		200,
	);
	const accepted = await fetch(`${root}/operations`, { method: "POST", headers, body: JSON.stringify(op) });
	assert.equal(accepted.status, 200);
	const receipt = await accepted.json();
	assert.equal(receipt.state, "accepted");
	assert.deepEqual(
		await (await fetch(`${root}/operations/receipt`, { method: "POST", headers, body: JSON.stringify(op) })).json(),
		receipt,
	);
	const crossHost = { ...op, operationId: randomUUID(), origin: { ...op.origin, lineageId: "other" } };
	assert.throws(() => validateDiagnosticsIntent(crossHost, f.journal.destination));
	const oversized = { ...op, payload: " ".repeat(20001) };
	oversized.payloadHash = payloadHash(oversized.payload);
	assert.throws(() => validateDiagnosticsIntent(oversized, f.journal.destination));
});

test("uncertain effects are sanitized and never replayed; chat pages disclose truncation", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const telemetry = await TelemetrySettingsService.open(f.home, f.hello);
	const host = f.journal.destination;
	const chats: SessionSummary[] = Array.from({ length: 101 }, (_, i) => ({
		id: `chat-${i}`,
		title: "Diagnosis",
		cwd: f.home,
		role: "diagnostics",
		mode: "ask",
		diagnosticScope: "app",
		diagnosticHost: host,
		state: "idle",
		createdAt: i,
		updatedAt: i,
	}));
	let calls = 0;
	const controls = new DiagnosticsControls(
		telemetry,
		{ listTaskModels: async () => ({ models: [] }) },
		{
			list: () => chats,
			clearDiagnostics: async () => {
				calls++;
				throw new Error("secret-body");
			},
			spawnDurable: async () => {
				throw new Error("forbidden");
			},
			sendDurable: async () => {
				throw new Error("forbidden");
			},
		},
		f.home,
		host,
		async () => {},
		async () => {},
	);
	const read = await controls.read();
	assert.equal(read.chats.items.length, 100);
	assert.equal(read.chats.hasMore, true);
	const op = f.operation(
		"global-diagnostics",
		{ purpose: "diagnostics-controls", binding: read.binding, action: "clear", value: null },
		read.binding,
	);
	const pending = await f.journal.execute(op, (op, e) => controls.admit(op, e.firstEntry));
	assert.equal(pending.state, "pending");
	assert.doesNotMatch(JSON.stringify(pending), /secret-body/);
	await assert.rejects(controls.admit(op, false), /lookup only/);
	await f.journal.execute(op, (op, e) => controls.admit(op, e.firstEntry));
	assert.equal(calls, 1);
	assert.deepEqual(await f.journal.lookup(op), pending);
});

test("all-false save persists despite an unknown receipt and fences stale queued enable intents", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const telemetry = await TelemetrySettingsService.open(f.home, f.hello);
	await telemetry.update({ ...privacy, localDiagnostics: true, localFeatureUsage: true, productAnalytics: true });
	const controls = new DiagnosticsControls(
		telemetry,
		{ listTaskModels: async () => ({ models: [] }) },
		{
			list: () => [],
			clearDiagnostics: async () => {
				throw new Error("uncertain clear");
			},
			spawnDurable: async () => {
				throw new Error("forbidden");
			},
			sendDurable: async () => {
				throw new Error("forbidden");
			},
		},
		f.home,
		f.journal.destination,
		async () => {},
		async () => {},
	);
	const first = await controls.read();
	const unknown = f.operation(
		"global-diagnostics",
		{ purpose: "diagnostics-controls", binding: first.binding, action: "clear", value: null },
		first.binding,
	);
	assert.equal((await f.journal.execute(unknown, (op, e) => controls.admit(op, e.firstEntry))).state, "pending");
	const current = await controls.read();
	const stop = f.operation(
		"global-diagnostics",
		{ purpose: "diagnostics-controls", binding: current.binding, action: "save", value: privacy },
		current.binding,
	);
	const staleEnable = f.operation(
		"global-diagnostics",
		{
			purpose: "diagnostics-controls",
			binding: current.binding,
			action: "save",
			value: { ...privacy, localDiagnostics: true, productAnalytics: true },
		},
		current.binding,
	);
	const stopped = f.journal.execute(stop, (op, e) => controls.admit(op, e.firstEntry));
	const enabling = f.journal.execute(staleEnable, (op, e) => controls.admit(op, e.firstEntry));
	assert.equal((await stopped).state, "accepted");
	assert.equal((await enabling).state, "rejected");
	const persisted = (await TelemetrySettingsService.open(f.home, f.hello)).settings();
	for (const key of ["localDiagnostics", "localFeatureUsage", "remoteOperational", "productAnalytics"] as const)
		assert.equal(persisted[key], false, key);
	assert.equal(persisted.endpoint, undefined);
	assert.equal((await f.journal.lookup(unknown))?.state, "pending");
	assert.equal((await f.journal.execute(unknown, (op, e) => controls.admit(op, e.firstEntry))).state, "pending");
	assert.equal(telemetry.settings().localDiagnostics, false);
});

test("revocation bypasses a blocked catalogue, diagnostics FIFO and four running operations", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const telemetry = await TelemetrySettingsService.open(f.home, f.hello);
	await telemetry.update({ ...privacy, localDiagnostics: true });
	const entered = deferred();
	const release = deferred();
	let blocked = false;
	const controls = new DiagnosticsControls(
		telemetry,
		{
			listTaskModels: async () => {
				if (blocked) {
					entered.resolve();
					await release.promise;
				}
				return { models: [] };
			},
		},
		{
			list: () => [],
			clearDiagnostics: async () => {},
			spawnDurable: async () => {
				throw new Error("forbidden");
			},
			sendDurable: async () => {
				throw new Error("forbidden");
			},
		},
		f.home,
		f.journal.destination,
		async () => {},
		async () => {},
	);
	const prior = await controls.read();
	blocked = true;
	const enabling = f.operation(
		"global-diagnostics",
		{
			purpose: "diagnostics-controls",
			binding: prior.binding,
			action: "save",
			value: { ...privacy, localDiagnostics: true, productAnalytics: true },
		},
		prior.binding,
	);
	const older = f.journal.execute(enabling, (op, e) => controls.admit(op, e.firstEntry));
	await entered.promise;
	const busy = [0, 1, 2].map(async () => {
		const admitted = deferred();
		const work = f.journal.execute(f.operation("unrelated", { purpose: "fixture" }), async () => {
			admitted.resolve();
			await release.promise;
			return {};
		});
		await admitted.promise;
		return { work };
	});
	const running = await Promise.all(busy);
	const stop = f.operation(
		"global-diagnostics",
		{ purpose: "diagnostics-controls", binding: "0".repeat(64), action: "save", value: privacy },
		"0".repeat(64),
	);
	assert.equal(isDiagnosticsRevocation(stop), true);
	const receipt = await f.journal.execute(stop, (op, e) => controls.admit(op, e.firstEntry), {
		safetyReduction: true,
	});
	assert.equal(receipt.state, "accepted");
	assert.equal((await TelemetrySettingsService.open(f.home, f.hello)).settings().localDiagnostics, false);
	release.resolve();
	assert.equal((await older).state, "rejected");
	await Promise.all(running.map((r) => r.work));
	assert.equal(telemetry.settings().localDiagnostics, false);
	assert.equal(telemetry.settings().productAnalytics, false);
});

test("failed reduction persistence leaves an unknown receipt while runtime collection is off", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const telemetry = await TelemetrySettingsService.open(f.home, f.hello);
	await telemetry.update({
		...privacy,
		localDiagnostics: true,
		remoteOperational: true,
		endpoint: "https://collector.example/v1/traces",
	});
	let runtime = telemetry.settings();
	telemetry.onChange((settings) => {
		runtime = settings;
	});
	const controls = new DiagnosticsControls(
		telemetry,
		{
			listTaskModels: async () => {
				throw new Error("forbidden");
			},
		},
		{
			list: () => [],
			clearDiagnostics: async () => {},
			spawnDurable: async () => {
				throw new Error("forbidden");
			},
			sendDurable: async () => {
				throw new Error("forbidden");
			},
		},
		f.home,
		f.journal.destination,
		async () => {},
		async () => {},
	);
	await rename(join(f.home, "telemetry.json"), join(f.home, "before.json"));
	await mkdir(join(f.home, "telemetry.json"));
	const op = f.operation(
		"global-diagnostics",
		{ purpose: "diagnostics-controls", binding: "0".repeat(64), action: "save", value: privacy },
		"0".repeat(64),
	);
	const receipt = await f.journal.execute(op, (op, e) => controls.admit(op, e.firstEntry), { safetyReduction: true });
	assert.equal(receipt.state, "pending");
	assert.equal(runtime.remoteOperational, false);
	assert.equal(runtime.localDiagnostics, false);
	assert.deepEqual(await f.journal.lookup(op), receipt);
	await assert.rejects(controls.admit(op, false), /lookup only/);
});
