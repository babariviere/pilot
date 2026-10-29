/** Internal only. These records prove attribution, not retained content or delivery acceptance. */
export interface JjWorkerScope {
	version: 1;
	sessionId: string;
	missionId: string;
	/** Enrollment assignment scope, never proof of exact per-change task attribution. */
	taskIds: string[];
}

export interface JjOwnershipBinding extends JjWorkerScope {
	repositoryId: string;
	repositoryPath: string;
	workspace: string;
	path: string;
	startOperation: string;
}

export interface JjRevision {
	changeId: string;
	commitId: string;
	parents: string[];
}

export interface JjCreation {
	changeId: string;
	commitId: string;
	operationId: string;
	kind: "workspace-created" | "workspace-operation";
}

export interface JjOwnedChange {
	repositoryId: string;
	changeId: string;
	/** Unknown means discovery has skipped an unprovable interval, not that a known creator changed. */
	discovery: "complete" | "unknown";
	ownership:
		| { status: "owned"; binding: JjOwnershipBinding; creation: JjCreation; taskAttribution: "unknown" }
		| { status: "unknown"; reason: "unproven" | "collision" };
	/** A point-in-time observation, never a freshness promise or stored review evidence. */
	current: {
		status: "observed" | "divergent" | "absent" | "unknown";
		operationId?: string;
		observedAt?: number;
		revisions: JjRevision[];
	};
}

export const changeIdPattern = /^[k-z]{32}$/;
export const commitIdPattern = /^[a-f0-9]{40}$/;
export const operationIdPattern = /^[a-f0-9]{128}$/;
export const repositoryIdPattern = /^[a-f0-9]{64}$/;

export function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("Invalid ownership record fields");
}

export function identifier(value: unknown, pattern: RegExp): asserts value is string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error("Invalid ownership identifier");
}

export function workerScope(value: unknown): asserts value is JjWorkerScope {
	exact(value, ["version", "sessionId", "missionId", "taskIds"]);
	if (value.version !== 1) throw new Error("Unsupported ownership version");
	for (const id of [value.sessionId, value.missionId]) identifier(id, /^[a-zA-Z0-9_-]{1,128}$/);
	if (!Array.isArray(value.taskIds) || value.taskIds.length < 1 || value.taskIds.length > 100)
		throw new Error("Invalid ownership task scope");
	for (const id of value.taskIds) identifier(id, /^[a-zA-Z0-9_-]{1,128}$/);
	if (new Set(value.taskIds).size !== value.taskIds.length) throw new Error("Duplicate ownership tasks");
}

export function bindingRecord(value: unknown): asserts value is JjOwnershipBinding {
	exact(value, [
		"version",
		"sessionId",
		"missionId",
		"taskIds",
		"repositoryId",
		"repositoryPath",
		"workspace",
		"path",
		"startOperation",
	]);
	workerScope({
		version: value.version,
		sessionId: value.sessionId,
		missionId: value.missionId,
		taskIds: value.taskIds,
	});
	identifier(value.repositoryId, repositoryIdPattern);
	identifier(value.startOperation, operationIdPattern);
	identifier(value.workspace, /^pilot-[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
	for (const path of [value.repositoryPath, value.path])
		if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0"))
			throw new Error("Invalid ownership path");
}

export function creationRecord(value: unknown): asserts value is JjCreation {
	exact(value, ["changeId", "commitId", "operationId", "kind"]);
	identifier(value.changeId, changeIdPattern);
	identifier(value.commitId, commitIdPattern);
	identifier(value.operationId, operationIdPattern);
	if (/^z+$/.test(value.changeId) || /^0+$/.test(value.commitId))
		throw new Error("Root revision cannot have a worker owner");
	if (value.kind !== "workspace-created" && value.kind !== "workspace-operation")
		throw new Error("Invalid creation proof");
}

export function revisionRecord(value: unknown): asserts value is JjRevision {
	exact(value, ["changeId", "commitId", "parents"]);
	identifier(value.changeId, changeIdPattern);
	identifier(value.commitId, commitIdPattern);
	if (!Array.isArray(value.parents)) throw new Error("Invalid revision parents");
	for (const parent of value.parents) identifier(parent, commitIdPattern);
}
