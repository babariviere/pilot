// biome-ignore-all lint/complexity/useLiteralKeys: Storage proof/fault tests inspect exact replica rows.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DurableOperation, InsightsLegacySelector } from "@pilot/protocol";
import { initialInsightsSettings } from "./insights-settings.ts";
import type { InsightsTransferAuthority } from "./insights-transition-store.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import { fixture as sessionFixture } from "./testing/session-workspace.ts";

const host = { hostId: "daemon", daemonId: "synthetic", lineageId: "synthetic" };
async function fixture(t: TestContext, uppercaseReport = false) {
	const f = await sessionFixture(t, { diagnosticHost: host }),
		store = new MissionStore(join(f.home, "missions.sqlite"));
	new MissionService(store, f.sessions, f.projects);
	const mission = store.create({ projectId: f.project.id, title: "Original user mission" }),
		report = uppercaseReport ? randomUUID().toUpperCase() : randomUUID();
	await f.sessions.spawnInsightsDurable(
		{ projectId: f.project.id, missionId: mission.id, model: "synthetic/terra", message: "Synthetic legacy setup" },
		report,
		randomUUID(),
		true,
	);
	const admission = f.sessions.insightsHostAdmission(report);
	await store.insights.settings.save(
		admission,
		randomUUID(),
		{ syntheticNativeSave: true },
		0,
		initialInsightsSettings("synthetic/terra"),
		"synthetic/terra",
	);
	const finding = {
		action: "propose",
		operationId: randomUUID(),
		key: randomUUID(),
		expectedRevision: 0,
		patternKey: "kept legacy pattern",
		draft: {
			title: "Kept é finding",
			priority: "medium",
			observation: "Synthetic observation",
			uncertainty: "Unknown baseline",
			proposedChange: "Separate approval required",
			expectedBenefit: "Unknown",
			targets: [],
			implementationLinks: [],
		},
		evidence: [],
	};
	await store.insights.call(admission, finding);
	const run = {
		runId: randomUUID(),
		windowStart: "2026-11-01T00:00:00Z",
		windowEnd: "2026-11-06T00:00:00Z",
		bounds: initialInsightsSettings("synthetic/terra").bounds,
		settingsRevision: 1,
	};
	await store.insights.reviews.reserve(admission, run);
	await store.insights.reviews.interrupt(report, "cancelled", "Synthetic known Stop, unfinished coverage", run.runId);
	const scope = String(store["one"]("SELECT binding FROM insights_runs WHERE run_id=?", run.runId)!.binding),
		source = randomUUID();
	const position = JSON.stringify({
		stream: "synthetic-stream",
		before: 42,
		anchor: { id: 43, hash: "a".repeat(64) },
	});
	store["run"](
		"INSERT INTO insights_sources(scope,session_id,project_id,position,reviewed) VALUES (?,?,?,?,0)",
		scope,
		source,
		f.project.id,
		position,
	);
	store["run"]("INSERT INTO insights_inventory VALUES (?,?)", scope, randomUUID());
	await store.durable();
	await f.sessions.revokeInsights(report, 1);
	const legacy: InsightsLegacySelector = {
		schemaVersion: 2,
		reportSessionId: report,
		projectId: f.project.id,
		missionId: mission.id,
		expectedHome: host,
		context: payloadHash(canonicalJSON([f.home, host, f.project.id, f.project.path, mission.id])),
	};
	const authority: InsightsTransferAuthority = {
		legacy,
		workspace: {
			home: f.home,
			projectPath: f.project.path,
			owner: {
				schemaVersion: 2,
				workspaceId: randomUUID(),
				reportSessionId: randomUUID(),
				scheduleId: randomUUID(),
				projectId: f.project.id,
				expectedHome: host,
				context: payloadHash(canonicalJSON([2, f.home, host, f.project.id, f.project.path])),
			},
		},
	};
	const snapshot = store.insightsTransition.snapshot(legacy);
	const raw = JSON.stringify({
		schemaVersion: 2,
		owner: authority.workspace.owner,
		legacy,
		manifest: snapshot.manifest,
		envelopesHash: payloadHash(JSON.stringify([])),
		model: snapshot.desired.model,
		settings: snapshot.desired.settings,
		disclosure: "insights-workspace-transfer-v2",
	});
	const op: DurableOperation = {
		schemaVersion: 1,
		kind: "insights-workspace-transfer",
		targetId: authority.workspace.owner.workspaceId,
		operationId: randomUUID(),
		producerId: "native-storage-fixture",
		sequence: 1,
		origin: { ...host, hostId: "local" },
		destination: { ...host, hostId: "local" },
		payload: raw,
		payloadHash: payloadHash(raw),
	};
	const guard = () => {
		f.sessions.insightsLegacyQuiescence(report, f.project.id, mission.id);
		assert.equal(f.projects.require(f.project.id).path, authority.workspace.projectPath);
	};
	let closed = false;
	const closeStore = async () => {
		if (closed) return;
		closed = true;
		await store.close();
	};
	t.after(async () => {
		await f.sessions.shutdown();
		await closeStore();
	});
	return { ...f, store, closeStore, legacy, authority, snapshot, op, guard, finding, position, source };
}

test("storage transfer owns one receipt, preserves original rows and unfinished cursor bytes", async (t) => {
	const f = await fixture(t),
		before = f.snapshot.parts;
	await f.store.insightsTransition.enter(f.op, f.authority, f.snapshot, f.guard);
	assert.throws(() => f.sessions.insightsReplacementTarget(f.legacy.reportSessionId), /fenced/);
	const result = await f.store.insightsTransition.commit(f.op, f.authority, f.snapshot, [], f.guard);
	assert.equal(result.state, "transferred");
	assert.equal(result.activation, "not_activated");
	assert.deepEqual(f.store.insightsTransition.snapshot(f.legacy).parts, before);
	assert.equal(
		f.store["one"]("SELECT position FROM insights_owner_sources WHERE session_id=?", f.source)!.position,
		f.position,
	);
	assert.equal(f.store["one"]("SELECT state FROM insights_owner_runs")!.state, "cancelled");
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_owner_execution")!.n, 0);
	assert.deepEqual(await f.store.insightsTransition.commit(f.op, f.authority, f.snapshot, [], f.guard), result);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_items")!.n, 1);
	assert.equal(f.store.require(f.legacy.missionId).title, "Original user mission");
	const lease = { authority: f.authority.workspace, revision: 1, revalidate: () => {} };
	const item = await f.store.insightsWorkspace.item(lease, "finding", f.finding.key);
	assert.equal(item.origin?.kind, "legacy_snapshot");
	assert.equal(item.origin?.transferOperationId, f.op.operationId);
	f.store.remove(f.legacy.missionId);
	await f.store.durable();
	assert.equal((await f.store.insightsWorkspace.item(lease, "finding", f.finding.key)).key, f.finding.key);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfer_rows")!.n, f.snapshot.manifest.rows);
	assert.throws(() => f.store.insightsTransition.assertTarget(f.legacy.reportSessionId), /fenced/);
});

test("stale snapshot and Stop guard refuse transfer without copying any tracking rows", async (t) => {
	const f = await fixture(t);
	await f.store.insightsTransition.enter(f.op, f.authority, f.snapshot, f.guard);
	await assert.rejects(
		f.store.insightsTransition.commit(f.op, f.authority, f.snapshot, [], () => {
			throw new Error("Synthetic Stop fence");
		}),
		/Stop fence/,
	);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_owners")!.n, 0);
	assert.equal((await f.store.insightsTransition.lookup(f.op, f.guard)).state, "entered");
	f.store["run"]("UPDATE insights_items SET revision=revision+1 WHERE key=?", f.finding.key);
	await f.store.durable();
	await assert.rejects(
		f.store.insightsTransition.commit(f.op, f.authority, f.snapshot, [], f.guard),
		/snapshot_or_marker_changed/,
	);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfer_rows")!.n, 0);
});

test("concurrent storage transfers cannot select another owner or duplicate copied records", async (t) => {
	const f = await fixture(t),
		other = { ...f.op, operationId: randomUUID(), sequence: 2 };
	const results = await Promise.allSettled([
		f.store.insightsTransition.enter(f.op, f.authority, f.snapshot, f.guard),
		f.store.insightsTransition.enter(other, f.authority, f.snapshot, f.guard),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfers")!.n, 1);
});

test("partial tracking-copy failure rolls back, while the durable entered fence stays", async (t) => {
	const f = await fixture(t);
	await f.store.insightsTransition.enter(f.op, f.authority, f.snapshot, f.guard);
	const db = f.store.insightsTransition["db"],
		original = db.run;
	const fault = t.mock.method(db, "run", (...args: Parameters<typeof original>) => {
		const [sql, ...params] = args;
		if (sql.startsWith("INSERT INTO insights_workspace_revisions")) throw new Error("Synthetic copy failure");
		original(sql, ...params);
	});
	await assert.rejects(f.store.insightsTransition.commit(f.op, f.authority, f.snapshot, [], f.guard), /copy failure/);
	fault.mock.restore();
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_items")!.n, 0);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_owners")!.n, 0);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_transfer_rows")!.n, 0);
	assert.equal((await f.store.insightsTransition.lookup(f.op, f.guard)).state, "entered");
	assert.deepEqual(f.store.insightsTransition.snapshot(f.legacy).parts, f.snapshot.parts);
	const result = await f.store.insightsTransition.commit(f.op, f.authority, f.snapshot, [], f.guard);
	assert.equal(result.state, "transferred");
});

test("lost final storage ACK recovers its exact receipt without copying again", async (t) => {
	const f = await fixture(t);
	await f.store.insightsTransition.enter(f.op, f.authority, f.snapshot, f.guard);
	const db = f.store.insightsTransition["db"],
		original = db.durable;
	const fault = t.mock.method(db, "durable", async () => {
		await original();
		throw new Error("Synthetic lost transaction ACK");
	});
	await assert.rejects(
		f.store.insightsTransition.commit(f.op, f.authority, f.snapshot, [], f.guard),
		/lost transaction ACK/,
	);
	fault.mock.restore();
	const receipt = await f.store.insightsTransition.lookup(f.op, f.guard);
	assert.equal(receipt.state, "committed");
	assert.equal(
		f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_receipts WHERE operation_id=?", f.op.operationId)!.n,
		1,
	);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_workspace_items")!.n, 1);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_owner_grants")!.n, 0);
});

test("committed transfer receipt, old-ID denial and original rows survive cold reopen", async (t) => {
	const f = await fixture(t);
	await f.store.insightsTransition.enter(f.op, f.authority, f.snapshot, f.guard);
	const result = await f.store.insightsTransition.commit(f.op, f.authority, f.snapshot, [], f.guard);
	await f.sessions.shutdown();
	await f.closeStore();
	const reopened = new MissionStore(join(f.home, "missions.sqlite")),
		sessions = await f.manager();
	new MissionService(reopened, sessions, f.projects);
	t.after(async () => {
		await sessions.shutdown();
		await reopened.close();
	});
	assert.equal((await reopened.insightsTransition.lookup(f.op, () => {})).state, "committed");
	assert.throws(() => sessions.insightsReplacementTarget(f.legacy.reportSessionId), /fenced/);
	assert.deepEqual(reopened.insightsTransition.snapshot(f.legacy).parts, f.snapshot.parts);
	assert.equal(
		reopened["one"]("SELECT COUNT(*) n FROM insights_workspace_receipts WHERE operation_id=?", f.op.operationId)!.n,
		1,
	);
	assert.equal(result.activation, "not_activated");
});

test("transferred v1 payload envelopes remain exact and are not interpreted as new grants", async (t) => {
	const f = await fixture(t);
	const original: DurableOperation = {
		...f.op,
		kind: "insights-enable",
		operationId: randomUUID(),
		targetId: f.legacy.reportSessionId,
		payload: '{\n  "kept": "é"\n}',
	};
	original.payloadHash = payloadHash(original.payload);
	const envelopes = [
		{
			operationId: original.operationId,
			original: JSON.stringify({
				operation: original,
				receipt: { state: "accepted", operationId: original.operationId, result: { unchanged: true } },
			}),
		},
	];
	const payload = JSON.stringify({
			...JSON.parse(f.op.payload),
			envelopesHash: payloadHash(JSON.stringify(envelopes)),
		}),
		op = { ...f.op, payload, payloadHash: payloadHash(payload) };
	await f.store.insightsTransition.enter(op, f.authority, f.snapshot, f.guard);
	await f.store.insightsTransition.commit(op, f.authority, f.snapshot, envelopes, f.guard);
	assert.equal(
		f.store["one"]("SELECT original FROM insights_transfer_envelopes WHERE operation_id=?", original.operationId)!
			.original,
		envelopes[0]!.original,
	);
	assert.equal(f.store["one"]("SELECT COUNT(*) n FROM insights_owner_grants")!.n, 0);
});

test("legacy UUID spelling is preserved while aliases remain denied", async (t) => {
	const f = await fixture(t, true);
	await f.store.insightsTransition.enter(f.op, f.authority, f.snapshot, f.guard);
	assert.throws(() => f.store.insightsTransition.assertTarget(f.legacy.reportSessionId.toLowerCase()), /fenced/);
	const result = await f.store.insightsTransition.commit(f.op, f.authority, f.snapshot, [], f.guard);
	assert.equal(result.legacy.reportSessionId, f.legacy.reportSessionId);
	assert.equal(
		f.store["one"]("SELECT old_session_id FROM insights_legacy_denials")!.old_session_id,
		f.legacy.reportSessionId,
	);
	assert.equal(
		f.store["one"]("SELECT old_session_id FROM insights_transfers")!.old_session_id,
		f.legacy.reportSessionId,
	);
});
