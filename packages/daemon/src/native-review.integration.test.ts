import assert from "node:assert/strict";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jjRepositoryIdentity } from "./jj-ownership.ts";
import { NativeReviewReader } from "./native-review.ts";
import type { ReviewCaptureRequest } from "./review-snapshot-contract.ts";
import { ReviewSnapshotStore } from "./review-snapshots.ts";
import { fixture, jj } from "./testing/shared-workspace.ts";

test("native retained reads are exact, scoped, paged, revocable and survive workspace loss", async () => {
	const f = fixture();
	const scope = { version: 1 as const, sessionId: "worker-a", missionId: "mission-a", taskIds: ["task-a"] };
	const w = await f.store.create(f.source, f.path(), undefined, undefined, scope);
	const repositoryId = await jjRepositoryIdentity(w.shared!.repository);
	const binding = await f.store.ownership.sessionBinding(
		scope.sessionId,
		scope.missionId,
		w.shared!.repository,
		w.shared!.name,
	);
	assert.ok(binding);
	const snapshots = new ReviewSnapshotStore(
		join(realpathSync(f.root), "retained", "reviews.sqlite"),
		f.store.ownership,
	);
	let admitted = true;
	const reader = new NativeReviewReader(snapshots, f.store.ownership, async () => {
		if (!admitted) throw new Error("Current membership revoked");
		return binding;
	});
	try {
		assert.deepEqual(await reader.list(0), { comparisons: [], next: null, capture: { pending: 0, failed: 0 } });
		writeFileSync(join(w.path, "a.txt"), "retained lower\n");
		jj(w.path, "commit", "-m", "lower");
		writeFileSync(join(w.path, "a.txt"), "tip\n");
		jj(w.path, "commit", "-m", "upper");
		await f.store.observeOwnership(w.path, w.shared!);
		const rev = (r: string) => {
			const [changeId, commitId] = jj(
				w.path,
				"--ignore-working-copy",
				"--at-op=@",
				"log",
				"--no-graph",
				"-r",
				r,
				"-T",
				'change_id ++ "\\t" ++ commit_id',
			).split("\t");
			return { changeId: changeId!, commitId: commitId! };
		};
		const head = rev("@--"),
			base = rev("@---");
		const request: ReviewCaptureRequest = {
			requestId: "native-1",
			repositoryId,
			changeId: head.changeId,
			operationId: jj(
				w.path,
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
			base,
			head,
			scope: { kind: "layer" },
			source: "committed",
		};
		const retained = await snapshots.capture(request);
		const stack = await snapshots.capture({ ...request, requestId: "native-stack", scope: { kind: "stack" } });
		const page = await reader.list(0);
		assert.equal(page.comparisons.length, 2);
		assert.deepEqual(
			page.comparisons.map((c) => c.request.scope.kind),
			["layer", "stack"],
		);
		assert.deepEqual(
			(await reader.list(page.comparisons[0]!.sequence)).comparisons.map((c) => c.snapshotId),
			[stack.snapshotId],
		);
		const s = await reader.get(retained.snapshotId);
		assert.equal(s.request.head.commitId, head.commitId);
		assert.doesNotMatch(JSON.stringify(s), /repositoryPath|startOperation|"path":"\//);
		assert.match(await reader.diff(s.snapshotId), /retained lower/);
		const e = s.after.find((e) => e.path === "a.txt")!;
		const ref = { snapshotId: s.snapshotId, side: "after" as const, path: e.path, sha256: e.sha256! };
		assert.equal(await reader.source(s.snapshotId, ref), "retained lower\n");
		await assert.rejects(reader.source(s.snapshotId, { ...ref, snapshotId: stack.snapshotId }), /Cross-comparison/);
		await assert.rejects(reader.source(s.snapshotId, { ...ref, path: "../private" }), /Unsafe/);
		await assert.rejects(reader.source(s.snapshotId, { ...ref, sha256: "a".repeat(64) }), /unavailable/);
		const other = new NativeReviewReader(snapshots, f.store.ownership, async () => ({
			...binding,
			missionId: "other",
		}));
		await assert.rejects(other.get(s.snapshotId), /Cross-scope/);
		await assert.rejects(other.list(0), /custody changed/);
		admitted = false;
		await assert.rejects(reader.diff(s.snapshotId), /revoked/);
		admitted = true;
		// Finite in-flight reads must re-admit before disclosing any bytes.
		const revoking = new NativeReviewReader(
			{
				...snapshots,
				get: snapshots.get.bind(snapshots),
				list: snapshots.list.bind(snapshots),
				read: snapshots.read.bind(snapshots),
				diff: async (id: string) => {
					const bytes = await snapshots.diff(id);
					admitted = false;
					return bytes;
				},
			},
			f.store.ownership,
			async () => {
				if (!admitted) throw new Error("revoked");
				return binding;
			},
		);
		await assert.rejects(revoking.diff(s.snapshotId), /revoked/);
		admitted = true;
		rmSync(w.path, { recursive: true, force: true });
		rmSync(w.shared!.repository, { recursive: true, force: true });
		assert.equal(await reader.source(s.snapshotId, ref), "retained lower\n");
		assert.equal(
			(
				await f.store.ownership.sessionBinding(
					scope.sessionId,
					scope.missionId,
					binding.repositoryPath,
					binding.workspace,
				)
			)?.repositoryId,
			repositoryId,
		);
		assert.match(await reader.diff(s.snapshotId), /retained lower/);
	} finally {
		await snapshots.close();
		await f.store.close();
		f.close();
	}
});
