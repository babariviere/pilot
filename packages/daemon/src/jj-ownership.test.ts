import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { JjOwnershipStore } from "./jj-ownership.ts";
import type { JjCreation, JjOwnershipBinding } from "./jj-ownership-contract.ts";

const repositoryId = "a".repeat(64);
const changeId = "k".repeat(32);
const operationId = "b".repeat(128);
const scope: JjOwnershipBinding = {
	version: 1,
	sessionId: "worker",
	missionId: "mission",
	taskIds: ["task"],
	repositoryId,
	repositoryPath: "/managed/repository",
	path: "/sessions/worker/workspace",
	workspace: `pilot-worker-${"a".repeat(16)}`,
	startOperation: operationId,
};
const creation: JjCreation = { changeId, commitId: "c".repeat(40), operationId, kind: "workspace-created" };

test("durable immutable bindings, repository isolation and collision underclaim", async () => {
	const home = mkdtempSync(join(tmpdir(), "pilot-ownership-"));
	const path = join(home, "ownership.sqlite");
	let store = new JjOwnershipStore(path);
	try {
		await store.register(scope, creation);
		await store.register(scope, creation);
		assert.equal((await store.list(repositoryId, scope.workspace)).length, 1);
		await assert.rejects(store.register({ ...scope, taskIds: ["other"] }, creation), /cannot transfer/);
		await assert.rejects(store.register(scope, { ...creation, commitId: "d".repeat(40) }), /Conflicting/);
		assert.equal((await store.get("e".repeat(64), changeId)).ownership.status, "unknown");
		await store.register({ ...scope, sessionId: "other", workspace: `pilot-other-${"d".repeat(16)}` }, creation);
		assert.deepEqual((await store.get(repositoryId, changeId)).ownership, { status: "unknown", reason: "collision" });
		await store.close();
		store = new JjOwnershipStore(path);
		assert.equal((await store.get(repositoryId, changeId)).ownership.status, "unknown");
		assert.equal((await store.list(repositoryId, scope.workspace, changeId)).length, 0);
	} finally {
		await store.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("strict writes and reads reject unsupported versions, unknown fields, prefixes and corruption", async () => {
	const home = mkdtempSync(join(tmpdir(), "pilot-ownership-"));
	const path = join(home, "ownership.sqlite");
	let store = new JjOwnershipStore(path);
	try {
		for (const invalid of [
			{ ...scope, version: 2 },
			{ ...scope, extra: true },
			{ ...scope, taskIds: [] },
			{ ...scope, taskIds: ["task", "task"] },
			{ ...scope, repositoryId: "a" },
			{ ...scope, startOperation: "b" },
		])
			await assert.rejects(store.register(invalid as never, creation));
		await assert.rejects(store.register(scope, { ...creation, changeId: "kkkk" }));
		await assert.rejects(store.register(scope, { ...creation, extra: true } as never));
		await store.register(scope, creation);
		await assert.rejects(store.get(repositoryId, "kkkk"));
		await assert.rejects(store.list(repositoryId, scope.workspace, "", 101));
		await assert.rejects(store.list(repositoryId, "other"));
		await store.close();
		const db = new DatabaseSync(path);
		db.prepare("UPDATE claims SET proof=?").run(JSON.stringify({ ...creation, kind: "guess" }));
		db.close();
		store = new JjOwnershipStore(path);
		await assert.rejects(store.get(repositoryId, changeId), /Invalid creation/);
		await store.close();
		const future = new DatabaseSync(path);
		future.exec("UPDATE ownership_meta SET version=2");
		future.close();
		store = new JjOwnershipStore(path);
		await assert.rejects(store.get(repositoryId, changeId), /Unsupported ownership ledger version/);
	} finally {
		await store.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("cursor compare-and-swap is atomic and incomplete observations never acknowledge claims", async () => {
	const home = mkdtempSync(join(tmpdir(), "pilot-ownership-"));
	const store = new JjOwnershipStore(join(home, "ownership.sqlite"));
	try {
		await store.register(scope, creation);
		const observation = {
			repositoryId,
			workspace: scope.workspace,
			expectedCursor: operationId,
			operationId: "d".repeat(128),
			creations: [{ ...creation, changeId: "l".repeat(32), kind: "workspace-operation" }],
			changes: [{ changeId, revisions: [{ changeId, commitId: "e".repeat(40), parents: [creation.commitId] }] }],
			problem: null,
			coverage: "complete",
		};
		// biome-ignore lint/complexity/useLiteralKeys: Exercise the internal validated transaction boundary.
		await store["rpc"]("apply", observation);
		// biome-ignore lint/complexity/useLiteralKeys: Exercise a stale concurrent observer.
		await assert.rejects(store["rpc"]("apply", observation), /cursor conflict/);
		const current = await store.get(repositoryId, changeId);
		assert.equal(current.current.revisions[0]!.commitId, "e".repeat(40));
		assert.equal(current.current.operationId, "d".repeat(128));
		assert.equal((await store.binding(repositoryId, scope.workspace))?.cursor, "d".repeat(128));
		// Claims and cursor must roll back together when a revision is not bound.
		await assert.rejects(
			// biome-ignore lint/complexity/useLiteralKeys: Exercise rollback at the internal transaction boundary.
			store["rpc"]("apply", {
				...observation,
				expectedCursor: "d".repeat(128),
				creations: [{ ...creation, changeId: "m".repeat(32), kind: "workspace-operation" }],
				changes: [{ changeId: "n".repeat(32), revisions: [] }],
			}),
			/Unbound revision/,
		);
		assert.equal((await store.get(repositoryId, "m".repeat(32))).ownership.status, "unknown");
	} finally {
		await store.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("v2 project/chat custody is strict, durable and separate from unchanged v1 mission bindings", async () => {
	const home = mkdtempSync(join(tmpdir(), "project-ownership-"));
	const file = join(home, "ownership.sqlite");
	let store = new JjOwnershipStore(file);
	const { missionId: _mission, taskIds: _tasks, ...common } = scope;
	const project: JjOwnershipBinding = { ...common, version: 2, projectId: "project" };
	const projectProof = { ...creation, changeId: "p".repeat(32) };
	try {
		await store.register(scope, creation);
		for (const invalid of [
			{ ...project, missionId: "fake" },
			{ ...project, taskIds: [] },
			{ ...project, projectId: "" },
			{ ...project, version: 3 },
			{ ...project, extra: true },
		])
			await assert.rejects(store.register(invalid as never, projectProof));
		// A project scope cannot replace an existing mission binding or vice versa.
		await assert.rejects(store.register(project, projectProof), /cannot transfer/);
		project.workspace = `pilot-project-${"d".repeat(16)}`;
		await store.register(project, projectProof);
		assert.deepEqual(
			await store.sessionBinding(scope.sessionId, scope.missionId!, scope.repositoryPath, scope.workspace),
			scope,
		);
		assert.equal(
			await store.sessionBinding(project.sessionId, "project", project.repositoryPath, project.workspace),
			undefined,
		);
		assert.equal(
			await store.projectSessionBinding(scope.sessionId, "project", scope.repositoryPath, scope.workspace),
			undefined,
		);
		assert.equal(
			await store.projectSessionBinding(project.sessionId, "wrong", project.repositoryPath, project.workspace),
			undefined,
		);
		assert.deepEqual(
			await store.projectSessionBinding(project.sessionId, "project", project.repositoryPath, project.workspace),
			project,
		);
		await store.close();
		store = new JjOwnershipStore(file);
		assert.deepEqual(
			await store.projectSessionBinding(project.sessionId, "project", project.repositoryPath, project.workspace),
			project,
		);
		const owner = (await store.get(repositoryId, projectProof.changeId)).ownership;
		assert.equal(owner.status, "owned");
		if (owner.status === "owned") {
			assert.deepEqual(owner.binding, project);
			assert.equal(owner.taskAttribution, "unknown");
			assert.equal("taskIds" in owner.binding, false);
			assert.equal("missionId" in owner.binding, false);
		}
		await store.register({ ...project, workspace: `pilot-collision-${"e".repeat(16)}` }, projectProof);
		assert.deepEqual((await store.get(repositoryId, projectProof.changeId)).ownership, {
			status: "unknown",
			reason: "collision",
		});
	} finally {
		await store.close();
		rmSync(home, { recursive: true, force: true });
	}
});
