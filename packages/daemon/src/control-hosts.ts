import { type KeyObject, randomBytes, randomUUID, verify } from "node:crypto";
import type {
	ControlCourierCapability,
	ControlCourierCapabilityRefreshRequest,
	ControlHomeEnrollmentRequest,
	ControlHostApprovalDecision,
	ControlHostApprovalInput,
	ControlHostApprovalRequest,
	ControlHostConfiguration,
	ControlHostStateResponse,
	ControlNativeRequestProof,
	ControlPairingAcknowledgment,
	ControlUnpairRequest,
	ControlUnpairResponse,
	OperationHost,
} from "@pilot/protocol";
import {
	ControlHostError,
	controlId,
	positive,
	requireHost,
	sameControlHost,
	strictObject,
} from "./control-host-policy.ts";
import type { ControlHostStore } from "./control-host-store.ts";
import { payloadHash } from "./operation-journal.ts";

/** Supplied only by an independently protected native management channel. Never load keys from
 * agent-readable files, env, HTTP bodies or SSH setup. Absent provider means pairing unavailable. */
export interface ProtectedControlKeys {
	publicKey(id: string): KeyObject | undefined;
}
export class ControlHosts {
	readonly host: OperationHost;
	readonly store: ControlHostStore;
	private readonly keys?: ProtectedControlKeys;
	private policy?: ControlHostConfiguration;
	private conversationRole?: "app-home" | "executor";
	constructor(host: OperationHost, store: ControlHostStore, keys?: ProtectedControlKeys) {
		requireHost(host);
		this.host = host;
		this.store = store;
		this.keys = keys;
	}
	private key(id: string): KeyObject {
		const key = this.keys?.publicKey(id);
		if (!key || key.asymmetricKeyType !== "ed25519")
			throw new ControlHostError(
				"approval_required",
				"Protected native management is unavailable or key is unknown",
				403,
			);
		return key;
	}
	private signed(id: string, bytes: string, signature: string): void {
		if (
			typeof signature !== "string" ||
			signature.length > 256 ||
			!verify(null, Buffer.from(bytes), this.key(id), Buffer.from(signature, "base64"))
		)
			throw new ControlHostError("authentication_required", "Invalid native signature", 401);
	}
	async authenticate(
		headers: { proof?: string; signature?: string },
		method: string,
		path: string,
		body: string,
		scope?: { bindingId: string; kind: ControlCourierCapability["scopes"][number] },
	): Promise<string> {
		if (!headers.proof || !headers.signature || headers.proof.length > 8192)
			throw new ControlHostError("authentication_required", "Signed Control request required", 401);
		const bytes = Buffer.from(headers.proof, "base64").toString("utf8");
		let proof: Record<string, unknown>;
		try {
			proof = JSON.parse(bytes);
		} catch {
			throw new ControlHostError("authentication_required", "Invalid authentication proof", 401);
		}
		if (
			!proof ||
			typeof proof !== "object" ||
			Array.isArray(proof) ||
			proof.method !== method ||
			proof.path !== path ||
			proof.bodyHash !== payloadHash(body) ||
			!Number.isSafeInteger(proof.issuedAt) ||
			Math.abs(Date.now() - Number(proof.issuedAt)) > 300000
		)
			throw new ControlHostError("authentication_required", "Authentication does not match the exact request", 401);
		controlId(proof.requestId);
		if (typeof proof.capabilityId === "string") {
			if (!scope) throw new ControlHostError("capability_denied", "Courier cannot manage Control policy", 403);
			const capability = await this.store.call<ControlCourierCapability | undefined>(
				"capability",
				proof.capabilityId,
			);
			if (!capability || capability.bindingId !== scope.bindingId || !capability.scopes.includes(scope.kind))
				throw new ControlHostError("capability_denied", "Courier scope denied", 403);
			this.signed(capability.appKeyId, `courier-v1\n${bytes}`, headers.signature);
			if (capability.expiresAt <= Date.now())
				throw new ControlHostError("capability_expired", "Courier capability expired");
			const state = await this.state(scope.bindingId);
			if (
				state.enrollment.generation !== capability.generation ||
				!sameControlHost(state.enrollment.home, capability.home) ||
				!sameControlHost(state.enrollment.executor, capability.executor)
			)
				throw new ControlHostError("identity_mismatch", "Courier enrollment changed");
			// Historical capabilities may reconcile receipts/facts after revoke, never issue new work.
			if (
				scope.kind === "exchange" &&
				(state.enrollment.state !== "active" ||
					state.configuration.roleEpoch !== capability.roleFence.executor ||
					state.peerHello.controlHost?.roleEpoch !== capability.roleFence.home)
			)
				throw new ControlHostError("capability_denied", "Courier execution authority is stale", 403);
			return capability.appKeyId;
		}
		const native = proof as unknown as ControlNativeRequestProof;
		if (!sameControlHost(native.host, this.host) || typeof native.appKeyId !== "string")
			throw new ControlHostError("identity_mismatch", "Native proof receiver changed");
		this.signed(native.appKeyId, `native-management-v1\n${bytes}`, headers.signature);
		if (
			scope &&
			scope.kind !== "inspect" &&
			scope.kind !== "events" &&
			scope.kind !== "receipts" &&
			scope.kind !== "archive-read"
		)
			throw new ControlHostError("capability_denied", "Courier proof required for data delivery", 403);
		return native.appKeyId;
	}
	async state(id: string): Promise<ControlHostStateResponse> {
		controlId(id);
		const state = await this.store.call<ControlHostStateResponse>("state", id);
		const courierCapability = await this.store.call<ControlCourierCapability | undefined>("bindingCapability", id);
		return { ...state, ...(courierCapability ? { courierCapability } : {}) };
	}
	async pairingAck(id: string, ack: ControlPairingAcknowledgment): Promise<ControlHostStateResponse> {
		const state = await this.state(id);
		const r = ack.peerRoleAcknowledgment;
		const hello = ack.peerHello;
		if (
			!r ||
			r.contractVersion !== 1 ||
			r.bindingId !== id ||
			r.generation !== state.enrollment.generation ||
			!sameControlHost(r.home, state.enrollment.home) ||
			!sameControlHost(r.host, state.enrollment.home) ||
			r.role !== "home" ||
			r.roleEpoch !== state.peerHello.controlHost?.roleEpoch ||
			hello.daemonId !== r.host.daemonId ||
			hello.lineageId !== r.host.lineageId ||
			hello.controlHost?.roleEpoch !== r.roleEpoch
		)
			throw new ControlHostError("identity_mismatch", "Pairing acknowledgment does not match the verified peer");
		await this.store.call("pairingAck", { id, ack });
		return this.state(id);
	}
	async refresh(
		id: string,
		request: ControlCourierCapabilityRefreshRequest,
		appKeyId: string,
	): Promise<ControlCourierCapability> {
		strictObject(request, ["capabilityId", "expectedRoleEpoch"]);
		this.key(appKeyId);
		const state = await this.state(id);
		const c = state.courierCapability;
		if (
			!c ||
			c.id !== request.capabilityId ||
			c.appKeyId !== appKeyId ||
			state.configuration.roleEpoch !== request.expectedRoleEpoch
		)
			throw new ControlHostError("capability_denied", "Capability refresh scope changed", 403);
		const scopes = state.enrollment.state === "active" ? c.scopes : c.scopes.filter((scope) => scope !== "exchange");
		const next = {
			...c,
			scopes,
			expiresAt: Date.now() + 300000,
			roleFence: { home: state.peerHello.controlHost!.roleEpoch, executor: state.configuration.roleEpoch },
		};
		await this.store.call("refreshCapability", next);
		return next;
	}
	async configuration(): Promise<ControlHostConfiguration | undefined> {
		this.policy = await this.store.call("configuration");
		return this.policy;
	}
	/** Local product policy, recovered before sessions/watches. This does not enroll a remote home. */
	async recoverConversationRole(platform: NodeJS.Platform = process.platform): Promise<void> {
		this.conversationRole = undefined;
		const role = await this.store.call<"app-home" | "executor">("conversationRole", { host: this.host, platform });
		await this.configuration();
		this.conversationRole = role;
	}
	legacyAllowed(): boolean {
		return (
			this.conversationRole === "app-home" &&
			(!this.policy ||
				(this.policy.role === "home" &&
					sameControlHost(this.policy.host, this.host) &&
					sameControlHost(this.policy.home, this.host) &&
					!this.policy.freeze &&
					!this.policy.archive))
		);
	}
	/** Called by the protected role-bootstrap owner, not exposed as an agent or pairing API. */
	async initialize(configuration: ControlHostConfiguration): Promise<ControlHostConfiguration> {
		if (!sameControlHost(configuration.host, this.host))
			throw new ControlHostError("identity_mismatch", "Role policy belongs to another lineage");
		positive(configuration.roleEpoch);
		requireHost(configuration.home);
		this.policy = await this.store.call("initialize", configuration);
		return this.policy!;
	}
	private async validateEnrollment(
		id: string,
		request: Omit<ControlHomeEnrollmentRequest, "approvalRequestId">,
	): Promise<void> {
		strictObject(request, ["enrollment", "peerHello", "expectedGeneration", "expectedRoleEpoch"]);
		const e = request.enrollment;
		strictObject(e, ["schemaVersion", "bindingId", "generation", "home", "executor", "state"]);
		controlId(id);
		positive(e.generation);
		positive(request.expectedRoleEpoch);
		requireHost(e.home);
		requireHost(e.executor);
		if (
			e.schemaVersion !== 1 ||
			e.bindingId !== id ||
			e.state !== "active" ||
			sameControlHost(e.home, e.executor) ||
			!sameControlHost(e.executor, this.host)
		)
			throw new ControlHostError("identity_mismatch", "Invalid executor enrollment");
		if (request.expectedGeneration !== null) positive(request.expectedGeneration);
		const peer = request.peerHello;
		if (
			!peer ||
			peer.daemonId !== e.home.daemonId ||
			peer.lineageId !== e.home.lineageId ||
			peer.protocolVersion !== 1 ||
			peer.minimumClientProtocolVersion > 1 ||
			peer.capabilities?.controlHosts !== 1 ||
			!peer.controlHost ||
			!sameControlHost(peer.controlHost.host, e.home) ||
			!sameControlHost(peer.controlHost.home, e.home) ||
			peer.controlHost.role !== "home"
		)
			throw new ControlHostError("incompatible_peer", "Peer does not support the pinned home contract", 503);
		positive(peer.controlHost.roleEpoch);
	}
	async preview(id: string, request: Omit<ControlHomeEnrollmentRequest, "approvalRequestId">) {
		let current: ControlHostStateResponse | undefined;
		try {
			current = await this.state(id);
		} catch (error) {
			if (!(error instanceof ControlHostError) || error.code !== "not_found") throw error;
		}
		const errors = [];
		try {
			await this.validateEnrollment(id, request);
		} catch (error) {
			if (!(error instanceof ControlHostError)) throw error;
			errors.push(error.response());
		}
		const intentPayload = JSON.stringify(request);
		return {
			intentPayload,
			intentHash: payloadHash(intentPayload),
			compatible: !errors.length,
			effect: "pair-only" as const,
			courierScopes: ["exchange", "receipts", "events", "status", "reads", "inspect", "archive-read"],
			...(current ? { current } : {}),
			errors,
		};
	}
	async issue(id: string, input: ControlHostApprovalInput, appKeyId: string): Promise<ControlHostApprovalRequest> {
		strictObject(input, ["action", "appKeyId", "intentPayload"]);
		this.key(appKeyId);
		if (
			input.appKeyId !== appKeyId ||
			typeof input.intentPayload !== "string" ||
			Buffer.byteLength(input.intentPayload) > 65536
		)
			throw new ControlHostError("invalid_request", "Invalid approval intent", 400);
		let intent: Record<string, unknown>;
		try {
			intent = JSON.parse(input.intentPayload);
		} catch {
			throw new ControlHostError("invalid_request", "Invalid intent JSON", 400);
		}
		let home: OperationHost, executor: OperationHost, generation: number;
		if (input.action === "enroll") {
			await this.validateEnrollment(
				id,
				intent as unknown as Omit<ControlHomeEnrollmentRequest, "approvalRequestId">,
			);
			const e = (intent as unknown as ControlHomeEnrollmentRequest).enrollment;
			({ home, executor, generation } = e);
		} else if (input.action === "unpair") {
			strictObject(intent, ["expectedGeneration", "expectedRoleEpoch", "idempotencyKey"]);
			const state = await this.state(id);
			({ home, executor, generation } = state.enrollment);
		} else throw new ControlHostError("not_ready", "This executor cannot issue home archive or bootstrap approvals");
		positive(intent.expectedRoleEpoch);
		const requestId = randomBytes(32).toString("hex");
		const fields = {
			requestId,
			action: input.action,
			appKeyId,
			requestingHost: this.host,
			home,
			executor,
			bindingId: id,
			generation,
			expectedRoleEpoch: intent.expectedRoleEpoch,
			intentHash: payloadHash(input.intentPayload),
			issuedAt: Date.now(),
			expiresAt: Date.now() + 300000,
		};
		const request: ControlHostApprovalRequest = {
			...fields,
			state: "pending",
			signingPayload: JSON.stringify(fields),
		};
		return this.store.call("issue", { request, intent: input.intentPayload });
	}
	async approval(id: string, requestId: string): Promise<ControlHostApprovalRequest> {
		const r = await this.store.call<ControlHostApprovalRequest | undefined>("approval", requestId);
		if (!r || r.bindingId !== id) throw new ControlHostError("not_found", "Unknown scoped approval", 404);
		return r;
	}
	async decision(
		id: string,
		requestId: string,
		decision: ControlHostApprovalDecision,
		appKeyId: string,
	): Promise<ControlHostApprovalRequest> {
		strictObject(decision, ["allow", "appKeyId", "signature"]);
		const request = await this.approval(id, requestId);
		if (decision.appKeyId !== appKeyId || request.appKeyId !== appKeyId || typeof decision.allow !== "boolean")
			throw new ControlHostError("approval_required", "Approval key mismatch", 403);
		this.signed(appKeyId, `${decision.allow ? "approve" : "deny"}\n${request.signingPayload}`, decision.signature);
		return this.store.call("decision", { id: requestId, allow: decision.allow });
	}
	async enroll(
		id: string,
		request: ControlHomeEnrollmentRequest,
		appKeyId: string,
	): Promise<ControlHostStateResponse> {
		this.key(appKeyId);
		const { approvalRequestId, ...intent } = request;
		await this.validateEnrollment(id, intent);
		controlId(approvalRequestId);
		const state = await this.store.call<ControlHostStateResponse>("enroll", { id, request, appKeyId });
		this.policy = state.configuration;
		const prior = await this.store.call<ControlCourierCapability | undefined>("bindingCapability", id);
		if (!prior) {
			const capability: ControlCourierCapability = {
				id: randomUUID(),
				bindingId: id,
				generation: state.enrollment.generation,
				home: state.enrollment.home,
				executor: this.host,
				appKeyId,
				roleFence: { home: request.peerHello.controlHost!.roleEpoch, executor: state.configuration.roleEpoch },
				expiresAt: Date.now() + 300000,
				scopes: ["exchange", "receipts", "events", "status", "reads", "inspect", "archive-read"],
			};
			await this.store.call("saveCapability", capability);
		}
		return { ...state, courierCapability: await this.store.call("bindingCapability", id) };
	}
	async unpair(id: string, request: ControlUnpairRequest, appKeyId: string): Promise<ControlUnpairResponse> {
		this.key(appKeyId);
		strictObject(request, ["approvalRequestId", "expectedGeneration", "expectedRoleEpoch", "idempotencyKey"]);
		controlId(request.idempotencyKey);
		const response = await this.store.call<ControlUnpairResponse>("unpair", { id, request, appKeyId });
		this.policy = response.configuration;
		return response;
	}
}
