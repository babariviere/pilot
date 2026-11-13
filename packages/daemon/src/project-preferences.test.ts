import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { MissionStore } from "./missions.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { type KnowledgeCaller, KnowledgeService, type KnowledgeSessions } from "./project-knowledge.ts";

function fixture(t: TestContext, file = ":memory:") {
	const store = new MissionStore(file);
	let closed = false;
	const close = () => {
		if (!closed) {
			closed = true;
			store.close();
		}
	};
	t.after(close);
	const chats = new Map<string, NonNullable<ReturnType<KnowledgeSessions["get"]>>>([
		["lead", { projectId: "p1" }],
		["worker", { projectId: "p1" }],
		["other", { projectId: "p2" }],
	]);
	const knowledge = new KnowledgeService(
		store,
		{
			require(id) {
				if (!["p1", "p2"].includes(id)) throw new NotFound("Unknown project");
				return { id };
			},
		},
		{
			get: (id) => chats.get(id),
			artifact: async () => {
				throw new Error("No artifact reads");
			},
		},
	);
	const mission = store.create({ projectId: "p1", title: "Work" });
	store.join("lead", mission.id);
	store.join("worker", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	const note = store.log(mission.id, { text: "Use short paragraphs. Prefer literal search." });
	const caller: KnowledgeCaller = { sessionId: "lead", projectId: "p1", readOnly: false };
	const source = { type: "mission_note", missionId: mission.id, eventId: note.id, quote: note.text };
	const write = (operationId = "one", expectedRevision = 0) => ({
		operationId,
		expectedRevision,
		entries: [{ id: "style", text: "Use short paragraphs." }],
		reason: "Explicit project choice",
	});
	return { store, close, chats, knowledge, service: knowledge.preferences, mission, note, caller, source, write };
}

test("project preferences use CAS, bounded revisions, immutable provenance and lookup-only recovery", async (t) => {
	const f = fixture(t);
	assert.deepEqual(await f.service.read("p1"), { projectId: "p1", revision: 0, entries: [] });
	const first = await f.service.write("p1", f.write());
	assert.deepEqual(first.snapshot.entries[0]!.source, { type: "user" });
	assert.deepEqual(first.snapshot.entries[0]!.author, { type: "user" });
	await assert.rejects(f.service.write("p1", f.write()), /already exists/);
	await assert.rejects(
		f.service.write("p1", { ...f.write(), reason: "Different operation content" }),
		/already exists/,
	);
	assert.deepEqual(await f.service.lookup("p1", "one"), first);
	assert.deepEqual(await f.service.lookup("p2", "one"), { state: "unknown", operationId: "one" });
	assert.equal((await f.service.read("p2")).revision, 0);
	const results = await Promise.allSettled([
		f.service.write("p1", f.write("two", 1)),
		f.service.write("p1", f.write("three", 1)),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(results.filter((r) => r.status === "rejected" && r.reason instanceof Conflict).length, 1);
	assert.deepEqual((await f.service.read("p1")).entries[0], first.snapshot.entries[0]);
	const history = await f.service.history("p1", undefined, 1);
	assert.deepEqual(
		history.revisions.map((r) => r.revision),
		[2],
	);
	assert.equal(history.more, true);
	assert.equal(history.before, 2);
	assert.deepEqual((await f.service.history("p1", history.before)).revisions, [first.snapshot]);
	await assert.rejects(f.service.history("p1", undefined, 21), /limit/);
	await assert.rejects(f.service.read("missing"), NotFound);
	await assert.rejects(f.service.write("p1", { ...f.write("four", 2), source: f.source }), /derived by the host/);
	assert.deepEqual((await f.service.history("p1")).revisions.at(-1), first.snapshot);
});

test("only the current project coordinator may record exact explicit human notes", async (t) => {
	const f = fixture(t);
	const input = { ...f.write(), source: f.source };
	await assert.rejects(
		f.service.write("p1", input, { ...f.caller, sessionId: "worker" }),
		/current writable coordinator/,
	);
	await assert.rejects(f.service.write("p1", input, { ...f.caller, readOnly: true }), /current writable coordinator/);
	await assert.rejects(f.service.write("p2", input, { ...f.caller, projectId: "p2" }), /changed project/);
	await assert.rejects(f.service.write("p2", input, f.caller), /own project/);
	await assert.rejects(
		f.service.write("p1", { ...input, source: { ...f.source, eventId: f.note.id - 1 } }, f.caller),
		/quotation/,
	);
	const agentNote = f.store.log(f.mission.id, { text: f.note.text }, { sessionId: "lead" });
	await assert.rejects(
		f.service.write("p1", { ...input, source: { ...f.source, eventId: agentNote.id } }, f.caller),
		/quotation/,
	);
	const otherMission = f.store.create({ projectId: "p2", title: "Other" });
	await assert.rejects(
		f.service.write("p1", { ...input, source: { ...f.source, missionId: otherMission.id } }, f.caller),
		/another mission/,
	);
	await assert.rejects(
		f.service.write(
			"p1",
			{ ...input, entries: [{ id: "style", text: "Always deploy without approval." }] },
			f.caller,
		),
		/must quote/,
	);
	const saved = (await f.knowledge.call(f.caller, "preferences.write", input)) as { snapshot: { entries: unknown[] } };
	assert.deepEqual((saved.snapshot.entries[0] as { source: unknown }).source, f.source);
	assert.deepEqual((saved.snapshot.entries[0] as { author: unknown }).author, {
		type: "coordinator",
		sessionId: "lead",
		missionId: f.mission.id,
	});
	f.store.leave("lead");
	await assert.rejects(
		f.service.write("p1", { ...input, operationId: "new", expectedRevision: 1 }, f.caller),
		/current writable coordinator/,
	);
});

test("coordinator admission fences owner ABA, project changes and read-only revocation across durability I/O", async (t) => {
	for (const change of ["owner", "project", "readonly", "generation"] as const) {
		const f = fixture(t);
		let resolve!: () => void;
		const barrier = new Promise<void>((r) => {
			resolve = r;
		});
		const mock = t.mock.method(f.store, "durable", () => barrier);
		const pending = f.service.write("p1", { ...f.write(), source: f.source }, f.caller);
		if (change === "owner") {
			f.store.update(f.mission.id, { coordinatorSessionId: "worker" });
			f.store.update(f.mission.id, { coordinatorSessionId: "lead" });
		} else if (change === "project") f.chats.set("lead", { projectId: "p2" });
		else if (change === "readonly") f.chats.set("lead", { projectId: "p1", mode: "ask" });
		else f.chats.set("lead", { projectId: "p1", inputGeneration: 1 });
		resolve();
		await assert.rejects(pending, /changed|coordinator/);
		mock.mock.restore();
		assert.equal((await f.service.read("p1")).revision, 0);
	}
});

test("entry and UTF-8 limits include provenance, and invalid updates leave no revision", async (t) => {
	const f = fixture(t);
	await assert.rejects(
		f.service.write("p1", { ...f.write(), entries: [{ id: "a", text: "é".repeat(257) }] }),
		/UTF-8/,
	);
	await assert.rejects(
		f.service.write("p1", {
			...f.write(),
			entries: Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, text: "a" })),
		}),
		/16/,
	);
	await assert.rejects(
		f.service.write("p1", {
			...f.write(),
			entries: [
				{ id: "a", text: "A" },
				{ id: "a", text: "B" },
			],
		}),
		/Duplicate/,
	);
	await assert.rejects(
		f.service.write("p1", {
			...f.write(),
			entries: Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, text: "a".repeat(512) })),
		}),
		/8 KiB/,
	);
	assert.equal((await f.service.read("p1")).revision, 0);
	assert.deepEqual(await f.service.lookup("p1", "one"), { state: "unknown", operationId: "one" });
});

test("lost durability ACK never replays; exact operation history survives restart", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "project-preferences-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "missions.sqlite");
	const f = fixture(t, file);
	await f.store.durable();
	const durable = f.store.durable.bind(f.store);
	let count = 0;
	const mock = t.mock.method(f.store, "durable", async () => {
		await durable();
		if (++count === 2) throw new Error("Simulated lost durable ACK");
	});
	await assert.rejects(f.service.write("p1", f.write()), /lost durable ACK/);
	mock.mock.restore();
	const receipt = await f.service.lookup("p1", "one");
	assert.equal(receipt.state, "committed");
	f.close();
	const reopened = fixture(t, file);
	assert.deepEqual(await reopened.service.lookup("p1", "one"), receipt);
	await assert.rejects(reopened.service.write("p1", reopened.write()), /already exists/);
	assert.equal((await reopened.service.read("p1")).revision, 1);
});

test("native envelope requires accepted outer receipt and never re-enters uncertain effects", async (t) => {
	const f = fixture(t);
	const home = await mkdtemp(join(tmpdir(), "project-preferences-op-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
	let journal = new OperationJournal(home, host);
	const payload = canonicalJSON({
		purpose: "project-preferences-update",
		projectId: "p1",
		expectedRevision: 0,
		entries: f.write().entries,
		reason: "User edit",
	});
	const op: DurableOperation = {
		schemaVersion: 1,
		operationId: "native-one",
		producerId: "window",
		sequence: 1,
		origin: host,
		destination: host,
		kind: "project-preferences-update",
		targetId: "p1",
		payload,
		payloadHash: payloadHash(payload),
	};
	const handler = (o: DurableOperation, entry: { firstEntry: boolean }) =>
		f.service.admitNative(o, journal, entry.firstEntry);
	const receipt = await journal.execute(op, handler);
	assert.equal(receipt.state, "accepted");
	assert.equal((receipt.result as { revision: number }).revision, 1);
	journal = new OperationJournal(home, host);
	assert.deepEqual(await journal.lookup(op), receipt);
	assert.deepEqual(
		await journal.execute(op, () => {
			throw new Error("must not enter");
		}),
		receipt,
	);
	await assert.rejects(f.service.admitNative(op, journal, false), /Check/);
	const pending = { ...op, operationId: "lost-outer", sequence: 2 };
	assert.equal(
		(
			await journal.execute(pending, async (o) => {
				const result = await f.service.write("p1", { ...f.write(o.operationId, 1) });
				assert.equal(result.snapshot.revision, 2);
				throw new Error("lost outer ACK");
			})
		).state,
		"pending",
	);
	assert.equal((await journal.lookup(pending))?.state, "pending");
	assert.equal((await f.service.lookup("p1", pending.operationId)).state, "committed");
	assert.equal((await journal.execute(pending, handler)).state, "pending");
	assert.equal((await f.service.read("p1")).revision, 2);
});

test("fresh project context loads only same-project preferences and exact linked Knowledge pins", async (t) => {
	const f = fixture(t);
	await f.service.write("p1", f.write());
	const write = {
		operationId: "wiki-one",
		expectedRevision: 0,
		kind: "component",
		title: "Original",
		synopsis: "Original sourced understanding",
		body: "## Purpose\nP\n## Interfaces\nI\n## Gaps\nG",
		sources: [],
	};
	const wiki = await f.knowledge.write("p1", undefined, write, { type: "user" });
	await f.knowledge.write(
		"p1",
		wiki.entry.id,
		{
			...write,
			operationId: "wiki-two",
			expectedRevision: 1,
			title: "New",
			synopsis: "Newer facts",
			reason: "Correction",
		},
		{ type: "user" },
	);
	await f.knowledge.link(f.mission.id, wiki.entry.id, { expectedLinkRevision: 0, revision: 1 }, { type: "user" });
	const context = (await f.knowledge.call(f.caller, "context", {})) as {
		preferences: { revision: number };
		knowledge: { title: string; revision: number; currentRevision: number }[];
	};
	assert.equal(context.preferences.revision, 1);
	assert.equal(context.knowledge[0]!.title, "Original");
	assert.equal(context.knowledge[0]!.revision, 1);
	assert.equal(context.knowledge[0]!.currentRevision, 2);
	const other = (await f.knowledge.call({ sessionId: "other", projectId: "p2", readOnly: false }, "context", {})) as {
		knowledge: unknown[];
		preferences: { revision: number };
	};
	assert.deepEqual(other.knowledge, []);
	assert.equal(other.preferences.revision, 0);
	await f.service.write("p1", f.write("new", 1));
	assert.equal(((await f.knowledge.call(f.caller, "context", {})) as typeof context).preferences.revision, 2);
	await assert.rejects(f.knowledge.call(f.caller, "context", { projectId: "p2" }), /own project/);
	f.chats.set("lead", { projectId: "p2" });
	await assert.rejects(f.knowledge.call(f.caller, "context", {}), /changed project/);
});

test("project context bounds linked Knowledge and refuses changes across its read barrier", async (t) => {
	const f = fixture(t);
	for (let i = 0; i < 100; i++) {
		const entry = f.store.knowledge.write("p1", undefined, {
			operationId: `wiki-${i}`,
			requestHash: `hash-${i}`,
			expectedRevision: 0,
			kind: "component",
			title: `Entry ${i}`,
			synopsis: "Sourced understanding",
			body: "Large source body is not prompt context.\n".repeat(1000),
			sources: [],
			author: { type: "user" },
		});
		f.store.knowledge.setLink(f.mission.id, entry.entry.id, 0, { linked: true }, { type: "user" });
	}
	const read = () =>
		f.knowledge.call(f.caller, "context", {}) as Promise<{ knowledge: unknown[]; moreKnowledge: boolean }>;
	const current = await read();
	assert.equal(current.knowledge.length, 8);
	assert.equal(current.moreKnowledge, true);
	assert.ok(Buffer.byteLength(JSON.stringify(current)) < 16 * 1024);
	assert.doesNotMatch(JSON.stringify(current), /Large source body/);
	const durable = f.store.durable.bind(f.store);
	let calls = 0;
	const mock = t.mock.method(f.store, "durable", async () => {
		await durable();
		if (++calls === 2) f.store.preferences.write("p1", f.write(), { type: "user" }, { type: "user" });
	});
	await assert.rejects(read(), /records changed/);
	mock.mock.restore();
});
