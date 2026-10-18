/** Only called by control-host-worker. Transactions own policy, admissions and executor audit. */
import type { DatabaseSync } from "node:sqlite";
import type {
	ControlCourierCapability,
	ControlHomeEnrollmentRequest,
	ControlHostApprovalRequest,
	ControlHostConfiguration,
	ControlHostStateResponse,
	ControlOperationResult,
	ControlUnpairRequest,
	DurableOperation,
	Watch,
} from "@pilot/protocol";
import { ControlHostError, sameControlHost } from "./control-host-policy.ts";
import { canonicalJSON } from "./operation-journal.ts";

export interface ExecutorAdmission {
	operation: DurableOperation;
	result?: ControlOperationResult;
}
export class ControlHostsDisk {
	readonly db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
		db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=32768;
		CREATE TABLE IF NOT EXISTS control_policy (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS control_enrollments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS control_approvals (id TEXT PRIMARY KEY, data TEXT NOT NULL, intent TEXT NOT NULL, consumed_by TEXT);
		CREATE TABLE IF NOT EXISTS control_capabilities (id TEXT PRIMARY KEY, binding TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS control_unpairs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS control_admissions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS control_revocations (binding TEXT NOT NULL, authorization TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(binding,authorization));
		CREATE TABLE IF NOT EXISTS control_remote_watches (id TEXT PRIMARY KEY, binding TEXT NOT NULL, authorization TEXT NOT NULL, data TEXT NOT NULL, active INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS control_executor_audit (seq INTEGER PRIMARY KEY, operation TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(operation,phase));`);
	}
	private transaction<T>(work: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private configuration(): ControlHostConfiguration | undefined {
		const row = this.db.prepare("SELECT data FROM control_policy WHERE id=1").get();
		return row ? JSON.parse(String(row.data)) : undefined;
	}
	private state(id: string): ControlHostStateResponse {
		const row = this.db.prepare("SELECT data FROM control_enrollments WHERE id=?").get(id);
		if (!row) throw new ControlHostError("not_found", "Unknown Control enrollment", 404);
		const value = JSON.parse(String(row.data)) as ControlHostStateResponse;
		return { ...value, configuration: this.configuration()! };
	}
	private audit(op: DurableOperation, phase: string, data: unknown): void {
		this.db
			.prepare("INSERT OR IGNORE INTO control_executor_audit(operation,phase,at,data) VALUES(?,?,?,?)")
			.run(op.operationId, phase, Date.now(), JSON.stringify(data));
	}
	private complete(operation: DurableOperation, result: ControlOperationResult): ControlOperationResult {
		this.db
			.prepare("UPDATE control_admissions SET data=? WHERE id=?")
			.run(JSON.stringify({ operation, result }), operation.operationId);
		this.audit(operation, "accepted", result);
		return result;
	}
	private fence(
		op: DurableOperation,
		roleFence: { home: number; executor: number },
		safety = false,
	): ControlHostStateResponse {
		const state = this.state(op.bindingId!);
		const { enrollment: e, configuration: c } = state;
		if (
			!sameControlHost(op.origin, e.home) ||
			!sameControlHost(op.destination, e.executor) ||
			!sameControlHost(c.host, e.executor)
		)
			throw new ControlHostError("identity_mismatch", "Operation is not from the enrolled Control home");
		if (op.bindingGeneration !== e.generation)
			throw new ControlHostError("stale_generation", "Control enrollment generation changed");
		if (e.state !== "active" && !safety)
			throw new ControlHostError("capability_denied", "Control enrollment revoked", 403);
		if (roleFence.executor !== c.roleEpoch || roleFence.home !== state.peerHello.controlHost?.roleEpoch)
			throw new ControlHostError("stale_role", "Control role fence changed");
		return state;
	}
	call(method: string, args: unknown): unknown {
		if (method === "pairingAck")
			return this.transaction(() => {
				const a = args as { id: string; ack: import("@pilot/protocol").ControlPairingAcknowledgment };
				const s = this.state(a.id);
				if (s.enrollment.state !== "active")
					throw new ControlHostError("capability_denied", "Pairing revoked", 403);
				s.pairing = { phase: "paired", localCommitted: true, peerCommitted: true };
				s.roleAcknowledgments = [
					...(s.roleAcknowledgments ?? []).filter(
						(r) => !sameControlHost(r.host, a.ack.peerRoleAcknowledgment.host),
					),
					a.ack.peerRoleAcknowledgment,
				];
				this.db.prepare("UPDATE control_enrollments SET data=? WHERE id=?").run(JSON.stringify(s), a.id);
			});
		if (method === "refreshCapability") {
			const c = args as ControlCourierCapability;
			this.db.prepare("UPDATE control_capabilities SET data=? WHERE id=?").run(JSON.stringify(c), c.id);
			return;
		}
		if (method === "capability" || method === "bindingCapability") {
			const row = this.db
				.prepare(`SELECT data FROM control_capabilities WHERE ${method === "capability" ? "id" : "binding"}=?`)
				.get(String(args));
			return row ? JSON.parse(String(row.data)) : undefined;
		}
		if (method === "saveCapability") {
			const c = args as ControlCourierCapability;
			this.db
				.prepare("INSERT OR IGNORE INTO control_capabilities VALUES(?,?,?)")
				.run(c.id, c.bindingId, JSON.stringify(c));
			return;
		}
		if (method === "unpair")
			return this.transaction(() => {
				const a = args as { id: string; request: ControlUnpairRequest; appKeyId: string };
				const { approvalRequestId, ...intent } = a.request;
				const row = this.db.prepare("SELECT * FROM control_approvals WHERE id=?").get(approvalRequestId);
				const approval = row && (JSON.parse(String(row.data)) as ControlHostApprovalRequest | undefined);
				if (
					!approval ||
					approval.action !== "unpair" ||
					approval.appKeyId !== a.appKeyId ||
					approval.bindingId !== a.id ||
					canonicalJSON(JSON.parse(String(row!.intent))) !== canonicalJSON(intent)
				)
					throw new ControlHostError("approval_required", "Matching unpair approval required", 403);
				if (row!.consumed_by) {
					if (row!.consumed_by !== a.request.idempotencyKey)
						throw new ControlHostError("approval_required", "Approval reused", 403);
					return JSON.parse(
						String(
							this.db.prepare("SELECT data FROM control_unpairs WHERE id=?").get(a.request.idempotencyKey)!.data,
						),
					);
				}
				if (approval.state !== "approved")
					throw new ControlHostError("approval_required", "Unpair not approved", 403);
				if (approval.expiresAt <= Date.now())
					throw new ControlHostError("approval_expired", "Unpair approval expired");
				const state = this.state(a.id);
				const c = state.configuration;
				if (a.request.expectedGeneration !== state.enrollment.generation)
					throw new ControlHostError("stale_generation", "Enrollment changed");
				if (a.request.expectedRoleEpoch !== c.roleEpoch)
					throw new ControlHostError("stale_role", "Role epoch changed");
				if (c.freeze && !c.archive)
					throw new ControlHostError("rollback_not_permitted", "Freeze must reconcile forward");
				state.enrollment.state = "revoked";
				c.roleEpoch++;
				delete c.stagedRole;
				state.pairing = { phase: "revoked", localCommitted: true, peerCommitted: false };
				const result = {
					enrollment: state.enrollment,
					configuration: c,
					revokedAt: Date.now(),
					peerAcknowledged: false,
				};
				approval.state = "consumed";
				this.db
					.prepare("UPDATE control_approvals SET data=?,consumed_by=? WHERE id=?")
					.run(JSON.stringify(approval), a.request.idempotencyKey, approvalRequestId);
				this.db
					.prepare("INSERT INTO control_unpairs VALUES(?,?)")
					.run(a.request.idempotencyKey, JSON.stringify(result));
				this.db.prepare("UPDATE control_remote_watches SET active=0 WHERE binding=?").run(a.id);
				this.db.prepare("UPDATE control_enrollments SET data=? WHERE id=?").run(JSON.stringify(state), a.id);
				this.db.prepare("UPDATE control_policy SET data=? WHERE id=1").run(JSON.stringify(c));
				return result;
			});
		if (method === "admission") {
			const op = args as DurableOperation;
			const row = this.db.prepare("SELECT data FROM control_admissions WHERE id=?").get(op.operationId);
			const old = row && (JSON.parse(String(row.data)) as ExecutorAdmission | undefined);
			if (old && canonicalJSON(old.operation) !== canonicalJSON(op))
				throw new ControlHostError("reconciliation_required", "Immutable domain admission changed");
			return old;
		}
		if (method === "configuration") return this.configuration();
		if (method === "state") return this.state(String(args));
		if (method === "audit")
			return this.db.prepare("SELECT * FROM control_executor_audit ORDER BY seq DESC LIMIT 100").all();
		// No HTTP route can initialize policy. The protected native bootstrap owner supplies it.
		if (method === "initialize")
			return this.transaction(() => {
				const c = args as ControlHostConfiguration;
				const old = this.configuration();
				if (old && canonicalJSON(old) !== canonicalJSON(c))
					throw new ControlHostError("stale_role", "Existing role policy cannot be replaced");
				this.db.prepare("INSERT OR IGNORE INTO control_policy VALUES(1,?)").run(JSON.stringify(c));
				return old ?? c;
			});
		if (method === "approval") {
			const row = this.db.prepare("SELECT data FROM control_approvals WHERE id=?").get(String(args));
			return row ? JSON.parse(String(row.data)) : undefined;
		}
		if (method === "issue")
			return this.transaction(() => {
				const a = args as { request: ControlHostApprovalRequest; intent: string };
				if (
					Number(this.db.prepare("SELECT COUNT(*) AS n FROM control_approvals").get()!.n) >= 4096 ||
					Number(
						this.db
							.prepare(
								"SELECT COUNT(*) AS n FROM control_approvals WHERE json_extract(data,'$.state')='pending'",
							)
							.get()!.n,
					) >= 64
				)
					throw new ControlHostError("capacity", "Native approval retention full", 503);
				this.db
					.prepare("INSERT INTO control_approvals(id,data,intent) VALUES(?,?,?)")
					.run(a.request.requestId, JSON.stringify(a.request), a.intent);
				return a.request;
			});
		if (method === "decision")
			return this.transaction(() => {
				const a = args as { id: string; allow: boolean };
				const row = this.db.prepare("SELECT data FROM control_approvals WHERE id=?").get(a.id);
				if (!row) throw new ControlHostError("not_found", "Unknown native approval", 404);
				const request = JSON.parse(String(row.data)) as ControlHostApprovalRequest;
				const next = a.allow ? "approved" : "denied";
				if (request.state === next || (a.allow && request.state === "consumed")) return request;
				if (request.state !== "pending")
					throw new ControlHostError("approval_required", "Approval decision conflicts", 403);
				if (request.expiresAt <= Date.now())
					throw new ControlHostError("approval_expired", "Native approval expired");
				request.state = next;
				this.db.prepare("UPDATE control_approvals SET data=? WHERE id=?").run(JSON.stringify(request), a.id);
				return request;
			});
		if (method === "enroll")
			return this.transaction(() => {
				const a = args as { id: string; request: ControlHomeEnrollmentRequest; appKeyId: string };
				const { enrollment: e, approvalRequestId } = a.request;
				const c = this.configuration();
				if (!c) throw new ControlHostError("legacy_migration_required", "Control role bootstrap is not configured");
				const approval = this.db.prepare("SELECT * FROM control_approvals WHERE id=?").get(approvalRequestId);
				const { approvalRequestId: _approval, ...intent } = a.request;
				const approved = approval && (JSON.parse(String(approval.data)) as ControlHostApprovalRequest | undefined);
				if (
					!approved ||
					approved.action !== "enroll" ||
					approved.appKeyId !== a.appKeyId ||
					canonicalJSON(JSON.parse(String(approval!.intent))) !== canonicalJSON(intent)
				)
					throw new ControlHostError("approval_required", "Matching native enrollment approval required", 403);
				if (approval!.consumed_by) {
					if (approval!.consumed_by !== a.id)
						throw new ControlHostError("approval_required", "Approval already consumed", 403);
					return { ...this.state(a.id), mutation: { disposition: "replayed", intentId: approvalRequestId } };
				}
				if (approved.state !== "approved")
					throw new ControlHostError("approval_required", "Enrollment is not approved", 403);
				if (approved.expiresAt <= Date.now())
					throw new ControlHostError("approval_expired", "Enrollment approval expired");
				if (a.request.expectedRoleEpoch !== c.roleEpoch)
					throw new ControlHostError("stale_role", "Role epoch changed");
				const oldRow = this.db.prepare("SELECT data FROM control_enrollments WHERE id=?").get(a.id);
				if (oldRow) {
					const old = JSON.parse(String(oldRow.data)) as ControlHostStateResponse;
					if (canonicalJSON(old.enrollment) !== canonicalJSON(e))
						throw new ControlHostError("stale_generation", "Enrollment is immutable; unpair before replacement");
				} else {
					if (a.request.expectedGeneration !== null)
						throw new ControlHostError("stale_generation", "Enrollment CAS requires explicit null");
					const all = this.db.prepare("SELECT data FROM control_enrollments").all();
					if (all.length >= 128) throw new ControlHostError("capacity", "Enrollment retention full", 503);
					if (
						all.some(
							(row) => (JSON.parse(String(row.data)) as ControlHostStateResponse).enrollment.state === "active",
						)
					)
						throw new ControlHostError("identity_mismatch", "Executor already accepts a Control home");
				}
				if (c.freeze || c.archive)
					throw new ControlHostError("rollback_not_permitted", "Frozen Control cannot be restaged");
				c.stagedRole = { home: e.home, role: "executor", phase: "paired" };
				const state: ControlHostStateResponse = {
					configuration: c,
					enrollment: e,
					peerHello: a.request.peerHello,
					pairing: { phase: "partial", localCommitted: true, peerCommitted: false },
					roleAcknowledgments: [
						{
							contractVersion: 1,
							bindingId: e.bindingId,
							generation: e.generation,
							home: e.home,
							host: c.host,
							role: c.role,
							roleEpoch: c.roleEpoch,
							intentId: approvalRequestId,
						},
					],
				};
				approved.state = "consumed";
				this.db
					.prepare("UPDATE control_approvals SET data=?,consumed_by=? WHERE id=?")
					.run(JSON.stringify(approved), a.id, approvalRequestId);
				this.db.prepare("INSERT OR REPLACE INTO control_enrollments VALUES(?,?)").run(a.id, JSON.stringify(state));
				this.db.prepare("UPDATE control_policy SET data=? WHERE id=1").run(JSON.stringify(c));
				return { ...state, mutation: { disposition: "applied", intentId: approvalRequestId } };
			});
		if (method === "check" || method === "prepare")
			return this.transaction(() => {
				const a = args as {
					operation: DurableOperation;
					roleFence: { home: number; executor: number };
					authorizationId: string;
					safety: boolean;
				};
				const row = this.db.prepare("SELECT data FROM control_admissions WHERE id=?").get(a.operation.operationId);
				const old = row && (JSON.parse(String(row.data)) as ExecutorAdmission | undefined);
				if (old && canonicalJSON(old.operation) !== canonicalJSON(a.operation))
					throw new ControlHostError("reconciliation_required", "Immutable domain admission changed");
				if (old?.result) return old;
				this.fence(a.operation, a.roleFence, a.safety);
				if (
					!a.safety &&
					this.db
						.prepare("SELECT 1 FROM control_revocations WHERE binding=? AND authorization=?")
						.get(a.operation.bindingId!, a.authorizationId)
				)
					throw new ControlHostError("capability_denied", "Authorization revoked on executor", 403);
				if (method === "check") return old;
				if (!old) {
					if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM control_admissions").get()!.n) >= 4096)
						throw new ControlHostError("capacity", "Executor admission retention full", 503);
					const admission = { operation: a.operation };
					this.db
						.prepare("INSERT INTO control_admissions VALUES(?,?)")
						.run(a.operation.operationId, JSON.stringify(admission));
					this.audit(a.operation, "requested", { authorizationId: a.authorizationId });
					return admission;
				}
				return old;
			});
		if (method === "complete")
			return this.transaction(() => {
				const a = args as ExecutorAdmission;
				const row = this.db.prepare("SELECT data FROM control_admissions WHERE id=?").get(a.operation.operationId);
				if (!row) throw new Error("Missing executor admission");
				const old = JSON.parse(String(row.data)) as ExecutorAdmission;
				if (old.result) return old.result;
				this.db
					.prepare("UPDATE control_admissions SET data=? WHERE id=?")
					.run(JSON.stringify(a), a.operation.operationId);
				this.audit(a.operation, "accepted", a.result);
				return a.result;
			});
		if (method === "reject")
			return this.transaction(() => {
				const a = args as { operation: DurableOperation; reason: unknown };
				this.audit(a.operation, "rejected", a.reason);
			});
		if (method === "watch")
			return this.transaction(() => {
				const a = args as { operation: DurableOperation; watch: Watch };
				const row = this.db.prepare("SELECT binding,data FROM control_remote_watches WHERE id=?").get(a.watch.id);
				if (row) {
					if (
						row.binding !== a.operation.bindingId ||
						canonicalJSON(JSON.parse(String(row.data))) !== canonicalJSON(a.watch)
					)
						throw new ControlHostError("reconciliation_required", "Watch ID already owned");
					this.complete(a.operation, {
						kind: "control.watch",
						authorizationId: a.watch.authorizationId!,
						watchId: a.watch.id,
					});
					return;
				}
				this.db
					.prepare("INSERT INTO control_remote_watches VALUES(?,?,?,?,1)")
					.run(a.watch.id, a.operation.bindingId!, a.watch.authorizationId!, JSON.stringify(a.watch));
				this.complete(a.operation, {
					kind: "control.watch",
					authorizationId: a.watch.authorizationId!,
					watchId: a.watch.id,
				});
			});
		if (method === "unwatch")
			return this.transaction(() => {
				const a = args as { operation: DurableOperation; authorizationId: string };
				const row = this.db.prepare("SELECT * FROM control_remote_watches WHERE id=?").get(a.operation.targetId);
				if (row && (row.binding !== a.operation.bindingId || row.authorization !== a.authorizationId))
					throw new ControlHostError("capability_denied", "Cannot remove another home's watch", 403);
				if (row) this.db.prepare("UPDATE control_remote_watches SET active=0 WHERE id=?").run(a.operation.targetId);
				this.complete(a.operation, {
					kind: "control.unwatch",
					authorizationId: a.authorizationId,
					watchId: a.operation.targetId,
					removed: !!row,
				});
				return !!row;
			});
		if (method === "revoke")
			return this.transaction(() => {
				const a = args as { operation: DurableOperation; at: number };
				this.db
					.prepare("INSERT OR IGNORE INTO control_revocations VALUES(?,?,?)")
					.run(a.operation.bindingId!, a.operation.targetId, a.at);
				this.db
					.prepare("UPDATE control_remote_watches SET active=0 WHERE binding=? AND authorization=?")
					.run(a.operation.bindingId!, a.operation.targetId);
				const at = Number(
					this.db
						.prepare("SELECT at FROM control_revocations WHERE binding=? AND authorization=?")
						.get(a.operation.bindingId!, a.operation.targetId)!.at,
				);
				this.complete(a.operation, {
					kind: "control.revoke",
					authorizationId: a.operation.targetId,
					revokedAt: at,
				});
				return at;
			});
		throw new Error(`Unknown Control host storage method: ${method}`);
	}
}
