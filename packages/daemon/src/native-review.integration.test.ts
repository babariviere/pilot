import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { RetainedCallResult } from "@pilot/kernel/retained-calls";
import { jjRepositoryIdentity } from "./jj-ownership.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { NativeReviewReader } from "./native-review.ts";
import { ProjectStore } from "./projects.ts";
import type { ReviewCaptureRequest } from "./review-snapshot-contract.ts";
import { ReviewSnapshotStore } from "./review-snapshots.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
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

test("production call-changes route reads a real retained pair and original BOM source after workspace loss", async (t) => {
	const f = fixture();
	const home = join(realpathSync(f.root), "home");
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: realpathSync(f.source) });
	const sessions = new SessionManager(home, projects);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, sessions, projects);
	const terminals = new TerminalManager();
	const mission = store.create({ title: "Retained calls", projectId: project.id });
	const sessionId = randomUUID();
	store.join(sessionId, mission.id);
	const scope = { version: 1 as const, sessionId, missionId: mission.id, taskIds: ["task"] };
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
		{ store, service },
	);
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await service.notices.stop();
		terminals.shutdown();
		await sessions.shutdown();
		await store.durable();
		store.close();
		await f.store.close();
		f.close();
	});
	const w = await f.store.create(
		f.source,
		join(home, "sessions", sessionId, "workspace"),
		undefined,
		undefined,
		scope,
	);
	// biome-ignore lint/complexity/useLiteralKeys: Inject only persisted metadata, not a reader or worker.
	sessions["metas"].set(sessionId, {
		id: sessionId,
		title: "Retained calls",
		cwd: w.path,
		projectId: project.id,
		createdAt: 1,
		updatedAt: 1,
		workspace: { source: project.path, base: w.base, jj: true, shared: w.shared! },
	});
	const before = '\uFEFFexport function leaf() { return "é😀"; }\r\nexport function caller() { return leaf(); }';
	const after = before.replace('"é😀"', '"changed😀"');
	writeFileSync(join(w.path, "code.ts"), before);
	jj(w.path, "commit", "-m", "base code");
	writeFileSync(join(w.path, "code.ts"), after);
	jj(w.path, "commit", "-m", "changed code");
	await f.store.observeOwnership(w.path, w.shared!);
	const revision = (rev: string) => {
		const [changeId, commitId] = jj(
			w.path,
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
	const head = revision("@-"),
		base = revision("@--");
	const request: ReviewCaptureRequest = {
		requestId: "http-pair",
		repositoryId: await jjRepositoryIdentity(w.shared!.repository),
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
	// biome-ignore lint/complexity/useLiteralKeys: Fixture capture only. Production GET cannot capture.
	const retained = await sessions["reviewSnapshots"].capture(request);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const root = `${api}/sessions/${sessionId}/review/${retained.snapshotId}`;
	const readCalls = async () => {
		const response = await fetch(`${root}/call-changes?expectedProjectId=${project.id}`);
		assert.equal(response.status, 200);
		return (await response.json()) as RetainedCallResult;
	};
	const first = await readCalls();
	assert.deepEqual(first.pair.request, request);
	assert.equal(first.pair.snapshotId, retained.snapshotId);
	assert.equal(first.results.find((r) => r.before[0]?.name === "leaf")!.bodyChanged, true);
	const caller = first.results.find((r) => r.before[0]?.name === "caller")!;
	assert.equal(caller.bodyChanged, false);
	assert.equal(caller.outgoingRelationshipChanged, false, "changed callee does not modify caller");
	// Rewrite HEAD and live bytes, then delete both original source trees. Reads still use this exact retained pair.
	jj(w.path, "edit", request.changeId);
	writeFileSync(join(w.path, "code.ts"), "function wrongLiveSource() {}\n");
	jj(w.path, "describe", "-m", "rewritten live source");
	rmSync(w.path, { recursive: true, force: true });
	rmSync(w.shared!.repository, { recursive: true, force: true });
	assert.deepEqual(await readCalls(), first);
	for (const side of ["before", "after"] as const) {
		const original = side === "before" ? before : after;
		const entry = retained.manifest[side].find((e) => e.path === "code.ts")!;
		const response = await fetch(
			`${root}/source?side=${side}&path=code.ts&sha256=${entry.sha256}&expectedProjectId=${project.id}`,
		);
		assert.equal(response.status, 200);
		const { text } = (await response.json()) as { text: string };
		assert.equal(text, original);
		assert.equal(createHash("sha256").update(text).digest("hex"), entry.sha256);
		const declaration = first.results.find((r) => r[side][0]?.name === "leaf")![side][0]!.declaration;
		assert.equal(declaration.utf8.start, 10);
		assert.equal(declaration.sha256, entry.sha256);
		assert.equal(
			createHash("sha256")
				.update(Buffer.from(text).subarray(declaration.utf8.start, declaration.utf8.end))
				.digest("hex"),
			declaration.sha256OfSpan,
		);
	}
	assert.equal((await fetch(`${root}/call-changes?expectedProjectId=stale`)).status, 403);
	store.leave(sessionId);
	assert.equal((await fetch(`${root}/call-changes`)).status, 403);
});
