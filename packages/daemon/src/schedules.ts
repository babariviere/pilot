import { randomUUID } from "node:crypto";
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
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
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
export interface ScheduleDispatch {
	spawn(request: SpawnRequest): Promise<{ id: string }>;
	send(id: string, message: string, mode: "followUp", requestId: string): Promise<void>;
	get(id: string): { projectId?: string; working?: boolean } | undefined;
	insightsStatus?(id: string): InsightsStatus | undefined;
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
	missions?: Pick<MissionStore, "require">;
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
	readonly store: ScheduleStore;
	private readonly deps: ScheduleServiceDeps;
	constructor(store: ScheduleStore, deps: ScheduleServiceDeps) {
		this.store = store;
		this.deps = deps;
		this.time = deps.clock ?? clock;
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
	private activeItems() {
		return this.store.pendingItems().filter((item) => item.trigger === "at" || this.deps.automationsEnabled?.());
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
		const pending = this.activeItems();
		this.deps.triggers?.setCalendarActive?.(pending.length > 0);
		if (this.unavailable()) {
			this.arm();
			return;
		}
		// Evaluate expiry even offline. Refresh once per sweep, only if an occurrence could run.
		let needsNetwork = false;
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
		for (const item of pending) {
			if (this.unavailable() || !this.online) break;
			if (item.at! > this.time.now()) continue;
			try {
				const current = this.store.require(item.id);
				if (current.state !== "pending" || current.paused || current.revision !== item.revision) continue;
				if (current.trigger === "recurring") {
					if (this.deps.automationsEnabled?.()) await this.fireRecurring(current);
				} else await this.fire(current);
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
		const waiting = !this.unavailable() && pending.some((item) => item.at! <= now);
		this.deps.triggers?.setActive?.(waiting && !this.online);
		if (this.unavailable()) return;
		// Offline due rules also need a period-expiry timer, not an immediate retry loop.
		const deadlines = pending.map((item) => {
			if (item.at! > now) return item.at!;
			if (item.trigger === "recurring")
				return new RecurrenceCalendar(this.store.require(item.id).recurrence!).periodEnd(now);
			return Infinity;
		});
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
		const noteworthy = run.late || !["started", "sent"].includes(run.outcome);
		await this.store.replace(item, {
			...item,
			state: "pending",
			handledThrough: run.due,
			at: new RecurrenceCalendar(item.recurrence!).next(run.due),
			claimedAt: undefined,
			insightsReview: undefined,
			updatedAt: this.time.now(),
			runs: [...(item.runs ?? []), run].slice(-10),
			notice: noteworthy ? run : undefined,
			sessionId: run.sessionId ?? item.sessionId,
			paused: paused ? true : item.paused,
			error: paused ? run.error : undefined,
		});
	}
	private async fireRecurring(item: ScheduledItem): Promise<void> {
		if (this.unavailable() || !this.deps.automationsEnabled?.()) return;
		const calendar = new RecurrenceCalendar(item.recurrence!);
		const due = calendar.latest(this.time.now());
		if (due <= item.handledThrough!) return;
		const count = calendar.count(item.handledThrough!, due);
		if (this.time.now() >= calendar.periodEnd(due)) {
			await this.finishOccurrence(item, { due, at: this.time.now(), outcome: "missed", count });
			return;
		}
		// Reserve the identity in the occurrence CAS, before any review preparation or input placement.
		// Destination role is host-owned. Message text cannot select/mint Insights authority.
		const insights =
			item.target.kind === "message" ? this.deps.sessions.insightsStatus?.(item.target.sessionId) : undefined;
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
		if (destination) {
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
			destination && item.target.kind === "message"
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
			});
		} catch (error) {
			if (error instanceof Conflict || error instanceof NotFound) return;
			throw error;
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
			if (this.unavailable() || !this.deps.automationsEnabled?.())
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
					: (claimed.runs?.findLast((run) => !!run.sessionId)?.sessionId ?? claimed.sessionId);
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
				if (claimed.target.kind === "chat") {
					const date = new Date(calendar.day(due)).toISOString().slice(0, 10);
					run.sessionId = (
						await this.deps.sessions.spawn({
							...claimed.target.spawn,
							title: `${claimed.title} · ${date}`,
							message: prefix + claimed.target.spawn.message,
						})
					).id;
					run.outcome = "started";
				} else {
					run.sessionId = claimed.target.sessionId;
					if (claimed.insightsReview) {
						const { sessionId, request } = claimed.insightsReview;
						run.insightsReview = { runId: request.runId, state: "unresolved" };
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
					} else {
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
			run.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
			// A lost dispatch ACK is lookup-only. Never call dispatch again for this occurrence.
			if (run.insightsReview) await this.lookupReview(run);
		}
		await this.finishOccurrence(claimed, run, permanentlyMissing);
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
			const status = await this.deps.sessions.insightsReviewStatus?.(run.sessionId!, run.insightsReview!.runId);
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
	private async fire(item: ScheduledItem): Promise<void> {
		if (this.stopped) return;
		let claimed: ScheduledItem;
		try {
			claimed = await this.store.replace(item, {
				...item,
				state: "dispatching",
				claimedAt: this.time.now(),
				updatedAt: this.time.now(),
			});
		} catch (error) {
			if (error instanceof Conflict || error instanceof NotFound) return;
			throw error;
		}
		let next: ScheduledItem;
		let sessionId: string | undefined;
		try {
			if (claimed.target.kind === "chat") {
				// Recheck the local ticket's project binding before admission.
				await this.validateTrackedItem(claimed.target.trackedItemId, claimed.projectId);
				sessionId = (await this.deps.sessions.spawn(claimed.target.spawn)).id;
				if (claimed.target.trackedItemId)
					await this.deps.trackedItems!.patch(claimed.target.trackedItemId, { sessionId, start: true });
			} else {
				sessionId = claimed.target.sessionId;
				if (!this.deps.sessions.get(sessionId)) throw new NotFound("Target chat was deleted");
				await this.deps.sessions.send(sessionId, claimed.target.message, "followUp", `schedule:${claimed.id}`);
			}
			next = { ...claimed, sessionId, state: "fired", firedAt: this.time.now(), updatedAt: this.time.now() };
		} catch (error) {
			next = {
				...claimed,
				sessionId,
				state: "failed",
				error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
				updatedAt: this.time.now(),
			};
		}
		// A persistence failure leaves the durable claim intact. Never redispatch automatically.
		await this.store.replace(claimed, next);
	}
	create(request: ScheduleRequest): Promise<ScheduledItem> {
		return this.runtime.run("create", () => this.createAdmitted(request));
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

	insightsEnableAvailable(expectedHome: ScheduleHome): void {
		this.assertOpen();
		this.checkHome(expectedHome, true);
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
		if (patch.paused !== undefined && (trigger !== "recurring" || typeof patch.paused !== "boolean"))
			throw new Error("paused requires a recurring rule and boolean");
		if (trigger === "recurring" && patch.at !== undefined) throw new Error("at is daemon-owned");
		if (patch.dismissNotice !== undefined && (patch.dismissNotice !== true || trigger !== "recurring"))
			throw new Error("dismissNotice must be true on a recurring rule");
		if (
			patch.dismissNotice === true &&
			!["title", "trigger", "at", "target", "recurrence", "paused"].some((key) => key in patch)
		)
			return this.store.replace(old, { ...old, notice: undefined, updatedAt: this.time.now() });
		const data = await this.validate({
			recurrence: patch.recurrence ?? old.recurrence,
			expectedHome: patch.expectedHome,
			title: patch.title ?? old.title,
			trigger,
			at: trigger === "at" ? (patch.at ?? old.at!) : undefined,
			target: patch.target ?? old.target,
		});
		if (data.target.kind === "message") this.deps.sessions.insightsReplacementTarget?.(data.target.sessionId);
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
			...(patch.dismissNotice ? { notice: undefined } : {}),
			projectId: data.projectId,
			sessionId: data.sessionId,
			...(trigger === "recurring"
				? {
						paused: (patch.paused ?? old.paused) ? true : undefined,
						handledThrough:
							patch.recurrence !== undefined || (old.paused && patch.paused === false)
								? this.time.now()
								: old.handledThrough,
						at: new RecurrenceCalendar(data.recurrence!).next(
							patch.recurrence !== undefined || (old.paused && patch.paused === false)
								? this.time.now()
								: old.handledThrough!,
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
	onChange(listener: () => void): () => void {
		return this.store.onChange(listener);
	}
	dashboard(projectId: string): DashboardScheduledItem[] {
		return this.store.dashboard(projectId);
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
			"handledThrough",
			"runs",
			"notice",
			"claimedAt",
			"insightsReview",
			"insightsDestination",
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
		if (recurring && !this.deps.automationsEnabled?.()) throw new ServiceUnavailable("Automations are disabled");
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
	): Promise<
		Pick<
			ScheduledItem,
			"title" | "trigger" | "at" | "target" | "projectId" | "sessionId" | "recurrence" | "insightsDestination"
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
