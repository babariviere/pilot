/** The Insights side of scheduling: Insights review occurrences and the rules Insights setup owns. */
import { randomUUID } from "node:crypto";
import type {
	InsightsLegacySelector,
	InsightsReviewDispatch,
	InsightsReviewRun,
	InsightsSettingsRecord,
	InsightsStatus,
	InsightsWorkspaceOwner,
	ScheduledItem,
	ScheduleHome,
	ScheduleRecurrence,
	ScheduleRequest,
	ScheduleRun,
} from "@pilot/protocol";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import { INSIGHTS_INITIAL_DEFAULTS } from "./insights-defaults.ts";
import { canonicalJSON } from "./operation-journal.ts";
import { RecurrenceCalendar } from "./schedule-recurrence.ts";
import type { ScheduleStore } from "./schedule-store.ts";

/** What SessionManager provides for Insights reviews. Each method is absent where Insights is not wired. */
export interface InsightsScheduleDispatch {
	insightsStatus(id: string): InsightsStatus | undefined;
	insightsOwnerStatus(id: string): { owner: InsightsWorkspaceOwner; available: boolean } | undefined;
	insightsOwnerScheduleBounds(
		id: string,
		revision: number,
		recurrence?: ScheduleRecurrence,
	): InsightsReviewDispatch["bounds"];
	dayInsightsScheduleReady(id: string, revision: number): boolean;
	dispatchInsightsOwnerReview(id: string, request: InsightsReviewDispatch): Promise<InsightsReviewRun>;
	insightsOwnerReviewStatus(id: string, runId: string): Promise<InsightsReviewRun | null>;
	insightsReplacementTarget(id: string): void;
	dispatchInsightsReview(id: string, request: InsightsReviewDispatch): Promise<InsightsReviewRun>;
	insightsReviewStatus(id: string, runId: string): Promise<InsightsReviewRun | null>;
	onInsightsReviewChange(listener: () => void): () => void;
	insightsScheduleBounds(
		id: string,
		revision?: number,
		recurrence?: ScheduleRecurrence,
	): InsightsReviewDispatch["bounds"];
}

type ValidatedSchedule = Pick<
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
>;

/** The scheduler tracks admission; the store checks the expected rule and inventory before committing. */
export interface InsightsScheduleHost {
	readonly store: ScheduleStore;
	sessions: Partial<InsightsScheduleDispatch> & { get(id: string): { working?: boolean } | undefined };
	run<T>(task: "create" | "update" | "remove", work: () => Promise<T>): Promise<T>;
	now(): number;
	assertOpen(): void;
	checkHome(expected: ScheduleHome | undefined, recurring: boolean): void;
	automationsEnabled(): boolean;
	inventoryLoaded(): boolean;
	validate(request: ScheduleRequest, owner?: InsightsWorkspaceOwner): Promise<ValidatedSchedule>;
}

/** An occurrence's Insights review, chosen before the scheduler claims the occurrence. */
export interface InsightsOccurrence {
	destination?: ScheduledItem["insightsDestination"];
	review?: ScheduledItem["insightsReview"];
	insights?: InsightsStatus;
	ownerDestination?: InsightsWorkspaceOwner;
	settingsReady: boolean;
}

const LEGACY_SNAPSHOT_RULES = 8;

const insightsIntent = (item: ScheduledItem) =>
	!!(item.insightsDestination || item.insightsEnableOperationId || item.insightsReview);

export class InsightsSchedule {
	private readonly host: InsightsScheduleHost;
	constructor(host: InsightsScheduleHost) {
		this.host = host;
	}
	private get sessions() {
		return this.host.sessions;
	}

	/** An owner rule waits until its report chat accepts the saved settings revision. */
	ready(item: ScheduledItem): boolean {
		return (
			!item.insightsOwnerDestination ||
			this.sessions.dayInsightsScheduleReady?.(
				item.insightsOwnerDestination.reportSessionId,
				item.insightsSettingsRevision ?? 0,
			) !== false
		);
	}

	/** The legacy Insights destination a recurring message to this chat records. */
	destination(sessionId: string): ScheduledItem["insightsDestination"] {
		const insights = this.sessions.insightsStatus?.(sessionId);
		return insights
			? { sessionId: insights.sessionId, projectId: insights.projectId, missionId: insights.missionId }
			: undefined;
	}

	/** Owner report chats take schedules only through the owner bridge. */
	assertOwnerAdmission(sessionId: string, owner: InsightsWorkspaceOwner | undefined): void {
		const ownerStatus = this.sessions.insightsOwnerStatus?.(sessionId);
		if (ownerStatus && canonicalJSON(ownerStatus.owner) !== canonicalJSON(owner))
			throw new Conflict("Owner schedules require exact native admission");
	}

	replacementTarget(sessionId: string): void {
		this.sessions.insightsReplacementTarget?.(sessionId);
	}

	onChange(listener: () => void): (() => void) | undefined {
		return this.sessions.onInsightsReviewChange?.(listener);
	}

	/**
	 * The review this occurrence sends, chosen before the claim reserves its identity. Undefined: an owner rule whose
	 * settings are not ready yet, so the occurrence waits. Message text cannot select or mint Insights authority.
	 */
	prepare(item: ScheduledItem, due: number, calendar: RecurrenceCalendar): InsightsOccurrence | undefined {
		const insights =
			item.target.kind === "message" ? this.sessions.insightsStatus?.(item.target.sessionId) : undefined;
		const ownerDestination = item.insightsOwnerDestination;
		if (ownerDestination && !this.ready(item)) return undefined;
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
				if (!this.sessions.insightsOwnerScheduleBounds) throw new Conflict("Owner execution unsupported");
				bounds = this.sessions.insightsOwnerScheduleBounds(
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
					this.sessions.insightsScheduleBounds?.(
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
		return { destination, review, insights, ownerDestination, settingsReady };
	}

	/** Sends the claimed occurrence's review once. Authority is checked again after the claim. */
	async dispatch(occurrence: InsightsOccurrence, claimed: ScheduledItem, run: ScheduleRun): Promise<void> {
		const { sessionId, request } = claimed.insightsReview!;
		const { insights, ownerDestination, destination, settingsReady } = occurrence;
		run.insightsReview = { runId: request.runId, state: "unresolved" };
		if (ownerDestination) {
			const current = this.sessions.insightsOwnerStatus?.(sessionId);
			if (
				!settingsReady ||
				!current?.available ||
				canonicalJSON(current.owner) !== canonicalJSON(ownerDestination) ||
				claimed.projectId !== current.owner.projectId ||
				!this.sessions.dispatchInsightsOwnerReview
			)
				throw new Conflict("Owner authority unavailable; review not sent");
			this.applyReviewStatus(run, await this.sessions.dispatchInsightsOwnerReview(sessionId, request));
		} else {
			if (
				!settingsReady ||
				!insights?.available ||
				insights.projectId !== claimed.projectId ||
				insights.projectId !== destination?.projectId ||
				insights.sessionId !== destination?.sessionId ||
				insights.missionId !== destination?.missionId ||
				!this.sessions.dispatchInsightsReview
			)
				throw new Conflict("Insights authority unavailable; review not sent");
			this.applyReviewStatus(run, await this.sessions.dispatchInsightsReview(sessionId, request));
		}
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

	/** A lost dispatch ACK is lookup-only: this never calls dispatch again for the occurrence. */
	async lookup(run: ScheduleRun): Promise<void> {
		try {
			const status = this.sessions.insightsOwnerStatus?.(run.sessionId!)
				? await this.sessions.insightsOwnerReviewStatus?.(run.sessionId!, run.insightsReview!.runId)
				: await this.sessions.insightsReviewStatus?.(run.sessionId!, run.insightsReview!.runId);
			this.applyReviewStatus(run, status ?? null);
			if (status?.state === "sent" && !this.sessions.get(run.sessionId!)?.working) {
				run.outcome = "failed";
				run.error =
					"Insights input placed, but no bounded report persisted and chat is idle; outcome unresolved. Never replay this occurrence.";
			}
		} catch {
			this.applyReviewStatus(run, null);
		}
	}

	/** Passive terminal lookup of reviews still in flight. Runs even while dispatch is paused, offline or disabled. */
	async reconcile(includeUnresolved = false): Promise<void> {
		const open = (run: ScheduleRun) =>
			!!run.insightsReview &&
			(["preparing", "ready", "sent"].includes(run.insightsReview.state) ||
				(includeUnresolved && run.insightsReview.state === "unresolved"));
		for (const item of this.host.store.matching((item) => !!item.runs?.some(open))) {
			const runs = structuredClone(item.runs!);
			let notice = item.notice;
			for (const run of runs) {
				if (!open(run)) continue;
				await this.lookup(run);
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
				await this.host.store.replace(item, { ...item, runs, notice, updatedAt: this.host.now() });
			} catch (error) {
				if (!(error instanceof Conflict || error instanceof NotFound)) throw error;
			}
		}
	}

	/** Legacy rules of a retired report chat, copied only for a small native transfer preview. */
	legacyItems(oldId: string): ScheduledItem[] {
		const retired = oldId.toLowerCase();
		return this.host.store.matching(
			(item) =>
				!item.insightsOwnerDestination &&
				(insightsIntent(item) ||
					(item.target.kind === "message" && item.target.sessionId.toLowerCase() === retired)),
			{ count: LEGACY_SNAPSHOT_RULES, conflict: "legacy_rule_snapshot_capacity" },
		);
	}

	/** Native-confirmed orchestration only. Stable ID and atomic overlap guard close lost-ACK races. */
	createInsights(
		request: ScheduleRequest,
		id: string,
		operationId: string,
		revalidate: () => void,
		settingsRevision?: number,
	): Promise<ScheduledItem> {
		return this.host.run("create", async () => {
			this.host.assertOpen();
			const data = await this.host.validate(request);
			if (!data.insightsDestination || data.trigger !== "recurring")
				throw new Conflict("Insights schedule requires admitted fixed chat");
			this.host.checkHome(request.expectedHome, true);
			if (!this.host.automationsEnabled()) throw new ServiceUnavailable("Automations are disabled");
			revalidate();
			const now = this.host.now();
			return this.host.store.create({
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
		owner: InsightsWorkspaceOwner,
		operationId: string,
		settingsRevision: number,
		revalidate: () => void,
	): Promise<ScheduledItem> {
		return this.host.run("create", async () => {
			this.host.assertOpen();
			const data = await this.host.validate(request, owner);
			this.host.checkHome(request.expectedHome, true);
			if (!this.host.automationsEnabled()) throw new ServiceUnavailable("Automations are disabled");
			revalidate();
			if (
				data.trigger !== "recurring" ||
				data.target.kind !== "message" ||
				data.target.sessionId !== owner.reportSessionId ||
				data.projectId !== owner.projectId ||
				data.insightsDestination
			)
				throw new Conflict("Exact owner schedule required");
			const now = this.host.now();
			return this.host.store.create({
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
		this.host.assertOpen();
		if (!this.host.automationsEnabled()) throw new ServiceUnavailable("Automations are disabled");
		this.host.checkHome(expectedHome, true);
	}

	/** Fresh native Apply re-arms one exact cancelled row, preserving occurrence history. */
	rearmOwnerInsights(
		expected: ScheduledItem,
		owner: InsightsWorkspaceOwner,
		operationId: string,
		settings: InsightsSettingsRecord,
		guard: () => void,
	): Promise<ScheduledItem> {
		return this.host.run("update", async () => {
			this.insightsEnableAvailable(owner.expectedHome);
			const current = this.host.store.require(owner.scheduleId);
			if (
				current.state !== "cancelled" ||
				current.target.kind !== "message" ||
				current.target.sessionId !== owner.reportSessionId ||
				canonicalJSON(current.insightsOwnerDestination) !== canonicalJSON(owner) ||
				canonicalJSON(current) !== canonicalJSON(expected)
			)
				throw new Conflict("owner_apply_cancelled_rule_changed");
			guard();
			const now = this.host.now();
			return this.host.store.replace(current, {
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
		this.host.store.assertSettled();
	}

	private assertInventory(expectedHome: ScheduleHome): void {
		this.host.assertOpen();
		this.host.checkHome(expectedHome, false);
		this.host.store.assertSettled();
		if (!this.host.inventoryLoaded()) throw new Conflict("schedule_inventory_unavailable");
	}

	/** Passive reservation fence, independent of the global Automations opt-in. */
	assertNoLegacyInsights(expectedHome: ScheduleHome): void {
		this.assertInventory(expectedHome);
		if (this.host.store.some(insightsIntent)) throw new Conflict("legacy_transition_required");
	}

	assertNoLegacyOwnerExecution(expectedHome: ScheduleHome): void {
		this.assertInventory(expectedHome);
		if (this.host.store.some((item) => !item.insightsOwnerDestination && insightsIntent(item)))
			throw new Conflict("legacy_transition_required");
	}

	assertLegacyDayQuiescent(expectedHome: ScheduleHome): void {
		this.assertInventory(expectedHome);
		if (
			this.host.store.some(
				(rule) =>
					!rule.insightsOwnerDestination &&
					insightsIntent(rule) &&
					!["cancelled", "completed"].includes(rule.state),
			)
		)
			throw new Conflict("legacy_schedule_not_quiescent");
	}

	assertTransferredLegacy(expectedHome: ScheduleHome, acknowledged: ScheduledItem[], oldId: string): void {
		this.assertInventory(expectedHome);
		for (const rule of this.legacyItems(oldId)) {
			if (!acknowledged.some((ack) => ack.state === "cancelled" && canonicalJSON(ack) === canonicalJSON(rule)))
				throw new Conflict("legacy_rule_not_exactly_acknowledged");
		}
	}

	/** Confirmed transfer may deny an exact old rule even while global Automations is off. */
	cancelLegacyForTransfer(
		expected: ScheduledItem,
		selector: InsightsLegacySelector,
		guard: () => void,
	): Promise<ScheduledItem> {
		return this.host.run("remove", async () => {
			this.host.assertOpen();
			this.host.checkHome(selector.expectedHome, false);
			this.host.store.assertSettled();
			const old = this.host.store.require(expected.id);
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
			return this.host.store.replace(old, { ...old, state: "cancelled", updatedAt: this.host.now() });
		});
	}

	/** Exact previewed integration-owned rule only; never dismiss a terminal/manual row. */
	cancelInsights(expected: ScheduledItem, expectedHome: ScheduleHome, revalidate: () => void): Promise<ScheduledItem> {
		return this.host.run("remove", async () => {
			this.insightsEnableAvailable(expectedHome);
			const old = this.host.store.require(expected.id);
			if (
				!old.insightsEnableOperationId ||
				old.state !== "pending" ||
				canonicalJSON(old) !== canonicalJSON(expected)
			)
				throw new Conflict("Previewed Insights rule changed");
			revalidate();
			return this.host.store.replace(old, { ...old, state: "cancelled", updatedAt: this.host.now() });
		});
	}

	/** Denial must still work with global Automations disabled. Exact CAS/ACK, never GET equality. */
	cancelOwnerInsights(
		expected: ScheduledItem,
		owner: InsightsWorkspaceOwner,
		revalidate: () => void,
	): Promise<ScheduledItem> {
		return this.host.run("remove", async () => {
			this.host.assertOpen();
			this.host.checkHome(owner.expectedHome, false);
			const old = this.host.store.require(owner.scheduleId);
			if (
				!old.insightsEnableOperationId ||
				old.state !== "pending" ||
				canonicalJSON(old) !== canonicalJSON(expected) ||
				canonicalJSON(old.insightsOwnerDestination) !== canonicalJSON(owner)
			)
				throw new Conflict("Owner rule changed or cancellation unknown");
			revalidate();
			return this.host.store.replace(old, { ...old, state: "cancelled", updatedAt: this.host.now() });
		});
	}
}
