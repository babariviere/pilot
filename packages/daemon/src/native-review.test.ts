import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { unavailableReviewProducer } from "./mission-review-contract.ts";
import { optionalReviewSeeds } from "./mission-review-seeds.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { NativeReviewReader, NoRetainedBinding } from "./native-review.ts";
import { ProjectStore } from "./projects.ts";
import { type ReviewSnapshot, snapshotManifest } from "./review-snapshot-contract.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

function snapshot(): ReviewSnapshot {
	const repositoryId = "a".repeat(64),
		changeId = "k".repeat(32),
		operationId = "b".repeat(128),
		commitId = "c".repeat(40);
	const binding = {
		version: 1 as const,
		sessionId: "worker",
		missionId: "mission",
		taskIds: ["task"],
		repositoryId,
		repositoryPath: "/host/repository",
		workspace: "pilot-worker-1234567890abcdef",
		path: "/host/workspace",
		startOperation: operationId,
	};
	return {
		snapshotId: "d".repeat(64),
		manifest: {
			version: 1,
			request: {
				requestId: "capture",
				repositoryId,
				changeId,
				operationId,
				base: { changeId: "l".repeat(32), commitId: "e".repeat(40) },
				head: { changeId, commitId },
				scope: { kind: "layer" },
				source: "committed",
			},
			provenance: {
				capturedAt: 1,
				taskAttribution: "unknown",
				ledger: {
					repositoryId,
					changeId,
					discovery: "complete",
					ownership: {
						status: "owned",
						binding,
						creation: { changeId, commitId, operationId, kind: "workspace-created" },
						taskAttribution: "unknown",
					},
					current: { status: "unknown", revisions: [] },
				},
			},
			status: "complete",
			omissions: [],
			before: [],
			after: [],
			changes: [],
			trees: { before: "e".repeat(40), after: "f".repeat(40) },
			diff: { sha256: createHash("sha256").update("").digest("hex"), bytes: 0 },
		},
	};
}
function passiveFixture() {
	const retained = snapshot(),
		row = retained.manifest.provenance.ledger,
		owner = row.ownership;
	assert.equal(owner.status, "owned");
	if (owner.status !== "owned") throw new Error("fixture");
	const b = owner.binding;
	row.current = {
		status: "observed",
		operationId: retained.manifest.request.operationId,
		revisions: [
			{
				changeId: row.changeId,
				commitId: retained.manifest.request.head.commitId,
				parents: [retained.manifest.request.base.commitId],
			},
		],
	};
	const checkpoint = {
		binding: b,
		cursor: retained.manifest.request.operationId,
		coverage: "complete" as "complete" | "unknown",
		problem: null as string | null,
		deliveryEnabled: true,
	};
	const calls: string[] = [];
	const ledger = {
		get: async () => structuredClone(row),
		binding: async () => {
			calls.push("binding");
			return structuredClone(checkpoint);
		},
		head: async () => {
			calls.push("head");
			return retained.manifest.request.operationId;
		},
		list: async (_repositoryId: string, _workspace: string, _after?: string, _limit?: number) => {
			calls.push("list");
			return [structuredClone(row)];
		},
		observe: async () => {
			throw new Error("Read must never observe/enroll/capture");
		},
	};
	const reader = new NativeReviewReader(
		{
			get: async () => structuredClone(retained),
			list: async () => ({ comparisons: [], next: null }),
			diff: async () => new Uint8Array(),
			read: async () => new Uint8Array(),
		},
		ledger,
		async () => structuredClone(b),
	);
	return { reader, ledger, checkpoint, retained, row, calls, b };
}

test("host contribution reads census the exact passive operation, never observe or capture", async () => {
	const f = passiveFixture(),
		result = await f.reader.contributions();
	assert.equal(result.status, "observed");
	assert.equal(result.changes.length, 1);
	assert.equal(result.operationId, f.checkpoint.cursor);
	assert.deepEqual(f.calls, ["binding", "head", "list", "binding", "head"]);
	assert.match(result.reason, /not a dirty\/unmanaged/);
});

test("passive census uses full bounded keyset pagination and underclaims truncated inventories", async (t) => {
	const id = (n: number) => {
		let value = n,
			result = "";
		for (let i = 0; i < 32; i++) {
			result = String.fromCharCode(107 + (value % 16)) + result;
			value = Math.floor(value / 16);
		}
		return result;
	};
	for (const count of [101, 1000])
		await t.test(String(count), async () => {
			const f = passiveFixture(),
				rows = Array.from({ length: count }, (_, i) => ({ ...structuredClone(f.row), changeId: id(i + 1) }));
			let reads = 0;
			f.ledger.list = async (repository, workspace, after = "", limit = 100) => {
				assert.equal(repository, f.b.repositoryId);
				assert.equal(workspace, f.b.workspace);
				assert.equal(limit, 100);
				reads++;
				return rows.filter((r) => r.changeId > after).slice(0, limit);
			};
			const result = await f.reader.contributions();
			assert.equal(result.changes.length, count);
			assert.equal(reads, count === 101 ? 2 : 10);
			assert.equal(result.status, count === 101 ? "observed" : "unknown");
			if (count === 1000) assert.match(result.reason, /pagination limit/);
		});
});

test("unobserved operation intervals and lost ledger observations stay Unknown", async (t) => {
	for (const kind of ["stale", "interval", "problem", "lost", "cursor"])
		await t.test(kind, async () => {
			const f = passiveFixture();
			if (kind === "stale") f.checkpoint.cursor = "c".repeat(128);
			if (kind === "interval") f.checkpoint.coverage = "unknown";
			if (kind === "problem") f.checkpoint.problem = "Unprovable interval";
			if (kind === "lost")
				f.ledger.list = async () => {
					throw new Error("lost reply");
				};
			if (kind === "cursor") f.ledger.list = async () => Array.from({ length: 100 }, () => structuredClone(f.row));
			if (kind === "lost" || kind === "cursor") await assert.rejects(f.reader.contributions());
			else assert.equal((await f.reader.contributions()).status, "unknown");
		});
});

test("census rechecks operation/checkpoint and custody after async reads", async (t) => {
	for (const kind of ["operation", "checkpoint", "custody"])
		await t.test(kind, async () => {
			const f = passiveFixture();
			let reads = 0;
			if (kind === "operation") f.ledger.head = async () => (++reads === 1 ? "b" : "c").repeat(128);
			if (kind === "checkpoint") {
				const original = f.ledger.binding;
				f.ledger.binding = async () => ({ ...(await original()), cursor: (++reads === 1 ? "b" : "c").repeat(128) });
			}
			if (kind === "custody")
				f.ledger.list = async () => {
					f.b.sessionId = "replacement";
					return [structuredClone(f.row)];
				};
			await assert.rejects(f.reader.contributions(), /changed|unavailable/i);
		});
});

test("legacy/direct workers explain missing retained custody without opening a content store", async () => {
	let touched = false;
	const reader = new NativeReviewReader(
		{
			get: async () => {
				touched = true;
				return snapshot();
			},
			list: async () => {
				touched = true;
				return { comparisons: [], next: null };
			},
			read: async () => new Uint8Array(),
			diff: async () => new Uint8Array(),
		},
		{ get: async () => snapshot().manifest.provenance.ledger },
		async () => {
			throw new NoRetainedBinding("Not enrolled");
		},
	);
	const page = await reader.list(0);
	assert.equal(page.comparisons.length, 0);
	assert.ok("unavailable" in page);
	assert.match(page.unavailable, /does not enroll/);
	await assert.rejects(reader.get("d".repeat(64)), NoRetainedBinding);
	assert.equal(touched, false);
});
test("internal retained analysis preserves BOM bytes and rechecks current custody before reads and return", async () => {
	const retained = snapshot();
	const own = retained.manifest.provenance.ledger.ownership;
	assert.equal(own.status, "owned");
	if (own.status !== "owned") return;
	const bytes = Buffer.from('\uFEFFexport function f() { return "😀"; }\r\n');
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	retained.manifest.before = retained.manifest.after = [
		{ path: "a.ts", mode: "100644", gitOid: "a".repeat(40), state: "text", bytes: bytes.length, sha256 },
	];
	let allowed = true,
		revokeRead = false,
		reads = 0;
	const reader = new NativeReviewReader(
		{
			get: async () => retained,
			list: async () => ({ comparisons: [], next: null }),
			identity: async () => "a".repeat(64),
			diff: async () => new Uint8Array(),
			read: async () => {
				reads++;
				if (revokeRead) allowed = false;
				return bytes;
			},
		},
		{ get: async () => retained.manifest.provenance.ledger },
		async () => {
			if (!allowed) throw new Error("Current scope revoked");
			return own.binding;
		},
	);
	assert.deepEqual(
		await reader.readExact(retained.snapshotId, {
			snapshotId: retained.snapshotId,
			side: "before",
			path: "a.ts",
			sha256,
		}),
		bytes,
	);
	const source = await reader.source(retained.snapshotId, {
		snapshotId: retained.snapshotId,
		side: "before",
		path: "a.ts",
		sha256,
	});
	assert.ok(source.startsWith("\uFEFF"));
	assert.equal(createHash("sha256").update(source).digest("hex"), sha256, "native source verifies the blob hash");
	assert.deepEqual(Buffer.from(source), bytes, "BOM, CRLF and non-BMP text remain original");
	const result = await reader.compareCalls(retained.snapshotId);
	assert.equal(result.results[0]!.bodyChanged, false);
	assert.equal(result.results[0]!.before[0]!.declaration.sha256, sha256);
	assert.equal(result.results[0]!.before[0]!.declaration.utf8.start, 10);
	allowed = false;
	const prior = reads;
	await assert.rejects(reader.compareCalls(retained.snapshotId), /Current scope revoked/);
	assert.equal(reads, prior);
	allowed = true;
	revokeRead = true;
	await assert.rejects(reader.compareCalls(retained.snapshotId), /Current scope revoked/);
	assert.equal(reads, prior + 1, "revocation fences the second side");
	allowed = true;
	revokeRead = false;
	own.binding.sessionId = "other-worker";
	await assert.rejects(
		reader.readExact(retained.snapshotId, { snapshotId: "0".repeat(64), side: "before", path: "a.ts", sha256 }),
		/Cross-comparison/,
	);
});

test("required retained manifest fields, custody and reference identities fail closed", () => {
	const valid = snapshot();
	snapshotManifest(valid.manifest);
	for (const mutate of [
		(m: any) => delete m.diff,
		(m: any) => (m.provenance.ledger.ownership.status = "unknown"),
		(m: any) => (m.provenance.ledger.ownership.creation.changeId = "l".repeat(32)),
		(m: any) => (m.provenance.ledger.ownership.binding.repositoryId = "f".repeat(64)),
		(m: any) =>
			(m.before = [
				{
					path: "../private",
					mode: "100644",
					gitOid: "c".repeat(40),
					state: "text",
					sha256: "d".repeat(64),
					bytes: 0,
				},
			]),
		(m: any) => (m.diff.bytes = 8 * 1024 * 1024),
		(m: any) => (m.omissions = ["Missing bytes"]),
		(m: any) =>
			(m.changes = [
				{
					status: "U",
					beforePath: null,
					afterPath: null,
					beforeMode: "000000",
					afterMode: "000000",
					beforeOid: "0".repeat(40),
					afterOid: "0".repeat(40),
				},
			]),
	]) {
		const m = structuredClone(valid.manifest);
		mutate(m);
		assert.throws(() => snapshotManifest(m));
	}
});

test("source never replaces malformed UTF-8 or decodes retained binary content", async () => {
	const retained = snapshot();
	const own = retained.manifest.provenance.ledger.ownership;
	assert.equal(own.status, "owned");
	if (own.status !== "owned") return;
	const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xff]);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const entry = {
		path: "bad.ts",
		mode: "100644",
		gitOid: "a".repeat(40),
		state: "text" as const,
		bytes: bytes.length,
		sha256,
	};
	retained.manifest.after = [entry];
	let reads = 0;
	const reader = new NativeReviewReader(
		{
			get: async () => retained,
			list: async () => ({ comparisons: [], next: null }),
			diff: async () => new Uint8Array(),
			read: async () => {
				reads++;
				return bytes;
			},
		},
		{ get: async () => retained.manifest.provenance.ledger },
		async () => own.binding,
	);
	const ref = { snapshotId: retained.snapshotId, side: "after" as const, path: entry.path, sha256 };
	await assert.rejects(reader.source(retained.snapshotId, ref), /encoded data.*not valid/);
	retained.manifest.after = [{ ...entry, state: "binary" }];
	await assert.rejects(reader.source(retained.snapshotId, ref), /unavailable, binary or unsupported/);
	assert.equal(reads, 1, "binary source is refused before reading bytes");
});

test("cancel during initial retained snapshot or store identity cannot start later byte analysis", async () => {
	for (const stage of ["snapshot", "identity"] as const) {
		const retained = snapshot();
		const own = retained.manifest.provenance.ledger.ownership;
		assert.equal(own.status, "owned");
		if (own.status !== "owned") return;
		const controller = new AbortController();
		let identities = 0;
		const reader = new NativeReviewReader(
			{
				get: async () => {
					if (stage === "snapshot") controller.abort(new Error("Disconnected before analysis"));
					return retained;
				},
				identity: async () => {
					identities++;
					controller.abort(new Error("Disconnected before analysis"));
					return "a".repeat(64);
				},
				list: async () => ({ comparisons: [], next: null }),
				diff: async () => new Uint8Array(),
				read: async () => assert.fail("Cancelled initial reads must not start source analysis"),
			},
			{ get: async () => retained.manifest.provenance.ledger },
			async () => own.binding,
		);
		await assert.rejects(
			reader.compareCalls(retained.snapshotId, {}, controller.signal),
			/Disconnected before analysis/,
		);
		assert.equal(identities, stage === "identity" ? 1 : 0);
	}
});

test("native Review HTTP admits current scope and rejects writes, cross-scope and revoked reads", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "native-review-api-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	const sessions = new SessionManager(home, projects);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, sessions, projects);
	const mission = store.create({ title: "Review", projectId: project.id });
	store.join("worker", mission.id);
	const terminals = new TerminalManager();
	const retained = snapshot();
	const own = retained.manifest.provenance.ledger.ownership;
	assert.equal(own.status, "owned");
	if (own.status !== "owned") return;
	own.binding.missionId = mission.id;
	let reads = 0,
		revoke = false;
	t.mock.method(sessions, "get", (id: string) =>
		id === "worker" ? ({ id, title: "Worker", projectId: project.id } as SessionSummary) : undefined,
	);
	t.mock.method(
		sessions,
		"nativeReviewReader",
		(_id: string, _mission: string, _project: string, authorize: () => void) =>
			new NativeReviewReader(
				{
					get: async () => {
						reads++;
						if (revoke) store.leave("worker");
						return retained;
					},
					list: async () => ({ comparisons: [], next: null }),
					diff: async () => new Uint8Array(),
					read: async () => new Uint8Array(),
				},
				{ get: async () => retained.manifest.provenance.ledger },
				async () => {
					authorize();
					return own.binding;
				},
			),
	);
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
		{ store, service },
	);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(async () => {
		await new Promise<void>((r) => server.close(() => r()));
		await service.notices.stop();
		terminals.shutdown();
		await sessions.shutdown();
		await store.durable();
		store.close();
		rmSync(home, { recursive: true, force: true });
	});
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missions/${mission.id}/review`;
	let response = await fetch(root);
	assert.equal(response.status, 200);
	assert.deepEqual(((await response.json()) as any).workers, [{ id: "worker", title: "Worker" }]);
	assert.equal((await fetch(root, { method: "POST" })).status, 405);
	assert.equal((await fetch(root, { headers: { origin: "https://evil.example" } })).status, 403);
	store.update(mission.id, { status: "archived" });
	assert.equal((await fetch(root)).status, 200, "passive archived browsing does not require active work admission");
	assert.equal((await fetch(`${root}/other/${retained.snapshotId}`)).status, 403);
	assert.equal(reads, 0);
	response = await fetch(`${root}/worker/${retained.snapshotId}`);
	assert.equal(response.status, 200);
	assert.doesNotMatch(await response.text(), /\/host\/|repositoryPath/);
	revoke = true;
	response = await fetch(`${root}/worker/${retained.snapshotId}`);
	assert.equal(response.status, 403);
	assert.doesNotMatch(await response.text(), /snapshotId|\/host\//);
});

test("project/chat Review adapters preserve bodies, narrow current scope and perform no capture or enrollment", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "chat-review-api-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	mkdirSync(join(home, "other"));
	const other = await projects.create({ path: join(home, "other") });
	const sessions = new SessionManager(home, projects);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, sessions, projects);
	const mission = store.create({ title: "Review", projectId: project.id });
	const second = store.create({ title: "Other", projectId: project.id });
	const foreign = store.create({ title: "Foreign", projectId: other.id });
	const chats = new Map<string, SessionSummary>();
	for (const [id, projectId, missionId] of [
		["worker", project.id, mission.id],
		["unbound", project.id, mission.id],
		["standalone", project.id, undefined],
		["lead", project.id, mission.id],
		["second", project.id, second.id],
		["foreign", other.id, foreign.id],
	] as const) {
		chats.set(id, { id, title: id, projectId } as SessionSummary);
		if (missionId) store.join(id, missionId);
	}
	store.update(mission.id, { coordinatorSessionId: "lead" });
	t.mock.method(sessions, "get", (id: string) => chats.get(id));
	t.mock.method(sessions, "list", (query: { projectId: string }) =>
		[...chats.values()].filter((chat) => chat.projectId === query.projectId),
	);
	t.mock.method(sessions, "hasNativeReviewBinding", async (id: string, _m: string, _p: string, auth: () => void) => {
		auth();
		return id !== "unbound" && id !== "standalone";
	});
	const retained = snapshot();
	const ownership = retained.manifest.provenance.ledger.ownership;
	assert.equal(ownership.status, "owned");
	if (ownership.status !== "owned") return;
	ownership.binding.missionId = mission.id;
	const digest = createHash("sha256").update("source").digest("hex");
	const code = "export function a() {} export function b() {} export function c() {}";
	const codeBytes = Buffer.from(code);
	const codeDigest = createHash("sha256").update(codeBytes).digest("hex");
	retained.manifest.after = [
		{ path: "a.txt", mode: "100644", gitOid: "c".repeat(40), state: "text", sha256: digest, bytes: 6 },
		{
			path: "b.ts",
			mode: "100644",
			gitOid: "c".repeat(40),
			state: "text",
			sha256: codeDigest,
			bytes: codeBytes.length,
		},
	];
	let mutate: (() => void) | undefined;
	let mutationStage: "get" | "list" | "diff" | "read" = "get";
	let broken = false;
	let analysisRead: (() => Promise<Uint8Array>) | undefined;
	let analysesSettled = 0;
	let analysisSettled: (() => void) | undefined;
	let analysisCancelled: (() => void) | undefined;
	const invokeMutation = (stage: typeof mutationStage) => {
		if (stage !== mutationStage) return;
		const call = mutate;
		mutate = undefined;
		call?.();
	};
	t.mock.method(
		sessions,
		"nativeReviewReader",
		(id: string, m: string | undefined, p: string, authorize: () => void) => {
			if (m !== undefined) assert.equal(m, mission.id);
			assert.equal(p, project.id);
			const reader = new NativeReviewReader(
				{
					get: async (snapshotId) => {
						invokeMutation("get");
						if (broken || snapshotId !== retained.snapshotId)
							throw new Error("private corrupt manifest /host/path");
						return retained;
					},
					list: async () => {
						invokeMutation("list");
						return { comparisons: [], next: null };
					},
					identity: async () => "a".repeat(64),
					diff: async () => {
						invokeMutation("diff");
						return Buffer.from("patch");
					},
					read: async (_snapshotId, ref) => {
						invokeMutation("read");
						if (ref.path === "b.ts") return analysisRead ? analysisRead() : codeBytes;
						return Buffer.from("source");
					},
				},
				{ get: async () => retained.manifest.provenance.ledger },
				async () => {
					authorize();
					if (id === "unbound" || !m) throw new NoRetainedBinding();
					return structuredClone(ownership.binding);
				},
			);
			const compare = reader.compareCalls.bind(reader);
			reader.compareCalls = (...args) => {
				args[2]?.addEventListener("abort", () => analysisCancelled?.(), { once: true });
				return compare(...args).finally(() => {
					analysesSettled++;
					analysisSettled?.();
				});
			};
			return reader;
		},
	);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
		{ store, service },
	);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(async () => {
		await new Promise<void>((r) => server.close(() => r()));
		await service.notices.stop();
		terminals.shutdown();
		await sessions.shutdown();
		await store.durable();
		store.close();
		rmSync(home, { recursive: true, force: true });
	});
	const forbidden = () => {
		throw new Error("GET attempted a write or workspace initialization");
	};
	t.mock.method(sessions, "spawn", forbidden);
	// biome-ignore lint/complexity/useLiteralKeys: Private test seam.
	t.mock.method(sessions["sharedWorkspaces"], "create", forbidden);
	// biome-ignore lint/complexity/useLiteralKeys: Private test seam.
	t.mock.method(sessions["reviewSnapshots"], "capture", forbidden);
	// biome-ignore lint/complexity/useLiteralKeys: Private test seam.
	t.mock.method(sessions["sharedWorkspaces"].ownership, "register", forbidden);
	t.mock.method(store, "create", forbidden);
	t.mock.method(store, "addTask", forbidden);
	const files = readdirSync(home, { recursive: true });
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const root = `${api}/sessions/worker/review`;
	const projectRoot = `${api}/projects/${project.id}/review`;
	let response = await fetch(projectRoot);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), {
		projectId: project.id,
		chats: [
			{ id: "worker", title: "worker", missionId: mission.id },
			{ id: "second", title: "second", missionId: second.id },
		],
		more: false,
	});
	response = await fetch(`${projectRoot}?missionId=${mission.id}`);
	assert.deepEqual(((await response.json()) as any).chats, [{ id: "worker", title: "worker", missionId: mission.id }]);
	assert.equal((await fetch(`${projectRoot}?missionId=${foreign.id}`)).status, 403);
	assert.equal((await fetch(`${projectRoot}?missionId=`)).status, 403);
	assert.equal((await fetch(projectRoot, { method: "POST" })).status, 405);
	for (const id of ["standalone", "lead", "unbound"]) {
		response = await fetch(`${api}/sessions/${id}/review`);
		assert.equal(response.status, 200);
		const page = (await response.json()) as any;
		assert.deepEqual(page.comparisons, []);
		assert.equal(page.next, null);
		assert.match(page.unavailable, /does not enroll/);
		assert.equal((await fetch(`${api}/sessions/${id}/review/${retained.snapshotId}`)).status, 403);
		assert.equal((await fetch(`${api}/sessions/${id}/review?expectedProjectId=${project.id}`)).status, 200);
		assert.equal((await fetch(`${api}/sessions/${id}/review?expectedProjectId=${other.id}`)).status, 403);
		assert.equal((await fetch(`${api}/sessions/${id}/review?expectedProjectId=`)).status, 403);
	}
	assert.equal((await fetch(`${api}/sessions/missing/review`)).status, 404);
	response = await fetch(`${root}?missionId=${foreign.id}&projectId=${other.id}`);
	assert.deepEqual(await response.json(), { comparisons: [], next: null }, "caller assertions do not select scope");
	for (const cursor of ["-1", "1.5", "NaN", "1000000000000000", ""]) {
		assert.equal((await fetch(`${root}?after=${cursor}`)).status, 403);
		assert.equal((await fetch(`${api}/sessions/standalone/review?after=${cursor}`)).status, 403);
	}
	assert.equal((await fetch(root, { method: "POST" })).status, 405);
	assert.equal((await fetch(root, { headers: { origin: "https://evil.example" } })).status, 403);
	response = await fetch(`${root}/${retained.snapshotId}`);
	assert.equal(response.status, 200);
	assert.equal(((await response.json()) as any).workerId, "worker");
	assert.deepEqual(await (await fetch(`${root}/${retained.snapshotId}/patch`)).json(), {
		snapshotId: retained.snapshotId,
		patch: "patch",
	});
	const source = `${root}/${retained.snapshotId}/source?side=after&path=a.txt&sha256=${digest}`;
	const calls = `${root}/${retained.snapshotId}/call-changes`;
	assert.deepEqual(await (await fetch(source)).json(), { snapshotId: retained.snapshotId, text: "source" });
	await t.test("session-only retained calls preserve pair, coverage and revision-bound pages", async () => {
		const response = await fetch(`${calls}?limit=1&expectedProjectId=${project.id}`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const first = (await response.json()) as any;
		assert.equal(first.mode, "source-inferred-not-runtime");
		assert.equal(first.exhaustive, false);
		assert.deepEqual(first.pair, {
			storeId: "a".repeat(64),
			snapshotId: retained.snapshotId,
			request: retained.manifest.request,
		});
		assert.equal(first.coverage.after.unsupported, 1);
		assert.equal(first.coverage.after.parsed, 1);
		assert.equal(first.page.nextOffset, 1);
		assert.equal(first.results[0].status, "added");
		assert.equal(first.results[0].after[0].declaration.sha256, codeDigest);
		const second = await fetch(`${calls}?limit=1&offset=1&expectedRevision=${first.revision}`);
		assert.equal(second.status, 200);
		const next = (await second.json()) as any;
		assert.equal(next.revision, first.revision);
		assert.deepEqual(next.pair, first.pair);
		assert.notEqual(next.results[0].key, first.results[0].key);
		assert.equal((await fetch(`${calls}?path=b.ts&expectedRevision=${first.revision}`)).status, 403);
		assert.equal((await fetch(`${calls}?offset=3&expectedRevision=${first.revision}`)).status, 403);
		assert.equal((await fetch(`${calls}?offset=4&expectedRevision=${first.revision}`)).status, 403);
		assert.equal((await fetch(calls, { method: "POST" })).status, 405);
		assert.equal(
			(await fetch(`${api}/missions/${mission.id}/review/worker/${retained.snapshotId}/call-changes`)).status,
			403,
		);
		for (const query of [
			"limit=0",
			"limit=51",
			"limit=1.5",
			"limit=",
			"limit=1&limit=2",
			"offset=-1",
			"offset=1001",
			"offset=1",
			"offset=01",
			"expectedRevision=",
			`expectedRevision=${"f".repeat(64)}`,
			"path=../private",
			"path=/absolute",
			"path=b.ts&path=a.txt",
			"root=/host/repository",
			"commit=HEAD",
			"side=after",
			"after=1",
			"projectId=other",
			"missionId=other",
		])
			assert.equal((await fetch(`${calls}?${query}`)).status, 403, query);
		for (const id of ["standalone", "lead", "unbound"])
			assert.equal((await fetch(`${api}/sessions/${id}/review/${retained.snapshotId}/call-changes`)).status, 403);
		retained.manifest.status = "unavailable";
		assert.equal((await fetch(calls)).status, 403);
		retained.manifest.status = "partial";
		const partial = (await (await fetch(calls)).json()) as any;
		assert.equal(partial.partial, true);
		assert.ok(partial.partialReasons.includes("retained-inventory-partial: absence-not-proven"));
		assert.ok(partial.results.every((row: any) => row.status === "unknown"));
		retained.manifest.status = "complete";
		analysisRead = async () => Buffer.from(code.replace("function a", "function z"));
		assert.equal((await fetch(calls)).status, 403, "same-length corrupt bytes are not an empty analysis");
		analysisRead = undefined;
	});
	await t.test("HTTP forwards resource omissions without inventing complete relationship results", async () => {
		const entry = retained.manifest.after[1]!;
		const large = Buffer.from(`function t() {} function f() {${"t();".repeat(1200)}}`);
		retained.manifest.after[1] = {
			...entry,
			bytes: large.length,
			sha256: createHash("sha256").update(large).digest("hex"),
		};
		analysisRead = async () => large;
		try {
			const response = await fetch(calls);
			assert.equal(response.status, 200);
			const result = (await response.json()) as any;
			assert.equal(result.partial, true);
			assert.ok(result.partialReasons.includes("comparison-edge-limit"));
			assert.equal(result.budget.edges, 1000);
			assert.ok(result.results.every((row: any) => row.outgoingRelationshipChanged === null));
			assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48 * 1024);
		} finally {
			retained.manifest.after[1] = entry;
			analysisRead = undefined;
		}
	});
	await t.test(
		"disconnect cancels active/queued analyses and drains entered reads before release",
		{ timeout: 20_000 },
		async () => {
			let release!: () => void, entered!: () => void, cancelled!: () => void, drained!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const reading = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const aborted = new Promise<void>((resolve) => {
				cancelled = resolve;
			});
			const allDrained = new Promise<void>((resolve) => {
				drained = resolve;
			});
			let reads = 0,
				cancellations = 0;
			const baseline = analysesSettled;
			analysisSettled = () => {
				if (analysesSettled === baseline + 11) drained();
			};
			analysisCancelled = () => {
				if (++cancellations === 10) cancelled();
			};
			analysisRead = async () => {
				if (++reads === 2) entered();
				await held;
				return codeBytes;
			};
			const controllers = Array.from({ length: 11 }, () => new AbortController());
			const requests = controllers.map((controller) =>
				fetch(calls, { signal: controller.signal }).catch(() => null),
			);
			try {
				await reading;
				const busy = await Promise.race(requests);
				assert.equal(busy?.status, 403, "two active plus eight queued refuse excess work explicitly");
				assert.match(await busy!.text(), /unavailable/);
				for (const controller of controllers) controller.abort();
				await aborted;
				await new Promise((resolve) => setImmediate(resolve));
				assert.ok(analysesSettled < baseline + 11, "closed sockets do not detach entered reads");
				release();
				await allDrained;
				await Promise.all(requests);
				assert.equal(reads, 2, "cancelled queue entries never start source reads");
			} finally {
				for (const controller of controllers) controller.abort();
				release();
				await Promise.all(requests);
				analysisRead = undefined;
				analysisCancelled = undefined;
				analysisSettled = undefined;
			}
			assert.equal((await fetch(calls)).status, 200, "admission remains usable after all workers/readers drain");
		},
	);
	assert.equal((await fetch(source.replace("side=after", "side=wrong"))).status, 403);
	assert.equal((await fetch(source.replace(digest, "e".repeat(64)))).status, 403);
	assert.equal((await fetch(`${root}/${"e".repeat(64)}`)).status, 403);
	broken = true;
	response = await fetch(`${root}/${retained.snapshotId}`);
	assert.equal(response.status, 403);
	assert.doesNotMatch(await response.text(), /private|\/host\//);
	assert.equal((await fetch(calls)).status, 403);
	broken = false;
	response = await fetch(`${root}/${retained.snapshotId}/records`);
	assert.equal(response.status, 200);
	const records = await response.json();
	const unsupported = t.mock.method(store, "nativeReviewRecords", () => {
		throw new Error("unsupported exact scope");
	});
	assert.equal((await fetch(`${root}/${retained.snapshotId}/records`)).status, 422);
	unsupported.mock.restore();
	assert.deepEqual(await (await fetch(`${root}/${retained.snapshotId}/records`)).json(), records);
	await t.test("expected project fences every chat Review read without selecting its scope", async () => {
		for (const url of [
			root,
			`${root}/${retained.snapshotId}`,
			`${root}/${retained.snapshotId}/patch`,
			source,
			`${root}/${retained.snapshotId}/records`,
			calls,
		]) {
			const expected = new URL(url);
			expected.searchParams.set("expectedProjectId", project.id);
			const legacy = await fetch(url);
			const matching = await fetch(expected);
			assert.equal(matching.status, legacy.status);
			assert.deepEqual(await matching.json(), await legacy.json(), "matching precondition leaves bodies unchanged");
			for (const staleOrInvalid of [other.id, "", " ", "not-a-project", "null", "../project"]) {
				expected.searchParams.set("expectedProjectId", staleOrInvalid);
				assert.equal(
					(await fetch(expected)).status,
					403,
					"stale pane project or invalid precondition refuses every read",
				);
			}
			expected.searchParams.set("expectedProjectId", project.id);
			expected.searchParams.append("expectedProjectId", other.id);
			assert.equal((await fetch(expected)).status, 403, "ambiguous preconditions refuse");
			expected.searchParams.delete("expectedProjectId");
			expected.searchParams.set("expectedProjectId", project.id);
			mutationStage =
				url === root ? "list" : url === source || url === calls ? "read" : url.endsWith("/patch") ? "diff" : "get";
			mutate = () => {
				chats.get("worker")!.projectId = other.id;
			};
			try {
				assert.equal((await fetch(expected)).status, 403, "project changes during I/O refuse the pinned pane");
			} finally {
				chats.get("worker")!.projectId = project.id;
				mutate = undefined;
			}
		}
	});
	for (const url of [
		root,
		`${root}/${retained.snapshotId}`,
		`${root}/${retained.snapshotId}/patch`,
		source,
		`${root}/${retained.snapshotId}/records`,
		calls,
	]) {
		mutationStage =
			url === root ? "list" : url === source || url === calls ? "read" : url.endsWith("/patch") ? "diff" : "get";
		mutate = () => {
			chats.get("worker")!.projectId = other.id;
		};
		assert.equal((await fetch(url)).status, 403, "project changed during I/O");
		chats.get("worker")!.projectId = project.id;
		mutate = () => {
			ownership.binding.workspace = "pilot-changed-1234567890abcdef";
		};
		assert.equal((await fetch(url)).status, 403, "binding changed during I/O");
		ownership.binding.workspace = "pilot-worker-1234567890abcdef";
		mutate = () => store.join("worker", second.id);
		assert.equal((await fetch(url)).status, 403, "membership moved during I/O");
		store.join("worker", mission.id);
	}
	mutationStage = "get";
	mutate = () => store.leave("worker");
	assert.equal((await fetch(`${root}/${retained.snapshotId}`)).status, 403, "removed membership during I/O");
	assert.equal((await fetch(`${root}/${retained.snapshotId}/patch`)).status, 403);
	assert.match(((await (await fetch(root)).json()) as any).unavailable, /Not captured/);
	assert.deepEqual(readdirSync(home, { recursive: true }), files, "GETs do not initialize new disk/workspace stores");
	// Discovery truncates eligible chats, not unrelated or unbound entries.
	for (let i = 0; i < 101; i++) {
		const id = `page-${i}`;
		chats.set(id, { id, title: id, projectId: project.id } as SessionSummary);
		store.join(id, mission.id);
	}
	response = await fetch(projectRoot);
	const page = (await response.json()) as any;
	assert.equal(page.chats.length, 100);
	assert.equal(page.more, true);
	await t.test("project access is rechecked after an asynchronous unbound probe", async (t) => {
		t.mock.method(sessions, "list", () => [chats.get("unbound")!]);
		const getProject = projects.get.bind(projects);
		let revoked = false;
		let probes = 0;
		t.mock.method(projects, "get", (id: string) => (revoked && id === project.id ? undefined : getProject(id)));
		t.mock.method(
			sessions,
			"hasNativeReviewBinding",
			async (_id: string, _m: string, _p: string, authorize: () => void) => {
				authorize();
				await Promise.resolve();
				probes++;
				revoked = true;
				return false;
			},
		);
		const response = await fetch(projectRoot);
		assert.equal(probes, 1, "discovery crossed the asynchronous false-binding probe");
		assert.equal(response.status, 404, "revoked project access must not return a stale successful empty list");
		assert.equal("chats" in ((await response.json()) as object), false);
	});
});

test("standalone Review GETs work without a mission service and create no retained stores", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "standalone-review-api-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	// biome-ignore lint/complexity/useLiteralKeys: Inject host metadata without spawning work.
	sessions["metas"].set("standalone", {
		id: "standalone",
		title: "Standalone",
		projectId: project.id,
		cwd: home,
		createdAt: 1,
		updatedAt: 1,
	});
	// biome-ignore lint/complexity/useLiteralKeys: Legacy projectless chat has no content grant.
	sessions["metas"].set("projectless", {
		id: "projectless",
		title: "Projectless",
		cwd: home,
		createdAt: 1,
		updatedAt: 1,
	});
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(async () => {
		await new Promise<void>((r) => server.close(() => r()));
		terminals.shutdown();
		await sessions.shutdown();
		rmSync(home, { recursive: true, force: true });
	});
	const files = readdirSync(home, { recursive: true });
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const response = await fetch(`${api}/sessions/standalone/review`);
	assert.equal(response.status, 200);
	assert.match(((await response.json()) as any).unavailable, /Not captured/);
	assert.equal((await fetch(`${api}/sessions/standalone/review/${"d".repeat(64)}`)).status, 403);
	assert.equal((await fetch(`${api}/sessions/projectless/review`)).status, 200);
	assert.equal((await fetch(`${api}/sessions/projectless/review/${"d".repeat(64)}`)).status, 403);
	assert.equal((await fetch(`${api}/sessions/projectless/review?expectedProjectId=${project.id}`)).status, 403);
	assert.equal((await fetch(`${api}/sessions/projectless/review?expectedProjectId=`)).status, 403);
	assert.deepEqual(await (await fetch(`${api}/projects/${project.id}/review`)).json(), {
		projectId: project.id,
		chats: [],
		more: false,
	});
	assert.deepEqual(readdirSync(home, { recursive: true }), files);
});

test("exact dimension results remain reported/unavailable, context changes make them outdated", async () => {
	const store = new MissionStore(":memory:");
	try {
		const m = store.create({ title: "Review", projectId: "p", planningVersion: 1 });
		store.join("lead", m.id);
		store.join("worker", m.id);
		store.update(m.id, { coordinatorSessionId: "lead" });
		const task = store.addTask(m.id, {
			title: "Change",
			sessionId: "worker",
			assignment: {
				version: 1,
				expectedRevision: 0,
				intent: "Fix parsing",
				scope: "One file",
				criteria: ["Correct"],
			},
		});
		const snapshotId = "a".repeat(64);
		await store.saveReviewProfile(
			m.id,
			"lead",
			{
				version: 1,
				operationId: "profile",
				profileId: "correctness",
				expectedRevision: 0,
				definition: optionalReviewSeeds().correctness,
			},
			() => {},
		);
		const request = {
			version: 1,
			operationId: "result",
			profileId: "correctness",
			profileRevision: 1,
			expectedResultId: null,
			definitionRevision: store.sharedDefinitionRevision(task.id),
			expectedContextFence: store.reviewContextFence(m.id),
			assignment: task.assignment!,
			intent: "code",
			content: [{ kind: "snapshot", snapshotId }],
			context: [],
			preferences: { unavailable: "Not configured" },
			output: { state: "completed", outcome: "pass", reason: "No issue reported" },
			findings: [],
			resolutions: [],
			limitations: "Not checks or acceptance",
			confidence: "unavailable",
		};
		await store.recordReviewResult(m.id, task.id, "worker", request, {
			authorize: () => {},
			resolve: async (reference) => ({
				reference,
				sourceOwnerSessionId: "worker",
				sha256: snapshotId,
				availability: "retained",
			}),
			observeProducer: async () => unavailableReviewProducer(),
			validateCitations: async () => {},
		});
		let data = store.nativeReviewRecords(m.id, "worker", snapshotId);
		assert.equal(data.assessments.length, 1);
		assert.equal(data.assessments[0]?.applicability, "unavailable");
		assert.equal(data.assessments[0]?.outcome, "pass");
		assert.deepEqual(store.nativeReviewRecords(m.id, "worker", "b".repeat(64)).assessments, []);
		store.addDecision(m.id, "New constraint");
		data = store.nativeReviewRecords(m.id, "worker", snapshotId);
		assert.equal(data.assessments[0]?.applicability, "outdated");
		assert.throws(() => store.nativeReviewRecords(m.id, "other", snapshotId), /custody/);
	} finally {
		await store.durable();
		store.close();
	}
});
