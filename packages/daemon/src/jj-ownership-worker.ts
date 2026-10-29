/** SQLite and fsync stay off the daemon event loop. No content is captured here. */
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
	bindingRecord,
	changeIdPattern,
	creationRecord,
	exact,
	identifier,
	type JjOwnedChange,
	type JjOwnershipBinding,
	type JjRevision,
	operationIdPattern,
	repositoryIdPattern,
	revisionRecord,
} from "./jj-ownership-contract.ts";

mkdirSync(dirname(workerData.file), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(workerData.file);
chmodSync(workerData.file, 0o600);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS ownership_meta(version INTEGER NOT NULL);
 INSERT INTO ownership_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM ownership_meta);
`);
if (db.prepare("SELECT version FROM ownership_meta").get()?.version !== 1)
	throw new Error("Unsupported ownership ledger version");
db.exec(`
 CREATE TABLE IF NOT EXISTS bindings(repository TEXT NOT NULL, workspace TEXT NOT NULL, binding TEXT NOT NULL,
 cursor TEXT NOT NULL, problem TEXT, coverage TEXT NOT NULL, PRIMARY KEY(repository,workspace));
 CREATE TABLE IF NOT EXISTS claims(repository TEXT NOT NULL, change_id TEXT NOT NULL, workspace TEXT NOT NULL,
 operation TEXT NOT NULL, proof TEXT NOT NULL, PRIMARY KEY(repository,change_id,workspace,operation));
 CREATE INDEX IF NOT EXISTS claims_by_workspace ON claims(repository,workspace,change_id);
 CREATE TABLE IF NOT EXISTS observations(repository TEXT NOT NULL, change_id TEXT NOT NULL, operation TEXT NOT NULL,
 observed_at INTEGER NOT NULL, revisions TEXT NOT NULL, PRIMARY KEY(repository,change_id));
 CREATE TABLE IF NOT EXISTS revisions(repository TEXT NOT NULL, change_id TEXT NOT NULL, commit_id TEXT NOT NULL,
 operation TEXT NOT NULL, observed_at INTEGER NOT NULL, revision TEXT NOT NULL,
 PRIMARY KEY(repository,change_id,commit_id));
`);

function binding(
	repository: unknown,
	workspace: unknown,
): { binding: JjOwnershipBinding; cursor: string; problem: unknown; coverage: "complete" | "unknown" } | undefined {
	identifier(repository, repositoryIdPattern);
	identifier(workspace, /^pilot-[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
	const row = db.prepare("SELECT * FROM bindings WHERE repository=? AND workspace=?").get(repository, workspace);
	if (!row) return undefined;
	const value: unknown = JSON.parse(String(row.binding));
	bindingRecord(value);
	if (value.repositoryId !== repository || value.workspace !== workspace) throw new Error("Corrupt ownership binding");
	identifier(row.cursor, operationIdPattern);
	if (row.problem !== null && row.problem !== "unobserved" && row.problem !== "history-unknown")
		throw new Error("Corrupt ownership checkpoint");
	if (row.coverage !== "complete" && row.coverage !== "unknown") throw new Error("Corrupt ownership coverage");
	return { binding: value, cursor: row.cursor, problem: row.problem, coverage: row.coverage };
}

function claim(scope: JjOwnershipBinding, proof: unknown) {
	creationRecord(proof);
	const prior = db
		.prepare("SELECT proof FROM claims WHERE repository=? AND change_id=? AND workspace=? AND operation=?")
		.get(scope.repositoryId, proof.changeId, scope.workspace, proof.operationId);
	if (prior && prior.proof !== JSON.stringify(proof)) throw new Error("Conflicting creation proof");
	db.prepare("INSERT OR IGNORE INTO claims VALUES(?,?,?,?,?)").run(
		scope.repositoryId,
		proof.changeId,
		scope.workspace,
		proof.operationId,
		JSON.stringify(proof),
	);
}

function get(repository: unknown, changeId: unknown): JjOwnedChange {
	identifier(repository, repositoryIdPattern);
	identifier(changeId, changeIdPattern);
	const claims = db
		.prepare("SELECT workspace,proof FROM claims WHERE repository=? AND change_id=? LIMIT 2")
		.all(repository, changeId);
	let ownership: JjOwnedChange["ownership"] = { status: "unknown", reason: claims.length ? "collision" : "unproven" };
	let problem = false;
	let discovery: JjOwnedChange["discovery"] = "unknown";
	if (claims.length === 1) {
		const row = claims[0]!;
		const owner = binding(repository, row.workspace);
		if (!owner) throw new Error("Missing ownership binding");
		const proof: unknown = JSON.parse(String(row.proof));
		creationRecord(proof);
		if (proof.changeId !== changeId) throw new Error("Corrupt creation identity");
		ownership = {
			status: "owned",
			binding: owner.binding,
			creation: proof,
			taskAttribution: "unknown",
		};
		problem = owner.problem !== null;
		discovery = owner.coverage;
	}
	const observed = db
		.prepare("SELECT * FROM observations WHERE repository=? AND change_id=?")
		.get(repository, changeId);
	let current: JjOwnedChange["current"] = { status: "unknown", revisions: [] };
	if (observed && !problem && ownership.status === "owned") {
		identifier(observed.operation, operationIdPattern);
		if (!Number.isSafeInteger(observed.observed_at) || Number(observed.observed_at) < 0)
			throw new Error("Corrupt observation time");
		const revisions: unknown = JSON.parse(String(observed.revisions));
		if (!Array.isArray(revisions)) throw new Error("Corrupt revisions");
		for (const revision of revisions) {
			revisionRecord(revision);
			if (revision.changeId !== changeId) throw new Error("Corrupt revision identity");
		}
		current = {
			status: revisions.length > 1 ? "divergent" : revisions.length ? "observed" : "absent",
			operationId: observed.operation,
			observedAt: Number(observed.observed_at),
			revisions,
		};
	}
	return { repositoryId: repository, changeId, discovery, ownership, current };
}

function transact(action: () => unknown) {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = action();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function dispatch(method: string, input: unknown): unknown {
	if (method === "register") {
		exact(input, ["binding", "creation"]);
		bindingRecord(input.binding);
		creationRecord(input.creation);
		const scope = input.binding;
		if (input.creation.kind !== "workspace-created") throw new Error("Enrollment needs a workspace creation proof");
		return transact(() => {
			const prior = binding(scope.repositoryId, scope.workspace);
			if (prior && JSON.stringify(prior.binding) !== JSON.stringify(scope))
				throw new Error("Ownership binding cannot transfer");
			db.prepare("INSERT OR IGNORE INTO bindings VALUES(?,?,?,?,'unobserved','complete')").run(
				scope.repositoryId,
				scope.workspace,
				JSON.stringify(scope),
				scope.startOperation,
			);
			claim(scope, input.creation);
		});
	}
	if (method === "binding") {
		exact(input, ["repositoryId", "workspace"]);
		return binding(input.repositoryId, input.workspace);
	}
	if (method === "get") {
		exact(input, ["repositoryId", "changeId"]);
		return get(input.repositoryId, input.changeId);
	}
	if (method === "list") {
		exact(input, ["repositoryId", "workspace", "after", "limit"]);
		identifier(input.repositoryId, repositoryIdPattern);
		identifier(input.workspace, /^pilot-[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
		if (input.after !== "") identifier(input.after, changeIdPattern);
		if (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)
			throw new Error("Invalid ownership page");
		return db
			.prepare(
				"SELECT DISTINCT change_id FROM claims WHERE repository=? AND workspace=? AND change_id>? ORDER BY change_id LIMIT ?",
			)
			.all(input.repositoryId, input.workspace, input.after as string, input.limit as number)
			.map((row) => get(input.repositoryId, row.change_id));
	}
	if (method === "apply") {
		exact(input, [
			"repositoryId",
			"workspace",
			"expectedCursor",
			"operationId",
			"creations",
			"changes",
			"problem",
			"coverage",
		]);
		identifier(input.expectedCursor, operationIdPattern);
		identifier(input.operationId, operationIdPattern);
		const operationId = input.operationId;
		if (input.coverage !== "complete" && input.coverage !== "unknown") throw new Error("Invalid ownership coverage");
		if (
			!Array.isArray(input.creations) ||
			!Array.isArray(input.changes) ||
			(input.problem !== null && input.problem !== "history-unknown")
		)
			throw new Error("Invalid ownership observation");
		const creations = input.creations;
		for (const proof of creations) {
			creationRecord(proof);
			if (proof.kind !== "workspace-operation") throw new Error("Invalid discovery proof");
		}
		const changes = input.changes;
		for (const change of changes) {
			exact(change, ["changeId", "revisions"]);
			identifier(change.changeId, changeIdPattern);
			if (!Array.isArray(change.revisions)) throw new Error("Invalid current revisions");
			for (const revision of change.revisions) {
				revisionRecord(revision);
				if (revision.changeId !== change.changeId) throw new Error("Revision mismatch");
			}
		}
		return transact(() => {
			const owner = binding(input.repositoryId, input.workspace);
			if (!owner || owner.cursor !== input.expectedCursor) throw new Error("Ownership cursor conflict");
			for (const proof of creations) claim(owner.binding, proof);
			const now = Date.now();
			for (const change of changes as { changeId: string; revisions: JjRevision[] }[]) {
				if (
					!db
						.prepare("SELECT 1 FROM claims WHERE repository=? AND change_id=? AND workspace=?")
						.get(owner.binding.repositoryId, change.changeId, owner.binding.workspace)
				)
					throw new Error("Unbound revision");
				db.prepare("INSERT OR REPLACE INTO observations VALUES(?,?,?,?,?)").run(
					owner.binding.repositoryId,
					change.changeId,
					operationId,
					now,
					JSON.stringify(change.revisions),
				);
				for (const revision of change.revisions)
					db.prepare("INSERT OR IGNORE INTO revisions VALUES(?,?,?,?,?,?)").run(
						owner.binding.repositoryId,
						change.changeId,
						revision.commitId,
						operationId,
						now,
						JSON.stringify(revision),
					);
			}
			db.prepare(
				"UPDATE bindings SET cursor=?,problem=?,coverage=CASE WHEN ?='unknown' THEN 'unknown' ELSE coverage END WHERE repository=? AND workspace=?",
			).run(
				operationId,
				input.problem as string | null,
				input.coverage as string,
				owner.binding.repositoryId,
				owner.binding.workspace,
			);
		});
	}
	if (method === "close") {
		exact(input, []);
		db.close();
		return;
	}
	throw new Error("Unknown ownership operation");
}

parentPort!.on("message", ({ id, method, args }) => {
	try {
		parentPort!.postMessage({ id, value: dispatch(method, args) });
	} catch (error) {
		parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
