// biome-ignore-all lint/complexity/useLiteralKeys: Verify private replica rows and immutable retained envelopes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { InsightsLegacy, type InsightsLegacySelector } from "./insights-legacy.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import type { ModelCatalog } from "./models.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { createDaemonServer } from "./server.ts";
import { TerminalManager } from "./terminals.ts";
import { fixture as sessionFixture } from "./testing/session-workspace.ts";

const host = { hostId: "daemon", daemonId: "synthetic", lineageId: "synthetic" };
async function fixture(t: TestContext) {
	const f = await sessionFixture(t, { diagnosticHost: host });
	const store = new MissionStore(join(f.home, "missions.sqlite"));
	const missionService = new MissionService(store, f.sessions, f.projects);
	const mission = store.create({ projectId: f.project.id, title: "User-owned legacy backlog" });
	const report = randomUUID(),
		journal = new OperationJournal(join(f.home, "operations"), host);
	await f.sessions.spawnInsightsDurable(
		{ projectId: f.project.id, missionId: mission.id, model: "synthetic/terra", message: "Synthetic legacy setup" },
		report,
		randomUUID(),
		true,
	);
	const context = payloadHash(canonicalJSON([f.home, host, f.project.id, f.project.path, mission.id]));
	const selector: InsightsLegacySelector = {
		schemaVersion: 2,
		reportSessionId: report,
		projectId: f.project.id,
		missionId: mission.id,
		expectedHome: host,
		context,
	};
	const service = new InsightsLegacy({
		home: f.home,
		host,
		projects: f.projects,
		sessions: f.sessions,
		journal,
		records: store.insightsLegacy,
		mission: (id) => {
			const m = store.require(id);
			return { projectId: m.projectId, status: m.status };
		},
	});
	let sequence = 0;
	const operation = (kind: string, payload: unknown): DurableOperation => {
		const raw = JSON.stringify(payload, null, 2);
		return {
			schemaVersion: 1,
			kind,
			targetId: report,
			operationId: randomUUID(),
			producerId: "native-legacy-fixture",
			sequence: ++sequence,
			origin: { ...host, hostId: "local" },
			destination: { ...host, hostId: "local" },
			payload: raw,
			payloadHash: payloadHash(raw),
		};
	};
	const enable = operation("insights-enable", {
		projectId: f.project.id,
		missionId: mission.id,
		expectedHome: host,
		context,
		model: "synthetic/terra",
		originalText: "kept é",
	});
	// A retained synthetic v1 ACK is evidence only, never executed as activation by this fixture.
	await journal.execute(enable, async () => ({ syntheticLegacyReceipt: "kept" }));
	const pending = operation("insights-apply", {
		projectId: f.project.id,
		missionId: mission.id,
		expectedHome: host,
		context,
	});
	await journal.reserve(pending);
	const draft = {
		title: "Kept legacy finding",
		priority: "medium" as const,
		observation: "Synthetic observation",
		uncertainty: "No live evidence",
		proposedChange: "Investigate separately",
		expectedBenefit: "Unknown",
		targets: [],
		implementationLinks: [],
	};
	const finding = {
		action: "propose",
		key: randomUUID(),
		operationId: randomUUID(),
		expectedRevision: 0,
		patternKey: "legacy workflow correction",
		draft,
		evidence: [],
	};
	await store.insights.call(f.sessions.insightsHostAdmission(report), finding);
	t.after(async () => {
		await f.sessions.shutdown();
		await store.close();
	});
	return { ...f, store, missionService, journal, report, selector, service, enable, pending, finding };
}

test("exact legacy projection preserves mission ownership, original payload strings and unconfirmed operations", async (t) => {
	const f = await fixture(t);
	const journalPath = join(f.home, "operations", `${payloadHash(f.enable.operationId)}.json`);
	const bytes = await readFile(journalPath),
		metadata = await f.stored(f.report),
		rows = f.store["all"]("SELECT * FROM insights_items");
	const page = await f.service.page(f.selector, "finding");
	assert.equal(page.state, "available");
	assert.equal(page.ownership, "legacy_mission");
	assert.equal(page.lifecycleDependency, "mission");
	assert.equal(page.items.length, 1);
	assert.equal(page.items[0]!.payload, rows[0]!.payload);
	assert.ok(page.operations.some((op) => op.operationId === f.pending.operationId && op.state === "pending"));
	assert.equal(page.transition.state, "blocked");
	assert.equal(page.transition.reason, "old_operation_pending_use_receipt");
	assert.equal(page.transition.immutableHomeProven, true);
	assert.deepEqual(await readFile(journalPath), bytes);
	assert.deepEqual(await f.stored(f.report), metadata);
	assert.deepEqual(f.store["all"]("SELECT * FROM insights_items"), rows);
	assert.equal(f.workers.length, 0);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_owners")!.n, 0);
	assert.equal(f.store.require(f.selector.missionId).title, "User-owned legacy backlog");
});

test("foreign lineage/context and unknown mission remain unavailable, never an empty successful setup", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		f.service.page({ ...f.selector, expectedHome: { ...host, lineageId: "foreign" } }, "finding"),
		/home_or_context/,
	);
	await assert.rejects(f.service.page({ ...f.selector, context: "0".repeat(64) }, "finding"), /home_or_context/);
	await assert.rejects(f.service.page({ ...f.selector, missionId: "unknown" }, "finding"), /Unknown mission/);
	assert.equal(f.workers.length, 0);
});

test("legacy projection pins rows before journal I/O and rejects a newer replacement row", async (t) => {
	const f = await fixture(t),
		original = f.journal.replacementReferences.bind(f.journal);
	let release!: () => void, entered!: () => void;
	const hold = new Promise<void>((r) => {
			release = r;
		}),
		start = new Promise<void>((r) => {
			entered = r;
		});
	t.after(release);
	t.mock.method(f.journal, "replacementReferences", async (...args: Parameters<typeof original>) => {
		const snapshot = await original(...args);
		entered();
		await hold;
		return snapshot;
	});
	const read = f.service.page(f.selector, "finding");
	await start;
	await f.store.insights.call(f.sessions.insightsHostAdmission(f.report), {
		...f.finding,
		action: "amend",
		expectedRevision: 1,
		operationId: randomUUID(),
		draft: { ...f.finding.draft, title: "Newer legacy finding" },
	});
	release();
	await assert.rejects(read, /changed_during_read/);
	assert.equal(f.workers.length, 0);
});

test("archived legacy missions remain readable; deletion still owns their lifecycle", async (t) => {
	const f = await fixture(t);
	f.store.update(f.selector.missionId, { status: "archived" });
	await f.store.durable();
	const page = await f.service.page(f.selector, "finding");
	assert.equal(page.missionStatus, "archived");
	assert.equal(page.items.length, 1);
	assert.equal(page.lifecycleDependency, "mission");
	f.store.remove(f.selector.missionId);
	await f.store.durable();
	await assert.rejects(f.service.page(f.selector, "finding"), /Unknown mission/);
	assert.equal(
		f.store["one"]("SELECT COUNT(*) n FROM insights_items")!.n,
		0,
		"Passive projection does not remove legacy cascade dependency",
	);
	assert.equal(f.workers.length, 0);
});

test("native legacy HTTP is bounded, exact-ID, authenticated and passive", async (t) => {
	const f = await fixture(t);
	const args: Parameters<typeof createDaemonServer> = [
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		{ list: async () => assert.fail("Projection never resolves models") } as unknown as ModelCatalog,
		new TerminalManager(),
		{ store: f.store, service: f.missionService },
	];
	args[12] = {
		...host,
		daemonVersion: "synthetic",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin",
		arch: "arm64",
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: true,
			independentExecution: true,
		},
	};
	args[17] = {
		authenticate: async (token: unknown) => {
			if (token !== "native") throw new Conflict("Native confirmation required");
		},
	} as NonNullable<(typeof args)[17]>;
	const server = createDaemonServer(...args);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const path = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/insights/legacy/findings?selector=${encodeURIComponent(JSON.stringify(f.selector))}`;
	assert.notEqual((await fetch(path)).status, 200);
	const response = await fetch(path, { headers: { "x-pilot-github-capability": "native" } });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const page = await response.json();
	assert.equal(page.items.length, 1);
	assert.equal(page.lifecycleDependency, "mission");
	assert.equal((await fetch(`${path}&cursor=-1`, { headers: { "x-pilot-github-capability": "native" } })).status, 400);
	assert.equal(
		(await fetch(path, { method: "POST", headers: { "x-pilot-github-capability": "native" } })).status,
		405,
	);
	assert.equal(f.workers.length, 0);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_owners")!.n, 0);
});
