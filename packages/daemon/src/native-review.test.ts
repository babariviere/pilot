import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { unavailableReviewProducer } from "./mission-review-contract.ts";
import { optionalReviewSeeds } from "./mission-review-seeds.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { NativeReviewReader, NoRetainedBinding } from "./native-review.ts";
import { ProjectStore } from "./projects.ts";
import { type ReviewSnapshot, snapshotManifest } from "./review-snapshot-contract.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

function snapshot(): ReviewSnapshot {
	const repositoryId = "a".repeat(64),
		changeId = "k".repeat(32),
		operationId = "b".repeat(128),
		commitId = "c".repeat(40);
	const binding = {
		version: 1 as const,
		sessionId: "worker",
		missionId: "mission",
		taskIds: ["task"],
		repositoryId,
		repositoryPath: "/host/repository",
		workspace: "pilot-worker-1234567890abcdef",
		path: "/host/workspace",
		startOperation: operationId,
	};
	return {
		snapshotId: "d".repeat(64),
		manifest: {
			version: 1,
			request: {
				requestId: "capture",
				repositoryId,
				changeId,
				operationId,
				base: { changeId: "l".repeat(32), commitId: "e".repeat(40) },
				head: { changeId, commitId },
				scope: { kind: "layer" },
				source: "committed",
			},
			provenance: {
				capturedAt: 1,
				taskAttribution: "unknown",
				ledger: {
					repositoryId,
					changeId,
					discovery: "complete",
					ownership: {
						status: "owned",
						binding,
						creation: { changeId, commitId, operationId, kind: "workspace-created" },
						taskAttribution: "unknown",
					},
					current: { status: "unknown", revisions: [] },
				},
			},
			status: "complete",
			omissions: [],
			before: [],
			after: [],
			changes: [],
			trees: { before: "e".repeat(40), after: "f".repeat(40) },
			diff: { sha256: createHash("sha256").update("").digest("hex"), bytes: 0 },
		},
	};
}
test("legacy/direct workers explain missing retained custody without opening a content store", async () => {
	let touched = false;
	const reader = new NativeReviewReader(
		{
			get: async () => {
				touched = true;
				return snapshot();
			},
			list: async () => {
				touched = true;
				return { comparisons: [], next: null };
			},
			read: async () => new Uint8Array(),
			diff: async () => new Uint8Array(),
		},
		{ get: async () => snapshot().manifest.provenance.ledger },
		async () => {
			throw new NoRetainedBinding("Not enrolled");
		},
	);
	const page = await reader.list(0);
	assert.equal(page.comparisons.length, 0);
	assert.ok("unavailable" in page);
	assert.match(page.unavailable, /does not enroll/);
	await assert.rejects(reader.get("d".repeat(64)), NoRetainedBinding);
	assert.equal(touched, false);
});
test("required retained manifest fields, custody and reference identities fail closed", () => {
	const valid = snapshot();
	snapshotManifest(valid.manifest);
	for (const mutate of [
		(m: any) => delete m.diff,
		(m: any) => (m.provenance.ledger.ownership.status = "unknown"),
		(m: any) => (m.provenance.ledger.ownership.creation.changeId = "l".repeat(32)),
		(m: any) => (m.provenance.ledger.ownership.binding.repositoryId = "f".repeat(64)),
		(m: any) =>
			(m.before = [
				{
					path: "../private",
					mode: "100644",
					gitOid: "c".repeat(40),
					state: "text",
					sha256: "d".repeat(64),
					bytes: 0,
				},
			]),
		(m: any) => (m.diff.bytes = 8 * 1024 * 1024),
		(m: any) => (m.omissions = ["Missing bytes"]),
		(m: any) =>
			(m.changes = [
				{
					status: "U",
					beforePath: null,
					afterPath: null,
					beforeMode: "000000",
					afterMode: "000000",
					beforeOid: "0".repeat(40),
					afterOid: "0".repeat(40),
				},
			]),
	]) {
		const m = structuredClone(valid.manifest);
		mutate(m);
		assert.throws(() => snapshotManifest(m));
	}
});

test("native Review HTTP admits current scope and rejects writes, cross-scope and revoked reads", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "native-review-api-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	const sessions = new SessionManager(home, projects);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, sessions, projects);
	const mission = store.create({ title: "Review", projectId: project.id });
	store.join("worker", mission.id);
	const terminals = new TerminalManager();
	const retained = snapshot();
	const own = retained.manifest.provenance.ledger.ownership;
	assert.equal(own.status, "owned");
	if (own.status !== "owned") return;
	own.binding.missionId = mission.id;
	let reads = 0,
		revoke = false;
	t.mock.method(sessions, "get", (id: string) =>
		id === "worker" ? ({ id, title: "Worker", projectId: project.id } as SessionSummary) : undefined,
	);
	t.mock.method(
		sessions,
		"nativeReviewReader",
		(_id: string, _mission: string, _project: string, authorize: () => void) =>
			new NativeReviewReader(
				{
					get: async () => {
						reads++;
						if (revoke) store.leave("worker");
						return retained;
					},
					list: async () => ({ comparisons: [], next: null }),
					diff: async () => new Uint8Array(),
					read: async () => new Uint8Array(),
				},
				{ get: async () => retained.manifest.provenance.ledger },
				async () => {
					authorize();
					return own.binding;
				},
			),
	);
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
		{ store, service },
	);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(async () => {
		await new Promise<void>((r) => server.close(() => r()));
		await service.notices.stop();
		terminals.shutdown();
		await sessions.shutdown();
		await store.durable();
		store.close();
		rmSync(home, { recursive: true, force: true });
	});
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missions/${mission.id}/review`;
	let response = await fetch(root);
	assert.equal(response.status, 200);
	assert.deepEqual(((await response.json()) as any).workers, [{ id: "worker", title: "Worker" }]);
	assert.equal((await fetch(root, { method: "POST" })).status, 405);
	assert.equal((await fetch(root, { headers: { origin: "https://evil.example" } })).status, 403);
	store.update(mission.id, { status: "archived" });
	assert.equal((await fetch(root)).status, 200, "passive archived browsing does not require active work admission");
	assert.equal((await fetch(`${root}/other/${retained.snapshotId}`)).status, 403);
	assert.equal(reads, 0);
	response = await fetch(`${root}/worker/${retained.snapshotId}`);
	assert.equal(response.status, 200);
	assert.doesNotMatch(await response.text(), /\/host\/|repositoryPath/);
	revoke = true;
	response = await fetch(`${root}/worker/${retained.snapshotId}`);
	assert.equal(response.status, 403);
	assert.doesNotMatch(await response.text(), /snapshotId|\/host\//);
});

test("exact dimension results remain reported/unavailable, context changes make them outdated", async () => {
	const store = new MissionStore(":memory:");
	try {
		const m = store.create({ title: "Review", projectId: "p", planningVersion: 1 });
		store.join("lead", m.id);
		store.join("worker", m.id);
		store.update(m.id, { coordinatorSessionId: "lead" });
		const task = store.addTask(m.id, {
			title: "Change",
			sessionId: "worker",
			assignment: {
				version: 1,
				expectedRevision: 0,
				intent: "Fix parsing",
				scope: "One file",
				criteria: ["Correct"],
			},
		});
		const snapshotId = "a".repeat(64);
		await store.saveReviewProfile(
			m.id,
			"lead",
			{
				version: 1,
				operationId: "profile",
				profileId: "correctness",
				expectedRevision: 0,
				definition: optionalReviewSeeds().correctness,
			},
			() => {},
		);
		const request = {
			version: 1,
			operationId: "result",
			profileId: "correctness",
			profileRevision: 1,
			expectedResultId: null,
			definitionRevision: store.sharedDefinitionRevision(task.id),
			expectedContextFence: store.reviewContextFence(m.id),
			assignment: task.assignment!,
			intent: "code",
			content: [{ kind: "snapshot", snapshotId }],
			context: [],
			preferences: { unavailable: "Not configured" },
			output: { state: "completed", outcome: "pass", reason: "No issue reported" },
			findings: [],
			resolutions: [],
			limitations: "Not checks or acceptance",
			confidence: "unavailable",
		};
		await store.recordReviewResult(m.id, task.id, "worker", request, {
			authorize: () => {},
			resolve: async (reference) => ({
				reference,
				sourceOwnerSessionId: "worker",
				sha256: snapshotId,
				availability: "retained",
			}),
			observeProducer: async () => unavailableReviewProducer(),
			validateCitations: async () => {},
		});
		let data = store.nativeReviewRecords(m.id, "worker", snapshotId);
		assert.equal(data.assessments.length, 1);
		assert.equal(data.assessments[0]?.applicability, "unavailable");
		assert.equal(data.assessments[0]?.outcome, "pass");
		assert.deepEqual(store.nativeReviewRecords(m.id, "worker", "b".repeat(64)).assessments, []);
		store.addDecision(m.id, "New constraint");
		data = store.nativeReviewRecords(m.id, "worker", snapshotId);
		assert.equal(data.assessments[0]?.applicability, "outdated");
		assert.throws(() => store.nativeReviewRecords(m.id, "other", snapshotId), /custody/);
	} finally {
		await store.durable();
		store.close();
	}
});
