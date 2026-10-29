import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type JjWorkerScope, jjRepositoryIdentity } from "./jj-ownership.ts";
import { MissionStore } from "./missions.ts";
import { SharedWorkspaceStore } from "./shared-workspaces.ts";
import { fixture, jj } from "./testing/shared-workspace.ts";
import { type Runner, run } from "./workspaces.ts";

const scope: JjWorkerScope = { version: 1, sessionId: "worker-a", missionId: "mission-a", taskIds: ["task-a"] };
const change = (cwd: string, rev = "@") =>
	jj(cwd, "--at-op=@", "--ignore-working-copy", "log", "--no-graph", "-r", rev, "-T", "change_id");
const commit = (cwd: string, rev = "@") =>
	jj(cwd, "--at-op=@", "--ignore-working-copy", "log", "--no-graph", "-r", rev, "-T", "commit_id");
const head = (cwd: string) =>
	jj(cwd, "--at-op=@", "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "self.id()");

test("new opt-in workspace records exact scope, discovers multiple stacked changes and survives reopen", async () => {
	const f = fixture();
	let reopened: SharedWorkspaceStore | undefined;
	try {
		const w = await f.store.create(f.source, f.path(), undefined, undefined, scope);
		const repositoryId = await jjRepositoryIdentity(w.shared!.repository);
		const first = change(w.path);
		writeFileSync(join(w.path, "a.txt"), "worker edit\n");
		jj(w.path, "commit", "-m", "first");
		const second = change(w.path);
		jj(w.path, "new", "-m", "second");
		const third = change(w.path);
		const before = head(w.path);
		await f.store.observeOwnership(w.path, w.shared!);
		assert.equal(head(w.path), before, "observation does not create jj operations");
		const records = await f.store.ownership.list(repositoryId, w.shared!.name);
		assert.deepEqual(new Set(records.map((record) => record.changeId)), new Set([first, second, third]));
		for (const record of records) {
			assert.equal(record.ownership.status, "owned");
			if (record.ownership.status !== "owned") assert.fail();
			assert.equal(record.ownership.binding.sessionId, scope.sessionId);
			assert.equal(record.ownership.binding.missionId, scope.missionId);
			assert.deepEqual(record.ownership.binding.taskIds, ["task-a"]);
			assert.equal(record.ownership.taskAttribution, "unknown");
			assert.equal(record.current.status, "observed");
			assert.equal(record.current.operationId, before);
		}
		await f.store.close();
		reopened = new SharedWorkspaceStore(join(f.root, "home"));
		assert.deepEqual(await reopened.ownership.list(repositoryId, w.shared!.name), records);
		jj(w.path, "new", "-m", "after reopen");
		await reopened.observeOwnership(w.path, w.shared!);
		assert.equal((await reopened.ownership.list(repositoryId, w.shared!.name)).length, 4);
		// Dirty files are not snapshotted merely to observe the ledger.
		writeFileSync(join(w.path, "dirty.txt"), "not yet snapshotted\n");
		const dirtyHead = head(w.path);
		const dirtyCommit = commit(w.path);
		await reopened.observeOwnership(w.path, w.shared!);
		assert.equal(head(w.path), dirtyHead);
		assert.equal(commit(w.path), dirtyCommit);
	} finally {
		await reopened?.close();
		await f.store.close();
		f.close();
	}
});

test("borrowed edits and rewritten revisions never transfer creator ownership", async () => {
	const f = fixture();
	try {
		const a = await f.store.create(f.source, f.path("a"), undefined, undefined, scope);
		const b = await f.store.create(f.source, f.path("b"), undefined, undefined, {
			...scope,
			sessionId: "worker-b",
			taskIds: ["task-b", "task-c"],
		});
		const repositoryId = await jjRepositoryIdentity(a.shared!.repository);
		const original = change(a.path);
		const originalCommit = commit(a.path);
		jj(b.path, "edit", original);
		jj(b.path, "describe", "-m", "borrowed rewrite");
		await f.store.observeOwnership(b.path, b.shared!);
		await f.store.observeOwnership(a.path, a.shared!);
		const record = await f.store.ownership.get(repositoryId, original);
		assert.equal(record.ownership.status, "owned");
		if (record.ownership.status !== "owned") assert.fail();
		assert.equal(record.ownership.binding.sessionId, "worker-a");
		assert.equal(record.ownership.creation.commitId, originalCommit);
		assert.notEqual(record.current.revisions[0]!.commitId, originalCommit);
		assert.equal(
			(await f.store.ownership.list(repositoryId, b.shared!.name)).some((item) => item.changeId === original),
			false,
		);
		const bRecords = await f.store.ownership.list(repositoryId, b.shared!.name);
		assert.equal(bRecords[0]!.ownership.status, "owned");
		if (bRecords[0]!.ownership.status === "owned")
			assert.equal(
				bRecords[0]!.ownership.taskAttribution,
				"unknown",
				"assignments are scope, not exact task attribution",
			);
		const base = change(a.path, a.base);
		assert.deepEqual((await f.store.ownership.get(repositoryId, base)).ownership, {
			status: "unknown",
			reason: "unproven",
		});
		jj(a.path, "rebase", "-r", original, "-d", "root()");
		await f.store.observeOwnership(a.path, a.shared!);
		const rebased = await f.store.ownership.get(repositoryId, original);
		assert.equal(rebased.ownership.status, "owned");
		assert.notEqual(rebased.current.revisions[0]!.commitId, record.current.revisions[0]!.commitId);
	} finally {
		await f.store.close();
		f.close();
	}
});

test("new on an abandoned borrowed commit never claims resurrected ancestry", async () => {
	const f = fixture();
	try {
		const legacy = await f.store.create(f.source, f.path("legacy"));
		writeFileSync(join(legacy.path, "a.txt"), "borrowed\n");
		jj(legacy.path, "commit", "-m", "unowned change");
		const borrowed = change(legacy.path, "@-");
		const borrowedCommit = commit(legacy.path, "@-");
		jj(legacy.path, "abandon", borrowed);
		const w = await f.store.create(f.source, f.path(), undefined, undefined, scope);
		jj(w.path, "new", "-r", borrowedCommit, "-m", "own child of borrowed history");
		await f.store.observeOwnership(w.path, w.shared!);
		const repositoryId = await jjRepositoryIdentity(w.shared!.repository);
		assert.deepEqual((await f.store.ownership.get(repositoryId, borrowed)).ownership, {
			status: "unknown",
			reason: "unproven",
		});
		assert.equal((await f.store.ownership.list(repositoryId, w.shared!.name)).length, 2);
	} finally {
		await f.store.close();
		f.close();
	}
});

test("split, squash and abandon preserve identities without transferring or erasing attribution", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path(), undefined, undefined, scope);
		const repositoryId = await jjRepositoryIdentity(w.shared!.repository);
		const original = change(w.path);
		writeFileSync(join(w.path, "a.txt"), "changed\n");
		writeFileSync(join(w.path, "b.txt"), "split\n");
		jj(w.path, "split", "-m", "split part", "b.txt");
		await f.store.observeOwnership(w.path, w.shared!);
		const splitRecords = await f.store.ownership.list(repositoryId, w.shared!.name);
		assert.equal(splitRecords.length, 2);
		assert.ok(splitRecords.every((record) => record.ownership.status === "owned"));
		const removed = change(w.path);
		jj(w.path, "squash", "-m", "combined");
		await f.store.observeOwnership(w.path, w.shared!);
		const squashed = await f.store.ownership.get(repositoryId, removed);
		assert.equal(squashed.ownership.status, "owned");
		assert.equal(squashed.current.status, "absent");
		assert.equal((await f.store.ownership.list(repositoryId, w.shared!.name)).length, 3);
		jj(w.path, "abandon", original);
		await f.store.observeOwnership(w.path, w.shared!);
		const abandoned = await f.store.ownership.get(repositoryId, original);
		assert.equal(abandoned.ownership.status, "owned");
		assert.equal(abandoned.current.status, "absent");
	} finally {
		await f.store.close();
		f.close();
	}
});

test("divergent change revisions remain explicit and operation divergence never mutates history", async () => {
	const f = fixture();
	try {
		const w = await f.store.create(f.source, f.path(), undefined, undefined, scope);
		const repositoryId = await jjRepositoryIdentity(w.shared!.repository);
		const id = change(w.path);
		const prior = head(w.path);
		jj(w.path, "describe", "-m", "left");
		jj(w.path, `--at-op=${prior}`, "describe", "-m", "right");
		const headsDirectory = join(w.shared!.repository, ".jj/repo/op_heads");
		const headsBefore = readdirSync(headsDirectory).sort();
		await assert.rejects(f.store.observeOwnership(w.path, w.shared!), /operation|Operation|concurrent/i);
		// Read-only observation didn't merge the two operation heads.
		assert.deepEqual(readdirSync(headsDirectory).sort(), headsBefore);
		assert.equal((await f.store.ownership.get(repositoryId, id)).current.status, "unknown");
		// Only the fixture explicitly reconciles. The skipped interval remains Unknown.
		jj(w.path, "status");
		await f.store.observeOwnership(w.path, w.shared!);
		const reconciled = await f.store.ownership.get(repositoryId, id);
		assert.equal(reconciled.ownership.status, "owned");
		assert.equal(reconciled.discovery, "unknown");
		assert.equal(reconciled.current.status, "divergent");
		jj(w.path, "new", "-r", "root()", "-m", "after ambiguity");
		const afterGap = change(w.path);
		await f.store.observeOwnership(w.path, w.shared!);
		assert.equal((await f.store.ownership.get(repositoryId, afterGap)).ownership.status, "owned");
		assert.equal((await f.store.ownership.get(repositoryId, afterGap)).discovery, "unknown");
	} finally {
		await f.store.close();
		f.close();
	}
});

test("paged operation discovery exceeds the old memory window and malformed scans cannot partially claim", async () => {
	let enabled = false;
	let malformed = false;
	let baseline = "";
	let workspace = "";
	let initial = "";
	let initialCommit = "";
	let pages = 0;
	const operation = (n: number) => n.toString(16).padStart(128, "0");
	const discovered = "x".repeat(32);
	const newCommit = "d".repeat(40);
	const runner: Runner = async (file, args, cwd, ...rest) => {
		if (!enabled || file !== "jj") return run(file, args, cwd, ...rest);
		assert.ok(args.includes("--ignore-working-copy"));
		assert.ok(args.some((arg) => arg.startsWith("--at-op=")));
		if (args.includes("workspace")) return `${workspace}\t${cwd}`;
		const at = args.find((arg) => arg.startsWith("--at-op="))!.slice(8);
		if (args.includes("op") && args.includes("log")) {
			if (args.includes("self.id()")) return operation(2300);
			pages++;
			const newest = Number.parseInt(at, 16);
			const rows: string[] = [];
			for (let n = newest; n > Math.max(0, newest - 128); n--)
				rows.push(
					[
						operation(n),
						n === 1 ? baseline : operation(n - 1),
						JSON.stringify(`${workspace}@`),
						JSON.stringify(n === 1 ? "new empty commit" : "snapshot working copy"),
					].join("\t"),
				);
			return rows.join("\n");
		}
		if (args.includes("op") && args.includes("show"))
			return malformed
				? "Changed commits:\n+ x shortened"
				: `Changed commits:\n+ ${discovered} ${newCommit}\n\nChanged working copy ${workspace}@:\n+ ${discovered} ${newCommit}`;
		if (args.includes("log"))
			return `${initial}\t${initialCommit}\t${"a".repeat(40)}\n${discovered}\t${newCommit}\t${initialCommit}`;
		throw new Error("Unexpected observer command");
	};
	const f = fixture(runner);
	try {
		const w = await f.store.create(f.source, f.path(), undefined, undefined, scope);
		const repositoryId = await jjRepositoryIdentity(w.shared!.repository);
		baseline = head(w.path);
		workspace = w.shared!.name;
		initial = change(w.path);
		initialCommit = commit(w.path);
		enabled = true;
		malformed = true;
		await assert.rejects(f.store.observeOwnership(w.path, w.shared!), /Malformed creation diff/);
		assert.equal((await f.store.ownership.get(repositoryId, discovered)).ownership.status, "unknown");
		assert.equal((await f.store.ownership.binding(repositoryId, workspace))!.cursor, baseline);
		malformed = false;
		pages = 0;
		await f.store.observeOwnership(w.path, w.shared!);
		assert.equal(pages, 18);
		assert.equal((await f.store.ownership.get(repositoryId, discovered)).ownership.status, "owned");
		assert.equal((await f.store.ownership.binding(repositoryId, workspace))!.cursor, operation(2300));
	} finally {
		await f.store.close();
		f.close();
	}
});

test("task reassignment without a jj operation never relabels enrollment scope or later changes", async () => {
	const f = fixture();
	const missions = new MissionStore(":memory:");
	try {
		const mission = missions.create({ projectId: "project", title: "Scope", planningVersion: 1 });
		missions.join("worker-a", mission.id);
		missions.join("worker-b", mission.id);
		const first = missions.addTask(mission.id, { title: "Initial", sessionId: "worker-a" });
		const w = await f.store.create(f.source, f.path(), undefined, undefined, {
			...scope,
			missionId: mission.id,
			taskIds: [first.id],
		});
		const repositoryId = await jjRepositoryIdentity(w.shared!.repository);
		const before = head(w.path);
		missions.updateTask(mission.id, first.id, { sessionId: "worker-b" });
		const later = missions.addTask(mission.id, { title: "Later", sessionId: "worker-a" });
		assert.notEqual(first.id, later.id);
		assert.equal(head(w.path), before, "task mutations produce no jj operation boundary");
		jj(w.path, "new", "-m", "after reassignment");
		await f.store.observeOwnership(w.path, w.shared!);
		for (const record of await f.store.ownership.list(repositoryId, w.shared!.name)) {
			if (record.ownership.status !== "owned") assert.fail();
			assert.deepEqual(
				record.ownership.binding.taskIds,
				[first.id],
				"immutable enrollment provenance, not a current assignment",
			);
			assert.equal(record.ownership.taskAttribution, "unknown");
		}
	} finally {
		await f.store.close();
		missions.close();
		f.close();
	}
});

test("shutdown aborts and joins observation before closing durable metadata", async () => {
	let enabled = false;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const runner: Runner = async (file, args, cwd, timeout, signal, env) => {
		if (!enabled) return run(file, args, cwd, timeout, signal, env);
		return new Promise((_resolve, reject) => {
			markStarted();
			signal!.addEventListener("abort", () => reject(new Error("Observation aborted")), { once: true });
		});
	};
	const f = fixture(runner);
	try {
		const w = await f.store.create(f.source, f.path(), undefined, undefined, scope);
		enabled = true;
		const rejected = assert.rejects(f.store.observeOwnership(w.path, w.shared!), /Observation aborted/);
		await started;
		await Promise.all([f.store.close(), f.store.close(), rejected]);
		await assert.rejects(
			f.store.ownership.observe(await jjRepositoryIdentity(w.shared!.repository), w.shared!.name, w.path),
			/closed/,
		);
	} finally {
		await f.store.close();
		f.close();
	}
});

test("legacy workspaces remain unenrolled; tampered repository and session bindings fail closed", async () => {
	const f = fixture();
	try {
		const legacy = await f.store.create(f.source, f.path("legacy"));
		await f.store.observeOwnership(legacy.path, legacy.shared!);
		assert.equal(existsSync(join(f.root, "home/jj-ownership.sqlite")), false);
		const w = await f.store.create(f.source, f.path(), undefined, undefined, scope);
		const repositoryId = await jjRepositoryIdentity(w.shared!.repository);
		const binding = (await f.store.ownership.binding(repositoryId, w.shared!.name))!;
		const initial = (await f.store.ownership.list(repositoryId, w.shared!.name))[0]!;
		if (initial.ownership.status !== "owned") assert.fail();
		await assert.rejects(
			f.store.ownership.register({ ...binding.binding, sessionId: "someone-else" }, initial.ownership.creation),
			/cannot transfer/,
		);
		const link = join(w.path, ".jj/repo");
		const old = readFileSync(link, "utf8");
		writeFileSync(link, join(f.source, ".jj/repo"));
		await assert.rejects(
			f.store.ownership.observe(repositoryId, w.shared!.name, w.path),
			/repository binding mismatch/,
		);
		writeFileSync(link, old);
		assert.equal((await f.store.ownership.get(repositoryId, initial.changeId)).current.status, "unknown");
		await f.store.observeOwnership(w.path, w.shared!);
		assert.equal((await f.store.ownership.get(repositoryId, initial.changeId)).current.status, "observed");
	} finally {
		await f.store.close();
		f.close();
	}
});
