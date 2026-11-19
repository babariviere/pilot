import type {
	DayInsightsPayload,
	DayInsightsSettings,
	DayInsightsStatus,
	DurableOperation,
	InsightsSettingsRecord,
} from "@pilot/protocol";
import { dayInsightsReaderSettings } from "./day-insights-policy.ts";
import type { DayInsightsStore } from "./day-insights-store.ts";
import { Conflict } from "./errors.ts";
import { InsightsJournal } from "./insights-journal.ts";
import { legacyInsightsWriterLease } from "./insights-legacy-lease.ts";
import type { InsightsOwnerStore } from "./insights-owner-store.ts";
import type { InsightsWorkspaceAuthority } from "./insights-workspace-store.ts";
import type { ModelCatalog } from "./models.ts";
import type { OperationJournal } from "./operation-journal.ts";
import type { ScheduleService } from "./schedules.ts";
import type { SessionManager } from "./sessions.ts";

interface Dependencies {
	sessions: SessionManager;
	owners: InsightsOwnerStore;
	store: DayInsightsStore;
	schedules: ScheduleService;
	journal: OperationJournal;
	models: Pick<ModelCatalog, "list">;
}
/** Fresh-context owner execution. Production installation is gated by integration qualification. */
export class DayInsightsExecution {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	changed(): void {
		this.deps.schedules.ownerSettingsCommitted();
	}
	nextAt(owner: import("@pilot/protocol").InsightsWorkspaceOwner | null): number | null {
		if (!owner) return null;
		const control = this.deps.store.control(owner.workspaceId);
		if (!control?.enabled || control.operation_id !== null) return null;
		const rule = this.deps.schedules.store.list().find((r) => r.id === owner.scheduleId);
		return rule?.state === "pending" ? (rule.at ?? null) : null;
	}
	private async fresh(a: InsightsWorkspaceAuthority) {
		const leases: Awaited<ReturnType<typeof legacyInsightsWriterLease>>[] = [];
		try {
			const known: string[] = [];
			let after: string | null = null;
			for (;;) {
				const old = this.deps.sessions.insightsLegacyDiscovery(after);
				if (!old) break;
				if (known.length >= 64) throw new Conflict("legacy_quiescence_capacity");
				known.push(old.reportSessionId);
				after = old.reportSessionId;
				const guard = () => {
					this.deps.sessions.insightsLegacyQuiescence(old.reportSessionId, old.projectId, old.missionId);
				};
				const directory = this.deps.sessions.insightsLegacyStorageDirectory(
					old.reportSessionId,
					old.projectId,
					old.missionId,
				);
				leases.push(await legacyInsightsWriterLease(directory, guard));
			}
			const journal = await new InsightsJournal(this.deps.journal).freshDayExecutionGuard(known);
			const guard = () => {
				this.deps.owners.assertLegacyDayRunsQuiescent();
				journal();
				this.deps.schedules.assertLegacyDayQuiescent(a.owner.expectedHome);
				for (const l of leases) l.revalidate();
				let cursor: string | null = null;
				for (const report of known) {
					const current = this.deps.sessions.insightsLegacyDiscovery(cursor);
					if (!current || current.reportSessionId !== report) throw new Conflict("legacy_identity_changed");
					this.deps.sessions.insightsLegacyQuiescence(
						current.reportSessionId,
						current.projectId,
						current.missionId,
					);
					cursor = report;
				}
				if (this.deps.sessions.insightsLegacyDiscovery(cursor)) throw new Conflict("legacy_identity_changed");
			};
			guard();
			return {
				guard,
				close: () => {
					for (const l of leases) l.close();
				},
			};
		} catch (error) {
			for (const l of leases) l.close();
			throw error;
		}
	}
	async preview(
		a: InsightsWorkspaceAuthority,
		p: Pick<DayInsightsPayload, "action" | "settings">,
		status: DayInsightsStatus,
	) {
		if (p.action === "save") return;
		if (p.action !== "pause") this.deps.owners.assertNoEntered(a);
		const current = this.deps.owners.current(a);
		if (current && !this.deps.owners.isDayExecution(current.binding))
			throw new Conflict("day_insights_existing_execution_requires_recovery");
		if (!current && p.action === "apply" && p.settings?.weekly !== null)
			throw new Conflict("day_insights_initial_apply_must_be_manual");
		if (!current && p.action !== "pause") {
			const proof = await this.fresh(a);
			proof.close();
		}
		if (p.action === "run" || p.action === "resume") {
			if (!status.effective || !current) throw new Conflict("day_insights_not_configured");
			if (p.action === "run" && status.paused) throw new Conflict("day_insights_paused");
		}
		if (p.action !== "pause" && current) {
			this.deps.owners.assertApplyIdle(a);
			this.deps.sessions.insightsOwnerApplySnapshot(a.owner.reportSessionId);
		}
		if (p.settings?.weekly && !status.paused) this.deps.schedules.insightsEnableAvailable(a.owner.expectedHome);
	}
	async execute(
		a: InsightsWorkspaceAuthority,
		op: DurableOperation,
		p: DayInsightsPayload,
		before: DayInsightsStatus,
		authorityGuard: (a: InsightsWorkspaceAuthority) => void,
	) {
		const existing = this.deps.owners.current(a);
		const proof = !existing && p.action !== "pause" ? await this.fresh(a) : null;
		let generation: number | null = null;
		let reportGuard: (() => void) | null = null;
		const guard = () => {
			authorityGuard(a);
			proof?.guard();
			reportGuard?.();
			if (generation !== null)
				this.deps.store.assertControl(
					a.owner.workspaceId,
					generation,
					p.action === "run" ? undefined : op.operationId,
				);
		};
		try {
			await this.deps.store.enter(a, op, p, () => guard());
			generation = Number(this.deps.store.control(a.owner.workspaceId)?.generation ?? 0);
			const lease = this.deps.sessions.insightsOwnerLease(a),
				id = a.owner.reportSessionId;
			if (p.action === "run") {
				const current = this.deps.owners.current(a)!;
				const now = Date.now();
				const request = {
					runId: op.operationId,
					windowStart: new Date(now - 86400000).toISOString(),
					windowEnd: new Date(now).toISOString(),
					bounds: current.settings.settings.bounds,
					settingsRevision: current.settings.revision,
				};
				await this.deps.sessions.dayInsights!.reserveRun(id, request);
				guard();
				const receipt = await this.deps.store.configure(a, op, p, () => guard(), true);
				// The committed receipt reserves this exact run. It is not a completion/coverage claim.
				try {
					await this.deps.sessions.dispatchInsightsOwnerReview(id, request);
				} catch {
					await this.deps.sessions.dayInsights!.finishRun(
						request.runId,
						"unknown",
						"Input placement unavailable; native Pause required; never replay",
					);
				}
				return receipt;
			}
			if (p.action === "pause") {
				if (existing) await this.deps.owners.fence(lease, "paused");
				try {
					await this.cancel(a, guard);
				} finally {
					if (this.deps.sessions.get(id)) {
						await this.deps.sessions.stop(id);
						await this.deps.sessions.drainInsightsOwner(id);
					}
					await this.deps.store.cancelRuns(a.owner.workspaceId);
				}
				if (this.deps.sessions.get(id)) {
					await this.deps.sessions.closeInsightsOwnerIdle(id, guard);
					await this.deps.sessions.syncDayInsightsOwner(id, guard);
				}
			} else {
				const settings = p.settings ?? before.effective;
				if (!settings) throw new Conflict("day_insights_settings_required");
				const desired: InsightsSettingsRecord = {
					revision: p.expectedRevision + 1,
					model: settings.model,
					settings: dayInsightsReaderSettings(settings),
				};
				if (existing) {
					const control = this.deps.sessions.insightsOwnerControl(id);
					reportGuard = () => control.revalidate();
					await this.deps.sessions.closeInsightsOwnerIdle(id, guard);
				}
				await this.deps.owners.prepareDay(lease, op, desired, settings.thinking, guard);
				if (!existing) {
					await this.deps.sessions.spawnInsightsOwnerDurable(this.deps.owners.current(a)!, op.operationId);
					const control = this.deps.sessions.insightsOwnerControl(id, op.operationId);
					reportGuard = () => control.revalidate();
				} else {
					await this.deps.sessions.syncDayInsightsOwner(id, guard);
					// Configuration only changes inert metadata. Each later run opens empty storage.
					await this.deps.sessions.configureFreshDayReport(id, settings.model, settings.thinking, guard);
				}
				const paused = p.action === "resume" ? false : before.paused;
				await this.cancel(a, guard);
				await this.deps.owners.finishDay(lease, op, desired, paused, settings.thinking, guard);
				await this.deps.sessions.syncDayInsightsOwner(id, guard);
				if (settings.weekly && !paused) await this.schedule(a, op, desired, guard);
			}
			guard();
			const result = await this.deps.store.configure(
				a,
				op,
				p,
				() => {
					authorityGuard(a);
					proof?.guard();
					reportGuard?.();
					this.deps.store.assertControl(a.owner.workspaceId, generation!);
				},
				true,
			);
			// The atomic commit clears operation_id. Keep only the generation/Stop fence now.
			reportGuard?.();
			authorityGuard(a);
			proof?.guard();
			this.deps.store.assertControl(a.owner.workspaceId, generation);
			await this.deps.schedules.ownerSettingsCommitted();
			return result;
		} finally {
			proof?.close();
		}
	}
	private async cancel(a: InsightsWorkspaceAuthority, guard: () => void) {
		const rule = this.deps.schedules.store.list().find((r) => r.id === a.owner.scheduleId);
		if (!rule || rule.state === "cancelled") return;
		await this.deps.schedules.cancelOwnerInsights(rule, a.owner, guard);
	}
	private async schedule(
		a: InsightsWorkspaceAuthority,
		op: DurableOperation,
		settings: InsightsSettingsRecord,
		guard: () => void,
	) {
		const prior = this.deps.schedules.store.list().find((r) => r.id === a.owner.scheduleId);
		if (prior) await this.deps.schedules.rearmOwnerInsights(prior, a.owner, op.operationId, settings, guard);
		else
			await this.deps.schedules.createOwnerInsights(
				{
					title: "Weekly Insights",
					trigger: "recurring",
					recurrence: settings.settings.recurrence,
					expectedHome: a.owner.expectedHome,
					target: {
						kind: "message",
						sessionId: a.owner.reportSessionId,
						message: "Prepare the next bounded Insights report.",
					},
				},
				a.owner,
				op.operationId,
				settings.revision,
				guard,
			);
	}
}
