import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
	ControlAuthorization,
	ControlBudgetReservation,
	ControlHomeEnrollment,
	ControlHostConfiguration,
	ControlHostRequest,
	ControlOperationAcknowledgment,
	ControlOperationAuthority,
	ControlOperationExchangeRequest,
	ControlOperationExchangeResponse,
	ControlOperationKind,
	ControlOperationPayloads,
	ControlRemoteEventAcknowledgment,
	ControlRemoteEventPage,
	ControlRemoteStatusPage,
} from "./index.ts";

type PayloadFixture = {
	[K in ControlOperationKind]: { kind: K; payload: ControlOperationPayloads[K] };
}[ControlOperationKind];
interface Fixtures {
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
				target: { kind: "task", missionId: "m", taskId: "t" },
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
	];
	assert.deepEqual(roundTrip(expected), fixture.payloads);
	assert.equal(new Set(expected.map((p) => p.kind)).size, 6);
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
	assert.equal(pages[0].snapshot.missionTasks[0].state, "accepted");
	assert.equal(pages[1].snapshot.missionTasks[0].context, "provisional");
	assert.equal(pages[1].next, undefined);
});
