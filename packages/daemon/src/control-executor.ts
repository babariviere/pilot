import type { ControlPermission } from "@pilot/kernel";
import type {
	ControlAuthorization,
	ControlHostStateResponse,
	ControlOperationAuthority,
	ControlOperationPayloads,
	ControlOperationResult,
	DurableOperation,
	SessionSummary,
	WatchTarget,
} from "@pilot/protocol";
import { CONTROL_LEVELS } from "./control-authorizations.ts";
import {
	ControlHostError,
	controlId,
	positive,
	requireHost,
	sameControlHost,
	strictObject,
} from "./control-host-policy.ts";
import type { ControlHostStore } from "./control-host-store.ts";
import type { ExecutorAdmission } from "./control-hosts-disk.ts";
import { validateWatch } from "./watches.ts";

/** Implementations must retain operation IDs at their own domain commit, not just here. */
export interface ControlExecutorBackend {
	reconciled(op: DurableOperation): Promise<boolean>;
	project(id: string): boolean;
	chat(id: string): SessionSummary | undefined;
	resolveChat(id: string, direct: boolean): { id: string; scopes: WatchTarget[][]; permission?: ControlPermission };
	prepareStart(payload: ControlOperationPayloads["control.start"]): Promise<void>;
	start(
		op: DurableOperation,
		payload: ControlOperationPayloads["control.start"],
		permission: ControlPermission,
		fence: () => Promise<void>,
	): Promise<void>;
	send(
		op: DurableOperation,
		sessionId: string,
		message: string,
		permission: ControlPermission,
		redirect: boolean,
		fence: () => Promise<void>,
	): Promise<void>;
	run(
		op: DurableOperation,
		sessionId: string,
		action: "stop" | "pause" | "resume",
		fence: () => Promise<void>,
	): Promise<void>;
	/** Build-verified acceptance evidence, not readiness booleans supplied in an operation. */
	executionReady(state: ControlHostStateResponse): boolean;
}
const authorityKeys = [
	"roleFence",
	"authorizationId",
	"levelCeiling",
	"budgetReservation",
	"idempotencyKey",
	"authorization",
];
function message(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > 4000)
		throw new ControlHostError("invalid_request", "message must be 1..4000 characters", 400);
}
function level(value: unknown): number {
	const n = CONTROL_LEVELS.indexOf(value as ControlAuthorization["level"]);
	if (n < 0) throw new ControlHostError("invalid_request", "Invalid authorization level", 400);
	return n;
}
function validateAuthority(a: ControlOperationAuthority, op: DurableOperation): void {
	controlId(a.authorizationId);
	if (a.idempotencyKey !== op.operationId)
		throw new ControlHostError("invalid_request", "Idempotency key must equal operation ID", 400);
	strictObject(a.roleFence, ["home", "executor"]);
	positive(a.roleFence.home);
	positive(a.roleFence.executor);
	level(a.levelCeiling);
	const g = a.authorization;
	if (
		!g ||
		g.id !== a.authorizationId ||
		!Array.isArray(g.targets) ||
		!g.targets.length ||
		g.targets.length > 32 ||
		!Array.isArray(g.hosts) ||
		g.hosts.length > 32 ||
		!g.userMessage ||
		g.watchId
	)
		throw new ControlHostError(
			"capability_denied",
			"Remote action requires an explicit host-qualified user authorization",
			403,
		);
	level(g.level);
	for (const host of g.hosts) requireHost(host);
	if (!g.hosts.some((host) => sameControlHost(host, op.destination)))
		throw new ControlHostError("capability_denied", "Authorization does not allow this host", 403);
	for (const target of g.targets) {
		requireHost(target.host);
		if (typeof target.id !== "string" || !target.id || target.id.length > 500)
			throw new ControlHostError("invalid_request", "Invalid authorization scope", 400);
	}
	if (!Number.isSafeInteger(g.createdAt) || (g.expiresAt !== undefined && !Number.isSafeInteger(g.expiresAt)))
		throw new ControlHostError("invalid_request", "Invalid authorization timestamps", 400);
	const b = a.budgetReservation;
	strictObject(b, ["reservationId", "budgetUsd", "followUps"]);
	controlId(b.reservationId);
	// A zero diagnostic reservation is valid, including starts. No invented USD cap.
	if (!Number.isFinite(b.budgetUsd) || b.budgetUsd < 0 || !Number.isSafeInteger(b.followUps) || b.followUps < 0)
		throw new ControlHostError("invalid_request", "Invalid reservation evidence", 400);
}
function checkScope(a: ControlOperationAuthority, op: DurableOperation, scopes: WatchTarget[][]): void {
	if (
		scopes.some(
			(alternatives) =>
				!alternatives.some((target) =>
					a.authorization.targets.some(
						(allowed) =>
							sameControlHost(allowed.host, op.destination) &&
							target.kind === allowed.kind &&
							target.id === allowed.id &&
							target.missionId === allowed.missionId,
					),
				),
		)
	)
		throw new ControlHostError("capability_denied", "Action outside actual host-qualified target scope", 403);
}
export class ControlExecutor {
	readonly store: ControlHostStore;
	readonly backend: ControlExecutorBackend;
	constructor(store: ControlHostStore, backend: ControlExecutorBackend) {
		this.store = store;
		this.backend = backend;
	}
	async handle(op: DurableOperation): Promise<ControlOperationResult> {
		try {
			return await this.admit(op);
		} catch (error) {
			if (error instanceof ControlHostError && error.status < 500) {
				await this.store.call("reject", { operation: op, reason: error.response() });
			}
			throw error;
		}
	}
	private async admit(op: DurableOperation): Promise<ControlOperationResult> {
		if (Buffer.byteLength(op.payload) > 65536)
			throw new ControlHostError("invalid_request", "Oversized payload", 400);
		let value: unknown;
		try {
			value = JSON.parse(op.payload);
		} catch {
			throw new ControlHostError("invalid_request", "Invalid payload JSON", 400);
		}
		const keys: Record<string, string[]> = {
			"control.start": ["target", "message", "model", "thinking"],
			"control.send": ["sessionId", "message", "direct"],
			"control.run": ["sessionId", "action", "message", "direct"],
			"control.watch": ["watch"],
			"control.unwatch": ["watchId"],
			"control.revoke": ["revokedAt"],
		};
		if (!keys[op.kind]) throw new ControlHostError("invalid_request", "Unsupported Control operation kind", 400);
		strictObject(value, [...authorityKeys, ...keys[op.kind]!]);
		const a = value as unknown as ControlOperationAuthority;
		validateAuthority(a, op);
		const permission: ControlPermission = {
			authorizationId: a.authorizationId,
			level: CONTROL_LEVELS[Math.min(level(a.levelCeiling), level(a.authorization.level))]!,
		};
		const safety = op.kind === "control.revoke" || op.kind === "control.unwatch";
		const checkArgs = { operation: op, roleFence: a.roleFence, authorizationId: a.authorizationId, safety };
		// Domain result lookup is before fresh expiry/role checks, covering a receipt-publication crash.
		const existing = await this.store.call<ExecutorAdmission | undefined>("admission", op);
		if (existing?.result) return existing.result;
		if (existing && (await this.backend.reconciled(op)))
			return this.store.call("complete", {
				operation: op,
				result: { kind: op.kind, authorizationId: a.authorizationId, sessionId: op.targetId },
			});
		const check = async () => {
			await this.store.call("check", checkArgs);
			if (!safety) {
				if (
					a.authorization.revokedAt !== undefined ||
					(a.authorization.expiresAt !== undefined && a.authorization.expiresAt <= Date.now())
				)
					throw new ControlHostError("capability_denied", "Authorization expired or revoked", 403);
				const state = await this.store.call<ControlHostStateResponse>("state", op.bindingId);
				if (!this.backend.executionReady(state))
					throw new ControlHostError("not_ready", "Remote Control activation proof is unavailable");
			}
		};
		await check();
		let target: { id: string; scopes: WatchTarget[][]; permission?: ControlPermission } | undefined;
		if (op.kind === "control.start") {
			const p = value as unknown as ControlOperationPayloads["control.start"];
			message(p.message);
			if (
				typeof p.model !== "string" ||
				!p.model.trim() ||
				p.model.length > 256 ||
				(p.thinking !== undefined && (typeof p.thinking !== "string" || p.thinking.length > 256))
			)
				throw new ControlHostError("invalid_request", "An explicit target-local model is required", 400);
			if (p.target?.kind === "task")
				throw new ControlHostError(
					"delegation_required",
					"Placement must durably enforce matching Control authority before task start",
				);
			strictObject(p.target, ["kind", "projectId"]);
			if (p.target.kind !== "project" || !this.backend.project(p.target.projectId))
				throw new ControlHostError("not_found", "Unknown target-local project", 404);
			checkScope(a, op, [[{ kind: "project", id: p.target.projectId }]]);
			await this.backend.prepareStart(p);
			await check();
		} else if (op.kind === "control.send" || op.kind === "control.run") {
			const p = value as unknown as ControlOperationPayloads["control.send"] & { action?: string };
			controlId(p.sessionId);
			if (p.direct !== undefined && typeof p.direct !== "boolean")
				throw new ControlHostError("invalid_request", "direct must be boolean", 400);
			target = this.backend.resolveChat(p.sessionId, p.direct === true);
			if (target.id !== op.targetId)
				throw new ControlHostError("identity_mismatch", "Home must seal the routed receiving session ID");
			checkScope(a, op, target.scopes);
			if (op.kind === "control.run" && !["stop", "pause", "resume", "redirect"].includes(p.action!))
				throw new ControlHostError("invalid_request", "Invalid run action", 400);
			if (op.kind === "control.send" || p.action === "redirect") message(p.message);
			else if (p.message !== undefined)
				throw new ControlHostError("invalid_request", "Only redirect carries a run message", 400);
			// An unrestricted existing execution cannot inherit narrower instructions safely. Fail closed.
			if (
				(op.kind === "control.send" || p.action === "redirect" || p.action === "resume") &&
				(!target.permission || level(target.permission.level) > level(permission.level))
			)
				throw new ControlHostError(
					"capability_denied",
					"Existing execution cannot enforce this input ceiling",
					403,
				);
		} else if (op.kind === "control.watch") {
			const p = value as unknown as ControlOperationPayloads["control.watch"];
			try {
				validateWatch(p.watch);
			} catch {
				throw new ControlHostError("invalid_request", "Invalid remote watch", 400);
			}
			if (!sameControlHost(p.watch.target.host, op.destination) || p.watch.authorizationId !== a.authorizationId)
				throw new ControlHostError("identity_mismatch", "Watch must retain its exact host and authorization");
			const scopes =
				p.watch.target.kind === "chat" || p.watch.target.kind === "chat_prs"
					? this.backend.resolveChat(p.watch.target.id, true).scopes
					: [[p.watch.target]];
			checkScope(a, op, scopes);
		} else if (op.kind === "control.unwatch") {
			if ((value as unknown as ControlOperationPayloads["control.unwatch"]).watchId !== op.targetId)
				throw new ControlHostError("identity_mismatch", "Unwatch target changed");
		} else {
			const p = value as unknown as ControlOperationPayloads["control.revoke"];
			if (op.targetId !== a.authorizationId || !Number.isSafeInteger(p.revokedAt) || p.revokedAt < 0)
				throw new ControlHostError("invalid_request", "Invalid exact authorization tombstone", 400);
		}
		await this.store.call("prepare", checkArgs);
		let result: ControlOperationResult = {
			kind: op.kind as ControlOperationResult["kind"],
			authorizationId: a.authorizationId,
		};
		if (op.kind === "control.start") {
			await this.backend.start(op, value as unknown as ControlOperationPayloads["control.start"], permission, check);
			result.sessionId = op.targetId;
		} else if (op.kind === "control.send") {
			await this.backend.send(
				op,
				target!.id,
				(value as unknown as ControlOperationPayloads["control.send"]).message,
				permission,
				false,
				check,
			);
			result.sessionId = target!.id;
		} else if (op.kind === "control.run") {
			const p = value as unknown as ControlOperationPayloads["control.run"];
			if (p.action === "redirect") await this.backend.send(op, target!.id, p.message, permission, true, check);
			else await this.backend.run(op, target!.id, p.action, check);
			result.sessionId = target!.id;
		} else if (op.kind === "control.watch") {
			const p = value as unknown as ControlOperationPayloads["control.watch"];
			await this.store.call("watch", {
				operation: op,
				watch: { ...p.watch, id: op.targetId, createdAt: a.authorization.createdAt },
			});
			result.watchId = op.targetId;
		} else if (op.kind === "control.unwatch") {
			result.removed = await this.store.call<boolean>("unwatch", {
				operation: op,
				authorizationId: a.authorizationId,
			});
			result.watchId = op.targetId;
		} else
			result.revokedAt = await this.store.call<number>("revoke", {
				operation: op,
				at: (value as unknown as ControlOperationPayloads["control.revoke"]).revokedAt,
			});
		result = await this.store.call("complete", { operation: op, result });
		return result;
	}
}
