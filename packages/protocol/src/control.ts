import type { DurableOperation, OperationHost, OperationReceipt } from "./operations.ts";

/** Global control APIs. All timestamps are epoch milliseconds. */
export type WatchEvent =
	| "chat.settled"
	| "chat.failed"
	| "pr.merged"
	| "pr.closed"
	| "pr.ready"
	| "linear.done"
	| "mission.task_done"
	| "mission.done";
export interface WatchTarget {
	/** Contract-only routing extension. Omitted means the configured Control home, never the receiving daemon. */
	host?: OperationHost;
	kind: "chat" | "project" | "mission" | "pr" | "chat_prs" | "linear" | "task";
	id: string;
	missionId?: string;
}
export interface WatchInput {
	/** Present on watches created by Control after authorization records were introduced. */
	authorizationId?: string;
	event: WatchEvent;
	target: WatchTarget;
	filter?: { outcome?: "done" | "failed" | "stopped" };
	mode: "once" | "persistent";
	note: string;
	expiresAt?: number;
}
export interface Watch extends WatchInput {
	id: string;
	createdAt: number;
}
/** GET /api/control-chat/watches?after=<id>&limit=40. ID order; limit 1..100. */
export interface WatchesResponse {
	watches: Watch[];
	next?: string;
}
/** DELETE /api/control-chat/watches/:id. Idempotent, including fired/expired watches. */
export interface CancelWatchResponse {
	removed: boolean;
}
export interface ControlAuditEntry {
	authorizationId?: string;
	seq: number;
	operationId: string;
	action: string;
	phase: "requested" | "succeeded" | "failed";
	at: number;
	caller: string;
	args: Record<string, unknown>;
	result?: unknown;
}
/** GET /api/control-chat/audit?before=<seq>&limit=50, newest first, limit 1..50. */
export type ControlAuditResponse = ControlAuditEntry[];
/** GET/POST /api/control-chat. POST ensures the singleton without starting a turn. */
export type ControlChatResponse = import("./index.ts").SessionSummary;
/** Read-only browsing of the control chat's append-only memory. All routes 404 without a control chat. */
export type ControlMemoryKind = "user" | "assistant" | "tool" | "echo" | "event" | "note";
/** One summary range: messages id..id+n-1. `pending` lines have no summary yet. */
export interface ControlMemoryLine {
	id: number;
	n: number;
	text: string;
	pending?: boolean;
}
/** GET /api/control-chat/memory/view. The current view, oldest first. */
export interface ControlMemoryViewResponse {
	lines: ControlMemoryLine[];
}
/** A whole logged message page. Tool rows are JSON {name,input,text} with format "json". */
export interface ControlMemoryMessagePage {
	message: { id: number; at: number; kind: ControlMemoryKind; text: string; name?: string };
	format?: "json";
	/** Offset of the next page of the same message. */
	next?: number;
}
/** GET /api/control-chat/memory/nodes/:id/:n. n > 1 returns the two halves; n = 1 returns the message,
 * paged with `offset` (only allowed for n = 1). */
export type ControlMemoryNodeResponse = { lines: ControlMemoryLine[] } | ControlMemoryMessagePage;
/** A clipped log row. `input` is the tool input as JSON text. Full content via nodes/:id/1. */
export interface ControlMemoryLogEntry {
	id: number;
	at: number;
	kind: ControlMemoryKind;
	text: string;
	name?: string;
	input?: string;
	clipped?: boolean;
}
/** GET /api/control-chat/memory/messages?before=<id>&limit=50&q=<text>. Newest first, limit 1..100, q at most
 * 200 characters (case-insensitive substring of text, tool name or input). A search scans a bounded window, so a
 * page may hold fewer matches than `limit`; continue with `next` until it is absent. */
export interface ControlMemoryMessagesResponse {
	messages: ControlMemoryLogEntry[];
	next?: number;
}
/** GET /api/control-chat/memory/stats. */
export interface ControlMemoryStats {
	count: number;
	/** Summaries waiting to be built (queued or running). */
	pendingJobs: number;
	/** Summaries that failed; background retries use bounded exponential backoff. */
	failedJobs: number;
	compactionFailure?: { id: number; n: number; attempts: number; errorClass: string; reason: string; retryAt: number };
	viewBytes: number;
	merging: boolean;
	/** chat.sqlite plus its write-ahead log. */
	dbBytes: number;
	oldestAt?: number;
	newestAt?: number;
}
/** POST /api/sessions/:id/model. Incompatible context is rebuilt as a restorable model attempt. */
export type ChangeModelResponse = import("./index.ts").SessionSummary;
/** Small invalidations on /api/ws. Refetch bounded HTTP pages on change/reconnect. */
export type ControlMessage =
	| { type: "watches.changed" }
	| { type: "control-audit.changed" }
	/** Coalesced to at most one per second. */
	| { type: "control-memory.changed" }
	| { type: "dashboard.changed" }
	| ControlHostInvalidation;

export interface ControlDashboardChat {
	controlStart?: ControlStartBudget;
	spend?: ControlSpend;
	id: string;
	chatUrl: string;
	title: string;
	projectId?: string;
	missionId?: string;
	state: import("./index.ts").SessionState;
	working?: boolean;
	outcome?: import("./index.ts").SessionOutcome;
	model?: string;
}
export interface ControlDashboardAgent extends ControlDashboardChat {
	/** Latest user submission, else creation. Not worker uptime. */
	startedAt: number;
	elapsedMs: number;
}
export interface ControlDashboardMission {
	id: string;
	projectId: string;
	title: string;
	status: import("./index.ts").MissionStatus;
	tasksDone: number;
	tasksTotal: number;
	coordinatorSessionId?: string;
}
/** Planned unified mission row; identity/navigation are canonical, never execution-host scoped. */
export interface ControlLogicalMission {
	/** Stable JSON tuple [mission.home.daemonId, mission.home.lineageId, mission.missionId]. */
	id: string;
	mission: import("./shared-context.ts").SharedMissionRef;
	title?: string;
	status?: import("./index.ts").MissionStatus;
	/** Unknown counts are omitted, never reconstructed from a clipped/provisional task list. */
	tasksDone?: number;
	tasksTotal?: number;
	coordinator?: import("./shared-context.ts").SharedSessionRef;
	/** Bounded source evidence, not host sections, execution placement or new authority. */
	provenance: ControlMissionProvenance[];
}
export interface ControlMissionProvenance {
	kind: "canonical" | "replica";
	sourceHost: import("./operations.ts").OperationHost;
	/** Source-local project metadata, not logical mission identity. */
	projectId: string;
	bindingId?: string;
	sequence?: number;
	complete?: boolean;
	replicaSyncedAt?: number;
	/** Missing means unknown; no wall-clock ordering or connectivity-derived mission status. */
	replicaAgeMs?: number;
}
export interface ControlDashboardBlocker {
	id: string;
	kind: "blocked_task" | "failed_chat" | "question" | "failing_checks";
	projectId?: string;
	missionId?: string;
	sessionId?: string;
	taskId?: string;
	taskNumber?: number;
	title: string;
	detail?: string;
	at: number;
	url?: string;
	/** Required for failing_checks: failures from a cache verified against this exact head. */
	headSha?: string;
}
export interface ControlDashboardDecision {
	id: string;
	missionId: string;
	projectId: string;
	decisionId: string;
	kind: "edit" | "remove";
	text?: string;
	reason: string;
	authorSessionId: string;
	createdAt: number;
}
/** A remote-home mission from an enrolled local replica, never a writable local mission. */
export interface ControlDashboardReplicaMission {
	id: string;
	bindingId: string;
	projectId: string;
	missionId: string;
	missionHome: import("./operations.ts").OperationHost;
	title?: string;
	status?: import("./index.ts").MissionStatus;
	complete: boolean;
	sequence: number;
	consistency: "committed";
	replicaSyncedAt?: number;
	/** null means unknown (including replicas imported before timestamp recording). */
	replicaAgeMs: number | null;
}
/** Last committed task facts and separate provisional task proposals. No connectivity-derived outcomes. */
export interface ControlDashboardSharedTask {
	id: string;
	bindingId: string;
	/** Local execution project for replicas, canonical project for mission-home grants. */
	projectId: string;
	missionId: string;
	missionHome: import("./operations.ts").OperationHost;
	source: "mission-home" | "replica";
	consistency: "committed" | "provisional";
	taskId?: string;
	taskNumber?: number;
	title?: string;
	status?: import("./index.ts").MissionTaskStatus;
	proposalId?: string;
	proposalState?: "pending" | "conflict" | "rejected";
	delegationId?: string;
	executionHost?: import("./operations.ts").OperationHost;
	executionEpoch?: number;
	grantState?: import("./shared-context.ts").DelegationGrant["state"];
	/** Last imported working fact, not a liveness probe. Sealed grants are never running. */
	running?: boolean;
	replicaSyncedAt?: number;
	replicaAgeMs?: number | null;
}
/** GET /api/control-chat/dashboard?projectId&missionId. Same snapshot as pilot status.
 * Local user only, daemon memory only, no worker starts. Unknown/duplicate parameters are 400.
 * At most 24,000 encoded bytes, 100 rows per list (200 projects, 50 missions/replicaMissions); totals precede clipping.
 * Text is untrusted. Next contains global active watches with saved instructions, even for scoped requests.
 */
export interface ControlFollowUp {
	requestId: string;
	authorizationId: string;
	sessionId?: string;
	state: "queued" | "running" | "result";
	createdAt: number;
}
export interface ControlAuthorizationNeeded {
	id: string;
	action: "start" | "send" | "watch" | "stop" | "pause" | "resume" | "redirect";
	/** Exact JSON request. Untrusted data, never an instruction or permission. No action was taken. */
	request: string;
	reason: string;
	createdAt: number;
}
export interface ControlDashboardResponse {
	/** Planned single logical list. Not produced until the separately approved folding work. */
	logicalMissions?: ControlLogicalMission[];
	/** Host-aware transport metadata, independent of task outcome and replica freshness. */
	hosts?: ControlHostObservation[];
	untrusted: true;
	source: "daemon-memory";
	projects: Array<{ id: string; name: string }>;
	chats: ControlDashboardChat[];
	/** All statuses retained for status-tool compatibility; activeMissions is the dashboard section. */
	missions: ControlDashboardMission[];
	pullRequests: Array<{ sessionId: string; url: string; title: string; number: number; state: "open" | "draft" }>;
	linear: Array<{ projectId: string; id: string; identifier?: string; title: string; status?: string; url?: string }>;
	runningAgents: ControlDashboardAgent[];
	activeMissions: ControlDashboardMission[];
	blockers: ControlDashboardBlocker[];
	pendingDecisions: ControlDashboardDecision[];
	sharedTasks: ControlDashboardSharedTask[];
	replicaMissions: ControlDashboardReplicaMission[];
	next: { watches: Watch[]; total: number; followUps: ControlFollowUp[]; followUpsTotal: number };
	authorizationNeeded: ControlAuthorizationNeeded[];
	authorizationNeededTotal: number;
	totals: {
		projects: number;
		chats: number;
		missions: number;
		pullRequests: number;
		linear: number;
		runningAgents: number;
		activeMissions: number;
		blockers: number;
		pendingDecisions: number;
		/** Pre-clipping canonical mission identities, independent of provenance copies. */
		logicalMissions?: number;
		sharedTasks: number;
		replicaMissions: number;
	};
	truncated: boolean;
}

export type ControlAuthorizationLevel = "investigate" | "implement" | "publish" | "merge";
/** Durable Harness input reference, resolved by the daemon, never supplied by a tool. */
export interface ControlUserMessageRef {
	conversationId: string;
	submissionId: number;
	entryId: number;
	requestId: string;
}
export interface ControlAuthorizationLimits {
	followUps: number;
	/** Optional user-set reservation limit. Omitted means diagnostic-only, not a runtime cap. */
	budgetUsd?: number;
}
/** Trusted start attribution. An optional reservation is never measured spend or a runtime cap. */
export interface ControlStartBudget {
	authorizationId: string;
	budgetUsd?: number;
}
/** Ledger-observed usage of chats started under a grant, including child operations and archived chats. */
export interface ControlSpend {
	sessions: number;
	observedSessions: number;
	cost: import("./index.ts").AIUsageCost;
	coverage: "ledger_observed_partial";
}
export interface ControlAuthorization {
	id: string;
	/** Contract-only host allowlist. Omitted means home only; empty grants no hosts. */
	hosts?: OperationHost[];
	userMessage?: ControlUserMessageRef;
	/** Only grandfathered watch authorizations omit userMessage. */
	watchId?: string;
	scope: string;
	level: ControlAuthorizationLevel;
	targets: WatchTarget[];
	limits: ControlAuthorizationLimits;
	createdAt: number;
	expiresAt?: number;
	revokedAt?: number;
	usage: { followUps: number; budgetUsd: number };
	/** Gross historical reservations and releases. usage.budgetUsd is the outstanding balance, not spend. */
	budget?: { reservedUsd: number; releasedUsd: number };
	spend?: ControlSpend;
}
/** GET /api/control-chat/authorizations?after=<id>&limit=40. Includes revoked/expired records. */
export interface ControlAuthorizationsResponse {
	authorizations: ControlAuthorization[];
	next?: string;
}
/** DELETE /api/control-chat/authorizations/:id. Local app only, idempotent. */
export interface RevokeControlAuthorizationResponse {
	revoked: boolean;
}

/** Cross-host contract only. Requires negotiated enrollment/handlers; does not enable remote actions.
 * See docs/control-hosts.md for validation, bounds, recovery and archive rules. */
export type ControlDaemonRole = "home" | "executor" | "archived-control";
export interface ControlHostConfiguration {
	schemaVersion: 1;
	/** Monotonic persisted role fence; not a transport reconnect generation. */
	roleEpoch: number;
	stagedRole?: ControlStagedRole;
	freeze?: ControlFreezeIntent;
	home: OperationHost;
	host: OperationHost;
	role: ControlDaemonRole;
	controlSessionId?: string;
	/** Staged executor policy may coexist with this visible legacy Control until the final archive. */
	legacyControlSessionId?: string;
	/** Present only after the explicit, end-to-end-gated archive migration. */
	archive?: { sessionId: string; archivedAt: number };
}
export interface ControlHomeEnrollment {
	schemaVersion: 1;
	bindingId: string;
	generation: number;
	home: OperationHost;
	executor: OperationHost;
	state: "active" | "revoked";
}
/** Durable cutover evidence, pinned to one enrollment. A capability bit alone is not readiness. */
export interface ControlHostCutover {
	bindingId: string;
	generation: number;
	contractVersion: 1;
	roleFence: ControlRoleFence;
	compatibleRoutes: boolean;
	archiveReady: boolean;
	acceptance?: ControlAcceptanceProof;
	home: OperationHost;
	executor: OperationHost;
	state: "preparing" | "ready" | "archived";
	homeReady: boolean;
	executorEnrolled: boolean;
	/** Conclusive accepted operation, durably adopted at home. */
	actionReceiptOperationId?: string;
	/** Remote watch match durably imported at home after reconnect. */
	watchEventId?: string;
	/** Fully imported snapshot containing the required qualified task/epoch. */
	taskSnapshotId?: string;
	updatedAt: number;
}
/** PUT /api/control-hosts/:bindingId/enrollment on each confirmed peer. Local-user setup only. */
export interface ControlHomeEnrollmentRequest {
	enrollment: ControlHomeEnrollment;
	approvalRequestId: string;
	expectedRoleEpoch: number;
	/** Original hello from the app's verified peer endpoint; never an agent-supplied claim. */
	peerHello: import("./hello.ts").DaemonHello;
	/** null asserts no record; otherwise compare the persisted generation. Exact replay is idempotent. */
	expectedGeneration: number | null;
}
/** GET /api/control-hosts/:bindingId; also returned after durable enrollment. */
export interface ControlHostStateResponse {
	configuration: ControlHostConfiguration;
	enrollment: ControlHomeEnrollment;
	peerHello: import("./hello.ts").DaemonHello;
	/** Home-issued evidence, never readiness booleans supplied by the app/model. */
	cutover?: ControlHostCutover;
	/** At most the two persisted home/executor acknowledgments; no client-invented activation flags. */
	roleAcknowledgments?: ControlRoleAcknowledgment[];
	courierCapability?: ControlCourierCapability;
	pairing?: ControlPairingState;
	mutation?: ControlMutationResult;
}
/** POST /api/control-hosts/:bindingId/archive on home. App rollout only, not a pilot action. */
export interface ControlArchiveRequest {
	approvalRequestId: string;
	expectedRoleEpoch: number;
	expectedRoleFence: ControlRoleFence;
	expectedGeneration: number;
	sessionId: string;
	/** Becomes the immutable outgoing operationId; retained across app restarts/lost responses. */
	idempotencyKey: string;
}
/** Administrative payload. No authorization grant or spending capability is conveyed. */
export interface ControlArchiveOperationPayload {
	roleFence: ControlRoleFence;
	/** Native administrative consent, verified by executor independently of enrolled origin/courier auth. */
	approval: ControlArchiveApproval;
	idempotencyKey: string;
	sessionId: string;
	/** Home verifies evidence from its durable stores before sealing this operation. */
	readiness: ControlHostCutover;
}
/** A queued intent is not proof the executor is archived. Reconcile its receipt. */
export interface ControlArchiveResponse {
	operation: ControlDurableOperation;
}
/** Accepted control.archive receipt result, after the executor's durable transition. */
export interface ControlArchiveResult {
	kind: "control.archive";
	configuration: ControlHostConfiguration;
	cutover: ControlHostCutover;
	roleAcknowledgment: ControlRoleAcknowledgment;
}
export type ControlPilotAction =
	| "status"
	| "health"
	| "logs"
	| "telemetry"
	| "read"
	| "checks"
	| "authorize"
	| "authorizations"
	| "revoke"
	| "resolve_authorization"
	| "start"
	| "send"
	| "stop"
	| "pause"
	| "resume"
	| "redirect"
	| "mission_create"
	| "mission_attach"
	| "watch"
	| "unwatch"
	| "watches";
/** Future daemon routing envelope, not a replacement for today's flat tool arguments.
 * Host selects execution/evidence routing, never a mission partition or identity filter.
 * Resolve canonical mission refs independently; home-owned actions reject remote hosts. */
export interface ControlHostRequest {
	action: ControlPilotAction;
	host?: OperationHost;
	args: Record<string, unknown>;
}
export interface ControlBudgetReservation {
	reservationId: string;
	budgetUsd: number;
	followUps: number;
}
export interface ControlOperationAuthority {
	roleFence: ControlRoleFence;
	authorizationId: string;
	levelCeiling: ControlAuthorizationLevel;
	budgetReservation: ControlBudgetReservation;
	/** Equals DurableOperation.operationId; retries retain the original payload bytes. */
	idempotencyKey: string;
	/** Trusted home-admitted snapshot, not authority accepted from model/tool arguments. */
	authorization: ControlAuthorization;
}
export type ControlStartTarget =
	| { kind: "project"; projectId: string }
	| { kind: "task"; missionId: string; taskId: string; delegation: ControlDelegationFence };
export interface ControlStartOperationPayload extends ControlOperationAuthority {
	target: ControlStartTarget;
	message: string;
	model: string;
	thinking?: string;
}
export interface ControlSendOperationPayload extends ControlOperationAuthority {
	sessionId: string;
	message: string;
	direct?: boolean;
}
export type ControlRunOperationPayload = ControlOperationAuthority & { sessionId: string; direct?: boolean } & (
		| { action: "stop" | "pause" | "resume" }
		| { action: "redirect"; message: string }
	);
export interface ControlWatchOperationPayload extends ControlOperationAuthority {
	watch: WatchInput;
}
export interface ControlUnwatchOperationPayload extends ControlOperationAuthority {
	watchId: string;
}
export interface ControlRevokeOperationPayload extends ControlOperationAuthority {
	revokedAt: number;
}
export interface ControlOperationPayloads {
	"control.start": ControlStartOperationPayload;
	"control.send": ControlSendOperationPayload;
	"control.run": ControlRunOperationPayload;
	"control.watch": ControlWatchOperationPayload;
	"control.unwatch": ControlUnwatchOperationPayload;
	"control.revoke": ControlRevokeOperationPayload;
	/** App-triggered administrative transition, never a Control tool capability. */
	"control.archive": ControlArchiveOperationPayload;
}
export type ControlOperationKind = keyof ControlOperationPayloads;
/** Payload remains an exact JSON string in the existing immutable envelope. */
export type ControlDurableOperation = Omit<DurableOperation, "kind"> & { kind: ControlOperationKind };
export interface ControlOperationResult {
	kind: Exclude<ControlOperationKind, "control.archive">;
	authorizationId: string;
	sessionId?: string;
	watchId?: string;
	removed?: boolean;
	revokedAt?: number;
}
export interface ControlOperationExchangeRequest {
	peer: OperationHost;
	/** Omitted means ordinary. The courier drains revocation before ordinary on reconnect. */
	lane?: "revocation" | "ordinary";
	/** Resume a bounded outbox scan, including past still-pending operations. */
	cursor?: string;
}
export interface ControlOperationExchangeResponse {
	bindingId: string;
	generation: number;
	lane: "revocation" | "ordinary";
	operations: ControlDurableOperation[];
	more: boolean;
	next?: string;
}
export interface ControlOperationAcknowledgment {
	operation: ControlDurableOperation;
	receipt: OperationReceipt;
}
/** POST /api/control-hosts/:bindingId/ack response, only after conclusive durable adoption. */
export interface ControlReceiptAdoptionResponse {
	operationId: string;
	state: "accepted" | "rejected";
	/** Present after accepted archive's role acknowledgment is durably adopted. */
	roleAcknowledgment?: ControlRoleAcknowledgment;
}
export interface ControlUntrustedResultTail {
	untrusted: true;
	text: string;
	truncated: boolean;
}
export interface ControlRemoteEvent {
	sourceHost: OperationHost;
	eventId: string;
	cursor: number;
	watchId: string;
	authorizationId: string;
	kind: WatchEvent | "chat.result" | "watch.removed";
	occurredAt: number;
	/** Frozen at match time, including for consumed once-watches. */
	watch: Watch;
	operationId?: string;
	sessionId?: string;
	resultTail?: ControlUntrustedResultTail;
}
export interface ControlRemoteEventPage {
	bindingId: string;
	generation: number;
	sourceHost: OperationHost;
	after: number;
	head: number;
	acknowledgedThrough: number;
	acknowledgedEventId?: string;
	events: ControlRemoteEvent[];
	next?: number;
}
/** GET /api/control-hosts/:bindingId/events query. Enrollment resolves source/home. */
export interface ControlRemoteEventQuery {
	after: number;
	limit?: number;
}
export interface ControlRemoteEventAcknowledgment {
	bindingId: string;
	generation: number;
	sourceHost: OperationHost;
	through: number;
	/** Omitted only for through=0 on a fresh empty stream. */
	eventId?: string;
}
/** Bounded source observations merged into one logical mission list, never a per-host mission section.
 * Across pages the capture identity, time and totals stay fixed. SourceHost is transport provenance. */
export interface ControlRemoteStatusSnapshot {
	sourceHost: OperationHost;
	snapshotId: string;
	/** Durable per-binding capture counter, not mission intent revision or wall-clock order. */
	revision: number;
	capturedAt: number;
	/** Task/replica inputs and any planned logical projection live only inside dashboard. */
	dashboard: ControlDashboardResponse;
	truncated: boolean;
}
export interface ControlRemoteStatusPage {
	bindingId: string;
	generation: number;
	snapshot: ControlRemoteStatusSnapshot;
	/** Opaque cursor pinned to the captured snapshot; absent on its final page. */
	next?: string;
}
/** GET /api/control-hosts/:bindingId/status query; omitted cursor captures a new inventory. */
export interface ControlRemoteStatusQuery {
	cursor?: string;
}
/** POST /api/control-hosts/:bindingId/status/import. Same baseline CAS on every page of a capture. */
export interface ControlRemoteStatusImportRequest {
	page: ControlRemoteStatusPage;
	expectedPublishedRevision: number;
}
/** POST /api/control-hosts/:bindingId/status/import; duplicates return the same durable stage. */
export interface ControlRemoteStatusImportResponse {
	snapshotId: string;
	state: "staged" | "published";
	/** Home-local publication counter (zero before the first complete publication). */
	publishedRevision: number;
	/** Original capture's next cursor. Omitted only after the final page is published. */
	next?: string;
}

/** Reserved post-commit invalidation. Never emitted by reads, scan fences or unchanged acknowledgments. */
export interface ControlHostInvalidation {
	type: "control-hosts.changed";
	bindingId: string;
	generation: number;
	changes: Array<
		"outbox" | "receipts" | "events" | "status" | "enrollment" | "readiness" | "archive" | "role" | "reads"
	>;
}
export interface ControlRoleFence {
	home: number;
	executor: number;
}
/** Exact-intent native approval. Request IDs and loopback reachability alone are not authentication. */
export interface ControlHostApprovalInput {
	action: "enroll" | "unpair" | "archive" | "bootstrap";
	appKeyId: string;
	/** Exact UTF-8 JSON intent bytes, excluding approvalRequestId; at most 64 KiB. */
	intentPayload: string;
}
export interface ControlHostApprovalRequest {
	requestId: string;
	action: ControlHostApprovalInput["action"];
	appKeyId: string;
	requestingHost: OperationHost;
	home: OperationHost;
	executor: OperationHost;
	bindingId: string;
	generation: number;
	expectedRoleEpoch: number;
	intentHash: string;
	expiresAt: number;
	state: "pending" | "approved" | "denied" | "consumed";
	/** Exact UTF-8 bytes to sign, prefixed by "approve\\n" or "deny\\n". See docs/control-hosts.md. */
	signingPayload: string;
}
export interface ControlHostApprovalDecision {
	allow: boolean;
	appKeyId: string;
	/** Base64 Ed25519 signature; private app key never leaves native secure storage. */
	signature: string;
}
export interface ControlArchiveApproval {
	request: ControlHostApprovalRequest;
	decision: ControlHostApprovalDecision;
	/** Exact original archive intent excluding approvalRequestId; digest is signed in request.signingPayload. */
	intentPayload: string;
	/** Home's durable consumption time, no later than request expiry. */
	consumedAt: number;
}
export interface ControlUnpairRequest {
	approvalRequestId: string;
	expectedGeneration: number;
	expectedRoleEpoch: number;
	idempotencyKey: string;
}
export interface ControlUnpairResponse {
	enrollment: ControlHomeEnrollment;
	configuration: ControlHostConfiguration;
	revokedAt: number;
	peerAcknowledged: boolean;
}
export interface ControlEventImportCursor {
	sourceHost: OperationHost;
	importedThrough: number;
	lastEventId?: string;
	acknowledgedThrough: number;
	head: number;
}
export interface ControlHostSyncState {
	bindingId: string;
	generation: number;
	/** Cursor owner, not necessarily event source. */
	host: OperationHost;
	events: ControlEventImportCursor;
	status?: {
		snapshotId: string;
		revision: number;
		publishedRevision: number;
		next?: string;
		state: "staged" | "published";
		importedAt: number;
	};
	reconciliationRequired: boolean;
}
export interface ControlAcceptanceProof {
	suite: "control-hosts-two-daemon-v1";
	homeBuildId: string;
	executorBuildId: string;
	daemonProofId: string;
	/** May be absent while preparing; required, verified and build-matched before ready/activation. */
	realCourier?: ControlRealCourierProof;
}
export interface ControlRealCourierProof {
	suite: "control-hosts-real-courier-v1";
	appBuildId: string;
	proofId: string;
}
export interface ControlRoleAcknowledgment {
	contractVersion: 1;
	bindingId: string;
	generation: number;
	home: OperationHost;
	host: OperationHost;
	role: ControlDaemonRole;
	roleEpoch: number;
	/** Enrollment's consumed native approval ID, or archive's original operationId. */
	intentId: string;
	sessionId?: string;
	archivedAt?: number;
}
export interface ControlArchivedWatch {
	watch: Watch;
	disposition: "stopped" | "fired";
	stoppedAt?: number;
	auditReason?: string;
}
export interface ControlArchivedWatchesResponse {
	watches: ControlArchivedWatch[];
	next?: string;
}
export type ControlHostAvailability = "available" | "disconnected" | "unknown";
export interface ControlHostObservation {
	host: OperationHost;
	availability: ControlHostAvailability;
	capturedAt?: number;
	importedAt?: number;
	snapshotAgeMs: number | null;
}
export interface ControlArchiveInfo {
	source: import("./shared-context.ts").SharedSessionRef;
	archivedAt: number;
	roleEpoch: number;
	readOnly: true;
}
export interface ControlArchiveRead<T> {
	archive: ControlArchiveInfo;
	value: T;
}
export interface ControlArchiveHistoryPage {
	entries: import("./index.ts").EntryRecord[];
	next?: number;
}
export interface ControlOperationLifecycle {
	operationId: string;
	kind: ControlOperationKind;
	targetId: string;
	delivery: "queued" | "unknown" | "pending" | "accepted" | "rejected";
	possiblyTransmitted: boolean;
}
export interface ControlHostLifecycleResponse {
	bindingId: string;
	generation: number;
	host: OperationHost;
	capturedAt: number;
	updateReady: boolean;
	operations: ControlOperationLifecycle[];
	blockers: Array<{
		kind: "control.operation" | "control.approval" | "control.archive" | "control.journal" | "control.sync";
		id: string;
	}>;
	truncated: boolean;
}

/** Machine-readable errors for the reserved Control-host routes, not generic operation receipts. */
export interface ControlHostErrorResponse {
	code:
		| "invalid_request"
		| "approval_required"
		| "approval_expired"
		| "not_found"
		| "incompatible_peer"
		| "identity_mismatch"
		| "stale_role"
		| "stale_generation"
		| "reconciliation_required"
		| "snapshot_restart_required"
		| "stale_snapshot"
		| "snapshot_cas_mismatch"
		| "cursor_gap"
		| "cursor_before_floor"
		| "delegation_required"
		| "delegation_stale"
		| "delegation_sealed"
		| "delegation_reassigned"
		| "rollback_not_permitted"
		| "authentication_required"
		| "capability_denied"
		| "capability_expired"
		| "read_unavailable"
		| "legacy_migration_required"
		| "not_ready"
		| "capacity";
	error: string;
	syncState?: ControlHostSyncState;
	checkpoint?: ControlRemoteEventCheckpoint;
	floor?: ControlEventFloor;
	current?: ControlHostStateResponse;
}

/** Pairing stages this target only; it does not change the effective role or freeze legacy turns. */
export interface ControlStagedRole {
	home: OperationHost;
	role: "executor";
	phase: "paired";
}
export interface ControlFreezeIntent {
	operationId: string;
	expectedRoleEpoch: number;
	phase: "requested" | "draining" | "blocked";
}
/** Reference to an immutable, already-owned grant. Never substitute a newer current grant. */
export type ControlDelegationFence = Pick<
	import("./shared-context.ts").DelegationGrant,
	| "delegationId"
	| "task"
	| "bindingId"
	| "bindingGeneration"
	| "executionEpoch"
	| "session"
	| "target"
	| "definitionRevision"
	| "context"
	| "manifestId"
> & {
	grantHash: string;
	/** Execution.operationId owns the existing session creation and original opening input. */
	placementOperationId: string;
};
export type ControlEnrollmentPreviewRequest = Omit<ControlHomeEnrollmentRequest, "approvalRequestId">;
export interface ControlEnrollmentPreviewResponse {
	intentPayload: string;
	intentHash: string;
	compatible: boolean;
	effect: "pair-only";
	courierScopes: ControlCourierCapability["scopes"];
	current?: ControlHostStateResponse;
	errors: ControlHostErrorResponse[];
}
/** Metadata only, never a native approval or a Control grant. */
export interface ControlCourierCapability {
	id: string;
	bindingId: string;
	generation: number;
	home: OperationHost;
	executor: OperationHost;
	appKeyId: string;
	roleFence: ControlRoleFence;
	expiresAt: number;
	scopes: Array<"exchange" | "receipts" | "events" | "status" | "reads" | "inspect" | "archive-read">;
}
/** Exact UTF-8 signedPayload in an authenticated HTTP header; no canonical reserialization. */
export interface ControlCourierAuthentication {
	signedPayload: string;
	signature: string;
}
export interface ControlCourierCapabilityRefreshRequest {
	capabilityId: string;
	expectedRoleEpoch: number;
}
export interface ControlCourierRequestProof {
	capabilityId: string;
	requestId: string;
	issuedAt: number;
	method: "GET" | "POST";
	path: string;
	bodyHash: string;
}
/** Signed management authentication is distinct from the scoped courier capability. */
export type ControlNativeRequestProof = Omit<ControlCourierRequestProof, "capabilityId" | "method"> & {
	appKeyId: string;
	host: OperationHost;
	method: "GET" | "POST" | "PUT";
};
export interface ControlRemoteEventCheckpoint extends ControlEventImportCursor {
	bindingId: string;
	generation: number;
	home: OperationHost;
}
export interface ControlEventFloor {
	bindingId: string;
	generation: number;
	sourceHost: OperationHost;
	through: number;
	eventId?: string;
}
export type ControlReadAction = "read" | "health" | "logs" | "telemetry" | "checks";
export interface ControlReadSelectors {
	sessionId?: string;
	view?: "result" | "tail";
	limit?: number;
	source?: "daemon" | "lifecycle" | "session";
	since?: string;
	q?: string;
	pr?: string;
	includeStale?: boolean;
}
export interface ControlRemoteReadRequest {
	requestId: string;
	host: OperationHost;
	action: ControlReadAction;
	selectors: ControlReadSelectors;
}
export interface ControlRemoteReadResponse {
	requestId: string;
	sourceHost: OperationHost;
	capturedAt: number;
	untrusted: true;
	result: unknown;
	truncated: boolean;
	availability: "available";
}
export interface ControlRemoteReadOutcome {
	requestId: string;
	host: OperationHost;
	availability: ControlHostAvailability;
	response?: ControlRemoteReadResponse;
	error?: ControlHostErrorResponse;
}
export interface ControlReadImportRequest {
	outcome: ControlRemoteReadOutcome;
}
export interface ControlReadExchangeRequest {
	peer: OperationHost;
	cursor?: string;
}
export interface ControlReadExchangeResponse {
	requests: ControlRemoteReadRequest[];
	next?: string;
	more: boolean;
}
export interface ControlReadImportResponse {
	requestId: string;
	state: "delivered" | "expired";
}

export interface ControlMutationResult {
	disposition: "applied" | "replayed";
	intentId: string;
}
export interface ControlPairingState {
	phase: "partial" | "paired" | "revoked";
	localCommitted: true;
	peerCommitted: boolean;
}
export interface ControlPairingAcknowledgment {
	peerRoleAcknowledgment: ControlRoleAcknowledgment;
	peerHello: import("./hello.ts").DaemonHello;
}
export interface ControlArchiveLookupResponse {
	operation: ControlDurableOperation;
	delivery: import("./operations.ts").OperationDelivery;
	adopted: boolean;
	roleAcknowledgment?: ControlRoleAcknowledgment;
}
export interface ControlRoleBootstrapRequest {
	host: OperationHost;
	home: OperationHost;
	role: "home" | "executor";
	mode: "fresh" | "preserve-legacy";
	expectedRoleEpoch: 0;
	idempotencyKey: string;
	approvalRequestId: string;
}
export interface ControlRoleBootstrapStatus {
	host: OperationHost;
	state: "unconfigured" | "configured" | "legacy-migration-required";
	roleEpoch: number;
	configuration?: ControlHostConfiguration;
	roleAcknowledgment?: ControlRoleAcknowledgment;
}
export interface ControlRoleBootstrapResult {
	configuration: ControlHostConfiguration;
	roleAcknowledgment: ControlRoleAcknowledgment;
	mutation: ControlMutationResult;
}
