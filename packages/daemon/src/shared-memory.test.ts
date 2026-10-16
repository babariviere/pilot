// biome-ignore-all lint/complexity/useLiteralKeys: Test the existing private worker lifetime without widening the API.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type {
	MemoryEntry,
	MemoryRecall,
	MemoryView,
	SharedMemoryCheckpointManifest,
	SharedMemoryMutation,
} from "@pilot/protocol";
import { MemoryDisk, RECORD_BYTES } from "./memory-disk.ts";
import { ProjectMemoryService } from "./project-memory.ts";
import { digestMemory, MEMORY_PAGE_BYTES } from "./shared-memory-common.ts";

const binding = "a".repeat(64),
	otherBinding = "b".repeat(64);
const host = { hostId: "target", daemonId: "target-daemon", lineageId: "target-lineage" };
function mutation(
	id: string,
	text = `fact ${id}`,
	replaces: SharedMemoryMutation["replaces"] = [],
): SharedMemoryMutation {
	return {
		operationId: `op-${id}`,
		noteId: `note-${id}`,
		payloadHash: createHash("sha256").update(id).digest("hex"),
		origin: { host, sessionId: "chat" },
		text,
		replaces,
	};
}
async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-shared-memory-"));
	const service = new ProjectMemoryService(home);
	t.after(async () => {
		await service.stop();
		await rm(home, { recursive: true, force: true });
	});
	return { home, service };
}
async function checkpoint(service: ProjectMemoryService, key = binding, manifest?: SharedMemoryCheckpointManifest) {
	manifest ??= await service.beginCheckpoint("p");
	let cursor = 0;
	for (;;) {
		const page = await service.checkpointPage("p", manifest.checkpointId, cursor);
		assert.ok(Buffer.byteLength(JSON.stringify(page)) < MEMORY_PAGE_BYTES);
		await service.stageReplica(key, manifest, page);
		if (page.next === undefined) break;
		cursor = page.next;
	}
	await service.activateReplica(key, manifest.checkpointId);
	return manifest;
}

test("shared canonical writes preserve identity/provenance, CAS conflicts and normalized duplicate mappings", async (t) => {
	const { home, service } = await fixture(t);
	const local = await service.note("p", "ordinary local note", "local-chat");
	const first = await service.commitSharedNote("p", mutation("one", "Unicode ＦＡＣＴ"));
	assert.equal(first.state, "committed");
	assert.equal(first.sequence, 2);
	assert.deepEqual(first.entry?.sharedOrigin, { host, sessionId: "chat" });
	assert.equal(local.sharedOrigin, undefined, "legacy/local origin is never invented");
	assert.deepEqual(await service.commitSharedNote("p", mutation("one", "Unicode ＦＡＣＴ")), first);
	assert.equal(
		(await service.commitSharedNote("p", { ...mutation("one"), text: "changed payload" })).state,
		"conflict",
	);
	const duplicate = await service.commitSharedNote("p", mutation("duplicate", "unicode fact"));
	assert.equal(duplicate.state, "already-present");
	assert.equal(duplicate.entry?.id, first.entry!.id);
	const whitespaceDuplicate = await service.commitSharedNote(
		"p",
		mutation("whitespace-duplicate", "  Unicode    ＦＡＣＴ  "),
	);
	assert.equal(whitespaceDuplicate.state, "already-present");
	assert.equal(whitespaceDuplicate.entry?.id, first.entry!.id);
	const fix = await service.commitSharedNote(
		"p",
		mutation("fix", "corrected fact", [{ id: first.entry!.id, expectedReplacementId: null }]),
	);
	assert.equal(fix.state, "committed");
	const stale = await service.commitSharedNote(
		"p",
		mutation("stale", "stale correction", [{ id: first.entry!.id, expectedReplacementId: null }]),
	);
	assert.equal(stale.state, "conflict");
	assert.equal(
		(
			await service.commitSharedNote(
				"p",
				mutation("missing", "unknown correction", [{ id: "missing", expectedReplacementId: null }]),
			)
		).state,
		"conflict",
	);
	const changes = await service.changes("p", 0);
	assert.deepEqual(
		changes.changes.map((c) => [c.sequence, c.entry.id]),
		[
			[1, local.id],
			[2, first.entry!.id],
			[3, fix.entry!.id],
		],
	);
	assert.deepEqual(changes.changes[1]!.entry.sharedOrigin, first.entry!.sharedOrigin);
	assert.equal(changes.changes[1]!.entry.replacedBy, undefined, "feed entry bytes never change after correction");
	assert.equal(
		(await service.wake("p")).nodes.some((n) => n.entry?.id === first.entry!.id),
		false,
	);
	await service.stop();
	const reopened = new ProjectMemoryService(home);
	t.after(() => reopened.stop());
	assert.deepEqual(await reopened.commitSharedNote("p", mutation("one", "Unicode ＦＡＣＴ")), first);
	assert.deepEqual(
		await reopened.commitSharedNote(
			"p",
			mutation("stale", "stale correction", [{ id: first.entry!.id, expectedReplacementId: null }]),
		),
		stale,
	);
	assert.deepEqual(await reopened.changes("p", 0), changes);
});

for (const point of ["prepared", "appended", "finalized"] as const) {
	test(`canonical recovery after ${point} retains one append/note/op ID and final outcome`, async (t) => {
		const { home } = await fixture(t),
			dir = join(home, "direct");
		let failed = false;
		let disk = new MemoryDisk(dir, "device", (at) => {
			if (at === point && !failed) {
				failed = true;
				throw new Error(`crash ${point}`);
			}
		});
		const write = mutation(point);
		assert.throws(() => disk.commitSharedNote(write), /crash/);
		disk.close();
		if (point === "prepared") await appendFile(join(dir, "log"), "torn record");
		disk = new MemoryDisk(dir, "device");
		try {
			const outcome = disk.commitSharedNote(write);
			assert.equal(outcome.state, "committed");
			assert.equal(outcome.entry?.id, write.noteId);
			assert.equal(outcome.sequence, 1);
			assert.equal(disk.count, 1);
			assert.deepEqual(disk.commitSharedNote(write), outcome);
			assert.equal(disk.changes(0).changes.length, 1);
			assert.equal((await stat(join(dir, "log"))).size, RECORD_BYTES);
		} finally {
			disk.close();
		}
	});
}

test("ordinary local note prepared intents recover into the same feed before subsequent writes", async (t) => {
	const { home } = await fixture(t),
		dir = join(home, "local");
	const disk = new MemoryDisk(dir, "device", (point) => {
		if (point === "prepared") throw new Error("crash");
	});
	assert.throws(() => disk.note("local survives", "chat"), /crash/);
	disk.close();
	const reopened = new MemoryDisk(dir, "device");
	t.after(() => reopened.close());
	assert.equal(reopened.count, 1);
	assert.equal(reopened.note("after recovery", "chat").index, 1);
	assert.deepEqual(
		reopened.changes(0).changes.map((c) => c.entry.text),
		["local survives", "after recovery"],
	);
});

test("full checkpoint pages are immutable across concurrent corrections and survive restart", async (t) => {
	const { home, service } = await fixture(t);
	for (let i = 0; i < 160; i++) await service.note("p", `full raw note ${i} ${"é".repeat(95)}`, "chat");
	const manifest = await service.beginCheckpoint("p"),
		before = await service.checkpointPage("p", manifest.checkpointId, 0);
	await service.note("p", "correct oldest after checkpoint", "chat", [0]);
	assert.deepEqual(await service.checkpointPage("p", manifest.checkpointId, 0), before);
	await checkpoint(service, binding, manifest);
	assert.equal((await service.replicaState(binding)).sequence, 160);
	const recall = await service.replicaRead(binding, "recall", { regex: "full raw note 0 ", lines: 4 });
	assert.equal((recall.value as MemoryRecall).entries[0]?.text.startsWith("full raw note 0 "), true);
	assert.equal((recall.value as MemoryRecall).entries[0]?.replacedBy, undefined);
	const zoom = await service.replicaRead(binding, "zoom", { lo: 0, hi: 1 });
	assert.equal((zoom.value as { entry: MemoryEntry }[])[0]?.entry.index, 0);
	const delta = await service.changes("p", manifest.sequence);
	await service.applyReplicaChanges(binding, delta);
	assert.equal(
		(await service.replicaRead(binding, "recall", { regex: "full raw note 0 ", lines: 4 })).value &&
			((await service.replicaRead(binding, "recall", { regex: "full raw note 0 ", lines: 4 })).value as MemoryRecall)
				.entries[0]?.replacedBy,
		160,
	);
	await service.stop();
	const reopened = new ProjectMemoryService(home);
	t.after(() => reopened.stop());
	assert.equal((await reopened.replicaState(binding)).sequence, 161);
	assert.deepEqual(await reopened.checkpointPage("p", manifest.checkpointId, 0), before);
});

test("checkpoint completeness, digests and contiguous delta checks are atomic and fail closed", async (t) => {
	const { service } = await fixture(t);
	await assert.rejects(service.replicaRead(binding, "wake", {}), /incomplete/);
	const base = await service.note("p", "base", "chat");
	await checkpoint(service);
	for (let i = 0; i < 80; i++) await service.note("p", `${i} ${"é".repeat(100)}`, "chat");
	const manifest = await service.beginCheckpoint("p"),
		first = await service.checkpointPage("p", manifest.checkpointId, 0);
	await service.stageReplica(binding, manifest, first);
	await assert.rejects(service.activateReplica(binding, manifest.checkpointId), /Incomplete|digest|gap/);
	assert.equal((await service.replicaState(binding)).sequence, 1);
	assert.deepEqual(
		(await service.replicaRead(binding, "wake", {})).value &&
			((await service.replicaRead(binding, "wake", {})).value as MemoryView).nodes[0]?.entry?.id,
		base.id,
	);
	const corrupt = { ...first, entries: first.entries.map((entry, i) => (i ? entry : { ...entry, text: "tampered" })) };
	await assert.rejects(service.stageReplica(binding, manifest, corrupt), /identity reused/);
	await assert.rejects(
		service.applyReplicaChanges(binding, {
			after: 2,
			head: 3,
			changes: [{ sequence: 3, entry: { ...base, index: 2, id: "third" } }],
		}),
		/cursor gap/,
	);
	await assert.rejects(
		service.applyReplicaChanges(binding, {
			after: 1,
			head: 3,
			changes: [
				{ sequence: 2, entry: { ...base, index: 1, id: "second" } },
				{ sequence: 4, entry: { ...base, index: 3, id: "fourth" } },
			],
		}),
		/sequence gap/,
	);
	assert.equal((await service.replicaState(binding)).sequence, 1);
	await checkpoint(service, binding, manifest);
	assert.equal((await service.replicaState(binding)).sequence, 81);
	const badManifest = { ...manifest, checkpointId: "bad-digest", digest: "0".repeat(64) };
	let cursor = 0;
	for (;;) {
		const page = await service.checkpointPage("p", manifest.checkpointId, cursor);
		await service.stageReplica(binding, badManifest, { ...page, checkpointId: badManifest.checkpointId });
		if (page.next === undefined) break;
		cursor = page.next;
	}
	await assert.rejects(service.activateReplica(binding, badManifest.checkpointId), /digest/);
	assert.equal((await service.replicaState(binding)).sequence, 81);
	assert.equal((await service.changes("p", 1000)).checkpointRequired, true);
});

test("paged changes include ordinary writes, apply idempotently and reject changed replays", async (t) => {
	const { service } = await fixture(t);
	await checkpoint(service);
	for (let i = 0; i < 100; i++) await service.note("p", `delta ${i}`, "chat");
	let cursor = 0;
	const initial = await service.changes("p", 0, 4);
	for (;;) {
		const batch = await service.changes("p", cursor, 4);
		assert.ok(Buffer.byteLength(JSON.stringify(batch)) < MEMORY_PAGE_BYTES);
		await service.applyReplicaChanges(binding, batch);
		await service.applyReplicaChanges(binding, batch);
		if (batch.next === undefined) break;
		cursor = batch.next;
	}
	await service.applyReplicaChanges(binding, initial);
	assert.equal((await service.replicaState(binding)).sequence, 100);
	const changed = structuredClone(initial);
	changed.changes[0]!.entry.text = "changed replay";
	await assert.rejects(service.applyReplicaChanges(binding, changed), /replay differs/);
});

test("binding-local proposals, success overlays and conflicts survive base replacement and restart", async (t) => {
	const { home, service } = await fixture(t);
	await service.note("p", "canonical", "chat");
	await service.note("local-project", "unrelated target local memory", "chat");
	await checkpoint(service);
	await checkpoint(service, otherBinding);
	const pending = mutation("pending"),
		conflict = mutation("conflict");
	await service.queueReplicaProposal(binding, pending);
	await service.queueReplicaProposal(binding, conflict);
	await assert.rejects(service.queueReplicaProposal(binding, { ...pending, text: "different" }), /identity reused/);
	await service.applyProposalOutcome(binding, {
		operationId: conflict.operationId,
		state: "conflict",
		sequence: 1,
		reason: "Target was corrected",
	});
	const outcome = await service.commitSharedNote("p", pending);
	await service.applyProposalOutcome(binding, outcome);
	assert.equal(
		(await service.replicaRead(binding, "wake", {})).proposals.length,
		2,
		"receipt alone cannot hide an entry whose base is absent",
	);
	assert.equal((await service.replicaProposals(binding)).length, 1, "successful receipt retires retransmission");
	await checkpoint(service);
	const read = await service.replicaRead(binding, "wake", {});
	assert.equal(read.proposals.length, 1);
	assert.equal(read.proposals[0]?.state, "conflict");
	assert.equal(read.state.conflictCount, 1);
	assert.equal(read.state.pendingCount, 0);
	assert.equal(read.proposals[0]!.mutation.noteId, conflict.noteId);
	assert.equal("index" in read.proposals[0]!.mutation, false);
	assert.equal((await service.replicaRead(otherBinding, "wake", {})).proposals.length, 0);
	assert.equal((await service.wake("local-project")).nodes[0]?.entry?.text, "unrelated target local memory");
	await service.applyProposalOutcome(binding, outcome);
	await assert.rejects(service.applyProposalOutcome(binding, { ...outcome, sequence: 999 }), /outcome changed/);
	await service.stop();
	const reopened = new ProjectMemoryService(home);
	t.after(() => reopened.stop());
	assert.deepEqual(await reopened.replicaRead(binding, "wake", {}), read);
	assert.deepEqual(await reopened.replicaProposals(binding), [read.proposals[0]]);
	await reopened.queueReplicaProposal(binding, pending);
	assert.equal(
		(await reopened.replicaProposals(binding)).length,
		1,
		"settled operation remains deduplicated after restart",
	);
});

test("duplicate proposal maps to canonical ID and retains conflict receipts across checkpoints", async (t) => {
	const { service } = await fixture(t);
	await service.note("p", "same normalized note", "chat");
	await checkpoint(service);
	const proposal = mutation("duplicate-map", "ＳＡＭＥ normalized NOTE");
	await service.queueReplicaProposal(binding, proposal);
	const outcome = await service.commitSharedNote("p", proposal);
	assert.equal(outcome.state, "already-present");
	assert.notEqual(outcome.entry!.id, proposal.noteId);
	await service.applyProposalOutcome(binding, outcome);
	assert.equal((await service.replicaRead(binding, "wake", {})).proposals.length, 0);
	await checkpoint(service);
	assert.equal((await service.replicaState(binding)).sequence, 1);
});

test("replica regex workers share the bounded recall pool and cannot block canonical writes or replica apply", async (t) => {
	const { service } = await fixture(t);
	await service.note("p", `${"a".repeat(275)}!`, "chat");
	await checkpoint(service);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const blocked = service.replicaRead(binding, "recall", { regex: "(a+)+$" });
	const rejected = assert.rejects(blocked, /5-second limit/);
	await service.note("p", "writes remain responsive", "chat");
	await service.applyReplicaChanges(binding, await service.changes("p", 1));
	await service.queueReplicaProposal(binding, mutation("responsive"));
	assert.equal(service["recalls"].size, 1);
	const blockedTwo = service.recall("p", "(a+)+$");
	const rejectedTwo = assert.rejects(blockedTwo, /5-second limit/);
	await service.load("p");
	assert.equal(service["recalls"].size, 2);
	await assert.rejects(service.replicaRead(binding, "recall", { regex: "." }), /busy/);
	t.mock.timers.tick(5000);
	await rejected;
	await rejectedTwo;
	assert.equal(service["recalls"].size, 0);
	await assert.rejects(service.replicaRead(binding, "recall", { regex: "[" }));
	await assert.rejects(service.replicaState("../escape"), /binding key/);
});

test("checkpoint digest is canonical raw data with qualified provenance and no derived/private extras", () => {
	const entry: MemoryEntry = {
		index: 0,
		id: "note",
		deviceId: "device",
		at: 1,
		sessionId: "chat",
		text: "safe",
		sharedOrigin: { host, sessionId: "chat" },
	};
	assert.equal(digestMemory([entry]), digestMemory([{ ...entry, replacedBy: 1, ...{ diagnostic: "not exported" } }]));
	assert.notEqual(
		digestMemory([entry]),
		digestMemory([{ ...entry, sharedOrigin: { host: { ...host, lineageId: "different" }, sessionId: "chat" } }]),
	);
});

test("hard process death at each journal boundary recovers the same fsynced append and receipt", async (t) => {
	const { home } = await fixture(t);
	for (const point of ["prepared", "appended", "finalized"]) {
		const dir = join(home, point),
			write = mutation(`kill-${point}`);
		const script = `import {MemoryDisk} from ${JSON.stringify(new URL("./memory-disk.ts", import.meta.url).href)};
		const disk = new MemoryDisk(${JSON.stringify(dir)}, "device", point => { if (point === ${JSON.stringify(point)}) process.kill(process.pid, "SIGKILL"); });
		disk.commitSharedNote(${JSON.stringify(write)});`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			timeout: 10_000,
			encoding: "utf8",
		});
		assert.equal(child.signal, "SIGKILL", child.stderr);
		const reopened = new MemoryDisk(dir, "device");
		try {
			const outcome = reopened.commitSharedNote(write);
			assert.equal(outcome.entry!.id, write.noteId);
			assert.equal(outcome.sequence, 1);
			assert.equal(reopened.count, 1);
			assert.deepEqual(reopened.commitSharedNote(write), outcome);
		} finally {
			reopened.close();
		}
	}
});

test("journal reconstructs a repaired finalized file suffix without regenerating IDs or receipts", async (t) => {
	const { home } = await fixture(t),
		dir = join(home, "file-vs-sqlite");
	let disk = new MemoryDisk(dir, "device");
	const outcomes = [
		disk.commitSharedNote(mutation("suffix-a")),
		disk.commitSharedNote(mutation("suffix-b")),
		disk.commitSharedNote(mutation("suffix-c")),
	];
	const changes = disk.changes(0);
	disk.close();
	const log = join(dir, "log"),
		data = await readFile(log);
	await writeFile(log, data.subarray(0, RECORD_BYTES + 11));
	disk = new MemoryDisk(dir, "device");
	try {
		assert.equal(disk.count, 3);
		assert.deepEqual(disk.changes(0), changes);
		for (let i = 0; i < 3; i++) assert.deepEqual(disk.commitSharedNote(mutation(`suffix-${"abc"[i]}`)), outcomes[i]);
		assert.equal((await stat(log)).size, 3 * RECORD_BYTES);
	} finally {
		disk.close();
	}
});

test("new ordinary notes carry configured host provenance without rewriting historical origins", async (t) => {
	const { home, service } = await fixture(t);
	await service.note("p", "historical note", "chat");
	await service.stop();
	const configured = new ProjectMemoryService(home, undefined, 30_000, host);
	t.after(() => configured.stop());
	const next = await configured.note("p", "qualified new ordinary note", "new-chat");
	assert.deepEqual(next.sharedOrigin, { host, sessionId: "new-chat" });
	const changes = await configured.changes("p", 0);
	assert.equal(changes.changes[0]!.entry.sharedOrigin, undefined);
	assert.deepEqual(changes.changes[1]!.entry.sharedOrigin, next.sharedOrigin);
});

test("checkpoint replacement cannot rewrite an already committed prefix even with a matching new digest", async (t) => {
	const { service } = await fixture(t);
	await service.note("p", "immutable", "chat");
	await checkpoint(service);
	const original = (await service.changes("p", 0)).changes[0]!.entry;
	const incoming = [
		{ ...original, text: "rewritten" },
		{ ...original, id: "second", index: 1, text: "second" },
	];
	const manifest = { checkpointId: "rewritten", sequence: 2, count: 2, digest: digestMemory(incoming) };
	await service.stageReplica(binding, manifest, { checkpointId: manifest.checkpointId, cursor: 0, entries: incoming });
	await assert.rejects(service.activateReplica(binding, manifest.checkpointId), /rewrites committed history/);
	assert.equal((await service.replicaState(binding)).sequence, 1);
	assert.equal(((await service.replicaRead(binding, "wake", {})).value as MemoryView).nodes[0]!.text, "immutable");
});

test("invalid canonical mutations get durable rejection without poisoning the append sequence", async (t) => {
	const { service } = await fixture(t);
	const invalid = mutation("invalid-line", "invalid\nline");
	const outcome = await service.commitSharedNote("p", invalid);
	assert.equal(outcome.state, "rejected");
	assert.equal(outcome.sequence, 0);
	assert.deepEqual(await service.commitSharedNote("p", invalid), outcome);
	assert.equal((await service.commitSharedNote("p", mutation("valid-next"))).sequence, 1);
	const rejected = await service.commitSharedNote("p", {
		...mutation("extra-field"),
		...{ credentials: "must not replicate" },
	});
	assert.equal(rejected.state, "rejected");
	await checkpoint(service);
	await assert.rejects(
		service.queueReplicaProposal(binding, { ...mutation("extra-overlay"), ...{ credentials: "must not replicate" } }),
		/Unexpected/,
	);
	assert.equal((await service.replicaProposals(binding)).length, 0);
});

test("proposal overlay quota backpressures safely without dropping pending writes or conflicts", async (t) => {
	const { service } = await fixture(t);
	await checkpoint(service);
	let accepted = 0;
	for (let i = 0; i < 256; i++) {
		try {
			await service.queueReplicaProposal(binding, mutation(`quota-${i}`, `quota ${i} ${"é".repeat(100)}`));
			accepted++;
		} catch (error) {
			assert.match(String(error), /full/);
			break;
		}
	}
	assert.ok(accepted > 0 && accepted < 256);
	assert.equal((await service.replicaState(binding)).pendingCount, accepted);
	await checkpoint(service);
	assert.equal((await service.replicaRead(binding, "wake", {})).proposals.length, accepted);
	assert.equal((await service.note("unrelated", "independent work", "chat")).index, 0);
});

test("replica writer lease excludes a second worker and releases without losing its outbox", async (t) => {
	const { home, service } = await fixture(t);
	await checkpoint(service);
	await service.queueReplicaProposal(binding, mutation("lease"));
	const other = new ProjectMemoryService(home);
	t.after(() => other.stop());
	await assert.rejects(other.queueReplicaProposal(binding, mutation("second-writer")), /locked/);
	await service.stop();
	assert.equal((await other.replicaState(binding)).pendingCount, 1);
	await other.queueReplicaProposal(binding, mutation("second-writer"));
	assert.equal((await other.replicaState(binding)).pendingCount, 2);
});

test("bounded replica handle eviction preserves staged pages and the proposal overlay", async (t) => {
	const { service } = await fixture(t);
	await checkpoint(service);
	await service.queueReplicaProposal(binding, mutation("evicted"));
	const manifest = await service.beginCheckpoint("p"),
		page = await service.checkpointPage("p", manifest.checkpointId, 0);
	await service.stageReplica(binding, manifest, page);
	for (let i = 0; i < 17; i++) await service.replicaState(i.toString(16).padStart(64, "0"));
	await service.activateReplica(binding, manifest.checkpointId);
	assert.equal((await service.replicaRead(binding, "wake", {})).proposals[0]?.mutation.noteId, "note-evicted");
});

test("credential-like context is rejected before shared admission or export, never silently omitted", async (t) => {
	const { service } = await fixture(t);
	const secret = "api_key=syntheticFixtureSecretOnly123456";
	await service.note("p", secret, "chat"); // Independent local memory is not silently modified.
	await assert.rejects(service.beginCheckpoint("p"), /export blocked/);
	await assert.rejects(service.changes("p", 0), /export blocked/);
	assert.equal((await service.wake("p")).nodes[0]?.text, secret);
	const outcome = await service.commitSharedNote("q", mutation("secret-proposal", secret));
	assert.equal(outcome.state, "rejected");
	assert.equal(outcome.sequence, 0);
	const manifest = await service.beginCheckpoint("q");
	await service.stageReplica(binding, manifest, await service.checkpointPage("q", manifest.checkpointId, 0));
	await service.activateReplica(binding, manifest.checkpointId);
	await assert.rejects(service.queueReplicaProposal(binding, mutation("secret-overlay", secret)), /export blocked/);
});

test("overlay revisions distinguish equal-count contents and survive checkpoints, retries and restart", async (t) => {
	const { home, service } = await fixture(t);
	await checkpoint(service);
	assert.equal((await service.replicaState(binding)).overlayRevision, 0);
	const conflict = mutation("revision-conflict"),
		rejected = mutation("revision-rejected");
	await service.queueReplicaProposal(binding, conflict);
	assert.equal((await service.replicaState(binding)).overlayRevision, 1);
	await service.queueReplicaProposal(binding, conflict);
	await assert.rejects(
		service.queueReplicaProposal(binding, { ...conflict, text: "changed operation" }),
		/identity reused/,
	);
	assert.equal((await service.replicaState(binding)).overlayRevision, 1);
	await service.queueReplicaProposal(binding, rejected);
	const conflictOutcome = {
		operationId: conflict.operationId,
		state: "conflict" as const,
		sequence: 0,
		reason: "Concurrent correction",
	};
	await service.applyProposalOutcome(binding, conflictOutcome);
	await service.applyProposalOutcome(binding, conflictOutcome);
	assert.equal((await service.replicaState(binding)).overlayRevision, 3);
	await service.applyProposalOutcome(binding, {
		operationId: rejected.operationId,
		state: "rejected",
		sequence: 0,
		reason: "Scope changed",
	});
	assert.equal((await service.replicaState(binding)).overlayRevision, 4);
	await checkpoint(service);
	assert.equal(
		(await service.replicaState(binding)).overlayRevision,
		4,
		"replacing only the base cannot reset overlay identity",
	);
	const committed = mutation("revision-committed");
	await service.queueReplicaProposal(binding, committed);
	const outcome = await service.commitSharedNote("p", committed);
	await service.applyProposalOutcome(binding, outcome);
	await service.applyProposalOutcome(binding, outcome);
	assert.equal((await service.replicaState(binding)).overlayRevision, 6);
	assert.equal(
		(await service.replicaRead(binding, "wake", {})).proposals.length,
		3,
		"receipt keeps its overlay until the base arrives",
	);
	await checkpoint(service);
	const before = await service.replicaState(binding);
	assert.equal(
		before.overlayRevision,
		7,
		"canonical installation advances revision when the settled overlay disappears",
	);
	assert.equal(before.pendingCount, 0);
	assert.equal(before.conflictCount, 2);
	const duplicate = mutation("revision-duplicate", committed.text);
	await service.queueReplicaProposal(binding, duplicate);
	const mapping = await service.commitSharedNote("p", duplicate);
	assert.equal(mapping.state, "already-present");
	await service.applyProposalOutcome(binding, mapping);
	const after = await service.replicaState(binding);
	assert.equal(after.sequence, before.sequence);
	assert.equal(after.pendingCount, before.pendingCount);
	assert.equal(after.conflictCount, before.conflictCount);
	assert.equal(after.overlayRevision, 10, "identical vector/counts cannot reuse an old overlay notice identity");
	await service.queueReplicaProposal(binding, duplicate);
	await service.applyProposalOutcome(binding, mapping);
	await checkpoint(service);
	assert.deepEqual(
		await service.replicaState(binding),
		after,
		"identical queue/outcome/checkpoint retries are revision-stable",
	);
	await checkpoint(service, otherBinding);
	assert.equal((await service.replicaState(otherBinding)).overlayRevision, 0, "revision is binding-local");
	assert.equal((await service.replicaRead(binding, "recall", { regex: "." })).state.overlayRevision, 10);
	await service.stop();
	const reopened = new ProjectMemoryService(home);
	t.after(() => reopened.stop());
	assert.deepEqual(await reopened.replicaState(binding), after);
	assert.equal((await reopened.replicaRead(binding, "wake", {})).state.overlayRevision, 10);
	await reopened.applyProposalOutcome(binding, mapping);
	assert.deepEqual(await reopened.replicaState(binding), after);
});

test("delta-driven overlay settlement advances revision once and a changed receipt rolls back atomically", async (t) => {
	const { service } = await fixture(t);
	await checkpoint(service);
	const proposal = mutation("delta-revision");
	await service.queueReplicaProposal(binding, proposal);
	const outcome = await service.commitSharedNote("p", proposal);
	await service.applyProposalOutcome(binding, outcome);
	assert.equal((await service.replicaState(binding)).overlayRevision, 2);
	const changes = await service.changes("p", 0);
	assert.equal((await service.applyReplicaChanges(binding, changes)).overlayRevision, 3);
	await service.applyReplicaChanges(binding, changes);
	const before = await service.replicaState(binding);
	await assert.rejects(
		service.applyProposalOutcome(binding, { ...outcome, reason: "changed immutable receipt" }),
		/outcome changed/,
	);
	assert.deepEqual(await service.replicaState(binding), before);
	await service.note("p", "A base-only change does not alter the overlay revision", "chat");
	assert.equal((await service.applyReplicaChanges(binding, await service.changes("p", 1))).overlayRevision, 3);
	assert.equal((await service.replicaRead(binding, "zoom", { lo: 0, hi: 1 })).state.overlayRevision, 3);
});

test("existing replica schema gains a persisted overlay revision without discarding pending context", async (t) => {
	const { home, service } = await fixture(t),
		root = join(home, "memory", "shared-replicas");
	await mkdir(root, { recursive: true });
	const db = new DatabaseSync(join(root, `${binding}.sqlite`)),
		existing = mutation("legacy-overlay");
	try {
		db.exec(
			"CREATE TABLE meta (id INTEGER PRIMARY KEY, sequence INTEGER NOT NULL, complete INTEGER NOT NULL, manifest TEXT); INSERT INTO meta VALUES (1,0,1,NULL); CREATE TABLE proposals (operation TEXT PRIMARY KEY, mutation TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, outcome TEXT)",
		);
		db.prepare("INSERT INTO proposals VALUES (?, ?, 'pending', NULL, NULL)").run(
			existing.operationId,
			JSON.stringify(existing),
		);
	} finally {
		db.close();
	}
	const initial = await service.replicaState(binding);
	assert.equal(initial.overlayRevision, 0);
	assert.equal(initial.pendingCount, 1);
	await service.queueReplicaProposal(binding, mutation("after-migration"));
	assert.equal((await service.replicaState(binding)).overlayRevision, 1);
	assert.deepEqual((await service.replicaProposals(binding))[0]?.mutation, existing);
});

test("revision exhaustion rolls back both proposal insertion and outcome mutation", async (t) => {
	const { home, service } = await fixture(t);
	await checkpoint(service);
	const proposal = mutation("revision-cap");
	await service.queueReplicaProposal(binding, proposal);
	const db = new DatabaseSync(join(home, "memory", "shared-replicas", `${binding}.sqlite`));
	try {
		db.prepare("UPDATE meta SET overlayRevision=? WHERE id=1").run(Number.MAX_SAFE_INTEGER);
	} finally {
		db.close();
	}
	const before = await service.replicaState(binding);
	await assert.rejects(service.queueReplicaProposal(binding, mutation("revision-overflow")), /revision exhausted/);
	await assert.rejects(
		service.applyProposalOutcome(binding, { operationId: proposal.operationId, state: "conflict", sequence: 0 }),
		/revision exhausted/,
	);
	assert.deepEqual(await service.replicaState(binding), before);
	assert.equal((await service.replicaProposals(binding))[0]?.state, "pending");
});
