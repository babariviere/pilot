import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CriticalReviewDisk } from "./critical-review-disk.ts";
import { REVIEW_RETENTION } from "./critical-review-retention.ts";
import { CriticalReviewStore } from "./critical-review-store.ts";
import { CriticalReviewVault } from "./critical-review-vault.ts";

async function fixture() {
	const home = await realpath(await mkdtemp(join(tmpdir(), "review-retention-")));
	let now = 100;
	const file = join(home, "db", "records.sqlite");
	let store = new CriticalReviewStore(file, () => now);
	let vault = new CriticalReviewVault(join(home, "vault"), store);
	return {
		home,
		file,
		get store() {
			return store;
		},
		get vault() {
			return vault;
		},
		advance: (ms: number) => {
			now += ms;
		},
		capture: (id: string) =>
			vault.capture({
				id,
				projectId: "project",
				hostId: "host",
				createdAt: now,
				sourceIds: ["source"],
				knownSecrets: [],
				selections: [
					{
						selectionId: "selected",
						sourceId: "source",
						label: "src/code.ts",
						selected: true,
						bytes: Buffer.from("private-copy-marker"),
						category: "source",
					},
				],
			}),
		restart: async () => {
			await store.close();
			store = new CriticalReviewStore(file, () => now);
			vault = new CriticalReviewVault(join(home, "vault"), store);
		},
		close: async () => {
			await store.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}

test("30d raw/90d context, explicit use, pin and active leases survive restart", async () => {
	const f = await fixture();
	try {
		for (const id of ["expires", "pinned", "active", "used"]) await f.capture(id);
		await f.vault.ownerAction("evidence", "pinned", "pin");
		await f.vault.ownerAction("evidence", "active", "activate");
		await f.store.put({
			schemaVersion: 1,
			kind: "context",
			id: "context",
			projectId: "project",
			hostId: "host",
			sourceIds: ["source"],
			createdAt: 100,
			policyVersion: "v1",
			challenge: "balanced",
			sources: [],
			missing: ["private-copy-marker"],
			conflicts: [],
		});
		f.advance(REVIEW_RETENTION.rawMs - 1);
		await f.vault.ownerAction("evidence", "used", "use");
		f.advance(1);
		await f.restart();
		assert.equal(await f.store.get("evidence", "expires"), undefined);
		await f.vault.maintain();
		await assert.rejects(stat(join(f.home, "vault", "expires")), { code: "ENOENT" });
		for (const id of ["pinned", "active", "used"]) assert.ok(await f.store.get("evidence", id));
		assert.ok(await f.store.get("context", "context"));
		await f.vault.ownerAction("evidence", "pinned", "unpin");
		await f.vault.ownerAction("evidence", "active", "release");
		await f.vault.maintain();
		assert.equal(await f.store.get("evidence", "pinned"), undefined);
		f.advance(REVIEW_RETENTION.resultMs - REVIEW_RETENTION.rawMs);
		await f.vault.maintain();
		assert.equal(await f.store.get("context", "context"), undefined);
		await f.vault.maintain();
	} finally {
		await f.close();
	}
});

test("linked erasure removes retained copies, denies resurrection and leaves unavailable IDs", async () => {
	const f = await fixture();
	try {
		const manifest = await f.capture("manifest");
		const entry = manifest.entries[0]!;
		await f.vault.ownerAction("evidence", manifest.id, "pin");
		const context = {
			schemaVersion: 1 as const,
			kind: "context" as const,
			id: "context",
			projectId: "project",
			hostId: "host",
			sourceIds: ["source"],
			createdAt: 100,
			policyVersion: "v1",
			challenge: "balanced" as const,
			sources: [
				{
					citation: { manifestId: manifest.id, blobId: entry.blobId, start: 0, end: 10 },
					basis: "requirement" as const,
				},
			],
			missing: ["private-copy-marker"],
			conflicts: [],
		};
		await f.store.put(context);
		await assert.rejects(f.store.put({ ...context, id: "bad", sourceIds: [] }), /provenance/);
		await f.vault.eraseSource("source");
		await f.vault.eraseSource("source");
		await f.restart();
		assert.equal(await f.store.get("context", "context"), undefined);
		await assert.rejects(f.vault.read(manifest.id, entry.blobId), /unavailable/);
		await assert.rejects(stat(join(f.home, "vault", manifest.id)), { code: "ENOENT" });
		await assert.rejects(f.store.put(context), /erased|unavailable/);
		assert.equal((await readFile(f.file)).includes(Buffer.from("private-copy-marker")), false);
	} finally {
		await f.close();
	}
});

test("quota reservations enforce 1GiB/project and 5GiB/host without eviction", async () => {
	const home = await mkdtemp(join(tmpdir(), "review-quota-"));
	const disk = new CriticalReviewDisk(join(home, "records.sqlite"));
	try {
		for (let i = 0; i < 5; i++) disk.retention.stage(`capture${i}`, `project${i}`, REVIEW_RETENTION.projectBytes);
		assert.throws(() => disk.retention.stage("extra", "project0", 1), /quota/);
		assert.throws(() => disk.retention.stage("hostextra", "project6", 1), /quota/);
		assert.equal(disk.db.prepare("SELECT COUNT(*) AS n FROM review_staging").get()!.n, 5);
	} finally {
		disk.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("crash after tombstone or staging recovers idempotently without re-exposing text", async () => {
	const f = await fixture();
	try {
		await f.capture("manifest");
		await f.store.rpc("eraseSource", { source: "source" });
		await f.store.rpc("vaultStage", { id: "orphan", projectId: "project", bytes: 10 });
		await mkdir(join(f.home, "vault", "orphan.part"));
		await writeFile(join(f.home, "vault", "orphan.part", "partial"), "private");
		await f.restart();
		await f.vault.recover();
		await f.vault.recover();
		assert.equal(await f.store.get("evidence", "manifest"), undefined);
		await assert.rejects(stat(join(f.home, "vault", "orphan.part")), { code: "ENOENT" });
		assert.deepEqual(await f.store.rpc("pendingErasure"), []);
		assert.deepEqual(await f.store.rpc("stagedCaptures"), []);
	} finally {
		await f.close();
	}
});
