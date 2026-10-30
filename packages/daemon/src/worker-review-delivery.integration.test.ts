import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { JjOwnershipStore } from "./jj-ownership.ts";
import { ReviewSnapshotStore } from "./review-snapshots.ts";
import { retainedReviewFixture } from "./testing/retained-review.ts";
import { jj } from "./testing/shared-workspace.ts";
import { WorkerReviewDelivery } from "./worker-review-delivery.ts";

test("lifecycle checkpoint captures real committed layers, not live edits; duplicate and newer events preserve exact reads", async () => {
	const f = await retainedReviewFixture();
	try {
		await f.run();
		assert.equal((await f.reader.list(0)).comparisons.length, 0);
		f.commit("retained lower\n");
		writeFileSync(join(f.w.path, "a.txt"), "UNSAVED MUST NOT BE READ\n");
		const operation = jj(
			f.w.path,
			"--ignore-working-copy",
			"--at-op=@",
			"op",
			"log",
			"--no-graph",
			"--limit",
			"1",
			"-T",
			"self.id()",
		);
		await Promise.all([f.run(), f.run()]);
		assert.equal(
			jj(
				f.w.path,
				"--ignore-working-copy",
				"--at-op=@",
				"op",
				"log",
				"--no-graph",
				"--limit",
				"1",
				"-T",
				"self.id()",
			),
			operation,
		);
		const first = (await f.reader.list(0)).comparisons;
		assert.equal(first.length, 1);
		const selected = first[0]!;
		assert.equal(selected.request.operationId, operation);
		const snapshot = await f.reader.get(selected.snapshotId);
		assert.match(await f.reader.diff(selected.snapshotId), /retained lower/);
		assert.doesNotMatch(await f.reader.diff(selected.snapshotId), /UNSAVED/);
		const entry = snapshot.after.find((e) => e.path === "a.txt")!;
		assert.equal(
			await f.reader.source(selected.snapshotId, {
				snapshotId: selected.snapshotId,
				side: "after",
				path: entry.path,
				sha256: entry.sha256!,
			}),
			"retained lower\n",
		);
		assert.equal((await f.snapshots.get(selected.snapshotId)).manifest.provenance.taskAttribution, "unknown");
		f.commit("newer revision\n");
		await f.run();
		await f.run();
		assert.equal((await f.reader.list(0)).comparisons.length, 2);
		assert.deepEqual(await f.reader.get(selected.snapshotId), snapshot);
		assert.deepEqual(await f.store.ownership.deliveryStatus(f.binding), { pending: 0, failed: 0 });
		f.revoke();
		await assert.rejects(f.reader.get(selected.snapshotId), /revoked/);
		await assert.rejects(f.run(), /revoked/);
	} finally {
		await f.dispose();
	}
});

test("outbox survives crash before capture and lost result ACK; newer revisions cannot replace the pinned request", async () => {
	const f = await retainedReviewFixture();
	try {
		f.commit("original checkpoint\n");
		await f.observe(); // Crash window: request durable, capture not started.
		const [original] = await f.store.ownership.deliveries(f.binding);
		assert.ok(original);
		const ledger = new JjOwnershipStore(join(f.root, "home", "jj-ownership.sqlite"));
		const snapshots = new ReviewSnapshotStore(join(realpathSync(f.root), "recovered", "reviews.sqlite"), ledger);
		let lost = true;
		const writer = new WorkerReviewDelivery(ledger, {
			capture: async (request) => {
				const saved = await snapshots.capture(request);
				if (lost) {
					lost = false;
					throw new Error("Simulated lost result ACK");
				}
				return saved;
			},
		});
		try {
			await writer.checkpoint(f.binding.sessionId, f.admit, async () => {});
			assert.deepEqual(await ledger.deliveryStatus(f.binding), { pending: 0, failed: 1 });
			const recovered = await snapshots.lookup(original);
			assert.equal(recovered.status, "done");
			f.commit("later checkpoint\n");
			await f.observe();
			await writer.checkpoint(f.binding.sessionId, f.admit, async () => {});
			assert.deepEqual(await snapshots.lookup(original), recovered);
			assert.deepEqual(await ledger.deliveryStatus(f.binding), { pending: 0, failed: 0 });
			assert.equal((await snapshots.list(f.binding)).comparisons.length, 2);
			await assert.rejects(
				snapshots.capture({ ...original, head: { ...original.head, commitId: "f".repeat(40) } }),
				/identity conflict/,
			);
		} finally {
			await writer.close();
			await snapshots.close();
			await ledger.close();
		}
	} finally {
		await f.dispose();
	}
});

test("capture failure remains retryable; wrong-worker custody and revocation refuse capture", async () => {
	const f = await retainedReviewFixture();
	try {
		f.commit("retry exact revision\n");
		await f.observe();
		let calls = 0;
		const failed = new WorkerReviewDelivery(f.store.ownership, {
			capture: async () => {
				calls++;
				throw new Error("quota reached");
			},
		});
		await failed.checkpoint(f.binding.sessionId, f.admit, async () => {});
		await failed.close();
		assert.equal(calls, 1);
		assert.deepEqual(await f.store.ownership.deliveryStatus(f.binding), { pending: 0, failed: 1 });
		await assert.rejects(f.store.ownership.deliveries({ ...f.binding, sessionId: "wrong-worker" }), /custody/);
		await assert.rejects(f.store.ownership.deliveries({ ...f.binding, repositoryId: "f".repeat(64) }), /custody/);
		const revoked = new WorkerReviewDelivery(f.store.ownership, {
			capture: async (request) => {
				calls++;
				return f.snapshots.capture(request);
			},
		});
		let admits = 0;
		await assert.rejects(
			revoked.checkpoint(
				f.binding.sessionId,
				async () => {
					if (++admits > 1) throw new Error("revoked");
					return f.binding;
				},
				async () => {},
			),
			/revoked/,
		);
		await revoked.close();
		assert.equal(calls, 1);
		await f.run();
		assert.equal((await f.reader.list(0)).comparisons.length, 1);
	} finally {
		await f.dispose();
	}
});

test("existing custody bindings are never silently enabled by observation or duplicate registration", async () => {
	const f = await retainedReviewFixture();
	try {
		const db = new DatabaseSync(join(f.root, "home", "jj-ownership.sqlite"));
		db.prepare("DELETE FROM delivery_workers WHERE repository=? AND workspace=?").run(
			f.binding.repositoryId,
			f.binding.workspace,
		);
		db.close();
		f.commit("legacy enrolled but not capture-enabled\n");
		await f.run();
		assert.deepEqual(await f.store.ownership.deliveries(f.binding), []);
		assert.deepEqual(await f.store.ownership.deliveryStatus(f.binding), {
			pending: 0,
			failed: 0,
			unavailable: "not-enabled",
		});
		const change = (await f.store.ownership.list(f.binding.repositoryId, f.binding.workspace))[0]!;
		assert.equal(change.ownership.status, "owned");
		if (change.ownership.status === "owned") {
			// Replaying register is recovery, not enrollment/activation of an old workspace.
			const initial = (await f.store.ownership.list(f.binding.repositoryId, f.binding.workspace)).find(
				(c) => c.ownership.status === "owned" && c.ownership.creation.kind === "workspace-created",
			)!;
			assert.equal(initial.ownership.status, "owned");
			if (initial.ownership.status === "owned")
				await f.store.ownership.register(f.binding, initial.ownership.creation);
		}
		assert.equal((await f.reader.list(0)).comparisons.length, 0);
		assert.equal((await f.store.ownership.deliveryStatus(f.binding)).unavailable, "not-enabled");
	} finally {
		await f.dispose();
	}
});

test("a newer lifecycle event during capture is coalesced without losing its revision", async () => {
	const f = await retainedReviewFixture();
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const capturing = new Promise<void>((r) => {
		entered = r;
	});
	let held = false;
	const writer = new WorkerReviewDelivery(f.store.ownership, {
		capture: async (request) => {
			if (!held) {
				held = true;
				entered();
				await gate;
			}
			return f.snapshots.capture(request);
		},
	});
	try {
		f.commit("first exact revision\n");
		const first = writer.checkpoint(f.binding.sessionId, f.admit, f.observe);
		await capturing;
		f.commit("new revision while capture waits\n");
		const second = writer.checkpoint(f.binding.sessionId, f.admit, f.observe);
		release();
		await Promise.all([first, second]);
		const page = await f.reader.list(0);
		assert.equal(page.comparisons.length, 2);
		assert.match(await f.reader.diff(page.comparisons[0]!.snapshotId), /first exact revision/);
		assert.doesNotMatch(await f.reader.diff(page.comparisons[0]!.snapshotId), /while capture waits/);
	} finally {
		release();
		await writer.close();
		await f.dispose();
	}
});

test("bounded failure retries do not starve a newer pending checkpoint", async () => {
	const f = await retainedReviewFixture();
	const attempted: string[] = [];
	const writer = new WorkerReviewDelivery(f.store.ownership, {
		capture: async (request) => {
			attempted.push(request.requestId);
			throw new Error("storage unavailable");
		},
	});
	try {
		for (let n = 0; n < 5; n++) f.commit(`closed revision ${n}\n`);
		await writer.checkpoint(f.binding.sessionId, f.admit, f.observe);
		assert.equal(attempted.length, 4);
		assert.deepEqual(await f.store.ownership.deliveryStatus(f.binding), { pending: 1, failed: 4 });
		const first = new Set(attempted);
		await writer.checkpoint(f.binding.sessionId, f.admit, f.observe);
		assert.equal(attempted.length, 8);
		assert.ok(attempted.slice(4).some((id) => !first.has(id)));
	} finally {
		await writer.close();
		await f.dispose();
	}
});

test("revocation during capture blocks every subsequent admission and retained reads", async () => {
	const f = await retainedReviewFixture();
	let captures = 0;
	const writer = new WorkerReviewDelivery(f.store.ownership, {
		capture: async (request) => {
			captures++;
			const saved = await f.snapshots.capture(request);
			f.revoke(); // Already admitted immutable work may finish; no new admission may start.
			return saved;
		},
	});
	try {
		f.commit("before revocation\n");
		f.commit("must not be newly captured\n");
		await writer.checkpoint(f.binding.sessionId, f.admit, f.observe);
		assert.equal(captures, 1);
		const retained = await f.snapshots.list(f.binding);
		assert.equal(retained.comparisons.length, 1);
		await assert.rejects(f.reader.get(retained.comparisons[0]!.snapshotId), /revoked/);
		await assert.rejects(writer.checkpoint(f.binding.sessionId, f.admit, f.observe), /revoked/);
		assert.equal(captures, 1);
		assert.deepEqual(await f.store.ownership.deliveryStatus(f.binding), { pending: 0, failed: 2 });
	} finally {
		await writer.close();
		await f.dispose();
	}
});

test("queue insertion failure rolls back the ownership observation and cursor together", async () => {
	const f = await retainedReviewFixture();
	try {
		f.commit("atomic checkpoint\n");
		await f.observe();
		const [request] = await f.store.ownership.deliveries(f.binding);
		assert.ok(request);
		const before = await f.store.ownership.binding(f.binding.repositoryId, f.binding.workspace);
		const change = await f.store.ownership.get(request.repositoryId, request.changeId);
		const operationId = "f".repeat(128);
		await assert.rejects(
			f.store.ownership["rpc"]("apply", {
				repositoryId: request.repositoryId,
				workspace: f.binding.workspace,
				expectedCursor: before!.cursor,
				operationId,
				creations: [],
				changes: [{ changeId: change.changeId, revisions: change.current.revisions }],
				problem: null,
				coverage: "complete",
				checkpoints: [
					{ ...request, requestId: "atomic-first", operationId },
					{
						...request,
						requestId: "atomic-invalid",
						operationId,
						head: { ...request.head, commitId: "e".repeat(40) },
					},
				],
			}),
			/Unobserved delivery revision/,
		);
		assert.deepEqual(await f.store.ownership.binding(f.binding.repositoryId, f.binding.workspace), before);
		assert.deepEqual(await f.store.ownership.get(request.repositoryId, request.changeId), change);
		assert.deepEqual(await f.store.ownership.deliveries(f.binding), [request]);
	} finally {
		await f.dispose();
	}
});

test("real conflicted and multi-parent revisions explain unsupported capture without choosing replacement content", async () => {
	const f = await retainedReviewFixture();
	try {
		f.commit("left branch\n");
		const left = jj(
			f.w.path,
			"--ignore-working-copy",
			"--at-op=@",
			"log",
			"--no-graph",
			"-r",
			"@-",
			"-T",
			"commit_id",
		);
		const base = jj(
			f.w.path,
			"--ignore-working-copy",
			"--at-op=@",
			"log",
			"--no-graph",
			"-r",
			"@--",
			"-T",
			"commit_id",
		);
		jj(f.w.path, "new", "-r", base, "-m", "right branch");
		f.commit("right branch\n");
		const right = jj(
			f.w.path,
			"--ignore-working-copy",
			"--at-op=@",
			"log",
			"--no-graph",
			"-r",
			"@-",
			"-T",
			"commit_id",
		);
		jj(f.w.path, "new", left, right);
		await f.observe();
		assert.ok((await f.store.ownership.deliveryStatus(f.binding)).unsupported?.includes("multiple-parents"));
		jj(f.w.path, "new");
		jj(f.w.path, "rebase", "-r", left, "-d", right);
		await f.run();
		const status = await f.store.ownership.deliveryStatus(f.binding);
		assert.ok(status.unsupported?.includes("conflicted"));
		assert.ok(status.failed > 0);
		assert.ok(
			(await f.reader.list(0)).comparisons.every(
				(c) => c.request.source === "committed" && c.request.scope.kind === "layer",
			),
		);
	} finally {
		await f.dispose();
	}
});
