// biome-ignore-all lint/complexity/useLiteralKeys: Synthetic private session admission seams.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonHello, SessionPathCandidates } from "@pilot/protocol";
import { ModelCatalog } from "./models.ts";
import { completionPrefix, PathCompletionReader } from "./path-completion.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("path candidates are bounded literal direct children, never links or expanded roots", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-path-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "README 🦀.md"), "x");
	await mkdir(join(root, "Sources"));
	await writeFile(join(root, ".hidden"), "x");
	await symlink(tmpdir(), join(root, "link"));
	const reader = new PathCompletionReader();
	await assert.rejects(reader.read("", "R"), "empty cwd must not fall back to filesystem root");
	await assert.rejects(reader.read("relative", "R"), "relative cwd must not use daemon working directory");
	assert.deepEqual(await reader.read(root, "R"), {
		entries: [{ path: "README 🦀.md", directory: false }],
		truncated: false,
	});
	assert.deepEqual((await reader.read(root, "Sou")).entries, [{ path: "Sources", directory: true }]);
	assert.deepEqual((await reader.read(root, ".h")).entries, [{ path: ".hidden", directory: false }]);
	assert.deepEqual((await reader.read(root, "link")).entries, []);
	await assert.rejects(reader.read(root, "link/x"));
	await assert.rejects(reader.read(join(root, "link"), "x"), "a symlink cwd is not an alternate completion root");
	for (const p of [
		"",
		"../x",
		"/tmp/x",
		"~/x",
		"a/../x",
		"a//x",
		"a/./x",
		"a\\b",
		"a\0b",
		"https://x",
		"x".repeat(1025),
	])
		assert.throws(() => completionPrefix(p));
	for (let i = 0; i < 20; i++) await writeFile(join(root, `many-${i}`), "x");
	const limited = await reader.read(root, "many-");
	assert.equal(limited.entries.length, 8);
	assert.equal(limited.truncated, true);
});

test("path candidate scan and concurrent admission stay bounded without pagination", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-path-bounds-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (let i = 0; i < 520; i += 8) {
		await Promise.all(Array.from({ length: 8 }, (_, n) => writeFile(join(root, `entry-${i + n}`), "")));
	}
	const reader = new PathCompletionReader();
	const first = reader.read(root, "missing");
	const second = reader.read(root, "missing");
	await assert.rejects(reader.read(root, "missing"), /busy/u);
	for (const result of await Promise.all([first, second])) {
		assert.deepEqual(result.entries, []);
		assert.equal(result.truncated, true);
	}
	assert.equal((await reader.read(root, "entry-")).entries.length, 8, "capacity releases after completion");
});

test("path candidate GET pins daemon/cwd and repeats passive admission without starting workers", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-path-route-"));
	const projects = new ProjectStore(root);
	const sessions = new SessionManager(root, projects);
	const meta = { id: "source", title: "Synthetic", cwd: root, createdAt: 1, updatedAt: 1 };
	sessions["metas"].set(meta.id, meta);
	let starts = 0;
	const worker = {
		ready: Promise.resolve(),
		state: "idle" as const,
		send: () => {
			starts++;
		},
		request: async () => {
			starts++;
		},
		close: async () => {},
	};
	sessions["workers"].set(meta.id, worker);
	await writeFile(join(root, "README"), "x");
	const terminals = new TerminalManager();
	const hello: DaemonHello = {
		daemonId: "daemon",
		lineageId: "lineage",
		daemonVersion: "1",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin",
		arch: "arm64",
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: true,
			independentExecution: true,
		},
	};
	const server = createDaemonServer(
		{ home: root, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(root),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		hello,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((r) => server.close(() => r()));
		await sessions.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const query = new URLSearchParams({ daemonId: "daemon", lineageId: "lineage", cwd: root, prefix: "R" });
	const url = `${base}/api/sessions/source/path-candidates?${query}`;
	assert.equal(
		((await (await fetch(`${base}/api/hello`)).json()) as DaemonHello).capabilities.sessionPathCandidates,
		1,
	);
	const ok = await fetch(url);
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get("cache-control"), "no-store");
	const result = (await ok.json()) as SessionPathCandidates;
	assert.equal(result.cwd, root);
	assert.equal(result.sessionId, meta.id);
	assert.equal(result.prefix, "R");
	assert.equal(result.daemonId, "daemon");
	assert.deepEqual(result.entries, [{ path: "README", directory: false }]);
	assert.equal((await fetch(url.replace("daemonId=daemon", "daemonId=other"))).status, 409);
	assert.equal(
		(
			await fetch(
				`${base}/api/sessions/source/path-candidates?${new URLSearchParams({ ...Object.fromEntries(query), cwd: "/other" })}`,
			)
		).status,
		409,
	);
	for (const patch of [
		{ mode: "ask" },
		{ workspaceRecovery: true },
		{ preparing: true },
		{ coordinatorView: true },
		{ archivedAt: 1 },
		{ failure: { message: "failed" } },
		{ continuedTo: "other" },
	]) {
		Object.assign(meta, patch);
		assert.notEqual((await fetch(url)).status, 200);
		for (const key of Object.keys(patch)) delete (meta as Record<string, unknown>)[key];
	}
	sessions["workers"].delete(meta.id);
	assert.equal((await fetch(url)).status, 409, "parked session never reopens for candidates");
	assert.equal(starts, 0);
	// A successful read cannot publish if admission changed while enumeration awaited.
	sessions["workers"].set(meta.id, worker);
	const original = PathCompletionReader.prototype.read;
	t.mock.method(
		PathCompletionReader.prototype,
		"read",
		async function (this: PathCompletionReader, cwd: string, prefix: string) {
			const result = await original.call(this, cwd, prefix);
			sessions["workers"].delete(meta.id);
			return result;
		},
	);
	assert.equal((await fetch(url)).status, 409);
	assert.equal(starts, 0);
});
