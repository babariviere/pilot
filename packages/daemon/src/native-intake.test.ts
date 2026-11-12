import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DurableOperation, IntakeIntent, Project, SessionSummary } from "@pilot/protocol";
import { NativeIntake } from "./native-intake.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { TrackedItemStore } from "./tracked-items.ts";

function trackedInput(externalId = "issue-1", updatedAt = 10) {
	return {
		externalId,
		updatedAt,
		title: "Request",
		url: "https://example.invalid/request",
		status: "Todo",
		metadata: {},
	};
}

const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "intake-"));
	const items = new TrackedItemStore(join(home, "items.sqlite"));
	t.after(async () => {
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	let journal = new OperationJournal(join(home, "operations"), host);
	const projects = new Map([
		["p", { id: "p", name: "One", path: home, model: "fake/model" } as Project],
		["q", { id: "q", name: "Two", path: home } as Project],
	]);
	await items.load(["p", "q"]);
	await items.commit("p", "linear", [trackedInput()]);
	await items.commit("q", "linear", [trackedInput()]);
	let starts = 0,
		effects = 0,
		fail = false;
	let modelDenied = false;
	const spawnRequests: unknown[] = [];
	const create = () =>
		new NativeIntake({
			journal,
			projects: {
				require: (id) => {
					const p = projects.get(id);
					if (!p) throw new Error("Project missing");
					return p;
				},
			},
			tracking: {
				items,
				savedLinear: async () => {
					throw new Error("Not used by intake tests");
				},
				assertIntakeSource: () => {},
				intakeSources: async (project) =>
					(await items.intake(project)).map((s) => ({ ...s, source: s.kind, label: s.kind, status: "ok" })),
				patch: async (id, patch, operation) => {
					effects++;
					return items.patch(id, patch, operation);
				},
			},
			sessions: {
				selectTaskModel: async () => {
					if (modelDenied) throw new Error("Task model price/scope policy refused");
					return { model: "fake/model", thinking: "high" };
				},
				spawnDurable: async (request, sessionId, _op, guard) => {
					guard?.();
					starts++;
					spawnRequests.push(request);
					if (fail) throw new Error("lost admission ACK");
					return { id: sessionId } as SessionSummary;
				},
			},
			missions: {
				require: (id) => ({ id, projectId: id === "other" ? "q" : "p", status: "active" }) as never,
				list: () => [],
			},
		});
	let service = create();
	const operation = async (
		purpose: IntakeIntent["purpose"],
		extra: Partial<IntakeIntent> = {},
	): Promise<DurableOperation> => {
		const read = await service.read("p");
		const item = read.sources.find((s) => s.kind === "linear")!.items[0]!;
		const p: IntakeIntent = {
			purpose,
			projectId: "p",
			itemId: item.id,
			revision: item.revision,
			contextDigest: read.contextDigest,
			...(purpose === "intake-start" ? { sessionId: randomUUID() } : { state: "later" }),
			...extra,
		};
		const payload = canonicalJSON(p);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: host,
			destination: host,
			kind: purpose,
			targetId: p.itemId,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: p.contextDigest,
			bindingGeneration: 1,
		};
	};
	return {
		items,
		projects,
		operation,
		get service() {
			return service;
		},
		get journal() {
			return journal;
		},
		get starts() {
			return starts;
		},
		get effects() {
			return effects;
		},
		spawnRequests,
		fail() {
			fail = true;
		},
		denyModel() {
			modelDenied = true;
		},
		reopen() {
			journal = new OperationJournal(join(home, "operations"), host);
			service = create();
		},
		execute(op: DurableOperation) {
			return journal.execute(op, (o, e) => service.admit(o, e.firstEntry));
		},
	};
}

test("complete local intake exceeds preview; filters linked/closed/other projects, reports overflow", async (t) => {
	const f = await fixture(t);
	await f.items.commit(
		"p",
		"linear",
		Array.from({ length: 106 }, (_, i) => trackedInput(`issue-${i}`, i)),
	);
	let page = (await f.service.read("p")).sources.find((s) => s.kind === "linear")!;
	assert.equal(page.items.length, 100);
	assert.equal(page.total, 106);
	assert.equal(page.complete, false);
	const first = page.items[0]!;
	await f.items.patch(first.id, { sessionId: "existing" });
	page = (await f.service.read("p")).sources.find((s) => s.kind === "linear")!;
	assert.equal(page.total, 105);
	assert(!page.items.some((i) => i.id === first.id));
	assert(page.items.every((i) => i.projectId === "p"));
});

test("Later/Bring back and Discard/Undo survive reopen; stale/ABA/source updates refuse", async (t) => {
	const f = await fixture(t);
	const later = await f.operation("intake-triage");
	assert.equal((await f.execute(later)).state, "accepted");
	f.reopen();
	assert.equal((await f.service.lookup(later))!.state, "accepted");
	assert.equal((await f.items.require(later.targetId)).triageState, "later");
	for (const state of ["new", "discarded", "new"] as const) {
		assert.equal((await f.execute(await f.operation("intake-triage", { state }))).state, "accepted");
	}
	const stale = { ...later, operationId: randomUUID(), producerId: randomUUID() };
	assert.equal((await f.execute(stale)).state, "rejected");
	const changed = await f.operation("intake-triage");
	await f.items.commit("p", "linear", [
		{ ...trackedInput("issue-1", 10), title: "Changed at the same source timestamp" },
	]);
	assert.equal((await f.execute(changed)).state, "rejected", "same source timestamp is not a revision fence");
	assert.equal(f.starts, 0);
	assert.equal(f.effects, 0);
});

test("user Later never means Slack waiting; sync keeps local triage", async (t) => {
	const f = await fixture(t);
	await f.items.commit("p", "slack", [{ ...trackedInput("C1/1.0"), status: "open", metadata: {} }]);
	let item = (await f.items.intake("p")).find((s) => s.kind === "slack")!.items[0]!;
	await f.items.intakeWrite("p", item.id, item.revision, "later");
	await f.items.commit("p", "slack", [{ ...trackedInput("C1/1.0", 20), status: "open", metadata: {} }]);
	item = await f.items.require(item.id);
	assert.equal(item.triageState, "later");
	assert.equal(item.slack!.status, "open");
});

test("Start creates exactly one pinned Build and existing link/effects; duplicate and Check never resend", async (t) => {
	const f = await fixture(t),
		op = await f.operation("intake-start", { missionId: "mission" });
	const ack = await f.execute(op);
	assert.equal(ack.state, "accepted");
	assert.equal(f.starts, 1);
	assert.equal(f.effects, 1);
	assert.deepEqual(
		f.spawnRequests.map((r) => [
			(r as { projectId: string }).projectId,
			(r as { missionId: string }).missionId,
			(r as { mode: string }).mode,
		]),
		[["p", "mission", "build"]],
	);
	assert.equal((await f.items.require(op.targetId)).sessionId, (ack.result as { sessionId: string }).sessionId);
	assert.equal((await f.items.require(op.targetId)).missionId, "mission");
	await f.items.patch(op.targetId, { missionId: "another-explicit-link" });
	f.reopen();
	assert.deepEqual(await f.service.lookup(op), ack);
	assert.deepEqual(await f.execute(op), ack);
	assert.equal(f.starts, 1);
	assert.equal(f.effects, 1);
});

test("lost admission ACK stays Unknown and blocks another Start across restart; Check only reads", async (t) => {
	const f = await fixture(t),
		op = await f.operation("intake-start");
	f.fail();
	assert.equal((await f.execute(op)).state, "pending");
	f.reopen();
	assert.equal((await f.service.lookup(op))!.state, "pending");
	assert.equal((await f.execute(op)).state, "pending");
	assert.equal((await f.execute(await f.operation("intake-start"))).state, "rejected");
	assert.equal(f.starts, 1);
	assert.equal(f.effects, 0);
	await assert.rejects(f.items.patch(op.targetId, { start: true, sessionId: "legacy" }), /Check/);
});

test("project config and mission scope fences refuse before claim", async (t) => {
	const f = await fixture(t),
		op = await f.operation("intake-start");
	f.projects.get("p")!.name = "changed";
	assert.equal((await f.execute(op)).state, "rejected");
	assert.equal((await f.execute(await f.operation("intake-start", { missionId: "other" }))).state, "rejected");
	assert.equal(f.starts, 0);
	assert.equal(f.effects, 0);
	assert.equal((await f.items.require(op.targetId)).startOperationId, undefined);
});

test("two Start operations race one revision; only one can claim/create", async (t) => {
	const f = await fixture(t);
	const first = await f.operation("intake-start"),
		second = await f.operation("intake-start");
	const receipts = await Promise.all([f.execute(first), f.execute(second)]);
	assert.deepEqual(receipts.map((r) => r.state).sort(), ["accepted", "rejected"]);
	assert.equal(f.starts, 1);
	assert.equal(f.effects, 1);
});

test("model policy refusal is final before claim; missing receipt Check does not create", async (t) => {
	const f = await fixture(t),
		op = await f.operation("intake-start");
	assert.equal(await f.service.lookup(op), undefined);
	assert.equal(f.starts, 0);
	f.denyModel();
	const receipt = await f.execute(op);
	assert.equal(receipt.state, "rejected");
	assert.match(receipt.reason!, /model policy/);
	assert.equal((await f.items.require(op.targetId)).startOperationId, undefined);
	assert.equal(f.starts, 0);
	assert.equal(f.effects, 0);
});
