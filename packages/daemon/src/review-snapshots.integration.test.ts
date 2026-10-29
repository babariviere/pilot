import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { type JjWorkerScope, jjRepositoryIdentity } from "./jj-ownership.ts";
import {
	REVIEW_SNAPSHOT_LIMITS,
	type ReviewCaptureRequest,
	type ReviewRevision,
	type ReviewSnapshot,
	type ReviewSourceRef,
} from "./review-snapshot-contract.ts";
import { ReviewSnapshotStore } from "./review-snapshots.ts";
import { fixture, git, jj } from "./testing/shared-workspace.ts";

const scope: JjWorkerScope = {
	version: 1,
	sessionId: "worker-a",
	missionId: "mission-a",
	taskIds: ["task-a", "task-b"],
};
const revision = (cwd: string, rev: string): ReviewRevision => {
	const [changeId, commitId] = jj(
		cwd,
		"--ignore-working-copy",
		"--at-op=@",
		"log",
		"--no-graph",
		"-r",
		rev,
		"-T",
		'change_id ++ "\\t" ++ commit_id',
	).split("\t");
	return { changeId: changeId!, commitId: commitId! };
};
const operation = (cwd: string) =>
	jj(cwd, "--ignore-working-copy", "--at-op=@", "op", "log", "--no-graph", "--limit", "1", "-T", "self.id()");
const ref = (snapshot: ReviewSnapshot, side: "before" | "after", path: string): ReviewSourceRef => {
	const entry = snapshot.manifest[side].find((e) => e.path === path)!;
	assert.ok(entry?.sha256);
	return { snapshotId: snapshot.snapshotId, side, path, sha256: entry.sha256 };
};
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
async function setup() {
	const f = fixture();
	const w = await f.store.create(f.source, f.path(), undefined, undefined, scope);
	const repositoryId = await jjRepositoryIdentity(w.shared!.repository);
	const file = join(realpathSync(f.root), "retained", "reviews.sqlite");
	const store = new ReviewSnapshotStore(file, f.store.ownership);
	let serial = 0;
	const request = async (head = "@-", base = `${head}-`): Promise<ReviewCaptureRequest> => {
		await f.store.observeOwnership(w.path, w.shared!);
		const h = revision(w.path, head);
		return {
			requestId: `capture-${++serial}`,
			repositoryId,
			changeId: h.changeId,
			operationId: operation(w.path),
			base: revision(w.path, base),
			head: h,
			scope: { kind: "layer" },
			source: "committed",
		};
	};
	return {
		f,
		w,
		file,
		store,
		request,
		async close() {
			await store.close();
			await f.store.close();
			f.close();
		},
	};
}

test("lower-layer capture freezes full source and diff, not the live stack tip or dirty edits", async () => {
	const s = await setup();
	try {
		writeFileSync(join(s.w.path, "a.txt"), "lower layer\n");
		jj(s.w.path, "commit", "-m", "lower");
		writeFileSync(join(s.w.path, "a.txt"), "stack tip\n");
		jj(s.w.path, "commit", "-m", "upper");
		writeFileSync(join(s.w.path, "a.txt"), "unsaved\n");
		const request = await s.request("@--");
		const before = operation(s.w.path),
			snapshot = await s.store.capture(request);
		assert.equal(operation(s.w.path), before, "capture never snapshots or rewrites jj");
		assert.equal(snapshot.manifest.status, "complete");
		assert.equal(text(await s.store.read(snapshot.snapshotId, ref(snapshot, "before", "a.txt"))), "base\n");
		assert.equal(text(await s.store.read(snapshot.snapshotId, ref(snapshot, "after", "a.txt"))), "lower layer\n");
		assert.match(text(await s.store.diff(snapshot.snapshotId)), /\+lower layer/);
		assert.doesNotMatch(text(await s.store.diff(snapshot.snapshotId)), /stack tip|unsaved/);
		assert.equal(readFileSync(join(s.w.path, "a.txt"), "utf8"), "unsaved\n");
		assert.equal(snapshot.manifest.provenance.taskAttribution, "unknown");
		assert.equal(snapshot.manifest.provenance.ledger.ownership.status, "owned");
		if (snapshot.manifest.provenance.ledger.ownership.status === "owned") {
			assert.deepEqual(snapshot.manifest.provenance.ledger.ownership.binding.taskIds, scope.taskIds);
			assert.equal(snapshot.manifest.provenance.ledger.ownership.taskAttribution, "unknown");
		}
		assert.deepEqual(
			await s.store.capture({
				...request,
				head: { commitId: request.head.commitId, changeId: request.head.changeId },
			}),
			snapshot,
		);
	} finally {
		await s.close();
	}
});

test("edit/rebase cannot change retained source; reads and exact retries survive source removal and reopen", async () => {
	const s = await setup();
	let reopened: ReviewSnapshotStore | undefined;
	try {
		writeFileSync(join(s.w.path, "a.txt"), "original revision\n");
		jj(s.w.path, "commit", "-m", "original");
		const request = await s.request(),
			snapshot = await s.store.capture(request);
		jj(s.w.path, "edit", request.changeId);
		writeFileSync(join(s.w.path, "a.txt"), "rewritten\n");
		jj(s.w.path, "describe", "-m", "rewritten");
		jj(s.w.path, "rebase", "-r", request.changeId, "-d", "root()");
		assert.notEqual(revision(s.w.path, "@").commitId, request.head.commitId);
		assert.deepEqual(await s.store.capture(request), snapshot);
		await assert.rejects(s.store.capture(await s.request("@")), /Conflicted jj comparison unavailable/);
		await s.store.close();
		await s.f.store.close();
		// Disposable fixtures only. This removes all jj/Git objects and the workspace, not just refs.
		rmSync(s.w.path, { recursive: true, force: true });
		rmSync(s.w.shared!.repository, { recursive: true, force: true });
		reopened = new ReviewSnapshotStore(s.file, {
			get: async () => {
				throw new Error("No live ledger/source reads allowed");
			},
		});
		assert.deepEqual(await reopened.get(snapshot.snapshotId), snapshot);
		assert.deepEqual(await reopened.capture(request), snapshot, "lost ACK retries return exact committed result");
		assert.equal(
			text(await reopened.read(snapshot.snapshotId, ref(snapshot, "after", "a.txt"))),
			"original revision\n",
		);
		assert.match(text(await reopened.diff(snapshot.snapshotId)), /\+original revision/);
		assert.equal(createHash("sha256").update(JSON.stringify(snapshot.manifest)).digest("hex"), snapshot.snapshotId);
	} finally {
		await reopened?.close();
		await s.close();
	}
});

test("renames, executable modes and binary bytes are retained honestly; oversized/symlink content is partial", async () => {
	const s = await setup();
	try {
		renameSync(join(s.w.path, "a.txt"), join(s.w.path, "renamed.txt"));
		chmodSync(join(s.w.path, "renamed.txt"), 0o755);
		const binary = Buffer.from([0, 1, 255, 42]);
		writeFileSync(join(s.w.path, "binary"), binary);
		writeFileSync(join(s.w.path, "large"), Buffer.alloc(REVIEW_SNAPSHOT_LIMITS.blobBytes + 1, 65));
		symlinkSync("/etc/passwd", join(s.w.path, "link"));
		jj(s.w.path, "--config=snapshot.max-new-file-size=4194304", "commit", "-m", "mixed sources");
		const snapshot = await s.store.capture(await s.request());
		assert.equal(snapshot.manifest.status, "partial");
		assert.ok(snapshot.manifest.omissions.length);
		const renamed = snapshot.manifest.changes.find((e) => e.status.startsWith("R"))!;
		assert.equal(renamed.beforePath, "a.txt");
		assert.equal(renamed.afterPath, "renamed.txt");
		assert.equal(renamed.beforeMode, "100644");
		assert.equal(renamed.afterMode, "100755");
		assert.equal(snapshot.manifest.after.find((e) => e.path === "binary")!.state, "binary");
		assert.deepEqual(Buffer.from(await s.store.read(snapshot.snapshotId, ref(snapshot, "after", "binary"))), binary);
		assert.equal(snapshot.manifest.after.find((e) => e.path === "large")!.reason, "blob-limit");
		assert.equal(snapshot.manifest.after.find((e) => e.path === "link")!.reason, "symlink");
		await assert.rejects(
			s.store.read(snapshot.snapshotId, {
				snapshotId: snapshot.snapshotId,
				side: "after",
				path: "link",
				sha256: "a".repeat(64),
			}),
			/unavailable/,
		);
	} finally {
		await s.close();
	}
});

test("explicit ancestor stack retains complete pair context; text selection is not comparison scope", async () => {
	const s = await setup();
	try {
		writeFileSync(join(s.w.path, "a.txt"), "one\ntwo\n");
		jj(s.w.path, "commit", "-m", "lower");
		writeFileSync(join(s.w.path, "a.txt"), "one\nthree\n");
		jj(s.w.path, "commit", "-m", "upper");
		const request = await s.request("@-", "@---");
		request.scope = { kind: "stack" };
		const stack = await s.store.capture(request);
		assert.equal(stack.manifest.status, "complete");
		assert.equal(text(await s.store.read(stack.snapshotId, ref(stack, "before", "a.txt"))), "base\n");
		assert.equal(text(await s.store.read(stack.snapshotId, ref(stack, "after", "a.txt"))), "one\nthree\n");
		await assert.rejects(
			s.store.capture({ ...request, requestId: "wrong-layer", scope: { kind: "layer" } }),
			/exact head parent/,
		);
		await assert.rejects(
			s.store.capture({
				...request,
				requestId: "wrong-line",
				scope: { kind: "lines", ranges: [{ side: "after", path: "a.txt", start: 9, end: 9 }] },
			} as unknown as ReviewCaptureRequest),
			/Invalid review scope/,
		);
	} finally {
		await s.close();
	}
});

test("working-copy request is unavailable without reading HEAD or claiming unsaved edits", async () => {
	const s = await setup();
	try {
		writeFileSync(join(s.w.path, "a.txt"), "recorded\n");
		jj(s.w.path, "commit", "-m", "recorded");
		const request = await s.request();
		request.source = "working-copy";
		writeFileSync(join(s.w.path, "a.txt"), "unsaved\n");
		const before = operation(s.w.path),
			snapshot = await s.store.capture(request);
		assert.equal(snapshot.manifest.status, "unavailable");
		assert.equal(snapshot.manifest.diff, null);
		assert.equal(snapshot.manifest.trees, null);
		assert.deepEqual(snapshot.manifest.after, []);
		assert.match(snapshot.manifest.omissions.join(), /unsaved/);
		assert.equal(operation(s.w.path), before);
	} finally {
		await s.close();
	}
});

test("invalid, cross-source and forged ownership references fail closed; no caller host paths", async () => {
	const s = await setup();
	try {
		writeFileSync(join(s.w.path, "a.txt"), "content\n");
		jj(s.w.path, "commit", "-m", "content");
		const request = await s.request(),
			snapshot = await s.store.capture(request);
		const other = await s.store.capture({ ...request, requestId: "other" });
		await assert.rejects(s.store.read(snapshot.snapshotId, ref(other, "after", "a.txt")), /Cross-source/);
		for (const path of ["../a.txt", "/etc/passwd", "a/../a.txt", ".git/config", "a\\b"]) {
			await assert.rejects(
				s.store.read(snapshot.snapshotId, { ...ref(snapshot, "after", "a.txt"), path }),
				/Unsafe/,
			);
		}
		await assert.rejects(
			s.store.read(snapshot.snapshotId, { ...ref(snapshot, "after", "a.txt"), sha256: "f".repeat(64) }),
			/reference/,
		);
		await assert.rejects(s.store.get("../etc/passwd"), /identifier/);
		await assert.rejects(
			s.store.capture({ ...request, requestId: "host-path", repositoryPath: "/etc" } as ReviewCaptureRequest),
			/fields/,
		);
		await assert.rejects(s.store.capture({ ...request, head: request.base }), /another change/);
		await assert.rejects(
			s.store.capture({
				...request,
				requestId: "wrong-change",
				base: { ...request.base, changeId: request.head.changeId },
			}),
			/revision\/source/,
		);
		await assert.rejects(
			s.store.capture({
				...request,
				requestId: "unknown-owner",
				changeId: request.base.changeId,
				head: request.base,
			}),
			/provenance/,
		);
		await assert.rejects(
			s.store.capture({ ...request, requestId: "wrong-repository", repositoryId: "f".repeat(64) }),
			/provenance/,
		);
		await assert.rejects(s.store.capture({ ...request, source: "working-copy" }), /identity conflict/);
	} finally {
		await s.close();
	}
});

test("interrupted admission is durable, cancellable and retried with original provenance and exact request", async () => {
	const s = await setup();
	let reopened: ReviewSnapshotStore | undefined;
	let worker: Worker | undefined;
	try {
		writeFileSync(join(s.w.path, "a.txt"), "capture me\n");
		jj(s.w.path, "commit", "-m", "capture");
		const request = await s.request(),
			ledger = await s.f.store.ownership.get(request.repositoryId, request.changeId);
		const provenance = { capturedAt: 123, ledger, taskAttribution: "unknown" };
		worker = new Worker(new URL("./review-snapshot-worker.ts", import.meta.url), { workerData: { file: s.file } });
		const result = new Promise<{ error?: string }>((resolve, reject) => {
			worker!.on("error", reject);
			worker!.on("message", (message) => {
				if (message.id === 1) resolve(message);
			});
		});
		// Ordered messages: capture synchronously commits admission before its first async source read.
		worker.postMessage({ id: 1, method: "capture", args: { request, provenance } });
		worker.postMessage({ cancel: 1 });
		assert.match((await result).error!, /cancel/i);
		await worker.terminate();
		worker = undefined;
		reopened = new ReviewSnapshotStore(s.file, {
			get: async () => {
				throw new Error("Do not refresh provenance on retry");
			},
		});
		assert.deepEqual(await reopened.lookup(request), { status: "interrupted" });
		await assert.rejects(reopened.capture({ ...request, operationId: "a".repeat(128) }), /identity conflict/);
		// A later rewrite is not substituted for the pinned revision on retry.
		jj(s.w.path, "edit", request.changeId);
		writeFileSync(join(s.w.path, "a.txt"), "later\n");
		jj(s.w.path, "describe", "-m", "later");
		const snapshot = await reopened.capture(request);
		assert.equal(snapshot.manifest.provenance.capturedAt, 123);
		assert.equal(text(await reopened.read(snapshot.snapshotId, ref(snapshot, "after", "a.txt"))), "capture me\n");
		assert.deepEqual(await reopened.lookup(request), { status: "done", snapshot });
		assert.deepEqual(await reopened.capture(request), snapshot);
	} finally {
		await worker?.terminate();
		await reopened?.close();
		await s.close();
	}
});

test("pre-cancel, bounded admission, close and retained-byte corruption do not acknowledge false success", async () => {
	const s = await setup();
	let reopened: ReviewSnapshotStore | undefined;
	try {
		writeFileSync(join(s.w.path, "a.txt"), "durable\n");
		jj(s.w.path, "commit", "-m", "durable");
		const request = await s.request();
		await assert.rejects(s.store.capture(request, AbortSignal.abort()), /abort/i);
		assert.deepEqual(await s.store.lookup(request), { status: "absent" });
		const pending = s.store.capture(request);
		await assert.rejects(s.store.capture({ ...request, requestId: "concurrent" }), /busy/);
		const snapshot = await pending;
		await s.store.close();
		const db = new DatabaseSync(s.file);
		db.prepare("UPDATE snapshot_bytes SET bytes=? WHERE snapshot_id=? AND sha256=?").run(
			Buffer.from("corrupt"),
			snapshot.snapshotId,
			ref(snapshot, "after", "a.txt").sha256,
		);
		db.close();
		reopened = new ReviewSnapshotStore(s.file, s.f.store.ownership);
		await assert.rejects(reopened.read(snapshot.snapshotId, ref(snapshot, "after", "a.txt")), /corrupt/);
		await assert.rejects(s.store.capture(request), /closed/);
	} finally {
		await reopened?.close();
		await s.close();
	}
});

test("missing object is partial and never falls back to a matching live workspace file", async () => {
	const s = await setup();
	try {
		writeFileSync(join(s.w.path, "a.txt"), "only in captured object\n");
		jj(s.w.path, "commit", "-m", "object");
		const request = await s.request();
		const oid = git(s.w.shared!.repository, "rev-parse", `${request.head.commitId}:a.txt`);
		unlinkSync(join(s.w.shared!.repository, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
		writeFileSync(join(s.w.path, "a.txt"), "live fallback must not be read\n");
		const snapshot = await s.store.capture(request);
		assert.equal(snapshot.manifest.status, "partial");
		const entry = snapshot.manifest.after.find((e) => e.path === "a.txt")!;
		assert.equal(entry.state, "unavailable");
		assert.equal(entry.reason, "object-unavailable");
		assert.equal(entry.sha256, null);
		assert.ok(snapshot.manifest.omissions.length);
		assert.equal(text(await s.store.read(snapshot.snapshotId, ref(snapshot, "before", "a.txt"))), "base\n");
	} finally {
		await s.close();
	}
});

test("wide source capture uses bounded batches and reports truncated tree coverage explicitly", async () => {
	const s = await setup();
	try {
		for (let i = 0; i < REVIEW_SNAPSHOT_LIMITS.paths + 1; i++)
			writeFileSync(join(s.w.path, `file-${String(i).padStart(5, "0")}.txt`), `unique ${i}\n`);
		jj(s.w.path, "commit", "-m", "wide tree");
		const request = await s.request();
		const started = performance.now(),
			snapshot = await s.store.capture(request);
		assert.equal(snapshot.manifest.status, "partial");
		assert.equal(snapshot.manifest.after.length, REVIEW_SNAPSHOT_LIMITS.paths);
		assert.match(snapshot.manifest.omissions.join(), /Tree path limit/);
		assert.ok(performance.now() - started < REVIEW_SNAPSHOT_LIMITS.durationMs);
		assert.equal(
			text(await s.store.read(snapshot.snapshotId, ref(snapshot, "after", "file-00000.txt"))),
			"unique 0\n",
		);
	} finally {
		await s.close();
	}
});

test("repository instance mismatch and unrelated stack base cannot produce a snapshot", async () => {
	const s = await setup();
	let mismatched: ReviewSnapshotStore | undefined;
	try {
		writeFileSync(join(s.w.path, "a.txt"), "first\n");
		jj(s.w.path, "commit", "-m", "first");
		const request = await s.request(),
			ledger = await s.f.store.ownership.get(request.repositoryId, request.changeId);
		assert.equal(ledger.ownership.status, "owned");
		if (ledger.ownership.status !== "owned") assert.fail();
		const foreign = structuredClone(ledger);
		if (foreign.ownership.status !== "owned") assert.fail();
		foreign.ownership.binding.repositoryPath = realpathSync(s.f.source);
		mismatched = new ReviewSnapshotStore(join(realpathSync(s.f.root), "mismatch", "store.sqlite"), {
			get: async () => foreign,
		});
		await assert.rejects(mismatched.capture(request), /repository instance mismatch/);
		jj(s.w.path, "new", "-r", request.base.commitId, "-m", "sibling");
		writeFileSync(join(s.w.path, "b.txt"), "sibling\n");
		jj(s.w.path, "commit", "-m", "sibling");
		const sibling = revision(s.w.path, "@-");
		await assert.rejects(
			s.store.capture({
				...request,
				requestId: "unrelated-base",
				base: sibling,
				operationId: operation(s.w.path),
				scope: { kind: "stack" },
			}),
			/merge-base/,
		);
	} finally {
		await mismatched?.close();
		await s.close();
	}
});

test("a killed capture worker leaves an exact recoverable request, not an acknowledgement", async () => {
	const s = await setup();
	let worker: Worker | undefined, reopened: ReviewSnapshotStore | undefined;
	try {
		writeFileSync(join(s.w.path, "a.txt"), "crash recovery\n");
		jj(s.w.path, "commit", "-m", "crash");
		const request = await s.request(),
			ledger = await s.f.store.ownership.get(request.repositoryId, request.changeId);
		worker = new Worker(new URL("./review-snapshot-worker.ts", import.meta.url), { workerData: { file: s.file } });
		const admitted = new Promise<{ value?: { status: string }; error?: string }>((resolve, reject) => {
			worker!.on("error", reject);
			worker!.on("message", (message) => {
				if (message.id === 2) resolve(message);
			});
		});
		worker.postMessage({
			id: 1,
			method: "capture",
			args: { request, provenance: { capturedAt: 456, ledger, taskAttribution: "unknown" } },
		});
		// The second message runs while source acquisition is awaiting I/O, after durable admission.
		worker.postMessage({ id: 2, method: "lookup", args: { request } });
		assert.deepEqual((await admitted).value, { status: "interrupted" });
		await worker.terminate();
		worker = undefined;
		reopened = new ReviewSnapshotStore(s.file, {
			get: async () => {
				throw new Error("No new provenance");
			},
		});
		const snapshot = await reopened.capture(request);
		assert.equal(snapshot.manifest.provenance.capturedAt, 456);
		assert.equal(text(await reopened.read(snapshot.snapshotId, ref(snapshot, "after", "a.txt"))), "crash recovery\n");
	} finally {
		await worker?.terminate();
		await reopened?.close();
		await s.close();
	}
});

test("total source budget is explicit and retained binary content stays within its bound", async () => {
	const s = await setup();
	try {
		for (let i = 0; i < 18; i++) {
			const bytes = Buffer.alloc(REVIEW_SNAPSHOT_LIMITS.blobBytes);
			bytes[0] = i + 1;
			writeFileSync(join(s.w.path, `binary-${String(i).padStart(2, "0")}`), bytes);
		}
		jj(s.w.path, "--config=snapshot.max-new-file-size=4194304", "commit", "-m", "bounded sources");
		const snapshot = await s.store.capture(await s.request());
		assert.equal(snapshot.manifest.status, "partial");
		assert.ok(snapshot.manifest.after.some((e) => e.reason === "total-limit"));
		const retained = new Map(
			[...snapshot.manifest.before, ...snapshot.manifest.after]
				.filter((e) => e.sha256)
				.map((e) => [e.sha256, e.bytes!]),
		);
		assert.ok([...retained.values()].reduce((a, b) => a + b, 0) <= REVIEW_SNAPSHOT_LIMITS.bytes);
		const entry = snapshot.manifest.after.find((e) => e.path === "binary-00")!;
		assert.equal(entry.state, "binary");
		assert.equal(
			(await s.store.read(snapshot.snapshotId, ref(snapshot, "after", "binary-00"))).length,
			REVIEW_SNAPSHOT_LIMITS.blobBytes,
		);
	} finally {
		await s.close();
	}
});
