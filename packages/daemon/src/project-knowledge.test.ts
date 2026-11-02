import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Conflict, NotFound } from "./errors.ts";
import { MissionStore } from "./missions.ts";
import { type KnowledgeCaller, KnowledgeService } from "./project-knowledge.ts";

const investigation = (title = "Exploration patterns", extra = "") => ({
	kind: "investigation",
	title,
	synopsis: "Which exploration patterns to reuse.",
	body: `## Question\nWhich patterns should we reuse?\n\n## Findings\n- F1 (observed, supported): literal search first.\n\n## Limitations\nNo runtime qualification.${extra}`,
});
const component = (title = "Code exploration") => ({
	kind: "component",
	title,
	synopsis: "First-party search and call-path tools.",
	body: "## Purpose\nBounded source exploration.\n\n## Interfaces\ncode_search, code_symbols.\n\n## Gaps\nNo persistent index.",
});

function fixture(file = ":memory:") {
	const store = new MissionStore(file);
	const projects = new Set(["p1", "p2"]);
	const chats = new Map<string, string>([
		["chat-1", "p1"],
		["chat-2", "p2"],
		["lead", "p1"],
		["worker", "p1"],
	]);
	const artifacts = new Set(["chat-1/report/1", "chat-2/report/1"]);
	let artifactReads = 0;
	const service = new KnowledgeService(
		store,
		{
			require(id: string) {
				if (!projects.has(id)) throw new NotFound(`Unknown project: ${id}`);
				return { id };
			},
		},
		{
			get: (id: string) => (chats.has(id) ? { projectId: chats.get(id) } : undefined),
			async artifact(sessionId: string, artifactId: string, revision?: number) {
				artifactReads++;
				if (!artifacts.has(`${sessionId}/${artifactId}/${revision}`)) throw new NotFound("missing");
				return { revision: revision ?? 1 };
			},
		},
	);
	return { store, service, projects, artifacts, reads: () => artifactReads };
}

let operation = 0;
const op = () => `op-${++operation}`;
const user = { type: "user" } as const;

test("creates readable entries, pages and filters stored summaries", async () => {
	const { service } = fixture();
	const first = await service.write(
		"p1",
		undefined,
		{ operationId: op(), expectedRevision: 0, ...investigation() },
		user,
	);
	assert.equal(first.replayed, false);
	assert.equal(first.entry.revision, 1);
	assert.deepEqual(first.entry.freshness, { state: "not_checked" });
	await service.write("p1", undefined, { operationId: op(), expectedRevision: 0, ...component() }, user);
	for (let i = 0; i < 58; i++)
		await service.write(
			"p1",
			undefined,
			{ operationId: op(), expectedRevision: 0, ...investigation(`Study ${i}`) },
			user,
		);
	await service.write(
		"p2",
		undefined,
		{ operationId: op(), expectedRevision: 0, ...component("Other project") },
		user,
	);

	const page = service.list("p1");
	assert.equal(page.entries.length, 25);
	assert.equal(page.more, true);
	const max = service.list("p1", { limit: "50" });
	assert.equal(max.entries.length, 50);
	assert.throws(() => service.list("p1", { limit: "51" }), /limit/);
	const rest = service.list("p1", { limit: "50", cursor: max.cursor });
	assert.equal(rest.entries.length, 10);
	assert.equal(rest.more, false);
	assert.equal(rest.cursor, null);
	const seen = new Set([...max.entries, ...rest.entries].map((e) => e.id));
	assert.equal(seen.size, 60);
	assert.throws(() => service.list("p1", { kind: "component", cursor: max.cursor }), /different project or filter/);
	assert.throws(() => service.list("p2", { limit: "50", cursor: max.cursor }), /different project or filter/);

	assert.deepEqual(
		service.list("p1", { kind: "component" }).entries.map((e) => e.title),
		["Code exploration"],
	);
	// Literal title/synopsis matching, not regex or body search.
	assert.equal(service.list("p1", { q: "STUDY 57" }).entries.length, 1);
	assert.equal(service.list("p1", { q: "study 5" }).entries.length, 9);
	assert.equal(service.list("p1", { q: "Study.*" }).entries.length, 0);
	assert.equal(service.list("p1", { q: "literal search" }).entries.length, 0);
	assert.ok(service.list("p2").entries.every((e) => e.projectId === "p2"));
	assert.throws(() => service.list("missing"), NotFound);
});

test("rejects unreadable, oversize and stale writes without truncating", async () => {
	const { service } = fixture();
	const write = (value: object, id?: string) => service.write("p1", id, { operationId: op(), ...value }, user);
	await assert.rejects(write({ expectedRevision: 0, ...investigation(), body: "Just a link." }), /Question/);
	await assert.rejects(write({ expectedRevision: 0, ...component(), body: "## Purpose\nOnly that." }), /Interfaces/);
	await assert.rejects(write({ expectedRevision: 0, ...investigation(), kind: undefined }), /kind is required/);
	await assert.rejects(
		write({ expectedRevision: 0, ...investigation("x", `\n${"a".repeat(64 * 1024)}`) }),
		/limit is 65536/,
	);
	const web = { type: "web", url: "https://example.com", accessedAt: "2026-11-02" };
	await assert.rejects(write({ expectedRevision: 0, ...investigation(), sources: Array(65).fill(web) }), /At most 64/);
	await assert.rejects(
		write({ expectedRevision: 0, ...investigation(), sources: [{ type: "web", url: "file:///etc" }] }),
	);
	await assert.rejects(
		write({ expectedRevision: 0, ...investigation(), sources: [{ type: "repository", path: "../secret" }] }),
		/relative/,
	);
	await assert.rejects(write({ expectedRevision: 1, ...investigation() }), Conflict);
	const saved = await write({ expectedRevision: 0, ...investigation(), sources: Array(64).fill(web) });
	assert.equal(service.detail("p1", saved.entry.id).revision.sources.length, 64);
	await assert.rejects(write({ expectedRevision: 1, ...investigation("Correction") }, saved.entry.id), /reason/);
	await assert.rejects(
		write({ expectedRevision: 1, ...component(), reason: "change kind" }, saved.entry.id),
		/kind cannot change/,
	);
	await write({ expectedRevision: 1, ...investigation("Corrected"), reason: "F1 narrowed" }, saved.entry.id);
	await assert.rejects(
		write({ expectedRevision: 1, ...investigation("Stale"), reason: "late" }, saved.entry.id),
		/current revision is 2/,
	);
});

test("keeps every revision readable and validates citations in the same project", async () => {
	const { service, store, reads } = fixture();
	const mission = store.create({ projectId: "p1", title: "Research" });
	const other = store.create({ projectId: "p2", title: "Elsewhere" });
	const decision = store.addDecision(mission.id, "Use literal search");
	const base = await service.write(
		"p1",
		undefined,
		{
			operationId: op(),
			expectedRevision: 0,
			...investigation(),
			sources: [
				{ type: "artifact", sessionId: "chat-1", artifactId: "report", revision: 1, label: "Study report" },
				{ type: "mission", missionId: mission.id, decisionId: decision.id, quote: "Use literal search" },
				{ type: "repository", path: "docs/code-exploration.md", commit: "0c3b3238212603f5" },
			],
		},
		user,
	);
	const id = base.entry.id;
	for (const [source, message] of [
		[{ type: "artifact", sessionId: "chat-2", artifactId: "report", revision: 1 }, /not in this project/],
		[{ type: "artifact", sessionId: "chat-1", artifactId: "report", revision: 2 }, /not found/],
		[{ type: "mission", missionId: other.id }, /not in this project/],
		[{ type: "mission", missionId: mission.id, decisionId: "nope" }, /decision was not found/],
		[{ type: "knowledge", knowledgeId: id, revision: 9, relation: "supersedes" }, /not found/],
	] as const)
		await assert.rejects(
			service.write(
				"p1",
				id,
				{ operationId: op(), expectedRevision: 1, ...investigation(), reason: "r", sources: [source] },
				user,
			),
			message,
		);
	const elsewhere = await service.write(
		"p2",
		undefined,
		{ operationId: op(), expectedRevision: 0, ...component() },
		user,
	);
	await assert.rejects(
		service.write(
			"p1",
			id,
			{
				operationId: op(),
				expectedRevision: 1,
				...investigation(),
				reason: "r",
				sources: [{ type: "knowledge", knowledgeId: elsewhere.entry.id, revision: 1, relation: "supports" }],
			},
			user,
		),
		/not found in this project/,
	);
	await service.write(
		"p1",
		id,
		{
			operationId: op(),
			expectedRevision: 1,
			...investigation("Exploration patterns, corrected"),
			reason: "Supersede F1 with a narrower finding",
			sources: [{ type: "knowledge", knowledgeId: id, revision: 1, relation: "supersedes", finding: "F1" }],
		},
		user,
	);
	const readsBefore = reads();
	const original = service.detail("p1", id, "1");
	assert.equal(original.revision.title, "Exploration patterns");
	assert.equal(original.revision.sources.length, 3);
	assert.equal(original.entry.revision, 2);
	assert.equal(service.detail("p1", id).revision.title, "Exploration patterns, corrected");
	assert.throws(() => service.detail("p1", id, "3"), /revision not found/);
	assert.throws(() => service.detail("p2", id), NotFound);
	const history = service.revisions("p1", id, { limit: 1 });
	assert.deepEqual(
		history.revisions.map((r) => r.revision),
		[2],
	);
	assert.equal(service.revisions("p1", id, { cursor: history.cursor }).revisions[0]?.revision, 1);
	assert.equal(reads(), readsBefore, "reads never open sources");
	// A later unavailable source leaves the retained body readable.
	store.remove(mission.id);
	assert.match(service.detail("p1", id, 1).revision.body, /## Findings/);
});

test("exact retries survive reopen; reused operations with other content conflict", async () => {
	const dir = await mkdtemp(join(tmpdir(), "knowledge-"));
	const file = join(dir, "missions.sqlite");
	try {
		let { service, store } = fixture(file);
		const write = { operationId: "create-1", expectedRevision: 0, ...investigation() };
		const first = await service.write("p1", undefined, write, user);
		const mission = store.create({ projectId: "p1", title: "Mission" });
		await service.link(mission.id, first.entry.id, { expectedLinkRevision: 0, followCurrent: true }, user);
		store.close();
		({ service, store } = fixture(file));
		// The ACK was lost: the identical request finds the saved entry instead of creating another.
		const again = await service.write("p1", undefined, write, user);
		assert.equal(again.replayed, true);
		assert.equal(again.entry.id, first.entry.id);
		assert.equal(service.list("p1").entries.length, 1);
		await assert.rejects(
			service.write("p1", undefined, { ...write, title: "Different" }, user),
			/different knowledge write/,
		);
		await assert.rejects(
			service.write("p1", undefined, write, { type: "session", sessionId: "chat-1" }),
			/different knowledge write/,
		);
		// The same operation ID in another project is a separate operation.
		assert.equal((await service.write("p2", undefined, write, user)).replayed, false);
		assert.equal(service.linkState(mission.id, first.entry.id).linkRevision, 1);
		await assert.rejects(
			service.link(mission.id, first.entry.id, { expectedLinkRevision: 0, revision: 1 }, user),
			/current link revision is 1/,
		);
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("mission links use one monotonic counter through repin, unlink and relink", async () => {
	const { service, store } = fixture();
	const mission = store.create({ projectId: "p1", title: "Mission" });
	const other = store.create({ projectId: "p2", title: "Other" });
	const entry = (
		await service.write("p1", undefined, { operationId: op(), expectedRevision: 0, ...component() }, user)
	).entry;
	await service.write(
		"p1",
		entry.id,
		{ operationId: op(), expectedRevision: 1, ...component(), reason: "Update" },
		user,
	);
	const before = store.knowledge.list("p1", { missionId: mission.id }, undefined, 50).entries.length;
	assert.deepEqual(service.linkState(mission.id, entry.id), {
		missionId: mission.id,
		knowledgeId: entry.id,
		linked: false,
		linkRevision: 0,
	});
	assert.equal(before, 0);
	assert.throws(() => service.linkState(other.id, entry.id), NotFound);
	await assert.rejects(
		service.link(other.id, entry.id, { expectedLinkRevision: 0, followCurrent: true }, user),
		NotFound,
	);
	await assert.rejects(service.unlink(mission.id, entry.id, "0", user), /at least 1/);

	const a = await service.link(mission.id, entry.id, { expectedLinkRevision: 0, revision: 1 }, user);
	assert.equal(a.linkRevision, 1);
	await service.link(mission.id, entry.id, { expectedLinkRevision: 1, revision: 2 }, user);
	const again = await service.link(mission.id, entry.id, { expectedLinkRevision: 2, revision: 1 }, user);
	assert.deepEqual([again.linkRevision, again.pinnedRevision], [3, 1]);
	// A→B→A: the pin value matches what the stale caller saw, but the revision does not.
	await assert.rejects(service.unlink(mission.id, entry.id, "1", user), /current link revision is 3/);
	const unlinked = await service.unlink(mission.id, entry.id, "3", user);
	assert.deepEqual([unlinked.linked, unlinked.linkRevision], [false, 4]);
	assert.equal(service.list("p1", { missionId: mission.id }).entries.length, 0);
	const relinked = await service.link(mission.id, entry.id, { expectedLinkRevision: 4, followCurrent: true }, user);
	assert.deepEqual([relinked.linked, relinked.linkRevision, relinked.pinnedRevision], [true, 5, undefined]);
	await assert.rejects(service.unlink(mission.id, entry.id, "3", user), Conflict);
	await assert.rejects(service.link(mission.id, entry.id, { expectedLinkRevision: 5, revision: 3 }, user), NotFound);
	const listed = service.list("p1", { missionId: mission.id }).entries;
	assert.deepEqual(
		listed.map((e) => [e.id, e.link?.linkRevision]),
		[[entry.id, 5]],
	);
	assert.throws(() => service.list("p2", { missionId: mission.id }), NotFound);

	// Archive keeps links and entries; deleting a mission removes only its links.
	store.lifecycle(mission.id, "p1", "active", "archive");
	assert.equal(service.list("p1", { missionId: mission.id }).entries.length, 1);
	assert.equal(service.detail("p1", entry.id, 1).revision.revision, 1);
	store.remove(mission.id);
	assert.equal(service.detail("p1", entry.id).entry.id, entry.id);
	assert.equal(service.list("p1").entries.length, 1);
});

test("GETs are passive and freshness is never inherited or set by a save", async () => {
	const { service, store } = fixture();
	const mission = store.create({ projectId: "p1", title: "Mission" });
	const entry = (
		await service.write("p1", undefined, { operationId: op(), expectedRevision: 0, ...component() }, user)
	).entry;
	let changes = 0;
	store.onChange(() => changes++);
	const snapshot = () =>
		JSON.stringify([
			service.list("p1", { limit: 50 }),
			store.knowledge.list("p1", { needsCheck: true }, undefined, 50),
		]);
	const before = snapshot();
	for (let i = 0; i < 3; i++) {
		service.list("p1", { missionId: mission.id, check: "needs_check", q: "code" });
		service.detail("p1", entry.id);
		service.revisions("p1", entry.id);
		service.linkState(mission.id, entry.id);
	}
	assert.equal(snapshot(), before);
	assert.equal(changes, 0);
	assert.equal(service.linkState(mission.id, entry.id).linkRevision, 0);

	const generation = store.knowledge.markPending("p1", entry.id, "Decision D29 changed", "decision:d29");
	assert.equal(service.detail("p1", entry.id).freshness.state, "needs_check");
	assert.equal(service.list("p1", { check: "needs_check" }).entries.length, 1);
	assert.throws(
		() =>
			store.knowledge.recordCheck("p1", entry.id, {
				revision: 1,
				pendingGeneration: generation - 1,
				checker: "test",
				coverage: "decisions",
				sourceVersions: {},
			}),
		/Newer pending/,
	);
	store.knowledge.recordCheck("p1", entry.id, {
		revision: 1,
		pendingGeneration: generation,
		checker: "test",
		coverage: "decisions",
		sourceVersions: {},
	});
	assert.equal(service.detail("p1", entry.id).freshness.state, "checked");
	await service.write(
		"p1",
		entry.id,
		{ operationId: op(), expectedRevision: 1, ...component(), reason: "Gap closed" },
		user,
	);
	assert.equal(service.detail("p1", entry.id).freshness.state, "not_checked");
	assert.equal(service.detail("p1", entry.id, 1).freshness.state, "checked");
	assert.equal(service.list("p1", { check: "needs_check" }).entries.length, 0);
});

test("the agent tool derives identity and keeps roles within their seams", async () => {
	const { service, store } = fixture();
	const mission = store.create({ projectId: "p1", title: "Mission", tasks: [{ title: "Study" }] });
	store.join("lead", mission.id);
	store.join("worker", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	const worker: KnowledgeCaller = { sessionId: "worker", projectId: "p1", readOnly: false };
	const lead: KnowledgeCaller = { sessionId: "lead", projectId: "p1", readOnly: false };
	const explorer: KnowledgeCaller = { sessionId: "chat-1", projectId: "p1", readOnly: true };

	await assert.rejects(service.call(explorer, "create", { ...investigation() }, "x"), /read-only/);
	await assert.rejects(service.call(worker, "list", { projectId: "p2" }), /own project/);
	const created = (await service.call(worker, "create", { ...investigation(), taskId: "#1" }, "call-1")) as {
		entry: { id: string; origin: { missionId?: string; taskId?: string; sessionId?: string } };
	};
	const task = store.tasks(mission.id)[0]!;
	assert.deepEqual(
		{ ...created.entry.origin, recordedAt: 0 },
		{ sessionId: "worker", missionId: mission.id, taskId: task.id, recordedAt: 0 },
	);
	const detail = service.detail("p1", created.entry.id);
	assert.deepEqual(detail.revision.author, { type: "session", sessionId: "worker" });
	assert.ok(((await service.call(explorer, "list", {})) as { entries: unknown[] }).entries.length === 1);
	await assert.rejects(
		service.call(worker, "link", { id: created.entry.id, expectedLinkRevision: 0 }),
		/mission coordinator/,
	);
	const linked = (await service.call(lead, "link", { id: created.entry.id, expectedLinkRevision: 0 })) as {
		linkRevision: number;
	};
	assert.equal(linked.linkRevision, 1);
	const got = (await service.call(worker, "get", { id: created.entry.id })) as { missionLink: { linked: boolean } };
	assert.equal(got.missionLink.linked, true);
	assert.equal(((await service.call(worker, "list", { linked: true })) as { entries: unknown[] }).entries.length, 1);
	await assert.rejects(service.call(explorer, "list", { linked: true }), /mission of this project/);
	await assert.rejects(
		service.call({ sessionId: "chat-2", projectId: "p2", readOnly: false }, "get", { id: created.entry.id }),
		NotFound,
	);
});

/** Holds or fails MissionStore.durable(), the barrier every knowledge ACK and read waits on. */
function holdDurability(store: MissionStore) {
	let held = true;
	let failure: Error | undefined;
	const waiting: (() => void)[] = [];
	store.durable = () =>
		failure
			? Promise.reject(failure)
			: held
				? new Promise<void>((resolve) => waiting.push(resolve))
				: Promise.resolve();
	return {
		get waiting() {
			return waiting.length;
		},
		release() {
			held = false;
			for (const resolve of waiting.splice(0)) resolve();
		},
		fail(error: Error) {
			failure = error;
		},
	};
}
async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	promise.then(
		() => (done = true),
		() => (done = true),
	);
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	return done;
}

test("tool reads, creates and links reply only after durability, and fail when it fails", async () => {
	const { service, store } = fixture();
	const mission = store.create({ projectId: "p1", title: "Mission" });
	store.join("lead", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	const lead: KnowledgeCaller = { sessionId: "lead", projectId: "p1", readOnly: false };

	const gate = holdDurability(store);
	const create = service.call(lead, "create", { ...component() }, "held-create");
	assert.equal(await settled(create), false, "create ACK waits for durability");
	assert.ok(gate.waiting > 0);
	gate.release();
	const created = (await create) as { entry: { id: string } };
	const id = created.entry.id;

	const reads = holdDurability(store);
	const pending = [
		service.call(lead, "list", {}),
		service.call(lead, "get", { id }),
		service.call(lead, "revisions", { id }),
	];
	for (const read of pending) assert.equal(await settled(read), false, "reads wait for pending commits");
	reads.release();
	const [list, detail] = (await Promise.all(pending)) as [
		{ entries: unknown[] },
		{ missionLink: { linkRevision: number } },
	];
	assert.equal(list.entries.length, 1);
	assert.equal(detail.missionLink.linkRevision, 0);

	const link = holdDurability(store);
	const linking = service.call(lead, "link", { id, expectedLinkRevision: 0 });
	assert.equal(await settled(linking), false, "link ACK waits for durability");
	link.release();
	assert.equal(((await linking) as { linkRevision: number }).linkRevision, 1);

	const broken = holdDurability(store);
	broken.fail(new Error("disk full"));
	await assert.rejects(service.call(lead, "create", { ...investigation("Unsaved") }, "failing-create"), /disk full/);
	await assert.rejects(service.call(lead, "unlink", { id, expectedLinkRevision: 1 }), /disk full/);
	await assert.rejects(service.call(lead, "list", {}), /disk full/);
	await assert.rejects(service.call(lead, "get", { id }), /disk full/);
	await assert.rejects(
		service.write("p1", undefined, { operationId: "http-create", expectedRevision: 0, ...component() }, user),
		/disk full/,
	);
	await assert.rejects(
		service.durableRead(() => service.linkState(mission.id, id)),
		/disk full/,
	);
});
