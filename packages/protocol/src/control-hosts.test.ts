import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type * as C from "./control.ts";

import type { DaemonHello } from "./hello.ts";
import type {
	ControlArchiveRequest,
	ControlArchiveResponse,
	ControlArchiveResult,
	ControlAuthorization,
	ControlBudgetReservation,
	ControlHomeEnrollment,
	ControlHomeEnrollmentRequest,
	ControlHostConfiguration,
	ControlHostCutover,
	ControlHostRequest,
	ControlHostStateResponse,
	ControlOperationAcknowledgment,
	ControlOperationAuthority,
	ControlOperationExchangeRequest,
	ControlOperationExchangeResponse,
	ControlOperationKind,
	ControlOperationPayloads,
	ControlReceiptAdoptionResponse,
	ControlRemoteEventAcknowledgment,
	ControlRemoteEventPage,
	ControlRemoteEventQuery,
	ControlRemoteStatusImportResponse,
	ControlRemoteStatusPage,
	ControlRemoteStatusQuery,
} from "./index.ts";

type PayloadFixture = {
	[K in ControlOperationKind]: { kind: K; payload: ControlOperationPayloads[K] };
}[ControlOperationKind];
interface Fixtures {
	archiveApproval: C.ControlArchiveApproval;
	archiveApprovalErrors: C.ControlHostErrorResponse[];
	emptyAckPolicy: {
		page: C.ControlRemoteEventPage;
		homeAcknowledgment: C.ControlRemoteEventAcknowledgment;
		executorAckNeeded: boolean;
	};
	readOutcomes: C.ControlRemoteReadOutcome[];
	readImportRequests: C.ControlReadImportRequest[];
	pairingResults: C.ControlHostStateResponse[];
	pairingAcknowledgment: C.ControlPairingAcknowledgment;
	pairingConflict: C.ControlHostErrorResponse;
	archiveLookups: C.ControlArchiveLookupResponse[];
	bootstrapRequests: C.ControlRoleBootstrapRequest[];
	bootstrapStatuses: C.ControlRoleBootstrapStatus[];
	bootstrapResults: C.ControlRoleBootstrapResult[];
	bootstrapApproval: C.ControlHostApprovalInput;
	bootstrapError: C.ControlHostErrorResponse;
	stagingRollback: C.ControlUnpairResponse;
	authErrors: C.ControlHostErrorResponse[];
	delegationFence: C.ControlDelegationFence;
	taskStartOperation: C.ControlDurableOperation;
	delegationCases: Array<{
		name: string;
		sealed: C.ControlDelegationFence;
		retained: C.ControlDelegationFence & { state?: string };
		error: C.ControlHostErrorResponse;
	}>;
	checkpoints: C.ControlRemoteEventCheckpoint[];
	eventFloors: C.ControlEventFloor[];
	emptyEventPages: C.ControlRemoteEventPage[];
	emptyEventAcknowledgments: C.ControlRemoteEventAcknowledgment[];
	relaunchAfterRetirement: {
		checkpoint: C.ControlRemoteEventCheckpoint;
		query: C.ControlRemoteEventQuery;
		page: C.ControlRemoteEventPage;
		ack: C.ControlRemoteEventAcknowledgment;
	};
	cursorErrors: C.ControlHostErrorResponse[];
	statusRecoveryCases: Array<{
		name: string;
		request: C.ControlRemoteStatusImportRequest;
		publishedSourceRevision?: number;
		response?: C.ControlRemoteStatusImportResponse;
		currentPublishedRevision?: number;
		checkpoint?: C.ControlHostSyncState;
		error?: C.ControlHostErrorResponse;
	}>;
	courierCapability: C.ControlCourierCapability;
	capabilityRefresh: C.ControlCourierCapabilityRefreshRequest;
	previewRequest: C.ControlEnrollmentPreviewRequest;
	previewResponse: C.ControlEnrollmentPreviewResponse;
	stagedStates: C.ControlHostStateResponse[];
	rollbackError: C.ControlHostErrorResponse;
	courierProof: C.ControlCourierRequestProof;
	nativeProof: C.ControlNativeRequestProof;
	nativeEnrollmentProof: C.ControlNativeRequestProof;
	authentications: C.ControlCourierAuthentication[];
	readRequests: C.ControlRemoteReadRequest[];
	readResponses: C.ControlRemoteReadResponse[];
	readExchangeRequest: C.ControlReadExchangeRequest;
	readExchangeResponse: C.ControlReadExchangeResponse;
	readImports: C.ControlReadImportResponse[];
	proofs: C.ControlAcceptanceProof[];
	preparingProofCutover: C.ControlHostCutover;
	roleAcknowledgments: C.ControlRoleAcknowledgment[];
	activatedHomeState: C.ControlHostStateResponse;
	archiveAdoption: C.ControlReceiptAdoptionResponse;
	statusImportRequests: C.ControlRemoteStatusImportRequest[];
	safetyQuery: C.ControlOperationExchangeRequest;
	safetyExchange: C.ControlOperationExchangeResponse;
	errors: C.ControlHostErrorResponse[];
	approvalInputs: C.ControlHostApprovalInput[];
	approvalRequests: C.ControlHostApprovalRequest[];
	approvalDecisions: C.ControlHostApprovalDecision[];
	unpairRequest: C.ControlUnpairRequest;
	unpairResponses: C.ControlUnpairResponse[];
	invalidations: C.ControlHostInvalidation[];
	syncStates: C.ControlHostSyncState[];
	sharedTasks: C.ControlDashboardSharedTask[];
	replicaMissions: C.ControlDashboardReplicaMission[];
	hostObservations: C.ControlHostObservation[];
	dashboardProjection: C.ControlDashboardResponse;
	archiveInfo: C.ControlArchiveInfo;
	archiveReads: {
		watches: C.ControlArchiveRead<C.ControlArchivedWatchesResponse>;
		history: C.ControlArchiveRead<C.ControlArchiveHistoryPage>;
		authorizations: C.ControlArchiveRead<C.ControlAuthorizationsResponse>;
	};
	lifecycles: C.ControlHostLifecycleResponse[];
	enrollmentRequests: ControlHomeEnrollmentRequest[];
	hostStates: ControlHostStateResponse[];
	archiveRequest: ControlArchiveRequest;
	archiveResponse: ControlArchiveResponse;
	archiveResult: ControlArchiveResult;
	archiveAcknowledgments: ControlOperationAcknowledgment[];
	outboxQueries: ControlOperationExchangeRequest[];
	outboxPages: ControlOperationExchangeResponse[];
	receiptAdoptions: ControlReceiptAdoptionResponse[];
	eventQueries: ControlRemoteEventQuery[];
	statusQueries: ControlRemoteStatusQuery[];
	statusImports: ControlRemoteStatusImportResponse[];
	hellos: DaemonHello[];
	cutovers: ControlHostCutover[];
	configurations: ControlHostConfiguration[];
	enrollments: ControlHomeEnrollment[];
	requests: ControlHostRequest[];
	authorizations: ControlAuthorization[];
	payloads: PayloadFixture[];
	exchangeRequest: ControlOperationExchangeRequest;
	exchange: ControlOperationExchangeResponse;
	acknowledgments: ControlOperationAcknowledgment[];
	eventPages: ControlRemoteEventPage[];
	eventAcknowledgment: ControlRemoteEventAcknowledgment;
	statusPages: ControlRemoteStatusPage[];
}
const fixture: Fixtures = JSON.parse(readFileSync(new URL("../fixtures/control-hosts.json", import.meta.url), "utf8"));
function roundTrip<T>(value: T): T {
	const decoded: T = JSON.parse(JSON.stringify(value));
	assert.deepEqual(decoded, value);
	return decoded;
}
test("Control host identity, default-home requests and explicit authorization hosts round trip", () => {
	const f = roundTrip(fixture);
	assert.equal(f.hellos[0].capabilities.controlHosts, undefined);
	assert.equal(f.hellos[0].controlHost, undefined);
	assert.deepEqual(
		f.hellos.slice(1).map((h) => h.controlHost?.role),
		["home", "executor", "archived-control"],
	);
	assert.ok(f.hellos.slice(1).every((h) => h.capabilities.controlHosts === 1));
	assert.deepEqual(
		f.cutovers.map((c) => c.state),
		["preparing", "ready", "archived"],
	);
	assert.equal(f.cutovers[0].watchEventId, undefined);
	assert.equal(f.cutovers[1].actionReceiptOperationId, "operation:1");
	assert.deepEqual(
		f.configurations.map((c) => c.role),
		["home", "executor", "archived-control"],
	);
	assert.deepEqual(f.configurations[0].home, f.configurations[0].host);
	assert.equal(f.configurations[2].archive?.sessionId, "old-control");
	assert.deepEqual(
		f.enrollments.map((e) => e.state),
		["active", "revoked"],
	);
	for (let i = 0; i < f.requests.length; i += 2) {
		assert.equal(f.requests[i].host, undefined);
		assert.deepEqual(f.requests[i + 1].host, f.enrollments[0].executor);
		assert.equal(f.requests[i].action, f.requests[i + 1].action);
	}
	assert.equal(f.authorizations[0].hosts?.length, 2);
	assert.equal(f.authorizations[1].hosts, undefined);
	assert.deepEqual(f.authorizations[2].hosts, []);
	assert.deepEqual(f.authorizations[0].targets[0].host, f.enrollments[0].executor);
});
test("all durable Control payloads retain the admission authority and typed body", () => {
	const authority: ControlOperationAuthority = {
		roleFence: { home: 1, executor: 2 },
		authorizationId: "auth:1",
		levelCeiling: "implement",
		budgetReservation: { reservationId: "reservation:1", budgetUsd: 1, followUps: 1 },
		idempotencyKey: "operation:1",
		authorization: fixture.authorizations[0],
	};
	const free: ControlBudgetReservation = { reservationId: "reservation:1", budgetUsd: 0, followUps: 0 };
	const expected: PayloadFixture[] = [
		{
			kind: "control.start",
			payload: {
				...authority,
				target: { kind: "project", projectId: "p" },
				message: "Investigate",
				model: "fake/model",
				thinking: "high",
			},
		},
		{
			kind: "control.start",
			payload: {
				...authority,
				target: { kind: "task", missionId: "m", taskId: "t", delegation: fixture.delegationFence },
				message: "Investigate task",
				model: "fake/model",
			},
		},
		{ kind: "control.send", payload: { ...authority, sessionId: "chat:1", message: "Continue", direct: true } },
		...(["stop", "pause", "resume"] as const).map(
			(action): PayloadFixture => ({
				kind: "control.run",
				payload: {
					...authority,
					sessionId: "chat:1",
					action,
					budgetReservation: { ...free, budgetUsd: action === "resume" ? 1 : 0 },
				},
			}),
		),
		{
			kind: "control.run",
			payload: { ...authority, sessionId: "chat:1", action: "redirect", message: "Change direction", direct: true },
		},
		{
			kind: "control.watch",
			payload: {
				...authority,
				budgetReservation: free,
				watch: {
					authorizationId: "auth:1",
					event: "chat.settled",
					target: { host: fixture.enrollments[0].executor, kind: "chat", id: "chat:1" },
					mode: "once",
					note: "Read the result",
					expiresAt: 10000,
				},
			},
		},
		{ kind: "control.unwatch", payload: { ...authority, budgetReservation: free, watchId: "watch:1" } },
		{ kind: "control.revoke", payload: { ...authority, budgetReservation: free, revokedAt: 2000 } },
		{
			kind: "control.archive",
			payload: {
				approval: fixture.archiveApproval,
				roleFence: { home: 1, executor: 2 },
				idempotencyKey: "archive:1",
				sessionId: "old-control",
				readiness: fixture.cutovers[1],
			},
		},
	];
	assert.deepEqual(roundTrip(expected), fixture.payloads);
	assert.equal(new Set(expected.map((p) => p.kind)).size, 7);
});
test("enrollment CAS, courier page queries and app-only archive HTTP contracts round trip", () => {
	const f = roundTrip(fixture);
	const create: ControlHomeEnrollmentRequest = {
		approvalRequestId: "approval:enroll:0",
		expectedRoleEpoch: 2,
		enrollment: f.enrollments[0],
		peerHello: f.hellos[1],
		expectedGeneration: null,
	};
	assert.deepEqual(f.enrollmentRequests[0], create);
	assert.ok(Object.hasOwn(f.enrollmentRequests[0], "expectedGeneration"));
	assert.equal(f.enrollmentRequests[2].expectedGeneration, 1);
	assert.equal(f.enrollmentRequests[2].enrollment.state, "revoked");
	assert.equal(f.hostStates[0].cutover, undefined);
	assert.equal(f.hostStates[1].cutover?.state, "ready");
	assert.equal(f.hostStates[2].configuration.archive?.sessionId, "old-control");
	const request: ControlArchiveRequest = {
		expectedRoleFence: { home: 1, executor: 2 },
		approvalRequestId: "approval:archive",
		expectedRoleEpoch: 1,
		expectedGeneration: 1,
		sessionId: "old-control",
		idempotencyKey: "archive:1",
	};
	assert.deepEqual(f.archiveRequest, request);
	const operation = f.archiveResponse.operation;
	assert.equal(operation.kind, "control.archive");
	assert.equal(operation.operationId, request.idempotencyKey);
	assert.equal(operation.targetId, request.sessionId);
	const payload: ControlOperationPayloads["control.archive"] = JSON.parse(operation.payload);
	assert.deepEqual(payload.readiness, f.cutovers[1]);
	assert.equal(Object.hasOwn(payload, "authorization"), false);
	assert.equal(Object.hasOwn(payload, "budgetReservation"), false);
	assert.equal(f.archiveResult.kind, "control.archive");
	assert.equal(f.archiveResult.cutover.state, "archived");
	assert.deepEqual(
		f.archiveAcknowledgments.map((a) => a.receipt.state),
		["pending", "accepted", "rejected"],
	);
	for (const ack of f.archiveAcknowledgments) {
		assert.deepEqual(ack.operation, operation);
		assert.equal(ack.receipt.operationId, operation.operationId);
		assert.equal(ack.receipt.targetId, operation.targetId);
	}
	assert.equal(f.outboxQueries[1].cursor, f.outboxPages[0].next);
	assert.ok(f.outboxPages[0].more);
	assert.equal(f.outboxPages[1].more, false);
	assert.equal(f.outboxPages[1].next, undefined);
	assert.deepEqual(
		f.receiptAdoptions.map((a) => a.state),
		["accepted", "rejected"],
	);
	assert.equal(f.eventQueries[0].after, 0);
	assert.equal(f.eventQueries[0].limit, 128);
	assert.equal(f.statusQueries[0].cursor, undefined);
	assert.equal(f.statusQueries[1].cursor, f.statusImports[0].next);
	assert.deepEqual(
		f.statusImports.map((s) => s.state),
		["staged", "published"],
	);
	assert.deepEqual(
		f.statusImports.map((s) => s.publishedRevision),
		[0, 1],
	);
	assert.ok(f.statusImportRequests.every((r) => r.expectedPublishedRevision === 0));
	assert.ok(f.statusImportRequests.every((r) => r.page.snapshot.revision === 1));
	assert.equal(f.safetyQuery.lane, "revocation");
	assert.equal(f.safetyExchange.lane, "revocation");
	assert.equal(f.safetyExchange.operations[0].kind, "control.revoke");
	assert.equal(f.outboxPages[0].lane, "ordinary");
});
test("courier envelope and pending, accepted, rejected receipts retain immutable matching fields", () => {
	const exchange = roundTrip(fixture.exchange);
	assert.equal(exchange.more, false);
	assert.deepEqual(fixture.exchangeRequest.peer, fixture.enrollments[0].executor);
	const operation = exchange.operations[0];
	assert.deepEqual(JSON.parse(operation.payload), fixture.payloads[0].payload);
	assert.equal(operation.bindingId, fixture.enrollments[0].bindingId);
	assert.equal(operation.bindingGeneration, fixture.enrollments[0].generation);
	for (const ack of roundTrip(fixture.acknowledgments)) {
		assert.deepEqual(ack.operation, operation);
		for (const key of ["operationId", "payloadHash", "destination", "targetId"] as const)
			assert.deepEqual(ack.receipt[key], operation[key]);
	}
	assert.deepEqual(
		fixture.acknowledgments.map((a) => a.receipt.state),
		["pending", "accepted", "rejected"],
	);
});
test("remote journal and frozen status pages round trip without losing source, cursors or untrusted tails", () => {
	const page = roundTrip(fixture.eventPages[0]);
	const event = page.events[0];
	assert.equal(page.after, 0);
	assert.equal(page.next, event.cursor);
	assert.equal(event.watch.id, event.watchId);
	assert.equal(event.resultTail?.untrusted, true);
	assert.ok(Buffer.byteLength(event.resultTail?.text ?? "") <= 2000);
	assert.match(event.resultTail?.text ?? "", /café 🛠/u);
	assert.deepEqual(fixture.eventAcknowledgment.sourceHost, page.sourceHost);
	assert.equal(fixture.eventAcknowledgment.through, event.cursor);
	assert.equal(fixture.eventPages[1].next, undefined);
	const pages = roundTrip(fixture.statusPages);
	assert.equal(pages[0].snapshot.snapshotId, pages[1].snapshot.snapshotId);
	assert.equal(pages[0].snapshot.capturedAt, pages[1].snapshot.capturedAt);
	assert.equal(pages[0].snapshot.missionTasksTotal, 2);
	assert.equal(pages[0].snapshot.missionTasks[0].grantState, "accepted");
	assert.equal(pages[1].snapshot.missionTasks[0].consistency, "provisional");
	assert.equal(pages[1].next, undefined);
});

test("audit contract preserves approval scope, durable cursors, task provenance, archived stores and lifecycle uncertainty", () => {
	const f = roundTrip(fixture);
	assert.equal(f.configurations[0].roleEpoch, 1);
	assert.equal(f.configurations[2].roleEpoch, 3);
	assert.deepEqual(
		f.approvalInputs.map((a) => a.action),
		["enroll", "unpair", "archive"],
	);
	for (const request of f.approvalRequests) {
		const signed = JSON.parse(request.signingPayload);
		assert.equal(signed.requestId, request.requestId);
		assert.deepEqual(signed.requestingHost, request.requestingHost);
		assert.deepEqual(signed.home, request.home);
		assert.deepEqual(signed.executor, request.executor);
		assert.equal(signed.expectedRoleEpoch, request.expectedRoleEpoch);
		assert.equal(signed.intentHash, request.intentHash);
	}
	assert.deepEqual(
		f.approvalRequests.map((a) => a.state),
		["pending", "approved", "denied", "consumed"],
	);
	assert.deepEqual(
		f.approvalDecisions.map((d) => d.allow),
		[true, false],
	);
	assert.deepEqual(
		f.unpairResponses.map((r) => r.peerAcknowledged),
		[false, true],
	);
	assert.equal(f.unpairResponses[0].enrollment.state, "revoked");
	assert.equal(f.invalidations[0].type, "control-hosts.changed");
	assert.equal(new Set(f.invalidations[0].changes).size, 9);
	assert.equal(f.syncStates[0].events.importedThrough, 1);
	assert.equal(f.syncStates[0].events.acknowledgedThrough, 0);
	assert.equal(f.syncStates[1].events.acknowledgedThrough, 1);
	assert.ok(f.cutovers[1].compatibleRoutes && f.cutovers[1].archiveReady);
	assert.equal(f.cutovers[1].acceptance?.suite, "control-hosts-two-daemon-v1");
	assert.equal(f.cutovers[1].acceptance?.realCourier?.suite, "control-hosts-real-courier-v1");
	assert.equal(f.proofs[0].realCourier, undefined);
	assert.equal(f.preparingProofCutover.state, "preparing");
	assert.equal(f.proofs[1].realCourier?.appBuildId, "fixture-app-build");
	const roleAck = f.archiveAdoption.roleAcknowledgment;
	assert.equal(roleAck?.intentId, f.archiveResponse.operation.operationId);
	assert.equal(roleAck?.role, "archived-control");
	assert.equal(roleAck?.roleEpoch, f.archiveResult.configuration.roleEpoch);
	assert.equal(roleAck?.sessionId, f.archiveResponse.operation.targetId);
	assert.deepEqual(f.archiveResult.roleAcknowledgment, roleAck);
	assert.deepEqual(f.activatedHomeState.roleAcknowledgments?.[1], roleAck);
	assert.equal(f.archiveReads.watches.value.watches[0].auditReason, "legacy-control-frozen");
	assert.deepEqual(
		f.archiveReads.watches.value.watches.map((w) => w.disposition),
		["stopped", "fired"],
	);
	assert.equal(f.sharedTasks[0].id, f.sharedTasks[1].id);
	assert.equal(f.sharedTasks[0].id, f.sharedTasks[2].id);
	assert.equal(f.sharedTasks[3].taskId, undefined);
	assert.equal(f.sharedTasks[3].taskNumber, undefined);
	assert.equal(f.sharedTasks[3].proposalOrigin?.host.daemonId, "executor-daemon");
	assert.equal(f.replicaMissions[1].replicaAgeMs, null);
	assert.deepEqual(
		f.hostObservations.map((h) => h.availability),
		["available", "disconnected", "unknown"],
	);
	assert.equal(f.archiveReads.history.archive.readOnly, true);
	assert.deepEqual(f.archiveReads.authorizations.value.authorizations, f.authorizations);
	assert.equal(f.lifecycles[0].updateReady, false);
	assert.equal(f.errors[0].code, "reconciliation_required");
	assert.equal(f.errors[0].syncState?.reconciliationRequired, true);
	assert.equal(f.dashboardProjection.sharedTasks?.length, 2);
	assert.notEqual(f.sharedTasks[0].bindingId, f.sharedTasks[2].bindingId);
	assert.equal(f.sharedTasks[2].grantBindingId, f.sharedTasks[0].grantBindingId);
	assert.deepEqual(
		f.lifecycles[0].operations.map((o) => o.delivery),
		["queued", "unknown", "pending", "accepted", "rejected"],
	);
});

test("wire-adoption fixtures cover checkpoint retirement, empty acknowledgments, causal status recovery and immutable delegation", () => {
	const f = roundTrip(fixture);
	assert.equal(f.emptyEventAcknowledgments[0].through, 0);
	assert.equal(f.emptyEventAcknowledgments[0].eventId, undefined);
	assert.equal(f.emptyEventPages[0].head, 0);
	assert.equal(f.emptyEventPages[0].next, undefined);
	const recovery = f.relaunchAfterRetirement;
	assert.equal(recovery.query.after, recovery.checkpoint.importedThrough);
	assert.equal(recovery.query.after, recovery.page.acknowledgedThrough);
	assert.equal(recovery.ack.eventId, recovery.checkpoint.lastEventId);
	assert.ok(recovery.query.after > 0);
	assert.deepEqual(
		f.cursorErrors.map((e) => e.code),
		["cursor_before_floor", "cursor_gap"],
	);
	assert.equal(f.cursorErrors[0].floor?.through, 2);
	assert.equal(f.statusRecoveryCases[0].error?.code, "stale_snapshot");
	assert.equal(f.statusRecoveryCases[1].response?.publishedRevision, 1);
	assert.equal(f.statusRecoveryCases[1].currentPublishedRevision, 2);
	assert.equal(f.statusRecoveryCases[2].checkpoint?.status?.next, "snapshot:1/page:2");
	assert.equal(f.statusRecoveryCases[2].request.expectedPublishedRevision, 0);
	assert.equal(f.statusRecoveryCases[3].error?.code, "identity_mismatch");
	const replacement = f.statusRecoveryCases[3].request.page.snapshot.sourceHost;
	assert.notEqual(replacement.lineageId, f.checkpoints[1].sourceHost.lineageId);
	assert.equal(f.taskStartOperation.targetId, f.delegationFence.session.sessionId);
	assert.notEqual(f.taskStartOperation.operationId, f.delegationFence.placementOperationId);
	assert.equal(f.delegationFence.task.mission.home.daemonId, f.configurations[0].host.daemonId);
	assert.notEqual(f.taskStartOperation.bindingId, f.delegationFence.bindingId);
	assert.deepEqual(
		f.delegationCases.map((c) => c.error.code),
		["delegation_stale", "delegation_sealed", "delegation_reassigned"],
	);
	for (const c of f.delegationCases) assert.deepEqual(c.sealed, f.delegationFence);
});
test("wire-adoption fixtures separate staged pairing, native approval, courier capabilities and bounded read relay", () => {
	const f = roundTrip(fixture);
	assert.equal(f.previewResponse.effect, "pair-only");
	assert.deepEqual(JSON.parse(f.previewResponse.intentPayload), f.previewRequest);
	assert.equal(f.stagedStates[0].configuration.role, "home");
	assert.equal(f.stagedStates[0].configuration.stagedRole?.role, "executor");
	assert.equal(f.stagedStates[0].configuration.freeze, undefined);
	assert.equal(f.stagedStates[1].configuration.freeze?.phase, "blocked");
	assert.equal(f.stagingRollback.configuration.role, "home");
	assert.equal(f.stagingRollback.configuration.stagedRole, undefined);
	assert.equal(f.stagingRollback.configuration.freeze, undefined);
	assert.equal(f.stagingRollback.enrollment.state, "revoked");
	assert.deepEqual(
		f.authErrors.map((e) => e.code),
		["authentication_required", "capability_denied", "capability_expired", "read_unavailable"],
	);
	assert.equal(f.rollbackError.code, "rollback_not_permitted");
	assert.deepEqual(JSON.parse(f.authentications[0].signedPayload), f.courierProof);
	assert.deepEqual(JSON.parse(f.authentications[1].signedPayload), f.nativeProof);
	assert.equal(f.nativeEnrollmentProof.method, "PUT");
	assert.deepEqual(JSON.parse(f.authentications[2].signedPayload), f.nativeEnrollmentProof);
	assert.ok(f.courierCapability.scopes.includes("reads"));
	assert.ok(!f.courierCapability.scopes.some((s) => (s as string) === "enroll"));
	assert.equal(f.capabilityRefresh.capabilityId, f.courierCapability.id);
	assert.deepEqual(
		f.readRequests.map((r) => r.action),
		["read", "health", "logs", "telemetry", "checks"],
	);
	assert.equal(f.readExchangeResponse.requests.length, 5);
	assert.equal(f.readExchangeRequest.peer.daemonId, f.readRequests[0].host.daemonId);
	for (let i = 0; i < f.readResponses.length; i++) {
		assert.equal(f.readResponses[i].requestId, f.readRequests[i].requestId);
		assert.deepEqual(f.readResponses[i].sourceHost, f.readRequests[i].host);
		assert.equal(f.readResponses[i].untrusted, true);
		assert.ok(Buffer.byteLength(JSON.stringify(f.readResponses[i])) <= 24_000);
	}
	assert.deepEqual(
		f.readImports.map((r) => r.state),
		["delivered", "expired"],
	);
});

test("bootstrap, pairing replay, archive lookup and unavailable reads expose daemon-owned wire outcomes", () => {
	const f = roundTrip(fixture);
	assert.deepEqual(
		f.bootstrapStatuses.map((s) => s.state),
		["unconfigured", "configured", "legacy-migration-required"],
	);
	assert.ok(f.bootstrapRequests.every((r) => r.expectedRoleEpoch === 0));
	assert.equal(f.bootstrapApproval.action, "bootstrap");
	assert.deepEqual(
		f.bootstrapResults.map((r) => r.mutation.disposition),
		["applied", "replayed"],
	);
	assert.deepEqual(f.bootstrapResults[0].roleAcknowledgment, f.bootstrapResults[1].roleAcknowledgment);
	assert.match(f.bootstrapResults[0].roleAcknowledgment.bindingId, /^role-bootstrap:/);
	assert.equal(f.bootstrapError.code, "legacy_migration_required");
	assert.deepEqual(
		f.pairingResults.map((s) => s.pairing?.phase),
		["partial", "paired", "paired"],
	);
	assert.equal(f.pairingResults[0].pairing?.peerCommitted, false);
	assert.equal(f.pairingResults[2].mutation?.disposition, "replayed");
	assert.equal(f.pairingConflict.current?.pairing?.phase, "paired");
	assert.equal(f.pairingAcknowledgment.peerRoleAcknowledgment.generation, f.enrollments[0].generation);
	assert.equal(f.archiveLookups[0].delivery.state, "unknown");
	assert.equal(f.archiveLookups[1].delivery.state, "accepted");
	assert.equal(f.archiveLookups[1].adopted, false);
	assert.equal(f.archiveLookups[1].roleAcknowledgment, undefined);
	assert.equal(f.archiveLookups[2].adopted, true);
	assert.equal(f.archiveLookups[2].roleAcknowledgment?.intentId, f.archiveResponse.operation.operationId);
	assert.equal(f.readOutcomes[0].response?.availability, "available");
	assert.equal(f.readOutcomes[1].availability, "disconnected");
	assert.equal(f.readOutcomes[1].response, undefined);
	assert.equal(f.readOutcomes[1].error?.code, "read_unavailable");
	assert.deepEqual(
		f.readImportRequests.map((r) => r.outcome.requestId),
		["read:0", "read:1"],
	);
});

test("archive administrative approval binds exact intent and both role epochs; empty source needs no ack", () => {
	const f = roundTrip(fixture);
	const proof = f.archiveApproval;
	assert.equal(proof.request.action, "archive");
	assert.equal(proof.request.requestId, f.archiveRequest.approvalRequestId);
	assert.equal(proof.decision.allow, true);
	assert.equal(proof.decision.appKeyId, proof.request.appKeyId);
	assert.deepEqual(proof.request.requestingHost, f.archiveResponse.operation.origin);
	assert.deepEqual(proof.request.executor, f.archiveResponse.operation.destination);
	const intent = JSON.parse(proof.intentPayload);
	assert.deepEqual(intent.expectedRoleFence, f.archiveRequest.expectedRoleFence);
	assert.equal(intent.expectedRoleEpoch, intent.expectedRoleFence.home);
	assert.equal(intent.idempotencyKey, f.archiveResponse.operation.operationId);
	assert.equal(intent.sessionId, f.archiveResponse.operation.targetId);
	assert.ok(proof.consumedAt <= proof.request.expiresAt);
	const payload: C.ControlArchiveOperationPayload = JSON.parse(f.archiveResponse.operation.payload);
	assert.deepEqual(payload.approval, proof);
	assert.deepEqual(payload.roleFence, intent.expectedRoleFence);
	assert.deepEqual(
		f.archiveApprovalErrors.map((e) => e.code),
		["approval_required", "stale_role", "approval_expired"],
	);
	assert.equal(f.emptyAckPolicy.page.head, 0);
	assert.equal(f.emptyAckPolicy.executorAckNeeded, false);
	assert.equal(f.emptyAckPolicy.homeAcknowledgment.eventId, undefined);
});
