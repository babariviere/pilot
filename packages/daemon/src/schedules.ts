import { createHash, randomUUID } from "node:crypto";
import type {
	DashboardScheduledItem,
	InsightsReviewDispatch,
	InsightsReviewRun,
	InsightsStatus,
	ScheduledItem,
	ScheduleHome,
	SchedulePatch,
	ScheduleRecurrence,
	ScheduleRequest,
	ScheduleRun,
	ScheduleTarget,
	SpawnRequest,
} from "@pilot/protocol";
import { Conflict, NotFound, ScheduleInputHeld, ServiceUnavailable } from "./errors.ts";
import { INSIGHTS_INITIAL_DEFAULTS } from "./insights-defaults.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import { RuntimeBackground } from "./runtime-background.ts";
import { RecurrenceCalendar, validateRecurrence } from "./schedule-recurrence.ts";
import type { ScheduleStore } from "./schedule-store.ts";
import type { TrackedItemStore } from "./tracked-items.ts";

/** Detection plugs in here. Initial online state is not an offline→online edge. */
export type ScheduleTriggerEvent =
	| { type: "sleep"; at: number }
	| { type: "wake"; full: boolean }
	| { type: "online"; online: boolean; initial?: boolean };
export interface ScheduleTriggerSource {
	readonly online: boolean;
	/** Validate cached reachability before dispatching due work. */
	refreshOnline?(): Promise<boolean>;
	/** Use online events with initial:true to resynchronize a suspended detector without inventing an edge. */
	subscribe(listener: (event: ScheduleTriggerEvent) => void): () => void;
	/** Detection can suspend its probes when no pending schedules remain. */
	setActive?(active: boolean): void;
	/** Helper wake events only, without subprocess wake sampling. */
	setCalendarActive?(active: boolean): void;
}
export interface ScheduleClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): () => void;
}
const clock: ScheduleClock = {
	now: Date.now,
	setTimeout(callback, ms) {
		const timer = setTimeout(callback, ms);
		timer.unref();
		return () => clearTimeout(timer);
	},
};
function companionReceipt(run: ScheduleRun, due: number, count = run.count): ScheduleRun {
	const admission = run.admission;
	return {
		...run,
		due,
		late: (run.admittedAt ?? run.at) - due > 300000 ? true : undefined,
		count,
		admission: admission
			? {
					inputHash: admission.inputHash,
					requestId: admission.requestId,
					sessionId: admission.sessionId,
					definitionHash: admission.definitionHash,
				}
			: undefined,
	};
}
export interface ScheduleInputGate {
	check(
		sessionId: string,
		requestId: string,
		content: string,
	): "ready" | "held" | "expired" | "invalid" | "stale_input";
	denied(
		sessionId: string,
		requestId: string,
		reason: "expired" | "invalid" | "unknown" | "stale_input",
	): Promise<void>;
	accepted(sessionId: string, requestId: string, at: number): Promise<void>;
	acceptedAt(sessionId: string, requestId: string, content?: string): number | undefined;
	now(): number;
}
export interface ScheduleDispatch {
	setScheduleAdmission?(gate: ScheduleInputGate): void;
	resumeScheduled?(): void | Promise<void>;
	pendingScheduled?(): boolean;
	uncertainScheduled?(id: string, requestId: string): boolean;
	sendScheduled?(sessionId: string, message: string, requestId: string): Promise<void>;
	spawnScheduled?(request: SpawnRequest, sessionId: string, requestId: string): Promise<{ id: string }>;
	spawn(
		request: SpawnRequest,
		activeMissionCoordinator?: boolean,
		taskId?: undefined,
		missionAdmission?: undefined,
		job?: import("./chat-report.ts").ChatJob,
	): Promise<{ id: string }>;
	send(id: string, message: string, mode: "followUp", requestId: string): Promise<void>;
	get(id: string):
		| {
				projectId?: string;
				working?: boolean;
				missionId?: string;
				activeMissionCoordinator?: boolean;
				archivedAt?: number;
				role?: string;
		  }
		| undefined;
	insightsStatus?(id: string): InsightsStatus | undefined;
	insightsOwnerStatus?(
		id: string,
	): { owner: import("@pilot/protocol").InsightsWorkspaceOwner; available: boolean } | undefined;
	insightsOwnerScheduleBounds?(
		id: string,
		revision: number,
		recurrence?: ScheduleRecurrence,
	): InsightsReviewDispatch["bounds"];
	dayInsightsScheduleReady?(id: string, revision: number): boolean;
	dispatchInsightsOwnerReview?(id: string, request: InsightsReviewDispatch): Promise<InsightsReviewRun>;
	insightsOwnerReviewStatus?(id: string, runId: string): Promise<InsightsReviewRun | null>;
	insightsReplacementTarget?(id: string): void;
	dispatchInsightsReview?(id: string, request: InsightsReviewDispatch): Promise<InsightsReviewRun>;
	insightsReviewStatus?(id: string, runId: string): Promise<InsightsReviewRun | null>;
	onInsightsReviewChange?(listener: () => void): () => void;
	insightsScheduleBounds?(
		id: string,
		revision?: number,
		recurrence?: ScheduleRecurrence,
	): InsightsReviewDispatch["bounds"];
}
export interface ScheduleServiceDeps {
	sessions: ScheduleDispatch;
	projects: Pick<ProjectStore, "require">;
	missions?: Pick<MissionStore, "require"> & Partial<Pick<MissionStore, "controls" | "onChange">>;
	trackedItems?: Pick<TrackedItemStore, "require" | "patch">;
	clock?: ScheduleClock;
	triggers?: ScheduleTriggerSource;
	automationsEnabled?: () => boolean;
	home?: ScheduleHome;
	paused?: () => boolean;
	subscribeAdmission?: (listener: () => void) => () => void;
	platform?: string;
}
/** One serial dispatcher. No detection/polling here; one nearest-deadline timer while online. */
export class ScheduleService {
	readonly runtime = new RuntimeBackground(
		"schedules",
		() => this.requestSweep(),
		() => {
			this.cancelTimer?.();
			this.cancelTimer = undefined;
			this.deps.triggers?.setActive?.(false);
			this.deps.triggers?.setCalendarActive?.(false);
		},
	);
	private readonly time: ScheduleClock;
	private online = false;
	private sleeping = false;
	private started = false;
	private stopped = false;
	private inventoryLoaded = false;
	private tail: Promise<void> = Promise.resolve();
	private queued = 0;
	private sweepQueued = false;
	private recoveryPending = true;
	private cancelTimer?: () => void;
	private disposers: Array<() => void> = [];
	private acknowledgements = new Map<string, { id: string; at: number }>();
	readonly store: ScheduleStore;
	private readonly deps: ScheduleServiceDeps;
	constructor(store: ScheduleStore, deps: ScheduleServiceDeps) {
		this.store = store;
		this.deps = deps;
		this.time = deps.clock ?? clock;
		deps.sessions.setScheduleAdmission?.({
			check: (id, req, content) => this.inputAdmission(id, req, content),
			denied: (id, req, reason) => this.inputDenied(id, req, reason),
			accepted: (id, req, at) => this.inputAccepted(id, req, at),
			acceptedAt: (id, req, content) => this.acceptedAt(id, req, content),
			now: () => this.time.now(),
		});
	}
	private acceptedAt(id: string, requestId: string, content?: string): number | undefined {
		const key = /^schedule:([^:]+)(?::\d+)?$/.exec(requestId)?.[1];
		if (!key) return;
		let row: ScheduledItem;
		try {
			row = this.store.require(key);
		} catch {
			return;
		}
		const at = row.runs?.find(
			(r) =>
				r.admission?.requestId === requestId &&
				r.admission.sessionId === id &&
				(content === undefined || r.admission.inputHash === this.inputHash(content)),
		)?.admittedAt;
		return typeof at === "number" && Number.isFinite(at) ? at : undefined;
	}
	private async inputAccepted(id: string, requestId: string, at: number): Promise<void> {
		this.assertOpen();
		const key = /^schedule:([^:]+)(?::\d+)?$/.exec(requestId)?.[1];
		if (!key) return;
		let row: ScheduledItem;
		try {
			row = this.store.require(key);
		} catch {
			return;
		}
		if (row.state === "dispatching" && row.admission?.requestId === requestId && row.admission.sessionId === id) {
			// The original dispatcher will persist this observation with its result.
			this.acknowledgements.set(requestId, { id, at });
			return;
		}
		await this.runtime.run("dispatch", async () => {
			const previous = row.runs?.find((r) => r.admission?.requestId === requestId && r.admission.sessionId === id);
			if (!previous) return;
			const run: ScheduleRun = {
				...previous,
				admittedAt: at,
				...(at - previous.due > 300000 ? { late: true } : {}),
			};
			if (previous.admittedAt !== at)
				row = await this.store.replace(row, {
					...row,
					runs: row.runs!.map((r) => (r === previous ? run : r)),
					...(run.late ? { notice: run } : {}),
					updatedAt: this.time.now(),
				});
			for (const ref of run.admission?.companions ?? []) {
				let related: ScheduledItem;
				try {
					related = this.store.require(ref.id);
				} catch {
					continue;
				}
				const prior = related.runs?.find((r) => r.admission?.requestId === requestId);
				if (!prior || prior.admittedAt === at) continue;
				const next = companionReceipt(
					{ ...prior, admittedAt: at, ...(at - prior.due > 300000 ? { late: true } : {}) },
					prior.due,
				);
				await this.store.replace(related, {
					...related,
					runs: related.runs!.map((r) => (r === prior ? next : r)),
					...(next.late ? { notice: next } : {}),
					updatedAt: this.time.now(),
				});
			}
		});
	}
	private requestFor(item: ScheduledItem, due?: number): string {
		return `schedule:${item.id}${due === undefined ? "" : `:${due}`}`;
	}
	private chatFor(requestId: string): string {
		const h = createHash("sha256").update(requestId).digest("hex");
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
	}
	private definitionHash(row: ScheduledItem): string {
		return createHash("sha256")
			.update(
				canonicalJSON({
					title: row.title,
					projectId: row.projectId,
					target: row.target,
					recurrence: row.recurrence ?? null,
					expiresAt: row.expiresAt ?? null,
					missionCheckIn: row.missionCheckIn ?? null,
				}),
			)
			.digest("hex");
	}
	private admissionFor(row: ScheduledItem, due?: number, companions: ScheduledItem[] = []) {
		const requestId = this.requestFor(row, due);
		return {
			inputHash: this.inputHash(
				[row, ...companions]
					.map((r) => (r.target.kind === "message" ? r.target.message : r.target.spawn.message))
					.join("\n\n"),
			),
			requestId,
			sessionId: row.target.kind === "message" ? row.target.sessionId : this.chatFor(requestId),
			definitionHash: this.definitionHash(row),
			...(companions.length
				? { companions: companions.map((r) => ({ id: r.id, definitionHash: this.definitionHash(r) })) }
				: {}),
		};
	}
	private inputHash(content: string): string {
		return createHash("sha256").update(content).digest("hex");
	}
	private inputAdmission(
		sessionId: string,
		requestId: string,
		content: string,
	): "ready" | "held" | "expired" | "invalid" | "stale_input" {
		if (!this.inventoryLoaded || this.stopped || this.runtime.frozen) return "held";
		const parts = /^schedule:([^:]+)(?::(\d+))?$/.exec(requestId);
		if (!parts) return "invalid";
		let row: ScheduledItem;
		try {
			row = this.store.require(parts[1]!);
		} catch {
			return "invalid";
		}
		const admission =
			row.admission?.requestId === requestId
				? row.admission
				: row.runs?.find((r) => r.admission?.requestId === requestId)?.admission;
		if (!admission || admission.sessionId !== sessionId || admission.definitionHash !== this.definitionHash(row))
			return "invalid";
		if (admission.inputHash !== this.inputHash(content)) return "stale_input";
		for (const ref of admission.companions ?? []) {
			let related: ScheduledItem;
			try {
				related = this.store.require(ref.id);
			} catch {
				return "invalid";
			}
			if (
				!["dispatching", "fired"].includes(related.state) ||
				ref.definitionHash !== this.definitionHash(related) ||
				!this.validCheckIn(related)
			)
				return "invalid";
			if (related.expiresAt !== undefined && related.expiresAt <= this.time.now()) return "expired";
		}
		if (row.target.kind === "message" ? row.target.sessionId !== sessionId : this.chatFor(requestId) !== sessionId)
			return "invalid";
		const target = this.deps.sessions.get(sessionId);
		if (target && (target.projectId !== row.projectId || target.role !== undefined)) return "invalid";
		try {
			this.deps.projects.require(row.projectId!);
		} catch {
			return "invalid";
		}
		if (!this.validCheckIn(row) || target?.archivedAt !== undefined) return "invalid";
		if (row.trigger === "at") {
			if (parts[2] || !["dispatching", "fired"].includes(row.state)) return "invalid";
			if (row.expiresAt !== undefined && row.expiresAt <= this.time.now()) return "expired";
		} else if (row.trigger === "recurring") {
			const due = Number(parts[2]);
			if (!Number.isSafeInteger(due) || !["dispatching", "pending"].includes(row.state) || row.handledThrough! < due)
				return "invalid";
			if (this.time.now() >= new RecurrenceCalendar(row.recurrence!).periodEnd(due)) return "expired";
			if (
				row.runs?.some(
					(r) => r.due === due && ["failed", "missed", "skipped_running", "unknown"].includes(r.outcome),
				)
			)
				return "invalid";
		} else return "invalid";
		if (
			row.paused ||
			this.missionHeld(row) ||
			this.unavailable() ||
			!this.online ||
			this.deps.automationsEnabled?.() === false
		)
			return "held";
		return "ready";
	}
	private inputDenied(
		sessionId: string,
		requestId: string,
		reason: "expired" | "invalid" | "unknown" | "stale_input",
	): Promise<void> {
		this.assertOpen();
		return this.runtime.run("dispatch", () => this.recordInputDenied(sessionId, requestId, reason));
	}
	private async recordInputDenied(
		_sessionId: string,
		requestId: string,
		reason: "expired" | "invalid" | "unknown" | "stale_input",
	): Promise<void> {
		const parts = /^schedule:([^:]+)(?::(\d+))?$/.exec(requestId);
		if (!parts) return;
		let row: ScheduledItem;
		try {
			row = this.store.require(parts[1]!);
		} catch {
			return;
		}
		if (reason === "unknown" && this.acceptedAt(_sessionId, requestId) !== undefined) return;
		const error =
			reason === "unknown"
				? "Earlier input admission is unknown; nothing was resent. Inspect the target chat before replacing work."
				: reason === "stale_input"
					? "Saved input no longer matches this occurrence"
					: reason === "expired"
						? "Expired before input admission"
						: "Schedule agreement or target changed before input admission";
		const due = parts[2] === undefined ? row.at! : Number(parts[2]);
		const run: ScheduleRun = {
			due,
			at: this.time.now(),
			outcome: reason === "unknown" ? "unknown" : "missed",
			error,
		};
		const admission =
			row.admission?.requestId === requestId
				? row.admission
				: row.runs?.find((r) => r.admission?.requestId === requestId)?.admission;
		run.admission = admission;
		if (
			reason !== "unknown" &&
			admission &&
			(admission.companions?.length || reason === "stale_input") &&
			row.trigger === "at"
		) {
			// This combined input was definitively refused before entry. Keep each
			// still-valid reminder, not the rejected combination, for re-coalescing.
			const refs = [{ id: row.id, definitionHash: admission.definitionHash }, ...(admission.companions ?? [])];
			for (const ref of refs) {
				let current: ScheduledItem;
				try {
					current = this.store.require(ref.id);
				} catch {
					continue;
				}
				if (
					current.trigger !== "at" ||
					!["dispatching", "fired"].includes(current.state) ||
					this.definitionHash(current) !== ref.definitionHash
				)
					continue;
				const target =
					current.target.kind === "message" ? this.deps.sessions.get(current.target.sessionId) : undefined;
				const expired = current.expiresAt !== undefined && current.expiresAt <= this.time.now();
				let project = true;
				try {
					this.deps.projects.require(current.projectId!);
				} catch {
					project = false;
				}
				if (
					!expired &&
					project &&
					target &&
					target.projectId === current.projectId &&
					target.role === undefined &&
					target.archivedAt === undefined &&
					this.validCheckIn(current)
				) {
					await this.store.replace(current, {
						...current,
						state: "pending",
						admission: undefined,
						claimedAt: undefined,
						firedAt: undefined,
						runs: undefined,
						notice: undefined,
						error: undefined,
						updatedAt: this.time.now(),
					});
				} else {
					const missed = companionReceipt(
						{
							...run,
							admission: undefined,
							error: expired
								? "Expired before input admission"
								: "Check-in agreement or target changed before input admission",
						},
						current.at!,
					);
					await this.store.replace(current, {
						...current,
						state: "failed",
						error: missed.error,
						runs: [missed],
						notice: missed,
						updatedAt: this.time.now(),
					});
				}
			}
			return;
		}
		const alreadyUnknown =
			reason === "unknown" && row.runs?.some((r) => r.outcome === "unknown" && r.admission?.requestId === requestId);
		if (!alreadyUnknown) {
			if (row.trigger === "recurring") {
				if (row.state === "dispatching" && row.handledThrough === due)
					await this.finishOccurrence(row, run, reason === "unknown");
				else if (row.runs?.some((r) => r.due === due))
					await this.store.replace(row, {
						...row,
						runs: row.runs.map((r) => (r.due === due ? run : r)),
						notice: run,
						updatedAt: this.time.now(),
						...(reason === "unknown" ? { paused: true as const } : {}),
					});
			} else if (
				row.trigger === "at" &&
				["dispatching", "fired", ...(reason === "unknown" ? ["failed"] : [])].includes(row.state)
			)
				await this.store.replace(row, {
					...row,
					state: "failed",
					error,
					runs: [run],
					notice: run,
					updatedAt: this.time.now(),
				});
		}
		for (const ref of admission?.companions ?? []) {
			let related: ScheduledItem;
			try {
				related = this.store.require(ref.id);
			} catch {
				continue;
			}
			if (
				reason === "unknown" &&
				related.runs?.some((r) => r.outcome === "unknown" && r.admission?.requestId === requestId)
			)
				continue;
			if (
				related.trigger === "at" &&
				["dispatching", "fired", ...(reason === "unknown" ? ["failed"] : [])].includes(related.state) &&
				this.definitionHash(related) === ref.definitionHash
			)
				await this.store.replace(related, {
					...related,
					state: "failed",
					error,
					runs: [companionReceipt(run, related.at!)],
					notice: companionReceipt(run, related.at!),
					updatedAt: this.time.now(),
				});
		}
	}
	async load(): Promise<void> {
		await this.store.load(this.time.now());
		this.inventoryLoaded = true;
	}
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.online = this.deps.triggers?.online ?? false;
		this.disposers.push(
			this.store.onChange(() => {
				// A durable claim removes the last pending item before admission can take a long time.
				if (this.store.pendingItems().length === 0) {
					this.deps.triggers?.setActive?.(false);
				}
				this.requestSweep();
			}),
		);
		if (this.deps.triggers)
			this.disposers.push(
				this.deps.triggers.subscribe((event) => {
					void this.signal(event).catch((error) => console.warn(`pilotd: schedule trigger: ${error}`));
				}),
			);
		if (this.deps.subscribeAdmission) this.disposers.push(this.deps.subscribeAdmission(() => this.requestSweep()));
		if (this.deps.missions?.onChange) this.disposers.push(this.deps.missions.onChange(() => this.requestSweep()));
		if (this.deps.sessions.onInsightsReviewChange)
			this.disposers.push(this.deps.sessions.onInsightsReviewChange(() => this.requestSweep()));
		this.requestSweep();
	}
	private enqueue(work: () => Promise<void>): Promise<void> {
		if (this.stopped) return Promise.reject(new ServiceUnavailable("Scheduler stopped"));
		if (this.queued >= 64) return Promise.reject(new ServiceUnavailable("Scheduler busy; retry shortly"));
		const end = this.runtime.begin("dispatch");
		this.queued++;
		const next = this.tail.then(work);
		this.tail = next
			.catch(() => {})
			.finally(() => {
				this.queued--;
				end();
			});
		return next;
	}
	private requestSweep(): void {
		if (!this.started || this.stopped || this.runtime.frozen || this.sweepQueued) return;
		this.sweepQueued = true;
		void this.enqueue(async () => {
			this.sweepQueued = false;
			await this.sweep();
		}).catch((error) => {
			this.sweepQueued = false;
			console.warn(`pilotd: schedule dispatch: ${error}`);
			this.arm();
		});
	}
	/** Injectable daemon detector events, never an HTTP dispatch endpoint. */
	signal(event: ScheduleTriggerEvent): Promise<void> {
		if (!this.started || this.stopped) return Promise.reject(new ServiceUnavailable("Scheduler not running"));
		if (this.queued >= 64) return Promise.reject(new ServiceUnavailable("Scheduler busy; retry shortly"));
		if (event.type === "online") this.online = event.online;
		if (event.type === "sleep") this.sleeping = true;
		if (event.type === "wake" && event.full) this.sleeping = false;
		if (this.runtime.frozen) return Promise.resolve();
		return this.enqueue(async () => {
			try {
				await this.sweep();
			} finally {
				this.arm();
			}
		});
	}
	ownerSettingsCommitted(): void {
		this.requestSweep();
	}
	private activeItems() {
		if (this.deps.automationsEnabled?.() === false) return [];
		return this.store.pendingItems().filter(({ id }) => {
			const item = this.store.require(id);
			return (
				!this.missionHeld(item) &&
				(!item.insightsOwnerDestination ||
					this.deps.sessions.dayInsightsScheduleReady?.(
						item.insightsOwnerDestination.reportSessionId,
						item.insightsSettingsRevision ?? 0,
					) !== false)
			);
		});
	}
	private missionId(item: ScheduledItem): string | undefined {
		return item.target.kind === "chat"
			? item.target.spawn.missionId
			: this.deps.sessions.get(item.target.sessionId)?.missionId;
	}
	private missionHeld(item: ScheduledItem): boolean {
		const id = this.missionId(item);
		return !!id && !!this.deps.missions?.controls?.current(id).held;
	}
	private validCheckIn(item: ScheduledItem): boolean {
		const owner = item.missionCheckIn;
		if (!owner) return true;
		try {
			const mission = this.deps.missions!.require(owner.missionId);
			const session = this.deps.sessions.get(owner.coordinatorSessionId);
			return (
				mission.status === "active" &&
				mission.coordinatorSessionId === owner.coordinatorSessionId &&
				mission.briefRevision === owner.briefRevision &&
				session?.missionId === owner.missionId &&
				session.projectId === item.projectId &&
				item.target.kind === "message" &&
				item.target.sessionId === owner.coordinatorSessionId
			);
		} catch {
			return false;
		}
	}
	/** Join already-entered dispatches. Pending rules keep their revisions and user holds. */
	async drainMission(missionId: string): Promise<void> {
		await this.tail;
		if (!this.inventoryLoaded) throw new Error("Schedule inventory is unavailable");
		if (this.store.list().some((item) => this.missionId(item) === missionId && item.state === "dispatching"))
			throw new Error("Mission schedule dispatch has no terminal receipt");
	}
	private unavailable(): boolean {
		return this.stopped || this.runtime.frozen || (this.deps.paused ? this.deps.paused() : this.sleeping);
	}
	private async sweep(): Promise<void> {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		// Passive terminal lookup also runs while dispatch is paused/offline/disabled.
		await this.reconcileReviews(this.recoveryPending);
		this.recoveryPending = false;
		for (const expiry of this.store.expiringItems()) {
			if (expiry.expiresAt! <= this.time.now()) {
				const item = this.store.require(expiry.id);
				await this.expire(item);
			}
		}
		const pending = this.activeItems();
		this.deps.triggers?.setCalendarActive?.(pending.length > 0);
		if (this.unavailable()) {
			this.arm();
			return;
		}
		// Evaluate expiry even offline. Refresh once per sweep, only if an occurrence could run.
		let needsNetwork = this.deps.sessions.pendingScheduled?.() ?? false;
		for (const item of pending) {
			if (item.at! > this.time.now()) continue;
			const row = this.store.require(item.id);
			if (row.revision !== item.revision || row.state !== "pending") continue;
			if (row.trigger === "recurring") {
				const c = new RecurrenceCalendar(row.recurrence!);
				const due = c.latest(this.time.now());
				if (due <= row.handledThrough!) continue;
				if (this.time.now() >= c.periodEnd(due)) {
					await this.finishOccurrence(row, {
						due,
						at: this.time.now(),
						outcome: "missed",
						count: c.count(row.handledThrough!, due),
					});
					continue;
				}
			}
			needsNetwork = true;
		}
		if (needsNetwork && this.deps.triggers?.refreshOnline) this.online = await this.deps.triggers.refreshOnline();
		if (this.online) await this.deps.sessions.resumeScheduled?.();
		for (const item of pending) {
			if (this.unavailable() || !this.online) break;
			if (item.at! > this.time.now()) continue;
			try {
				const current = this.store.require(item.id);
				if (current.state !== "pending" || current.paused || current.revision !== item.revision) continue;
				if (current.trigger === "recurring") {
					if (this.deps.automationsEnabled?.()) await this.fireRecurring(current);
				} else {
					const target = current.target;
					const session = target.kind === "message" ? this.deps.sessions.get(target.sessionId) : undefined;
					const others =
						session?.activeMissionCoordinator && session.missionId && target.kind === "message"
							? pending
									.filter((p) => p.id !== current.id && p.trigger === "at" && p.at! <= this.time.now())
									.map((p) => this.store.require(p.id))
									.filter(
										(p) =>
											p.state === "pending" &&
											this.validCheckIn(p) &&
											!p.paused &&
											p.target.kind === "message" &&
											p.target.sessionId === target.sessionId &&
											(p.expiresAt === undefined || p.expiresAt > this.time.now()),
									)
							: [];
					// 32 KiB fits about four full native-editor messages in one model turn.
					// Count without allocating a joined prompt. Oversized groups stay held,
					// not split into an automatic burst of turns.
					const group = [current, ...others];
					const bytes = others.length
						? group.reduce(
								(sum, r, i) =>
									sum + (r.target.kind === "message" ? Buffer.byteLength(r.target.message) : 0) + (i ? 2 : 0),
								0,
							)
						: 0;
					if (bytes > 32 * 1024) {
						for (const row of group)
							await this.store.replace(row, {
								...row,
								paused: true,
								error: `Combined check-ins use ${bytes} bytes; the limit is 32 KiB (32768 bytes). Shorten messages or resume selected check-ins separately.`,
								updatedAt: this.time.now(),
							});
						continue;
					}
					await this.fire(current, others);
				}
			} catch (error) {
				if (!(error instanceof NotFound)) throw error;
			}
		}
		this.arm();
	}
	private arm(): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		const pending = this.activeItems(),
			now = this.time.now();
		this.deps.triggers?.setCalendarActive?.(!this.stopped && pending.length > 0);
		const waiting =
			!this.unavailable() &&
			(pending.some((item) => item.at! <= now) ||
				(!!this.deps.automationsEnabled?.() && !!this.deps.sessions.pendingScheduled?.()));
		this.deps.triggers?.setActive?.(waiting && !this.online);
		if (this.stopped || this.runtime.frozen) return;
		// Offline due rules also need a period-expiry timer, not an immediate retry loop.
		const deadlines = (this.unavailable() ? [] : pending).map((item) => {
			if (item.at! > now) return item.at!;
			if (item.trigger === "recurring")
				return new RecurrenceCalendar(this.store.require(item.id).recurrence!).periodEnd(now);
			return Infinity;
		});
		for (const item of this.store.expiringItems()) deadlines.push(item.expiresAt!);
		const next = Math.min(...deadlines);
		if (Number.isFinite(next))
			this.cancelTimer = this.time.setTimeout(
				() => {
					this.cancelTimer = undefined;
					this.requestSweep();
				},
				Math.min(
					this.deps.platform === "linux" || (!this.deps.platform && process.platform === "linux")
						? 900_000
						: 2_147_483_647,
					Math.max(0, next - now),
				),
			);
	}
	private async finishOccurrence(item: ScheduledItem, run: ScheduleRun, paused = false): Promise<void> {
		run = { ...run, ...(item.admission ? { admission: item.admission } : {}) };
		const noteworthy = run.late || !["started", "sent"].includes(run.outcome);
		await this.store.replace(item, {
			...item,
			state: "pending",
			handledThrough: run.due,
			at: new RecurrenceCalendar(item.recurrence!).next(run.due),
			claimedAt: undefined,
			insightsReview: undefined,
			admission: undefined,
			updatedAt: this.time.now(),
			runs: [...(item.runs ?? []), run].slice(-10),
			notice: noteworthy ? run : undefined,
			sessionId: run.sessionId ?? item.sessionId,
			paused: paused ? true : item.paused,
			error: paused ? run.error : undefined,
		});
	}
	private async fireRecurring(item: ScheduledItem): Promise<void> {
		if (this.missionHeld(item)) return;
		if (this.unavailable() || !this.deps.automationsEnabled?.()) return;
		const calendar = new RecurrenceCalendar(item.recurrence!);
		const due = calendar.latest(this.time.now());
		if (due <= item.handledThrough!) return;
		const count = calendar.count(item.handledThrough!, due);
		if (!this.validCheckIn(item)) {
			await this.finishOccurrence(
				item,
				{ due, at: this.time.now(), outcome: "missed", error: "Check-in agreement or coordinator changed" },
				true,
			);
			return;
		}
		if (this.time.now() >= calendar.periodEnd(due)) {
			await this.finishOccurrence(item, { due, at: this.time.now(), outcome: "missed", count });
			return;
		}
		// Reserve the identity in the occurrence CAS, before any review preparation or input placement.
		// Destination role is host-owned. Message text cannot select/mint Insights authority.
		const insights =
			item.target.kind === "message" ? this.deps.sessions.insightsStatus?.(item.target.sessionId) : undefined;
		const ownerDestination = item.insightsOwnerDestination;
		if (
			ownerDestination &&
			this.deps.sessions.dayInsightsScheduleReady?.(
				ownerDestination.reportSessionId,
				item.insightsSettingsRevision ?? 0,
			) === false
		)
			return;
		const destination =
			item.insightsDestination ??
			(insights
				? {
						sessionId: insights.sessionId,
						projectId: insights.projectId,
						missionId: insights.missionId,
					}
				: undefined);
		let bounds: InsightsReviewDispatch["bounds"] = { ...INSIGHTS_INITIAL_DEFAULTS.bounds };
		let settingsReady = true;
		if (ownerDestination) {
			try {
				if (!this.deps.sessions.insightsOwnerScheduleBounds) throw new Conflict("Owner execution unsupported");
				bounds = this.deps.sessions.insightsOwnerScheduleBounds(
					ownerDestination.reportSessionId,
					item.insightsSettingsRevision ?? 0,
					item.recurrence,
				);
			} catch {
				settingsReady = false;
			}
		} else if (destination) {
			try {
				bounds =
					this.deps.sessions.insightsScheduleBounds?.(
						destination.sessionId,
						item.insightsSettingsRevision,
						item.recurrence,
					) ?? bounds;
			} catch {
				settingsReady = false;
			}
		}
		const review =
			(destination || ownerDestination) && item.target.kind === "message"
				? {
						sessionId: item.target.sessionId,
						request: {
							runId: randomUUID(),
							windowStart: new Date(calendar.latest(due - 1)).toISOString(),
							windowEnd: new Date(due).toISOString(),
							bounds,
							...(item.insightsSettingsRevision === undefined
								? {}
								: { settingsRevision: item.insightsSettingsRevision }),
						},
					}
				: undefined;
		let claimed: ScheduledItem;
		try {
			claimed = await this.store.replace(item, {
				...item,
				state: "dispatching",
				handledThrough: due,
				claimedAt: this.time.now(),
				updatedAt: this.time.now(),
				insightsReview: review,
				insightsDestination: destination,
				...(!review ? { admission: this.admissionFor(item, due) } : {}),
				...(item.target.kind === "chat" ? { sessionId: this.chatFor(this.requestFor(item, due)) } : {}),
			});
		} catch (error) {
			if (error instanceof Conflict || error instanceof NotFound) return;
			throw error;
		}
		if (!review && (this.unavailable() || this.missionHeld(claimed) || !this.deps.automationsEnabled?.())) {
			// No effect entered: keep the overdue occurrence available for a later resume.
			await this.store.replace(claimed, { ...item, updatedAt: this.time.now() });
			return;
		}
		if (!this.validCheckIn(claimed)) {
			await this.finishOccurrence(
				claimed,
				{ due, at: this.time.now(), outcome: "missed", error: "Check-in agreement or coordinator changed" },
				true,
			);
			return;
		}
		const run: ScheduleRun = {
			due,
			at: this.time.now(),
			outcome: "failed",
			...(count > 1 ? { count } : {}),
			...(review
				? {
						sessionId: review.sessionId,
						insightsReview: { runId: review.request.runId, state: "unresolved" as const },
					}
				: {}),
		};
		let permanentlyMissing = false;
		try {
			// Gates can change while SQLite commits. Consume the claim, never admit across a pause/disable.
			if (this.unavailable() || this.missionHeld(claimed) || !this.deps.automationsEnabled?.())
				throw new Error("Dispatch interrupted before admission");
			try {
				this.deps.projects.require(claimed.projectId!);
			} catch {
				permanentlyMissing = true;
				throw new NotFound("Project was removed");
			}
			const priorId =
				claimed.target.kind === "message"
					? claimed.target.sessionId
					: (item.runs?.findLast((run) => !!run.sessionId)?.sessionId ?? item.sessionId);
			const previous = priorId ? this.deps.sessions.get(priorId) : undefined;
			if (claimed.target.kind === "message" && !previous) {
				permanentlyMissing = true;
				throw new NotFound("Target chat was deleted");
			}
			if (previous?.working) {
				run.outcome = "skipped_running";
				run.sessionId = priorId;
				delete run.insightsReview; // No review was admitted for a skipped occurrence.
			} else {
				run.at = this.time.now();
				const late = run.at - due > 300_000;
				const prefix = late ? lateScheduleLine(claimed.title, due, run.at, calendar) + "\n" : "";
				if (!review && claimed.admission && prefix) {
					const content =
						prefix + (claimed.target.kind === "message" ? claimed.target.message : claimed.target.spawn.message);
					claimed = await this.store.replace(claimed, {
						...claimed,
						admission: { ...claimed.admission, inputHash: this.inputHash(content) },
						updatedAt: this.time.now(),
					});
				}
				if (claimed.target.kind === "chat") {
					const date = new Date(calendar.day(due)).toISOString().slice(0, 10);
					if (this.deps.sessions.spawnScheduled) {
						run.sessionId = (
							await this.deps.sessions.spawnScheduled(
								{
									...claimed.target.spawn,
									title: `${claimed.title} · ${date}`,
									message: prefix + claimed.target.spawn.message,
								},
								claimed.sessionId!,
								this.requestFor(claimed, due),
							)
						).id;
					} else {
						run.sessionId = (
							await this.deps.sessions.spawn(
								{
									...claimed.target.spawn,
									title: `${claimed.title} · ${date}`,
									message: prefix + claimed.target.spawn.message,
								},
								false,
								undefined,
								undefined,
								"schedule",
							)
						).id;
					}
					run.outcome = "started";
				} else {
					run.sessionId = claimed.target.sessionId;
					if (claimed.insightsReview) {
						const { sessionId, request } = claimed.insightsReview;
						run.insightsReview = { runId: request.runId, state: "unresolved" };
						if (ownerDestination) {
							const current = this.deps.sessions.insightsOwnerStatus?.(sessionId);
							if (
								!settingsReady ||
								!current?.available ||
								canonicalJSON(current.owner) !== canonicalJSON(ownerDestination) ||
								claimed.projectId !== current.owner.projectId ||
								!this.deps.sessions.dispatchInsightsOwnerReview
							)
								throw new Conflict("Owner authority unavailable; review not sent");
							this.applyReviewStatus(
								run,
								await this.deps.sessions.dispatchInsightsOwnerReview(sessionId, request),
							);
						} else {
							if (
								!settingsReady ||
								!insights?.available ||
								insights.projectId !== claimed.projectId ||
								insights.projectId !== destination?.projectId ||
								insights.sessionId !== destination?.sessionId ||
								insights.missionId !== destination?.missionId ||
								!this.deps.sessions.dispatchInsightsReview
							)
								throw new Conflict("Insights authority unavailable; review not sent");
							const status = await this.deps.sessions.dispatchInsightsReview(sessionId, request);
							this.applyReviewStatus(run, status);
						}
					} else {
						if (this.deps.sessions.sendScheduled)
							await this.deps.sessions.sendScheduled(
								run.sessionId,
								prefix + claimed.target.message,
								this.requestFor(claimed, due),
							);
						else
							await this.deps.sessions.send(
								run.sessionId,
								prefix + claimed.target.message,
								"followUp",
								`schedule:${claimed.id}:${due}`,
							);
						run.outcome = "sent";
					}
				}
				if (late) run.late = true;
			}
		} catch (error) {
			if (error instanceof ScheduleInputHeld) {
				await this.store.replace(claimed, { ...item, updatedAt: this.time.now() });
				return;
			}
			run.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
			if (error instanceof Error && "code" in error && error.code === "busy") {
				run.outcome = "skipped_running";
				delete run.error;
			}
			if (
				this.deps.sessions.uncertainScheduled?.(
					run.sessionId ?? claimed.sessionId ?? "",
					this.requestFor(claimed, due),
				)
			) {
				run.outcome = "unknown";
				run.error = `Input admission is unknown; nothing will be resent. ${run.error ?? ""}`.slice(0, 1000);
			}
			// A lost dispatch ACK is lookup-only. Never call dispatch again for this occurrence.
			if (run.insightsReview) await this.lookupReview(run);
		}
		const acknowledged = this.acknowledgements.get(this.requestFor(claimed, due));
		if (acknowledged) {
			run.admittedAt = acknowledged.at;
			if (acknowledged.at - due > 300000) run.late = true;
			if (run.outcome === "unknown") {
				run.outcome = claimed.target.kind === "chat" ? "started" : "sent";
				run.error = "Input acknowledged; schedule bookkeeping needs inspection";
			}
		}
		const current = this.store.require(claimed.id);
		if (current.state === "dispatching" && current.admission?.requestId === claimed.admission?.requestId)
			claimed = current;
		if (this.store.require(claimed.id).revision === claimed.revision)
			await this.finishOccurrence(claimed, run, permanentlyMissing || run.outcome === "unknown");
		this.acknowledgements.delete(this.requestFor(claimed, due));
	}
	private applyReviewStatus(run: ScheduleRun, status: InsightsReviewRun | null): void {
		if (!run.insightsReview) return;
		if (!status || status.runId !== run.insightsReview.runId) {
			run.insightsReview.state = "unresolved";
			run.outcome = "failed";
			run.error = "Insights review outcome unresolved; never replay this occurrence. Check the chat.";
			return;
		}
		run.insightsReview.state = status.state;
		if (status.state === "partial" || status.state === "sent") {
			run.outcome = "sent"; // Placement/persistence only, never completed review or delivery proof.
			delete run.error;
		} else {
			run.outcome = "failed";
			run.error = `Insights review ${status.state}; never replay this occurrence. ${status.detail}`.slice(0, 1000);
		}
	}
	private async lookupReview(run: ScheduleRun): Promise<void> {
		try {
			const status = this.deps.sessions.insightsOwnerStatus?.(run.sessionId!)
				? await this.deps.sessions.insightsOwnerReviewStatus?.(run.sessionId!, run.insightsReview!.runId)
				: await this.deps.sessions.insightsReviewStatus?.(run.sessionId!, run.insightsReview!.runId);
			this.applyReviewStatus(run, status ?? null);
			if (status?.state === "sent" && !this.deps.sessions.get(run.sessionId!)?.working) {
				run.outcome = "failed";
				run.error =
					"Insights input placed, but no bounded report persisted and chat is idle; outcome unresolved. Never replay this occurrence.";
			}
		} catch {
			this.applyReviewStatus(run, null);
		}
	}
	private async reconcileReviews(includeUnresolved = false): Promise<void> {
		for (const item of this.store.reviewItems(includeUnresolved)) {
			const runs = structuredClone(item.runs!);
			let notice = item.notice;
			for (const run of runs) {
				if (
					!run.insightsReview ||
					(!["preparing", "ready", "sent"].includes(run.insightsReview.state) &&
						!(includeUnresolved && run.insightsReview.state === "unresolved"))
				)
					continue;
				await this.lookupReview(run);
				// Do not replace a newer occurrence's notice or resurrect a dismissed old notice.
				if (notice?.due === run.due) notice = run.outcome === "sent" && !run.late ? undefined : run;
				else if (
					run === runs.at(-1) &&
					run.outcome === "failed" &&
					item.runs!.at(-1)!.outcome !== "failed" &&
					!notice
				)
					notice = run;
			}
			if (
				JSON.stringify(runs) === JSON.stringify(item.runs) &&
				JSON.stringify(notice) === JSON.stringify(item.notice)
			)
				continue;
			try {
				await this.store.replace(item, { ...item, runs, notice, updatedAt: this.time.now() });
			} catch (error) {
				if (!(error instanceof Conflict || error instanceof NotFound)) throw error;
			}
		}
	}
	private expire(item: ScheduledItem): Promise<ScheduledItem> {
		return this.store.replace(item, {
			...item,
			state: "failed",
			updatedAt: this.time.now(),
			error: "Expired before starting",
			notice: { due: item.at!, at: this.time.now(), outcome: "missed", error: "Expired before starting" },
		});
	}
	private async fire(item: ScheduledItem, coalesced: ScheduledItem[] = []): Promise<void> {
		if (this.unavailable() || this.missionHeld(item) || this.deps.automationsEnabled?.() === false) return;
		if (!this.validCheckIn(item)) {
			await this.store.replace(item, {
				...item,
				state: "failed",
				error: "Check-in agreement or coordinator changed",
				updatedAt: this.time.now(),
			});
			return;
		}
		if (item.expiresAt !== undefined && item.expiresAt <= this.time.now()) {
			await this.expire(item);
			return;
		}
		let claimed: ScheduledItem;
		try {
			claimed = await this.store.replace(item, {
				...item,
				state: "dispatching",
				admission: this.admissionFor(item, undefined, coalesced),
				...(item.target.kind === "chat" ? { sessionId: this.chatFor(this.requestFor(item)) } : {}),
				claimedAt: this.time.now(),
				updatedAt: this.time.now(),
			});
		} catch (error) {
			if (error instanceof Conflict || error instanceof NotFound) return;
			throw error;
		}
		let next: ScheduledItem;
		let sessionId: string | undefined;
		let entered = false;
		const group: ScheduledItem[] = [];
		try {
			for (const row of coalesced)
				group.push(
					await this.store.replace(row, {
						...row,
						state: "dispatching",
						claimedAt: this.time.now(),
						updatedAt: this.time.now(),
					}),
				);
			const settleGroup = async () => {
				// Remove invalid companions once, rechecking after persistence waits before the send.
				while (group.length) {
					const row = group.find(
						(r) => !this.validCheckIn(r) || (r.expiresAt !== undefined && r.expiresAt <= this.time.now()),
					);
					if (!row) break;
					if (!this.validCheckIn(row))
						await this.store.replace(row, {
							...row,
							state: "failed",
							error: "Check-in agreement or coordinator changed",
							updatedAt: this.time.now(),
						});
					else await this.expire(row);
					group.splice(group.indexOf(row), 1);
				}
				if ((claimed.admission?.companions?.length ?? 0) !== group.length)
					claimed = await this.store.replace(claimed, {
						...claimed,
						admission: this.admissionFor(claimed, undefined, group),
					});
			};
			await settleGroup();
			const expireClaim = async () => {
				for (const row of group)
					await this.store.replace(row, {
						...row,
						state: "pending",
						claimedAt: undefined,
						updatedAt: this.time.now(),
					});
				await this.expire(claimed);
			};
			const guard = () => {
				if (this.unavailable() || this.missionHeld(claimed) || this.deps.automationsEnabled?.() === false)
					throw new Conflict("Scheduled work held before admission");
				if (!this.validCheckIn(claimed)) throw new Conflict("Check-in agreement or coordinator changed");
			};
			guard();
			if (claimed.target.kind === "chat") {
				// Recheck the local ticket's project binding before admission.
				await this.validateTrackedItem(claimed.target.trackedItemId, claimed.projectId);
				guard();
				if (claimed.expiresAt !== undefined && claimed.expiresAt <= this.time.now()) {
					await expireClaim();
					return;
				}
				entered = true;
				sessionId = this.deps.sessions.spawnScheduled
					? (
							await this.deps.sessions.spawnScheduled(
								claimed.target.spawn,
								claimed.sessionId!,
								this.requestFor(claimed),
							)
						).id
					: (await this.deps.sessions.spawn(claimed.target.spawn, false, undefined, undefined, "schedule")).id;
				if (claimed.target.trackedItemId)
					await this.deps.trackedItems!.patch(claimed.target.trackedItemId, { sessionId, start: true });
			} else {
				sessionId = claimed.target.sessionId;
				await settleGroup();
				guard();
				if (!this.deps.sessions.get(sessionId)) throw new NotFound("Target chat was deleted");
				if (claimed.expiresAt !== undefined && claimed.expiresAt <= this.time.now()) {
					await expireClaim();
					return;
				}
				entered = true;
				const messages = [claimed, ...group].map((r) => (r.target.kind === "message" ? r.target.message : ""));
				if (this.deps.sessions.sendScheduled)
					await this.deps.sessions.sendScheduled(sessionId, messages.join("\n\n"), this.requestFor(claimed));
				else await this.deps.sessions.send(sessionId, messages.join("\n\n"), "followUp", `schedule:${claimed.id}`);
			}
			const run: ScheduleRun = {
				admission: claimed.admission,
				due: claimed.at!,
				at: this.time.now(),
				outcome: claimed.target.kind === "chat" ? "started" : "sent",
				sessionId,
				...(this.time.now() - claimed.at! > 300_000 ? { late: true } : {}),
			};
			next = {
				...claimed,
				sessionId,
				state: "fired",
				firedAt: this.time.now(),
				updatedAt: this.time.now(),
				runs: [run],
				notice: run.late ? run : undefined,
			};
		} catch (error) {
			if (
				error instanceof ScheduleInputHeld ||
				(!entered &&
					error instanceof Conflict &&
					(this.unavailable() || this.missionHeld(claimed) || this.deps.automationsEnabled?.() === false))
			) {
				await this.store.replace(claimed, {
					...claimed,
					state: "pending",
					claimedAt: undefined,
					updatedAt: this.time.now(),
				});
				for (const row of group)
					await this.store.replace(row, {
						...row,
						state: "pending",
						claimedAt: undefined,
						updatedAt: this.time.now(),
					});
				return;
			}
			const uncertain = this.deps.sessions.uncertainScheduled?.(
				sessionId ?? claimed.sessionId ?? (claimed.target.kind === "message" ? claimed.target.sessionId : ""),
				this.requestFor(claimed),
			);
			const failure = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
			next = {
				...claimed,
				sessionId: sessionId ?? claimed.sessionId,
				state: "failed",
				error: uncertain ? `Input admission is unknown; nothing will be resent. ${failure}` : failure,
				...(uncertain
					? {
							runs: [
								{
									admission: claimed.admission,
									due: claimed.at!,
									at: this.time.now(),
									outcome: "unknown" as const,
									error: "Input admission is unknown; nothing will be resent.",
								},
							],
							notice: {
								admission: claimed.admission,
								due: claimed.at!,
								at: this.time.now(),
								outcome: "unknown" as const,
								error: "Input admission is unknown; nothing will be resent.",
							},
						}
					: {}),
				updatedAt: this.time.now(),
			};
		}
		// A persistence failure leaves the durable claim intact. Never redispatch automatically.
		const acknowledged = this.acknowledgements.get(this.requestFor(claimed));
		if (acknowledged) {
			const run: ScheduleRun = {
				admission: claimed.admission,
				due: claimed.at!,
				at: next.runs?.[0]?.at ?? this.time.now(),
				admittedAt: acknowledged.at,
				outcome: claimed.target.kind === "chat" ? "started" : "sent",
				sessionId: sessionId ?? claimed.sessionId,
				...(acknowledged.at - claimed.at! > 300000 ? { late: true } : {}),
				...(next.error ? { error: next.error } : {}),
			};
			if (next.error?.startsWith("Input admission is unknown")) {
				run.error = "Input acknowledged; schedule bookkeeping needs inspection";
				next.error = run.error;
			}
			next = { ...next, runs: [run], notice: run.late || run.error ? run : undefined };
		}
		const current = this.store.require(claimed.id);
		if (current.state === "dispatching" && current.admission?.requestId === claimed.admission?.requestId) {
			claimed = current;
			next = { ...next, revision: current.revision };
		}
		if (this.store.require(claimed.id).revision !== claimed.revision) {
			this.acknowledgements.delete(this.requestFor(claimed));
			return;
		}
		await this.store.replace(claimed, next);
		for (const row of group) {
			if (row.expiresAt !== undefined && row.expiresAt <= this.time.now() && !entered) {
				await this.expire(row);
				continue;
			}
			const receipts = next.runs?.map((run) => companionReceipt(run, row.at!, group.length + 1));
			const notice = next.notice
				? companionReceipt(next.notice, row.at!, group.length + 1)
				: receipts?.find((run) => run.late);
			await this.store.replace(row, {
				...row,
				state: next.state,
				sessionId: next.sessionId,
				firedAt: next.firedAt,
				updatedAt: next.updatedAt,
				error: next.error,
				runs: receipts,
				notice,
			});
		}
		this.acknowledgements.delete(this.requestFor(claimed));
	}
	create(request: ScheduleRequest): Promise<ScheduledItem> {
		return this.runtime.run("create", () => this.createAdmitted(request));
	}
	/** Current coordinator only, called through authenticated mission IPC. Definitions/history survive cancellation. */
	async checkIn(sessionId: string, missionId: string, request: Record<string, unknown>) {
		return this.runtime.run("create", () => this.checkInAdmitted(sessionId, missionId, request));
	}
	private async checkInAdmitted(sessionId: string, missionId: string, request: Record<string, unknown>) {
		this.assertOpen();
		const guard = () => {
			const mission = this.deps.missions?.require(missionId);
			const session = this.deps.sessions.get(sessionId);
			if (
				mission?.status !== "active" ||
				mission.coordinatorSessionId !== sessionId ||
				session?.missionId !== missionId ||
				session.projectId !== mission.projectId
			)
				throw new Conflict("Current same-mission coordinator required");
			return mission;
		};
		const mission = guard();
		const own = (row: ScheduledItem) =>
			row.missionCheckIn?.missionId === missionId && row.missionCheckIn.coordinatorSessionId === sessionId;
		if (request.operation === "list") return this.store.list(mission.projectId).filter(own);
		if (request.operation === "cancel") {
			const row = this.store.require(String(request.id));
			if (!own(row) || row.state !== "pending" || row.revision !== request.expectedRevision)
				throw new Conflict("Only your unchanged pending check-ins can be cancelled");
			await this.store.replace(row, { ...row, state: "cancelled", updatedAt: this.time.now() });
			return this.store.require(row.id);
		}
		if (
			request.operation !== "save" ||
			request.expectedBriefRevision !== mission.briefRevision ||
			typeof request.requestId !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(request.requestId)
		)
			throw new Conflict("Save requires requestId and the current agreed brief revision");
		const data = await this.validate({
			title: request.title as string | undefined,
			trigger: request.recurrence ? "recurring" : "at",
			at: request.at as number | undefined,
			recurrence: request.recurrence as ScheduleRecurrence | undefined,
			expiresAt: request.expiresAt as number | undefined,
			target: { kind: "message", sessionId, message: request.message as string },
		});
		const current = guard();
		if (current.briefRevision !== mission.briefRevision)
			throw new Conflict("Agreement changed before saving check-in");
		const id = createHash("sha256")
			.update(canonicalJSON([missionId, sessionId, request.requestId]))
			.digest("hex");
		const previous = this.store.list(mission.projectId).find((r) => r.id === id);
		const owner = {
			missionId,
			coordinatorSessionId: sessionId,
			briefRevision: mission.briefRevision,
			requestId: request.requestId,
		};
		if (previous) {
			if (
				canonicalJSON(previous.missionCheckIn) !== canonicalJSON(owner) ||
				canonicalJSON(previous.target) !== canonicalJSON(data.target) ||
				previous.title !== data.title ||
				canonicalJSON(previous.recurrence ?? null) !== canonicalJSON(data.recurrence ?? null) ||
				previous.expiresAt !== data.expiresAt ||
				(data.trigger === "at" && previous.at !== data.at)
			)
				throw new Conflict("Check-in requestId already used for different content");
			return previous;
		}
		const now = this.time.now();
		return this.store.create({
			...data,
			id,
			revision: 1,
			state: "pending",
			missionCheckIn: owner,
			createdAt: now,
			updatedAt: now,
			...(data.trigger === "recurring" ? { handledThrough: now, runs: [] } : {}),
		});
	}
	private async createAdmitted(request: ScheduleRequest): Promise<ScheduledItem> {
		this.assertOpen();
		const data = await this.validate(request);
		const now = this.time.now();
		this.checkHome(request.expectedHome, data.trigger === "recurring");
		if (data.target.kind === "message") this.deps.sessions.insightsReplacementTarget?.(data.target.sessionId);
		return this.store.create({
			...data,
			id: randomUUID(),
			revision: 1,
			state: "pending",
			...(data.trigger === "recurring" ? { handledThrough: now, runs: [] } : {}),
			createdAt: now,
			updatedAt: now,
		});
	}
	/** Native-confirmed orchestration only. Stable ID and atomic overlap guard close lost-ACK races. */
	createInsights(
		request: ScheduleRequest,
		id: string,
		operationId: string,
		revalidate: () => void,
		settingsRevision?: number,
	): Promise<ScheduledItem> {
		return this.runtime.run("create", async () => {
			this.assertOpen();
			const data = await this.validate(request);
			if (!data.insightsDestination || data.trigger !== "recurring")
				throw new Conflict("Insights schedule requires admitted fixed chat");
			this.checkHome(request.expectedHome, true);
			if (!this.deps.automationsEnabled?.()) throw new ServiceUnavailable("Automations are disabled");
			revalidate();
			const now = this.time.now();
			return this.store.create({
				...data,
				id,
				revision: 1,
				state: "pending",
				handledThrough: now,
				runs: [],
				createdAt: now,
				updatedAt: now,
				insightsEnableOperationId: operationId,
				...(settingsRevision === undefined ? {} : { insightsSettingsRevision: settingsRevision }),
			});
		});
	}
	/** Trusted owner bridge only. The ordinary request parser cannot supply this destination. */
	createOwnerInsights(
		request: ScheduleRequest,
		owner: import("@pilot/protocol").InsightsWorkspaceOwner,
		operationId: string,
		settingsRevision: number,
		revalidate: () => void,
	): Promise<ScheduledItem> {
		return this.runtime.run("create", async () => {
			this.assertOpen();
			const data = await this.validate(request, owner);
			this.checkHome(request.expectedHome, true);
			if (!this.deps.automationsEnabled?.()) throw new ServiceUnavailable("Automations are disabled");
			revalidate();
			if (
				data.trigger !== "recurring" ||
				data.target.kind !== "message" ||
				data.target.sessionId !== owner.reportSessionId ||
				data.projectId !== owner.projectId ||
				data.insightsDestination
			)
				throw new Conflict("Exact owner schedule required");
			const now = this.time.now();
			return this.store.create({
				...data,
				id: owner.scheduleId,
				revision: 1,
				state: "pending",
				handledThrough: now,
				runs: [],
				createdAt: now,
				updatedAt: now,
				insightsOwnerDestination: owner,
				insightsEnableOperationId: operationId,
				insightsSettingsRevision: settingsRevision,
			});
		});
	}

	insightsEnableAvailable(expectedHome: ScheduleHome): void {
		this.assertOpen();
		if (!this.deps.automationsEnabled?.()) throw new ServiceUnavailable("Automations are disabled");
		this.checkHome(expectedHome, true);
	}
	/** Fresh native Apply re-arms one exact cancelled row, preserving occurrence history. */
	rearmOwnerInsights(
		expected: ScheduledItem,
		owner: import("@pilot/protocol").InsightsWorkspaceOwner,
		operationId: string,
		settings: import("@pilot/protocol").InsightsSettingsRecord,
		guard: () => void,
	): Promise<ScheduledItem> {
		return this.runtime.run("update", async () => {
			this.insightsEnableAvailable(owner.expectedHome);
			const current = this.store.require(owner.scheduleId);
			if (
				current.state !== "cancelled" ||
				current.target.kind !== "message" ||
				current.target.sessionId !== owner.reportSessionId ||
				canonicalJSON(current.insightsOwnerDestination) !== canonicalJSON(owner) ||
				canonicalJSON(current) !== canonicalJSON(expected)
			)
				throw new Conflict("owner_apply_cancelled_rule_changed");
			guard();
			const now = this.time.now();
			return this.store.replace(current, {
				...current,
				state: "pending",
				paused: undefined,
				claimedAt: undefined,
				at: new RecurrenceCalendar(settings.settings.recurrence).next(now),
				recurrence: settings.settings.recurrence,
				handledThrough: now,
				updatedAt: now,
				insightsSettingsRevision: settings.revision,
				insightsEnableOperationId: operationId,
			});
		});
	}
	insightsReplacementAvailable(expectedHome: ScheduleHome): void {
		this.insightsEnableAvailable(expectedHome);
		this.store.assertSettled();
	}
	/** Passive reservation fence, independent of the global Automations opt-in. */
	assertNoLegacyInsights(expectedHome: ScheduleHome): void {
		this.assertOpen();
		this.checkHome(expectedHome, false);
		this.store.assertSettled();
		if (!this.inventoryLoaded) throw new Conflict("schedule_inventory_unavailable");
		if (this.store.hasInsightsIntent()) throw new Conflict("legacy_transition_required");
	}
	assertNoLegacyOwnerExecution(expectedHome: ScheduleHome): void {
		this.assertOpen();
		this.checkHome(expectedHome, false);
		this.store.assertSettled();
		if (!this.inventoryLoaded) throw new Conflict("schedule_inventory_unavailable");
		if (this.store.hasLegacyInsightsIntent()) throw new Conflict("legacy_transition_required");
	}
	assertLegacyDayQuiescent(expectedHome: ScheduleHome): void {
		this.assertOpen();
		this.checkHome(expectedHome, false);
		this.store.assertSettled();
		if (!this.inventoryLoaded) throw new Conflict("schedule_inventory_unavailable");
		for (const rule of this.store.list())
			if (
				!rule.insightsOwnerDestination &&
				(rule.insightsDestination || rule.insightsEnableOperationId || rule.insightsReview) &&
				!["cancelled", "completed"].includes(rule.state)
			)
				throw new Conflict("legacy_schedule_not_quiescent");
	}
	assertTransferredLegacy(expectedHome: ScheduleHome, acknowledged: ScheduledItem[], oldId: string): void {
		this.assertOpen();
		this.checkHome(expectedHome, false);
		this.store.assertSettled();
		if (!this.inventoryLoaded) throw new Conflict("schedule_inventory_unavailable");
		for (const rule of this.store.legacyInsightsItems(oldId)) {
			if (!acknowledged.some((ack) => ack.state === "cancelled" && canonicalJSON(ack) === canonicalJSON(rule)))
				throw new Conflict("legacy_rule_not_exactly_acknowledged");
		}
	}
	/** Confirmed transfer may deny an exact old rule even while global Automations is off. */
	cancelLegacyForTransfer(
		expected: ScheduledItem,
		selector: import("@pilot/protocol").InsightsLegacySelector,
		guard: () => void,
	): Promise<ScheduledItem> {
		return this.runtime.run("remove", async () => {
			this.assertOpen();
			this.checkHome(selector.expectedHome, false);
			this.store.assertSettled();
			const old = this.store.require(expected.id);
			if (
				!old.insightsEnableOperationId ||
				old.insightsOwnerDestination ||
				old.state !== "pending" ||
				canonicalJSON(old) !== canonicalJSON(expected) ||
				canonicalJSON(old.insightsDestination) !==
					canonicalJSON({
						sessionId: selector.reportSessionId,
						projectId: selector.projectId,
						missionId: selector.missionId,
					})
			)
				throw new Conflict("legacy_rule_changed_or_cancellation_unknown");
			guard();
			return this.store.replace(old, { ...old, state: "cancelled", updatedAt: this.time.now() });
		});
	}
	/** Exact previewed integration-owned rule only; never dismiss a terminal/manual row. */
	cancelInsights(expected: ScheduledItem, expectedHome: ScheduleHome, revalidate: () => void): Promise<ScheduledItem> {
		return this.runtime.run("remove", async () => {
			this.insightsEnableAvailable(expectedHome);
			const old = this.store.require(expected.id);
			if (
				!old.insightsEnableOperationId ||
				old.state !== "pending" ||
				canonicalJSON(old) !== canonicalJSON(expected)
			)
				throw new Conflict("Previewed Insights rule changed");
			revalidate();
			return this.store.replace(old, { ...old, state: "cancelled", updatedAt: this.time.now() });
		});
	}
	/** Denial must still work with global Automations disabled. Exact CAS/ACK, never GET equality. */
	cancelOwnerInsights(
		expected: ScheduledItem,
		owner: import("@pilot/protocol").InsightsWorkspaceOwner,
		revalidate: () => void,
	): Promise<ScheduledItem> {
		return this.runtime.run("remove", async () => {
			this.assertOpen();
			this.checkHome(owner.expectedHome, false);
			const old = this.store.require(owner.scheduleId);
			if (
				!old.insightsEnableOperationId ||
				old.state !== "pending" ||
				canonicalJSON(old) !== canonicalJSON(expected) ||
				canonicalJSON(old.insightsOwnerDestination) !== canonicalJSON(owner)
			)
				throw new Conflict("Owner rule changed or cancellation unknown");
			revalidate();
			return this.store.replace(old, { ...old, state: "cancelled", updatedAt: this.time.now() });
		});
	}
	update(id: string, patch: SchedulePatch): Promise<ScheduledItem> {
		return this.runtime.run("update", () => this.updateAdmitted(id, patch));
	}
	private async updateAdmitted(id: string, patch: SchedulePatch): Promise<ScheduledItem> {
		this.assertOpen();
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Schedule patch is required");
		this.rejectOwned(patch);
		if ("networkNames" in patch) throw new Error("Wi-Fi triggers were removed");
		for (const key of [
			"title",
			"expiresAt",
			"timeZone",
			"trigger",
			"at",
			"target",
			"expectedRevision",
			"recurrence",
			"paused",
			"expectedHome",
			"dismissNotice",
		] as const)
			if (patch[key] === null) throw new Error(`${key} cannot be null`);
		if (
			patch.expectedRevision !== undefined &&
			(!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 1)
		)
			throw new Error("expectedRevision must be a positive integer");
		const old = this.store.require(id);
		if (old.state !== "pending") throw new Conflict("Only pending schedules can be edited");
		if (patch.expectedRevision !== undefined && patch.expectedRevision !== old.revision)
			throw new Conflict("Schedule changed; reload before editing");
		const trigger = patch.trigger ?? old.trigger;
		if (trigger !== "at" && trigger !== "recurring") throw new Error("Invalid schedule trigger");
		if (trigger === "recurring" && patch.expectedRevision === undefined)
			throw new Error("expectedRevision is required");
		this.checkHome(patch.expectedHome, old.trigger === "recurring" || trigger === "recurring");
		if (old.trigger !== trigger) throw new Error("Schedule trigger cannot be changed");
		if (patch.paused !== undefined && typeof patch.paused !== "boolean") throw new Error("paused must be a boolean");
		if (trigger === "recurring" && patch.at !== undefined) throw new Error("at is daemon-owned");
		if (patch.dismissNotice !== undefined && (patch.dismissNotice !== true || trigger !== "recurring"))
			throw new Error("dismissNotice must be true on a recurring rule");
		if (
			patch.dismissNotice === true &&
			!["title", "trigger", "at", "target", "recurrence", "paused"].some((key) => key in patch)
		)
			return this.store.replace(old, { ...old, notice: undefined, updatedAt: this.time.now() });
		const data = await this.validate({
			expiresAt: patch.expiresAt ?? old.expiresAt,
			timeZone: patch.timeZone ?? old.timeZone,
			recurrence: patch.recurrence ?? old.recurrence,
			expectedHome: patch.expectedHome,
			title: patch.title ?? old.title,
			trigger,
			at: trigger === "at" ? (patch.at ?? old.at!) : undefined,
			target: patch.target ?? old.target,
		});
		if (data.target.kind === "message") this.deps.sessions.insightsReplacementTarget?.(data.target.sessionId);
		const recurrenceChanged = canonicalJSON(data.recurrence ?? null) !== canonicalJSON(old.recurrence ?? null);
		return this.store.replace(old, {
			...old,
			...data,
			// Same-chat edits/pause cannot discard a previously recorded Insights destination.
			insightsDestination:
				old.target.kind === "message" &&
				data.target.kind === "message" &&
				old.target.sessionId === data.target.sessionId
					? (old.insightsDestination ?? data.insightsDestination)
					: data.insightsDestination,
			at: data.at,
			paused: (patch.paused ?? old.paused) ? true : undefined,
			...(patch.dismissNotice ? { notice: undefined } : {}),
			projectId: data.projectId,
			sessionId: data.sessionId,
			...(trigger === "recurring"
				? {
						paused: (patch.paused ?? old.paused) ? true : undefined,
						handledThrough: recurrenceChanged ? this.time.now() : old.handledThrough,
						at: new RecurrenceCalendar(data.recurrence!).next(
							recurrenceChanged ? this.time.now() : old.handledThrough!,
						),
					}
				: {}),
			updatedAt: this.time.now(),
		});
	}
	/**
	 * Pending rows are cancelled, terminal rows dismissed. In-flight claims cannot be cancelled.
	 * With expectedRevision, a row that changed since it was read (for example one that sent) is refused.
	 */
	remove(id: string, expectedRevision?: number): Promise<void> {
		return this.runtime.run("remove", () => this.removeAdmitted(id, expectedRevision));
	}
	private async removeAdmitted(id: string, expectedRevision?: number): Promise<void> {
		this.assertOpen();
		if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
			throw new Error("expectedRevision must be a positive integer");
		const old = this.store.require(id);
		if (expectedRevision !== undefined && expectedRevision !== old.revision)
			throw new Conflict("Schedule changed; reload before cancelling");
		if (old.state === "dispatching") throw new Conflict("Schedule is already dispatching");
		if (old.state === "pending")
			await this.store.replace(old, { ...old, state: "cancelled", updatedAt: this.time.now() });
		else await this.store.remove(old);
	}
	list(projectId?: string): ScheduledItem[] {
		return this.store.list(projectId);
	}
	snapshot(projectId?: string, ws = false): Promise<string> {
		return this.store.snapshot(projectId, ws);
	}
	require(id: string): ScheduledItem {
		return this.store.require(id);
	}
	controls(): { enabled: boolean; paused: boolean } {
		return { enabled: this.deps.automationsEnabled?.() ?? true, paused: this.unavailable() };
	}
	controlPage(page: number) {
		return this.store.controlPage(page, (item) => this.held(item));
	}
	held(item: ScheduledItem): boolean {
		return !!item.paused || this.missionHeld(item) || !this.controls().enabled || this.unavailable();
	}
	onChange(listener: () => void): () => void {
		return this.store.onChange(listener);
	}
	dashboard(projectId: string): DashboardScheduledItem[] {
		return this.store.dashboard(projectId, (item) => this.held(item));
	}
	noticeProjects(): string[] {
		return this.store.noticeProjects();
	}
	scheduledMessageSessions(): Set<string> {
		return this.store.scheduledMessageSessions();
	}
	async stop(): Promise<void> {
		this.stopped = true;
		this.cancelTimer?.();
		for (const dispose of this.disposers.splice(0)) dispose();
		this.deps.triggers?.setActive?.(false);
		this.deps.triggers?.setCalendarActive?.(false);
		await this.tail;
	}
	private assertOpen(): void {
		if (this.stopped) throw new ServiceUnavailable("Scheduler stopped");
	}
	private rejectOwned(value: object): void {
		for (const key of [
			"admission",
			"missionCheckIn",
			"handledThrough",
			"runs",
			"notice",
			"claimedAt",
			"insightsReview",
			"insightsDestination",
			"insightsOwnerDestination",
			"insightsEnableOperationId",
			"insightsSettingsRevision",
			"firedAt",
			"state",
			"sessionId",
			"projectId",
			"error",
			"createdAt",
			"updatedAt",
			"revision",
		])
			if (key in value) throw new Error(`${key} is daemon-owned`);
	}
	private checkHome(expected: ScheduleHome | undefined, recurring: boolean): void {
		if (recurring && !expected) throw new Error("expectedHome is required");
		if (
			expected &&
			(!this.deps.home ||
				expected.daemonId !== this.deps.home.daemonId ||
				expected.lineageId !== this.deps.home.lineageId)
		)
			throw new Conflict("Schedule home changed; reconnect before editing");
	}
	private async validateTrackedItem(id: string | undefined, projectId: string | undefined): Promise<void> {
		if (id === undefined) return;
		if (typeof id !== "string" || !id.trim() || id.length > 200)
			throw new Error("trackedItemId must be 1 to 200 characters");
		if (!this.deps.trackedItems) throw new ServiceUnavailable("Tracking unavailable");
		const item = await this.deps.trackedItems.require(id);
		if (!projectId || item.projectId !== projectId) throw new Error("Ticket must belong to this project");
	}
	private async validate(
		request: ScheduleRequest,
		owner?: import("@pilot/protocol").InsightsWorkspaceOwner,
	): Promise<
		Pick<
			ScheduledItem,
			| "title"
			| "trigger"
			| "at"
			| "target"
			| "projectId"
			| "sessionId"
			| "recurrence"
			| "insightsDestination"
			| "expiresAt"
			| "timeZone"
		>
	> {
		if (!request || typeof request !== "object" || Array.isArray(request))
			throw new Error("Schedule request is required");
		this.rejectOwned(request);
		if ("networkNames" in request) throw new Error("Wi-Fi triggers were removed");
		const trigger = request.trigger;
		if (trigger !== "at" && trigger !== "recurring") throw new Error("Invalid schedule trigger");
		const recurrence = trigger === "recurring" ? validateRecurrence(request.recurrence) : undefined;
		if (trigger === "at" && request.recurrence !== undefined) throw new Error("recurrence requires a recurring rule");
		if (trigger === "recurring" && request.at !== undefined) throw new Error("at is daemon-owned");
		if (
			trigger === "at" &&
			(typeof request.at !== "number" || !Number.isSafeInteger(request.at) || request.at < 0 || request.at > 8.64e15)
		)
			throw new Error("at must be epoch milliseconds");
		if (
			request.expiresAt !== undefined &&
			(trigger !== "at" ||
				!Number.isSafeInteger(request.expiresAt) ||
				request.expiresAt <= request.at! ||
				request.expiresAt > 8.64e15)
		)
			throw new Error("expiresAt must be after a one-shot deadline");
		if (request.timeZone !== undefined) {
			if (trigger !== "at" || typeof request.timeZone !== "string" || request.timeZone.length > 100)
				throw new Error("Invalid one-shot time zone");
			try {
				new Intl.DateTimeFormat("en", { timeZone: request.timeZone }).format();
			} catch {
				throw new Error("Invalid one-shot time zone");
			}
		}
		if (
			request.title !== undefined &&
			(typeof request.title !== "string" || !request.title.trim() || request.title.length > 200)
		)
			throw new Error("title must be 1 to 200 characters");
		const raw = request.target;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("target is required");
		let target: ScheduleTarget, projectId: string | undefined, sessionId: string | undefined, message: string;
		if (raw.kind === "chat") {
			const spawn = raw.spawn;
			if (!spawn || typeof spawn !== "object" || Array.isArray(spawn)) throw new Error("spawn is required");
			const copy: SpawnRequest = { message: spawn.message };
			for (const key of [
				"missionId",
				"projectId",
				"cwd",
				"title",
				"model",
				"thinking",
				"baseBranch",
				"mode",
				"workspace",
			] as const) {
				const value = spawn[key];
				if (value !== undefined) {
					if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
					(copy as unknown as Record<string, string>)[key] = value;
				}
			}
			if (copy.mode !== undefined && !["build", "ask"].includes(copy.mode)) throw new Error("Invalid chat mode");
			if (copy.workspace !== undefined && !["clone", "direct"].includes(copy.workspace))
				throw new Error("Invalid workspace");
			projectId = copy.projectId;
			if (copy.missionId) {
				if (!this.deps.missions) throw new NotFound("Unknown mission");
				const mission = this.deps.missions.require(copy.missionId);
				if (mission.status !== "active") throw new Conflict("Mission is not active");
				if (projectId && projectId !== mission.projectId) throw new Conflict("Mission belongs to another project");
				if (copy.cwd !== undefined) throw new Error("missionId does not allow cwd");
				projectId = mission.projectId;
			}
			if (
				trigger === "recurring" &&
				(!projectId || copy.cwd !== undefined || copy.missionId !== undefined || raw.trackedItemId !== undefined)
			)
				throw new Error("Recurring chats require projectId without cwd, missionId or trackedItemId");
			const project = projectId ? this.deps.projects.require(projectId) : undefined;
			if (!projectId && !copy.cwd) throw new Error("projectId, missionId or cwd is required");
			if (copy.workspace && (copy.mode === "ask" || !project || copy.cwd))
				throw new Error("workspace override requires a Build project without cwd");
			if (
				copy.baseBranch &&
				(!project || copy.cwd || (copy.mode !== "ask" && (copy.workspace ?? project.workspace) === "direct"))
			)
				throw new Error("baseBranch requires a branch-backed project");
			await this.validateTrackedItem(raw.trackedItemId, projectId);
			target = {
				kind: "chat",
				spawn: copy,
				...(raw.trackedItemId !== undefined ? { trackedItemId: raw.trackedItemId } : {}),
			};
			message = copy.message;
		} else if (raw.kind === "message") {
			if ("trackedItemId" in raw) throw new Error("trackedItemId is only valid for a chat target");
			if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) throw new Error("sessionId is required");
			const session = this.deps.sessions.get(raw.sessionId);
			const ownerStatus = this.deps.sessions.insightsOwnerStatus?.(raw.sessionId);
			if (ownerStatus && canonicalJSON(ownerStatus.owner) !== canonicalJSON(owner))
				throw new Conflict("Owner schedules require exact native admission");
			if (!session) throw new NotFound("Unknown target chat");
			sessionId = raw.sessionId;
			projectId = session.projectId;
			target = { kind: "message", sessionId, message: raw.message };
			message = raw.message;
		} else throw new Error("target kind must be chat or message");
		if (trigger === "recurring") {
			if (!projectId) throw new Error("Recurring targets require a project");
			this.deps.projects.require(projectId);
		}
		if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
		if (Buffer.byteLength(JSON.stringify(target)) > 16_384) throw new Error("Schedule target exceeds 16 KiB");
		const insights =
			trigger === "recurring" && target.kind === "message"
				? this.deps.sessions.insightsStatus?.(target.sessionId)
				: undefined;
		return {
			...(insights
				? {
						insightsDestination: {
							sessionId: insights.sessionId,
							projectId: insights.projectId,
							missionId: insights.missionId,
						},
					}
				: {}),
			title:
				request.title?.trim() ??
				(target.kind === "chat" ? target.spawn.title?.trim().slice(0, 200) : undefined) ??
				message.trim().split("\n")[0].slice(0, 200),
			trigger,
			expiresAt: request.expiresAt,
			timeZone: request.timeZone,
			at: recurrence ? new RecurrenceCalendar(recurrence).next(this.time.now()) : request.at,
			recurrence,
			target,
			projectId,
			sessionId,
		};
	}
}

// Attribute text only; escape user-supplied titles so the envelope remains one line.
function lateScheduleLine(title: string, due: number, at: number, calendar: RecurrenceCalendar): string {
	const escapeAttribute = (s: string) =>
		s.replace(
			/[&<>"\r\n]/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\r": " ", "\n": " " })[c]!,
		);
	const stamp = (instant: number) => {
		const wall = calendar.local(instant),
			offset = Math.round((wall - Math.floor(instant / 60_000) * 60_000) / 60_000);
		const sign = offset < 0 ? "-" : "+",
			abs = Math.abs(offset);
		return (
			new Date(wall).toISOString().slice(0, 16) +
			sign +
			String(Math.floor(abs / 60)).padStart(2, "0") +
			":" +
			String(abs % 60).padStart(2, "0")
		);
	};
	return `<schedule rule="${escapeAttribute(title)}" due="${stamp(due)}" started="${stamp(at)}">Started late: Pilot was off, asleep or offline when this was due.</schedule>`;
}
