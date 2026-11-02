import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { KnowledgeCheckInput, KnowledgeSource } from "@pilot/protocol";
import { NotFound } from "./errors.ts";
import { observeRepository } from "./knowledge-maintenance.ts";
import { MissionStore } from "./missions.ts";
import { KnowledgeService } from "./project-knowledge.ts";

const user = { type: "user" } as const;
const caller = { sessionId: "worker", projectId: "p1", readOnly: false };
const content = {
	kind: "component",
	title: "Explorer",
	synopsis: "Bounded reads",
	body: "## Purpose\nExplore.\n## Interfaces\nRead.\n## Constraints\nNo writes.",
};
let operation = 0;
function fixture(file = ":memory:") {
	const store = new MissionStore(file);
	const objects = new Map([
		["src/a.ts", "blob:a1"],
		["src/b.ts", "blob:b1"],
		["docs/a.md", "blob:d1"],
	]);
	let reads = 0;
	let latest = 1;
	let beforeRead: (() => Promise<void>) | undefined;
	let artifactListener: ((sessionId: string) => void) | undefined;
	const service = new KnowledgeService(
		store,
		{
			require(id) {
				if (id !== "p1") throw new NotFound("project unavailable");
				return { path: "/project" };
			},
		},
		{
			get: () => ({ projectId: "p1" }),
			async artifact(_session, _id, revision) {
				reads++;
				return { revision: revision ?? latest };
			},
			onArtifactsChanged(listener) {
				artifactListener = listener;
				return () => {
					artifactListener = undefined;
				};
			},
		},
		async (_root, paths) => {
			reads++;
			await beforeRead?.();
			return new Map(paths.flatMap((path) => (objects.has(path) ? [[path, objects.get(path)!]] : [])));
		},
	);
	const create = async (sources: KnowledgeSource[]) =>
		(
			await service.write(
				"p1",
				undefined,
				{
					...content,
					operationId: `create-${++operation}`,
					expectedRevision: 0,
					sources,
				},
				user,
			)
		).entry.id;
	const observe = async (ids: string[]) => await service.maintenance.observeKnowledgeSources("p1", ids);
	const check = async (id: string) => {
		const [input] = await observe([id]);
		assert.ok(input && !("error" in input));
		await service.maintenance.recordCheck("p1", input, "worker", "Inspected committed sources; no runtime proof");
		return input;
	};
	return {
		store,
		service,
		objects,
		create,
		observe,
		check,
		reads: () => reads,
		setLatest(value: number) {
			latest = value;
			artifactListener?.("worker");
		},
		setBeforeRead(value?: () => Promise<void>) {
			beforeRead = value;
		},
	};
}

test("scoped observations coalesce, preserve checked sources, and make duplicates read-only", async () => {
	const f = fixture();
	const a = await f.create([
		{ type: "repository", path: "src/a.ts" },
		{ type: "repository", path: "docs/a.md" },
	]);
	const b = await f.create([{ type: "repository", path: "src/b.ts" }]);
	await f.check(a);
	await f.check(b);
	const before = f.service.detail("p1", a);
	const duplicate = await f.observe([a, b]);
	assert.deepEqual(f.service.detail("p1", a), before);
	assert.equal(f.service.detail("p1", b).freshness.state, "checked");
	f.objects.set("src/a.ts", "blob:a2");
	f.objects.set("docs/a.md", "blob:d2");
	await f.observe([a, b]);
	const pending = f.service.detail("p1", a).freshness;
	assert.equal(pending.state, "needs_check");
	assert.equal(pending.pending!.generation, (duplicate[0] as KnowledgeCheckInput).pendingGeneration + 1);
	assert.deepEqual(pending.checked, before.freshness.checked);
	assert.ok(pending.checked!.sourceVersions);
	assert.equal(f.service.detail("p1", b).freshness.state, "checked");
	await f.observe([a]);
	assert.deepEqual(f.service.detail("p1", a).freshness, pending);
	const reads = f.reads();
	for (let i = 0; i < 4; i++) {
		f.service.list("p1");
		f.service.detail("p1", a);
		f.service.revisions("p1", a);
	}
	assert.equal(f.reads(), reads, "GET/Refresh never fan out to sources");
	await assert.rejects(f.observe(Array.from({ length: 51 }, () => a)), /1-50/);
	await assert.rejects(f.observe([a, a]), /distinct/);
	await assert.rejects(f.service.maintenance.observeKnowledgeSources("p2", [a]), /unavailable/);
});

test("checks reject changed sources, pending generations and author edits without overwriting bodies", async () => {
	const f = fixture();
	const id = await f.create([{ type: "repository", path: "src/a.ts" }]);
	const [input] = await f.observe([id]);
	assert.ok(input && !("error" in input));
	f.objects.set("src/a.ts", "blob:a2");
	await assert.rejects(f.service.maintenance.recordCheck("p1", input, "worker", "code"), /Stale/);
	assert.match(f.service.detail("p1", id).freshness.failure!.reason, /pending work retained/);
	const [next] = await f.observe([id]);
	assert.ok(next && !("error" in next));
	f.store.knowledge.markPending("p1", id, "new canonical evidence", "evidence:123");
	await assert.rejects(f.service.maintenance.recordCheck("p1", next, "worker", "code"), /Stale/);
	await f.service.write(
		"p1",
		id,
		{
			...content,
			body: `${content.body}\nUser correction.`,
			operationId: "user-edit",
			expectedRevision: 1,
			reason: "User correction",
			sources: [{ type: "repository", path: "src/a.ts" }],
		},
		user,
	);
	await assert.rejects(f.service.maintenance.recordCheck("p1", next, "worker", "code"), /Stale/);
	assert.equal(f.service.detail("p1", id).revision.revision, 2);
	assert.match(f.service.detail("p1", id).revision.body, /User correction/);
	assert.equal(
		f.service.detail("p1", id, 1).observation,
		undefined,
		"historical body never inherits the new observation",
	);
	await f.check(id);
	assert.equal(f.service.detail("p1", id).freshness.state, "checked");
	assert.equal(f.service.detail("p1", id, 1).freshness.state, "not_checked");
});

test("unavailable and unsupported sources remain inspectably pending; recovery needs a real check", async () => {
	const f = fixture();
	const missing = await f.create([{ type: "repository", path: "missing.ts" }]);
	await f.observe([missing]);
	assert.equal(f.service.detail("p1", missing).observation!.sources[0]!.version, null);
	await assert.rejects(f.check(missing), /unavailable/);
	assert.equal(f.service.detail("p1", missing).freshness.state, "needs_check");
	f.objects.set("missing.ts", "blob:new");
	await f.check(missing);
	assert.equal(f.service.detail("p1", missing).freshness.failure, undefined);
	const web = await f.create([{ type: "web", url: "https://example.test/report", accessedAt: "2026-11-02" }]);
	await assert.rejects(f.check(web), /unavailable/);
	assert.match(f.service.detail("p1", web).observation!.sources[0]!.coverage, /not observed/);
});

test("decision changes mark pending atomically, including same-millisecond ABA", async () => {
	const f = fixture();
	const mission = f.store.create({ projectId: "p1", title: "Test" });
	const decision = f.store.addDecision(mission.id, "A");
	const id = await f.create([{ type: "mission", missionId: mission.id, decisionId: decision.id }]);
	await f.check(id);
	const checked = f.service.detail("p1", id).freshness.checked;
	f.store.updateDecision(mission.id, decision.id, "A");
	await f.observe([id]);
	assert.equal(f.service.detail("p1", id).freshness.state, "checked", "same decision text/audience needs no check");
	f.store.updateDecision(mission.id, decision.id, "B");
	const generation = f.store.knowledge.pendingGeneration(id);
	f.store.updateDecision(mission.id, decision.id, "A");
	assert.equal(f.store.knowledge.pendingGeneration(id), generation + 1);
	assert.deepEqual(f.service.detail("p1", id).freshness.checked, checked);
	assert.equal(f.service.detail("p1", id).freshness.state, "needs_check", "no background observer needed to mark");
	await f.check(id);
	f.store.removeDecision(mission.id, decision.id);
	await assert.rejects(f.check(id), /unavailable/);
});

test("coordinator reuses one task, records host origin, and never launches or recursively creates tasks", async () => {
	const f = fixture();
	const mission = f.store.create({
		projectId: "p1",
		title: "Test",
		tasks: [{ title: "Maintain component docs" }, { title: "Other" }],
	});
	f.store.join("lead", mission.id);
	f.store.join("worker", mission.id);
	f.store.update(mission.id, { coordinatorSessionId: "lead" });
	const lead = { ...caller, sessionId: "lead" };
	const a = await f.create([{ type: "repository", path: "src/a.ts" }]);
	const b = await f.create([{ type: "knowledge", knowledgeId: a, revision: 1, relation: "documents" }]);
	await f.observe([a, b]);
	for (const action of ["observe", "check", "batch"])
		await assert.rejects(f.service.call({ ...caller, readOnly: true }, action, { ids: [a] }), /read-only/);
	await assert.rejects(f.service.call(caller, "batch", { ids: [a], taskId: "1" }), /coordinator/);
	await f.service.call(lead, "batch", { ids: [a], taskId: "1" });
	await f.service.call(lead, "batch", { ids: [a, b], taskId: "1" });
	const task = f.store.tasks(mission.id)[0]!;
	assert.equal(f.service.detail("p1", a).freshness.pending!.taskId, task.id);
	assert.equal(f.service.detail("p1", b).freshness.pending!.taskId, task.id);
	await assert.rejects(f.service.call(lead, "batch", { ids: [a], taskId: "2" }), /existing open/);
	assert.ok(f.store.knowledge.isDocumentationTask(mission.id, task.id));
	await f.service.write(
		"p1",
		a,
		{
			...content,
			operationId: "docs-append",
			expectedRevision: 1,
			reason: "Document behavior",
			sources: [{ type: "repository", path: "src/a.ts" }],
		},
		user,
	);
	assert.ok(
		f.service
			.detail("p1", b)
			.freshness.pending!.reasons.some((reason) => reason.includes("Documentation source revised")),
	);
	f.store.claimTask(mission.id, task.id, "worker");
	f.store.completeTask(mission.id, task.id, "worker", { commit: "a".repeat(40), checks: "checked", issues: "" });
	assert.ok(
		f.service
			.detail("p1", a)
			.freshness.pending!.reasons.some((reason) => /Documentation-origin.*mapping unknown/.test(reason)),
	);
	f.objects.set("src/a.ts", "blob:mixed-code-change");
	await f.observe([a]);
	assert.equal(
		f.service.detail("p1", a).freshness.state,
		"needs_check",
		"documentation origin cannot hide mixed code changes",
	);
	assert.equal(f.store.tasks(mission.id).length, 2, "no task/model/worker created by any source mark or check");
});

test("missed artifact/repository events reconcile after reopen; durability failures fail replies", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "knowledge-maintenance-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "missions.sqlite");
	let f = fixture(path);
	const id = await f.create([{ type: "artifact", sessionId: "worker", artifactId: "report", revision: 1 }]);
	await f.check(id);
	await f.store.durable();
	f.store.close();
	f = fixture(path);
	t.after(async () => {
		await f.service.maintenance.stop();
		await f.store.durable();
		f.store.close();
	});
	f.setLatest(2);
	assert.equal(f.service.detail("p1", id).freshness.state, "checked", "passive reads don't reconcile missed hints");
	await f.observe([id]);
	assert.equal(f.service.detail("p1", id).freshness.state, "needs_check");
	assert.equal(f.service.detail("p1", id).revision.sources[0]!.type, "artifact");
	const durable = f.store.durable.bind(f.store);
	f.store.durable = async () => {
		throw new Error("disk unavailable");
	};
	await assert.rejects(f.observe([id]), /disk unavailable/);
	f.store.durable = durable;
});

test("a stale entry in a batch doesn't block another entry, and stop drains active observation", async () => {
	const f = fixture();
	const a = await f.create([{ type: "repository", path: "src/a.ts" }]);
	const b = await f.create([{ type: "repository", path: "src/b.ts" }]);
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.setBeforeRead(async () => {
		entered();
		await gate;
	});
	const observation = f.observe([a, b]);
	await started;
	f.store.knowledge.markPending("p1", a, "new event", "decision:1");
	release();
	const result = await observation;
	assert.ok("error" in result[0]!);
	assert.ok("observationToken" in result[1]!);
	assert.equal(f.service.detail("p1", a).freshness.state, "needs_check");
	assert.equal(f.service.detail("p1", b).freshness.state, "needs_check");
	f.setBeforeRead(undefined);
	await f.check(a);
	await f.check(b);
	const count = f.reads();
	f.service.maintenance.start();
	f.service.maintenance.hint("p1");
	f.service.maintenance.hint("p1");
	await yieldTurn();
	await f.service.maintenance.stop();
	const after = f.reads();
	f.service.maintenance.hint("p1");
	await yieldTurn();
	assert.equal(f.reads(), after);
	assert.ok(after >= count);
});

test("Git observation uses exact committed objects, bounded literal paths, and excludes dirty/symlink targets", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "knowledge-git-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.test");
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src/a.ts"), "original");
	await writeFile(join(root, "[literal].md"), "literal");
	await symlink("src/a.ts", join(root, "link"));
	git("add", ".");
	git("commit", "-qm", "initial");
	const sources = ["src", "src/a.ts", "[literal].md", "link", "missing"];
	const before = await observeRepository(root, sources);
	assert.ok(before.get("src"));
	assert.ok(before.get("src/a.ts"));
	assert.ok(before.get("[literal].md"));
	assert.equal(before.has("link"), false);
	assert.equal(before.has("missing"), false);
	await writeFile(join(root, "src/a.ts"), "dirty");
	assert.deepEqual(await observeRepository(root, sources), before);
	git("add", ".");
	git("commit", "-qm", "change");
	const after = await observeRepository(root, sources);
	assert.notEqual(after.get("src"), before.get("src"));
	assert.notEqual(after.get("src/a.ts"), before.get("src/a.ts"));
	assert.equal(after.get("[literal].md"), before.get("[literal].md"));
});

test("startup and duplicate hints use batches of at most 50 entries and drain before closing", async () => {
	const f = fixture();
	const ids: string[] = [];
	for (let i = 0; i < 53; i++) {
		const path = `src/${i}.ts`;
		f.objects.set(path, `blob:${i}`);
		ids.push(await f.create([{ type: "repository", path }]));
	}
	let batches = 0;
	let entered!: () => void;
	let release!: () => void;
	const secondBatch = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.setBeforeRead(async () => {
		batches++;
		if (batches === 2) {
			entered();
			await gate;
		}
	});
	f.service.maintenance.start();
	for (let i = 0; i < 30; i++) f.service.maintenance.hint("p1");
	await secondBatch;
	assert.equal(ids.filter((id) => f.service.detail("p1", id).freshness.pending).length, 50);
	let stopped = false;
	const stopping = f.service.maintenance.stop().then(() => {
		stopped = true;
	});
	await yieldTurn();
	assert.equal(stopped, false);
	release();
	await stopping;
	assert.equal(batches, 2, "duplicate hints coalesce into the startup sweep");
	assert.equal(ids.filter((id) => f.service.detail("p1", id).freshness.pending).length, 53);
});

test("observation and check replies wait for durability", async () => {
	const f = fixture();
	const id = await f.create([{ type: "repository", path: "src/a.ts" }]);
	const durable = f.store.durable.bind(f.store);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.store.durable = () => gate;
	let replied = false;
	const observing = f.observe([id]).then((value) => {
		replied = true;
		return value;
	});
	await yieldTurn();
	assert.equal(replied, false);
	release();
	const [input] = await observing;
	assert.ok(input && !("error" in input));
	f.store.durable = durable;
	await f.service.call(caller, "check", { ...input, coverage: "Read code; static-only evidence" });
	assert.equal(f.service.detail("p1", id).freshness.checked!.checker, "worker");
});

test("committed artifact events coalesce without polling or source reads from Refresh", async () => {
	const f = fixture();
	const id = await f.create([{ type: "artifact", sessionId: "worker", artifactId: "report", revision: 1 }]);
	f.service.maintenance.start();
	await yieldTurn();
	await f.check(id);
	const reads = f.reads();
	f.setLatest(2);
	f.setLatest(3);
	f.setLatest(3);
	await yieldTurn();
	await f.service.maintenance.stop();
	assert.equal(f.reads() - reads, 2, "one exact-pin read and one latest-pointer read for coalesced events");
	assert.equal(f.service.detail("p1", id).freshness.state, "needs_check");
	assert.equal(f.service.detail("p1", id).observation!.sources[0]!.version, "3");
	assert.equal(f.service.detail("p1", id).revision.sources[0]!.type, "artifact");
	const beforeRefresh = f.reads();
	await f.service.call(caller, "get", { id });
	assert.equal(f.reads(), beforeRefresh);
});

test("shutdown joins admitted writer observations and refuses new ones", async () => {
	const f = fixture();
	const id = await f.create([{ type: "repository", path: "src/a.ts" }]);
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.setBeforeRead(async () => {
		entered();
		await gate;
	});
	const observation = f.observe([id]);
	await started;
	let closed = false;
	const stopping = f.service.maintenance.stop().then(() => {
		closed = true;
	});
	await yieldTurn();
	assert.equal(closed, false);
	await assert.rejects(f.observe([id]), /closed/);
	release();
	await observation;
	await stopping;
	assert.ok(f.service.detail("p1", id).observation);
});
