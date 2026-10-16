import type { MissionDetail, SpawnRequest } from "./index.ts";
import type { MemoryEntry, MemoryNode, MemoryRecall, MemoryTree, MemoryView } from "./memory.ts";
import type { DurableOperation, OperationHost, OperationReceipt } from "./operations.ts";

/** All durable identities include storage history, independently of transport generation. */
export interface SharedProjectRef {
	host: OperationHost;
	projectId: string;
}
export interface SharedMissionRef {
	home: OperationHost;
	missionId: string;
}
export interface SharedTaskRef {
	mission: SharedMissionRef;
	taskId: string;
}
export interface SharedSessionRef {
	host: OperationHost;
	sessionId: string;
}
export interface SharedContextBinding {
	schemaVersion: 1;
	bindingId: string;
	generation: number;
	logicalProjectId: string;
	memoryHome: SharedProjectRef;
	missionHome: OperationHost;
	executionProject: SharedProjectRef;
	/** Explicit allowlist, not a repository-name match or decision audience ACL. */
	missionIds: string[];
	shareMemory: boolean;
	state: "active" | "revoked";
}
export interface SharedContextVector {
	memory: number;
	mission: number;
}
export interface SharedContextFreshness {
	applied: SharedContextVector;
	observedHead?: SharedContextVector;
	complete: boolean;
	pendingCount: number;
	conflictCount: number;
	lastSyncedAt?: number;
}
export interface SharedMemoryMutation {
	operationId: string;
	payloadHash: string;
	noteId: string;
	origin: SharedSessionRef;
	text: string;
	/** null asserts this entry is still live; indices never cross the wire as write addresses. */
	replaces: { id: string; expectedReplacementId: string | null }[];
}
export interface SharedMemoryCommitOutcome {
	operationId: string;
	state: "committed" | "already-present" | "conflict" | "rejected";
	sequence: number;
	entry?: MemoryEntry;
	reason?: string;
}
export interface SharedMemoryCheckpointManifest {
	checkpointId: string;
	sequence: number;
	count: number;
	digest: string;
}
export interface SharedMemoryCheckpointPage {
	checkpointId: string;
	cursor: number;
	entries: MemoryEntry[];
	next?: number;
}
export interface SharedMemoryChange {
	sequence: number;
	entry: MemoryEntry;
}
export interface SharedMemoryChangePage {
	after: number;
	head: number;
	changes: SharedMemoryChange[];
	next?: number;
	checkpointRequired?: boolean;
}
export interface SharedMemoryReplicaState {
	/** Durable binding-local overlay changes, independent of canonical commit count. */
	overlayRevision?: number;
	sequence: number;
	complete: boolean;
	pendingCount: number;
	conflictCount: number;
}
export interface SharedMemoryProposal {
	mutation: SharedMemoryMutation;
	state: "pending" | "conflict" | "rejected";
	reason?: string;
}
export interface SharedMemoryRead {
	state: SharedMemoryReplicaState;
	value: MemoryView | MemoryRecall | MemoryNode[];
	/** Pending entries have stable IDs, never fabricated canonical note indices. */
	proposals: SharedMemoryProposal[];
}
export interface SharedEntity {
	id: string;
	kind: "mission" | "brief" | "task" | "decision" | "comment" | "resource" | "artifact" | "phase";
	revision: number;
	/** Task user-intent revision captured with this value, not execution progress. Missing on legacy replicas. */
	definitionRevision?: number;
	deleted: boolean;
	value?: unknown;
}
export interface SharedMissionChange {
	sequence: number;
	missionId: string;
	entity: SharedEntity;
}
export interface SharedMissionSnapshot {
	missionId: string;
	sequence: number;
	/** Allowlisted structured state only. No transcript, executable config or integration database. */
	detail: MissionDetail;
	entities: SharedEntity[];
}
export interface SharedEntityVersion {
	id: string;
	kind: SharedEntity["kind"];
	revision: number;
	definitionRevision?: number;
	deleted: boolean;
}
export interface SharedMissionVersions {
	bindingId: string;
	generation: number;
	missionId: string;
	authority: OperationHost;
	source: "canonical" | "replica";
	sequence: number;
	complete: boolean;
	entities: SharedEntityVersion[];
	/** Offset for the next page. Supply sequence on subsequent requests to reject mixed versions. */
	next?: number;
}
export interface SharedMissionRead {
	bindingId: string;
	generation: number;
	authority: OperationHost;
	source: "canonical" | "replica";
	snapshot: SharedMissionSnapshot;
	/** Provisional/reviewed contributions remain separate from committed detail. */
	proposals: SharedMissionProposal[];
}
export interface SharedMemoryTreeRead {
	state: SharedMemoryReplicaState;
	value: MemoryTree;
	proposals: SharedMemoryProposal[];
}
export interface SharedMissionProposal {
	proposalId: string;
	missionId: string;
	entityId: string;
	expectedRevision: number;
	action: string;
	args: Record<string, unknown>;
	origin: SharedSessionRef;
	state: "pending" | "committed" | "conflict" | "rejected";
	reason?: string;
	canonicalId?: string;
}
export interface SharedContextConflict {
	operationId: string;
	bindingId: string;
	reason: string;
	base?: unknown;
	current?: unknown;
	incoming: unknown;
}
export interface DelegationGrant {
	delegationId: string;
	task: SharedTaskRef;
	executionEpoch: number;
	bindingId: string;
	bindingGeneration: number;
	target: SharedProjectRef;
	session: SharedSessionRef;
	definitionRevision: number;
	context: SharedContextVector;
	manifestId: string;
	references: SharedContextReference[];
	/** Explicitly acknowledged unavailable-offline URLs, not hidden mandatory context. */
	onlineOnlyUrls?: string[];
	/** Immutable accepted scope. Target resolves repository and trust from its own binding. */
	request: SpawnRequest;
	state: "reserved" | "accepted" | "cancel_requested" | "sealed";
}
export interface SharedContextReference {
	host: OperationHost;
	sessionId: string;
	artifactId: string;
	revision: number;
	requirement: "required" | "optional-online";
	digest?: string;
}
export interface DelegatedMembership {
	grant: DelegationGrant;
	freshness: SharedContextFreshness;
}
export interface DelegationEvent {
	eventId: string;
	delegationId: string;
	executionEpoch: number;
	sequence: number;
	kind: "progress" | "result" | "question" | "artifact" | "pull-request" | "sealed";
	/** Facts are retained even if current definition/tombstones prohibit projection. */
	payload: Record<string, unknown>;
}
export interface SharedExchangeBatch {
	bindingId: string;
	generation: number;
	operations: DurableOperation[];
	more: boolean;
}
export interface SharedExchangeAcknowledgment {
	operation: DurableOperation;
	receipt: OperationReceipt;
}
export interface SharedContextSummary {
	binding: SharedContextBinding;
	freshness: SharedContextFreshness;
	grants: DelegationGrant[];
}
