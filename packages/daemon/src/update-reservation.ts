/** Bounded admission ownership for an explicit update. Never drains, signals or stops work itself. */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RuntimeResources } from "./runtime-admission.ts";

export interface ReservationReceipt {
	schema: 1;
	operationId: string;
	token: string;
	/** Omitted for legacy GUI-only updates, which leave pilotd running. */
	purpose?: "daemon-upgrade";
}

export class UpdateReservation {
	private active?: ReservationReceipt & { until: number; release: () => void };
	private preparing = false;
	private closed = false;
	private timer?: ReturnType<typeof setTimeout>;
	private readonly used = new Set<string>();
	private readonly resources: Pick<RuntimeResources, "freezeAdmissions" | "blockers">;
	private readonly daemonResources?: Pick<RuntimeResources, "freezeAdmissions" | "blockers">;
	private readonly now: () => number;
	private readonly duration: number;
	constructor(
		resources: Pick<RuntimeResources, "freezeAdmissions" | "blockers">,
		now = () => performance.now(),
		duration = 180_000,
		daemonResources?: Pick<RuntimeResources, "freezeAdmissions" | "blockers">,
	) {
		this.resources = resources;
		this.daemonResources = daemonResources;
		this.now = now;
		this.duration = duration;
	}
	private expire(): void {
		if (this.active && this.now() >= this.active.until) this.release();
	}
	private scheduleExpiry(): void {
		clearTimeout(this.timer);
		if (!this.active) return;
		this.timer = setTimeout(
			() => {
				this.expire();
				// Node may wake early after rounding a fractional monotonic deadline.
				// Never strand a freeze when the first callback precedes that deadline.
				if (this.active) this.scheduleExpiry();
			},
			Math.max(1, Math.ceil(this.active.until - this.now())),
		);
		this.timer.unref();
	}
	async prepare(operationId: string, purpose?: "daemon-upgrade"): Promise<ReservationReceipt> {
		this.expire();
		if (purpose !== undefined && (purpose !== "daemon-upgrade" || !this.daemonResources))
			throw new Error("update_reservation_purpose_invalid");
		if (
			this.closed ||
			this.preparing ||
			this.active ||
			this.used.has(operationId) ||
			this.used.size >= 64 ||
			!/^[a-f0-9-]{36}$/.test(operationId)
		)
			throw new Error("update_reservation_busy");
		this.preparing = true;
		this.used.add(operationId); // Failed/expired attempts cannot be replayed or renewed.
		let release = () => {};
		const until = this.now() + this.duration;
		let inspectionTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const resources = purpose === "daemon-upgrade" ? this.daemonResources! : this.resources;
			release = resources.freezeAdmissions();
			const blockers = await Promise.race([
				resources.blockers(),
				new Promise<never>((_, reject) => {
					inspectionTimer = setTimeout(
						() => reject(new Error("update_inspection_timeout")),
						Math.min(10_000, this.duration),
					);
				}),
			]);
			if (blockers.length || this.closed || this.now() >= until) throw new Error("update_reservation_not_idle");
			const receipt: ReservationReceipt = {
				schema: 1,
				operationId,
				token: randomBytes(32).toString("hex"),
				...(purpose ? { purpose } : {}),
			};
			this.active = { ...receipt, until, release };
			this.scheduleExpiry();
			return receipt;
		} catch (error) {
			release();
			throw error;
		} finally {
			clearTimeout(inspectionTimer);
			this.preparing = false;
		}
	}
	/** Proves continuous, unexpired ownership, not permission to signal a process.
	 * GUI updaters verify after GUI exit; daemon adapters must verify before their stop intent. */
	verify(receipt: ReservationReceipt): ReservationReceipt {
		this.expire();
		if (
			!this.active ||
			receipt.schema !== 1 ||
			receipt.operationId !== this.active.operationId ||
			receipt.purpose !== this.active.purpose ||
			receipt.token !== this.active.token
		)
			throw new Error("update_reservation_expired");
		return {
			schema: 1,
			operationId: this.active.operationId,
			token: this.active.token,
			...(this.active.purpose ? { purpose: this.active.purpose } : {}),
		};
	}
	cancel(receipt: ReservationReceipt): void {
		this.verify(receipt);
		this.release();
	}
	private release(): void {
		clearTimeout(this.timer);
		const active = this.active;
		this.active = undefined;
		active?.release();
	}
	close(): void {
		this.closed = true;
		this.release();
	}
}
