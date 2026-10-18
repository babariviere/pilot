import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ControlAuthorization,
	ControlHostConfiguration,
	ControlOperationAuthority,
	DaemonHello,
	DurableOperation,
	OperationHost,
} from "@pilot/protocol";
import { ControlExecutor, type ControlExecutorBackend } from "../control-executor.ts";
import { ControlHostStore } from "../control-host-store.ts";
import { ControlHosts } from "../control-hosts.ts";
import { OperationJournal, payloadHash } from "../operation-journal.ts";

export const home: OperationHost = { hostId: "daemon", daemonId: "home", lineageId: "home-lineage" };
export const executorHost: OperationHost = { hostId: "daemon", daemonId: "executor", lineageId: "executor-lineage" };
export async function executorFixture(t: { after(fn: () => Promise<void>): void }, legacy = false) {
	const root = await mkdtemp(join(tmpdir(), "pilot-control-executor-"));
	const key = generateKeyPairSync("ed25519");
	const path = join(root, "control-hosts", "state.sqlite");
	let store = new ControlHostStore(path);
	const keys = { publicKey: (id: string) => (id === "native" ? key.publicKey : undefined) };
	let hosts = new ControlHosts(executorHost, store, keys);
	const configuration: ControlHostConfiguration = {
		schemaVersion: 1,
		roleEpoch: 1,
		host: executorHost,
		home: legacy ? executorHost : home,
		role: legacy ? "home" : "executor",
	};
	await hosts.initialize(configuration);
	const hello: DaemonHello = {
		daemonId: home.daemonId,
		lineageId: home.lineageId,
		daemonVersion: "1.0.0",
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
			controlHosts: 1,
		},
		controlHost: { schemaVersion: 1, roleEpoch: 1, host: home, home, role: "home" },
	};
	const enrollment = {
		schemaVersion: 1 as const,
		bindingId: "control-pair",
		generation: 1,
		home,
		executor: executorHost,
		state: "active" as const,
	};
	async function approve(action: "enroll" | "unpair", intent: unknown) {
		const r = await hosts.issue(
			enrollment.bindingId,
			{ action, appKeyId: "native", intentPayload: JSON.stringify(intent) },
			"native",
		);
		await hosts.decision(
			enrollment.bindingId,
			r.requestId,
			{
				appKeyId: "native",
				allow: true,
				signature: sign(null, Buffer.from(`approve\n${r.signingPayload}`), key.privateKey).toString("base64"),
			},
			"native",
		);
		return r;
	}
	const intent = { enrollment, peerHello: hello, expectedRoleEpoch: 1, expectedGeneration: null };
	const approval = await approve("enroll", intent);
	const request = { ...intent, approvalRequestId: approval.requestId };
	await hosts.enroll(enrollment.bindingId, request, "native");
	const authorization: ControlAuthorization = {
		id: "grant",
		hosts: [executorHost],
		scope: "Inspect this project",
		level: "implement",
		targets: [{ host: executorHost, kind: "project", id: "project" }],
		limits: { followUps: 10 },
		usage: { followUps: 0, budgetUsd: 0 },
		createdAt: Date.now(),
		expiresAt: Date.now() + 60000,
		userMessage: { conversationId: "user-chat", submissionId: 1, entryId: 1, requestId: "user-input" },
	};
	const calls: { kind: string; id: string; level?: string }[] = [];
	const backend: ControlExecutorBackend = {
		reconciled: async (op) => calls.some((c) => c.id === op.operationId),
		project: (id) => id === "project",
		chat: () => undefined,
		resolveChat: (id) => ({
			id,
			scopes: [[{ kind: "project", id: "project" }]],
			permission: { authorizationId: "grant", level: "investigate" },
		}),
		prepareStart: async () => {},
		start: async (op, _p, permission, fence) => {
			await fence();
			calls.push({ kind: "start", id: op.operationId, level: permission.level });
		},
		send: async (op, _id, _text, p, redirect, fence) => {
			await fence();
			calls.push({ kind: redirect ? "redirect" : "send", id: op.operationId, level: p.level });
		},
		run: async (op, _id, action, fence) => {
			await fence();
			calls.push({ kind: action, id: op.operationId });
		},
		executionReady: () => true,
	};
	let handler = new ControlExecutor(store, backend);
	const journal = new OperationJournal(join(root, "operations"), executorHost);
	let seq = 0;
	function operation(
		kind: string,
		fields: Record<string, unknown> = {},
		targetId: string = randomUUID(),
	): DurableOperation {
		const id = randomUUID();
		const a: ControlOperationAuthority = {
			authorizationId: authorization.id,
			authorization: structuredClone(authorization),
			idempotencyKey: id,
			levelCeiling: "investigate",
			roleFence: { home: 1, executor: 1 },
			budgetReservation: { reservationId: randomUUID(), budgetUsd: 0, followUps: 0 },
		};
		const payload = JSON.stringify({ ...a, ...fields });
		return {
			schemaVersion: 1,
			operationId: id,
			producerId: "control-home",
			sequence: ++seq,
			origin: home,
			destination: executorHost,
			bindingId: enrollment.bindingId,
			bindingGeneration: 1,
			kind,
			targetId,
			payload,
			payloadHash: payloadHash(payload),
		};
	}
	t.after(async () => {
		await store.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		path,
		key,
		keys,
		configuration,
		hello,
		enrollment,
		request,
		approval,
		approve,
		authorization,
		calls,
		backend,
		journal,
		operation,
		get store() {
			return store;
		},
		get hosts() {
			return hosts;
		},
		get handler() {
			return handler;
		},
		async reopen() {
			await store.close();
			store = new ControlHostStore(path);
			hosts = new ControlHosts(executorHost, store, keys);
			await hosts.configuration();
			handler = new ControlExecutor(store, backend);
		},
	};
}
