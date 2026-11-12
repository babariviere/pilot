/** Host-owned pause preparation only. Never installs an app or manages a service. */
import type { DurableOperation, OperationReceipt } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { type LifecycleRuntime, validLifecycleRuntime } from "./lifecycle-checkpoint.ts";
import { canonicalJSON, type OperationJournal, payloadHash } from "./operation-journal.ts";
import type { RuntimeBlocker, RuntimeResources } from "./runtime-admission.ts";
import type { SessionManager } from "./sessions.ts";

export const GLOBAL_UPDATE_TARGET = "global-update";
const PREPARE = "global-update-prepare";
const RELEASE = "global-update-release";

export interface AcceptedUpdateLoss {
	schema: 1;
	operationId: string;
	confirmation: string;
	unsavedUI: true;
	unfinishedWork: true;
}

export interface GlobalUpdateTarget {
	/** Digest of the exact durably saved native window/capture. Not a save receipt itself. */
	captureHash?: string;
	/** Native-only explicit consent, instead of a fabricated save receipt. */
	acceptedLoss?: AcceptedUpdateLoss;
	app: { source: string; build: string };
	/** Supplied only by the verified GUI-bundled runtime owner, never a TSX path. */
	replacement?: LifecycleRuntime;
}

function target(value: unknown, operationId: string): GlobalUpdateTarget {
	const v = value as GlobalUpdateTarget;
	const loss = v?.acceptedLoss;
	const stateKey = loss === undefined ? "captureHash" : "acceptedLoss";
	const validState =
		loss === undefined
			? typeof v?.captureHash === "string" && /^[a-f0-9]{64}$/.test(v.captureHash)
			: !!loss &&
				Object.keys(loss).sort().join() === "confirmation,operationId,schema,unfinishedWork,unsavedUI" &&
				loss.schema === 1 &&
				loss.operationId === operationId &&
				typeof loss.confirmation === "string" &&
				/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(loss.confirmation) &&
				loss.unsavedUI === true &&
				loss.unfinishedWork === true;
	if (
		!v ||
		![
			["app", stateKey],
			["app", stateKey, "replacement"],
		].some((keys) => keys.sort().join() === Object.keys(v).sort().join()) ||
		!validState ||
		!v.app ||
		Object.keys(v.app).sort().join() !== "build,source" ||
		typeof v.app.source !== "string" ||
		!/^[a-f0-9]{40}$/.test(v.app.source) ||
		typeof v.app.build !== "string" ||
		v.app.build.length > 128 ||
		!/^\d+(?:\.\d+)*$/.test(v.app.build) ||
		(v.replacement !== undefined && !validLifecycleRuntime(v.replacement))
	)
		throw new Conflict("Invalid global update target/capture");
	return structuredClone(v);
}

/** One preparation per immutable operation. Unknown is lookup-only, including on reopen.
 * The native caller must save/seal state or durably confirm exact loss before entry, and independently verify
 * signatures/versions and process safety before installing. A pause receipt grants none
 * of that authority. All resource contributors (including schedules) must be supplied.
 */
export class GlobalUpdatePreparation {
	private releaseAdmissions?: () => void;
	private loading?: Promise<void>;
	private active?: string;
	private pending = false;
	private loaded = false;
	private readonly journal: OperationJournal;
	private readonly resources: RuntimeResources;
	private readonly sessions: SessionManager;
	constructor(journal: OperationJournal, resources: RuntimeResources, sessions: SessionManager) {
		this.journal = journal;
		this.resources = resources;
		this.sessions = sessions;
	}

	/** Freeze before the first await, before SessionManager.load or queued recovery. */
	load(): Promise<void> {
		if (this.loading) return this.loading;
		this.releaseAdmissions ??= this.resources.freezeAdmissions();
		this.loading ??= this.restore();
		return this.loading;
	}
	private async restore(): Promise<void> {
		const preparations = await this.journal.targetReceipts(PREPARE, GLOBAL_UPDATE_TARGET);
		const releases = await this.journal.targetReceipts(RELEASE, GLOBAL_UPDATE_TARGET);
		const outstanding = preparations.filter((p) => {
			if (p.state === "rejected") throw new Conflict("Invalid retained global preparation");
			return !releases.some((r) => {
				if (r.state !== "accepted") return false;
				const result = r.result as { prepareId?: string; prepareHash?: string } | undefined;
				return result?.prepareId === p.operationId && result.prepareHash === p.payloadHash;
			});
		});
		if (outstanding.length > 1) throw new Conflict("Multiple retained global update owners");
		this.active = outstanding[0]?.operationId;
		if (this.active) this.sessions.holdGlobalUpdateRecovery(this.active);
		this.loaded = true;
		if (!this.active) this.thaw();
	}
	private thaw(): void {
		const release = this.releaseAdmissions;
		this.releaseAdmissions = undefined;
		release?.();
	}
	get frozen(): boolean {
		return !this.loaded || this.active !== undefined || this.pending;
	}
	private assertOperation(op: DurableOperation, kind: string): void {
		if (!this.loaded || this.pending || op.kind !== kind || op.targetId !== GLOBAL_UPDATE_TARGET)
			throw new Conflict("Global update preparation unavailable or changed");
	}
	/** Native authority must be checked by the caller. This is not a public HTTP intent. */
	async prepare(operation: DurableOperation): Promise<OperationReceipt> {
		const op = structuredClone(operation);
		this.assertOperation(op, PREPARE);
		const pinned = target(JSON.parse(op.payload), op.operationId);
		const previous = await this.journal.lookup(op);
		if (previous) return previous; // Never re-enter a retained pending operation.
		// Recheck after journal I/O. Another preparation/release may have won.
		this.assertOperation(op, PREPARE);
		if (this.active) throw new Conflict("Original global update requires lookup");
		this.pending = true;
		this.active = op.operationId;
		this.releaseAdmissions ??= this.resources.freezeAdmissions();
		try {
			return await this.journal.execute(op, async (_op, { firstEntry }) => {
				if (!firstEntry) throw new Conflict("Original global update requires lookup");
				try {
					// Loss acceptance must be durable before the first interruption. A
					// pending/unknown operation is still lookup-only, never new consent.
					if (pinned.acceptedLoss) await this.journal.checkpoint(op, { target: pinned, phase: "loss-accepted" });
					await this.sessions.checkpointLifecycle(
						op.operationId,
						"app-update",
						pinned.replacement,
						pinned.acceptedLoss,
					);
				} catch (error) {
					await this.journal.checkpoint(op, {
						target: pinned,
						phase: "interrupted",
						reason: error instanceof Error ? error.message.slice(0, 512) : "Host preparation failed",
					});
					throw error;
				}
				// These are separate observations, NOT a replacement authorization. A
				// broken chat can be interrupted while its effects/processes stay Unknown.
				let timer: ReturnType<typeof setTimeout> | undefined;
				let blockers: RuntimeBlocker[];
				try {
					blockers = await Promise.race([
						this.resources.blockers(),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("Global resource inspection timed out")), 5_000);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
				return {
					target: pinned,
					blockers,
					sessions: this.sessions.lifecycleManifest(op.operationId).map(({ sessionId, checkpoint }) => ({
						sessionId,
						phase: checkpoint.phase,
						hostExited: checkpoint.hostExited === true,
						interrupted: checkpoint.interrupted === true,
					})),
				};
			});
		} finally {
			this.pending = false;
		}
	}
	/** Check always reads the original immutable operation. No pause/cancel/resume effects. */
	lookup(op: DurableOperation): Promise<OperationReceipt | undefined> {
		if (![PREPARE, RELEASE].includes(op.kind) || op.targetId !== GLOBAL_UPDATE_TARGET)
			throw new Conflict("Invalid global update lookup");
		return this.journal.lookup(op);
	}
	/** Fresh process/resource observation under the original durable hold. No
	 * checkpoint, cancellation, install or release is retried by verification. */
	async verify(operation: DurableOperation): Promise<{ receipt: OperationReceipt; blockers: RuntimeBlocker[] }> {
		const op = structuredClone(operation);
		this.assertOperation(op, PREPARE);
		const receipt = await this.journal.lookup(op);
		if (this.active !== op.operationId || receipt?.state !== "accepted")
			throw new Conflict("Original preparation is not acknowledged");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const blockers = await Promise.race([
				this.resources.blockers(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Global resource inspection timed out")), 5_000);
				}),
			]);
			this.assertOperation(op, PREPARE);
			if (this.active !== op.operationId) throw new Conflict("Global preparation owner changed");
			return { receipt, blockers };
		} finally {
			clearTimeout(timer);
		}
	}

	/** A separate native-owned operation releases only this preparation. The verifier
	 * must check actual target versions/rollback or prove install was not entered.
	 * It is never supplied by TSX, a retained hint, or a successful GET.
	 */
	async release(
		operation: DurableOperation,
		preparation: DurableOperation,
		verify: (target: GlobalUpdateTarget) => Promise<void>,
	): Promise<OperationReceipt> {
		const op = structuredClone(operation),
			prepared = structuredClone(preparation);
		this.assertOperation(op, RELEASE);
		const binding = { prepareId: prepared.operationId, prepareHash: prepared.payloadHash };
		if (op.payload !== canonicalJSON(binding) || op.payloadHash !== payloadHash(op.payload))
			throw new Conflict("Global release binding changed");
		const priorRelease = await this.journal.lookup(op);
		if (priorRelease) return priorRelease;
		this.assertOperation(op, RELEASE);
		if (
			this.active !== prepared.operationId ||
			prepared.kind !== PREPARE ||
			prepared.targetId !== GLOBAL_UPDATE_TARGET
		)
			throw new Conflict("Global preparation owner changed");
		const receipt = await this.journal.lookup(prepared);
		if (receipt?.state !== "accepted") throw new Conflict("Unknown preparation is lookup-only");
		const releases = await this.journal.targetReceipts(RELEASE, GLOBAL_UPDATE_TARGET);
		if (releases.some((r) => r.state === "pending"))
			throw new Conflict("Unknown release is original-operation lookup-only");
		const pinned = target(JSON.parse(prepared.payload), prepared.operationId);
		this.assertOperation(op, RELEASE);
		this.pending = true;
		try {
			const released = await this.journal.execute(op, async (_op, { firstEntry }) => {
				if (!firstEntry) throw new Conflict("Unknown release is lookup-only");
				await verify(pinned);
				return binding;
			});
			if (released.state === "accepted") {
				// Authorization is durable before any session can resume. Interrupted
				// checkpoints remain Unknown; existing Stop/mission/sleep holds still win.
				this.active = undefined;
				this.thaw();
				await this.sessions.resumeMaintenance();
			}
			return released;
		} finally {
			this.pending = false;
		}
	}
}
