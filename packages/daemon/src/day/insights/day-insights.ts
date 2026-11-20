import type { DayInsightsPayload, DayInsightsPreflight, DayInsightsStatus, DurableOperation } from "@pilot/protocol";
import type { DayInsightsAllowance } from "./day-insights-allowance.ts";
import { dayInsightsExact, dayInsightsSourceAllowed, validateDayInsightsSettings } from "./day-insights-policy.ts";
import type { DayInsightsStore } from "./day-insights-store.ts";
import { Conflict, NotFound } from "../../runtime/contracts/errors.ts";
import { canonicalFundingQuote } from "../../models/funding/funding-requests.ts";
import { deriveInsightsWorkspaceAuthority } from "../../insights/ownership/insights-workspace.ts";
import type { InsightsWorkspaceAuthority, InsightsWorkspaceStore } from "../../insights/ownership/insights-workspace-store.ts";
import type { ModelCatalog } from "../../models/models.ts";
import { canonicalJSON, OperationConflict, OperationRejected } from "../../transport/operations/operation-journal.ts";
import type { ProjectStore } from "../../projects/projects.ts";
import type { SessionManager } from "../../sessions/sessions.ts";

interface Dependencies {
	home: string;
	host: import("@pilot/protocol").OperationHost;
	admissionEpoch: string;
	projects: Pick<ProjectStore, "require">;
	models: Pick<ModelCatalog, "list">;
	store: DayInsightsStore;
	workspace: InsightsWorkspaceStore;
	owners?: import("../../insights/ownership/insights-owner-store.ts").InsightsOwnerStore;
	/** No production adapter is installed until execution admission and evidence isolation qualify. */
	runtime?: DayInsightsExecutionAdapter;
	allowance?: DayInsightsAllowance;
	sessions?: SessionManager;
}
export interface DayInsightsExecutionAdapter {
	changed?(): void;
	nextAt(owner: import("@pilot/protocol").InsightsWorkspaceOwner | null): number | null;
	preview(
		a: InsightsWorkspaceAuthority,
		p: Pick<DayInsightsPayload, "action" | "settings">,
		status: DayInsightsStatus,
	): Promise<void>;
	execute(
		a: InsightsWorkspaceAuthority,
		op: DurableOperation,
		p: DayInsightsPayload,
		before: DayInsightsStatus,
		guard: (a: InsightsWorkspaceAuthority) => void,
	): Promise<DayInsightsStatus>;
}
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);

// Preflight is an HTTP boundary. Other services can throw conflicts with private details.
const reviewConflictReasons = new Set([
	"day_insights_invalid_fields",
	"day_insights_invalid_review",
	"day_insights_invalid_source_ids",
	"day_insights_invalid_model",
	"day_insights_source_project_required",
	"day_insights_invalid_weekly",
	"day_insights_invalid_timezone",
	"day_insights_invalid_allowance",
	"day_insights_unexpected_settings",
	"day_insights_stale_revision",
	"day_insights_owner_changed",
	"day_insights_operation_uncertain",
	"day_insights_initial_apply_must_be_manual",
	"day_insights_execution_adapter_unavailable",
	"day_insights_exact_model_unavailable",
	"day_insights_changed_during_review",
	"day_insights_not_configured",
	"day_insights_paused",
	"day_insights_existing_execution_requires_recovery",
	"legacy_execution_not_proven_quiescent",
	"legacy_execution_or_transfer_uncertain",
	"legacy_executor_not_quiescent_or_grant_not_revoked",
	"legacy_schedule_not_quiescent",
	"schedule_inventory_unavailable",
]);

const legacyJournalReviewReasons = new Set([
	"legacy_journal_busy_or_unavailable",
	"legacy_execution_not_proven_quiescent",
]);

/** Passive configuration service. Execution remains unavailable until its distinct adapter is installed. */
export class DayInsights {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	get executionAvailable(): boolean {
		return !!this.deps.runtime;
	}
	assertAdmission(current: import("../../insights/ownership/insights-owner-store.ts").InsightsOwnerExecution, configurationOnly = false) {
		if (!this.executionAvailable) throw new Conflict("day_insights_execution_adapter_unavailable");
		if (configurationOnly) throw new Conflict("day_insights_configuration_worker_forbidden");
		this.deps.store.assertCommitted(current.authority.owner.workspaceId, current.settings.revision);
	}
	scheduleReady(id: string, revision: number): boolean {
		try {
			const s = this.deps.store.current(this.deps.home, this.guard);
			if (!s?.owner || s.owner.reportSessionId !== id || s.paused || !this.executionAvailable) return false;
			if (this.deps.store.blockingRun(s.owner.workspaceId) || this.deps.sessions?.get(id)?.working) return false;
			this.deps.store.assertCommitted(s.owner.workspaceId, revision);
			return true;
		} catch {
			return false;
		}
	}
	assertRunId(id: string, run: string): number {
		const s = this.deps.store.current(this.deps.home, this.guard);
		if (!s?.owner || s.owner.reportSessionId !== id) throw new Conflict("day_insights_run_owner_changed");
		return this.deps.store.assertRun(s.owner.workspaceId, run, this.deps.admissionEpoch);
	}
	async recoverCancelledStop(): Promise<void> {
		const { store, sessions, owners, home } = this.deps;
		if (!this.executionAvailable || !sessions || !owners) return;
		const owner = store.current(home, this.guard)?.owner;
		if (!owner) return;
		await sessions.recoverCancelledDayStop(owner.reportSessionId, (run) => {
			if (store.uncertain(home) || store.blockingRun(owner.workspaceId) || !store.isCancelledRun(owner.workspaceId, run))
				return false;
			const authority = this.authority(owner.projectId);
			owners.assertNoEntered(authority);
			owners.assertApplyIdle(authority);
			return true;
		});
	}
	async reserveRun(id: string, request: import("@pilot/protocol").InsightsReviewDispatch) {
		const s = this.deps.store.current(this.deps.home, this.guard);
		if (!s?.owner || s.owner.reportSessionId !== id || !request.settingsRevision)
			throw new Conflict("day_insights_run_owner_changed");
		const generation = this.deps.store.assertCommitted(s.owner.workspaceId, request.settingsRevision);
		await this.deps.store.beginRun(
			s.owner.workspaceId,
			request.settingsRevision,
			request.runId,
			this.deps.admissionEpoch,
			() => this.deps.store.assertControl(s.owner!.workspaceId, generation),
		);
	}
	async prepareRun(id: string, request: import("@pilot/protocol").InsightsReviewDispatch) {
		if (!this.deps.sessions || !this.deps.owners) throw new Conflict("day_insights_runtime_unavailable");
		if (!this.deps.store.run(request.runId)) await this.reserveRun(id, request);
		const guard = () => {
			this.assertRunId(id, request.runId);
		};
		await this.deps.sessions.closeInsightsOwnerIdle(id, guard);
		await this.deps.store.claimRun(request.runId, guard);
		await this.deps.sessions.bindFreshDayRun(id, request.runId, guard);
	}
	private async hold(id: string, run: string, reason: string) {
		await this.deps.owners!.reviews.hold(id, run, reason);
		await this.deps.store.runState(run, "held", reason);
		this.deps.runtime?.changed?.();
	}
	private delivery(id: string, run: string) {
		const cutoff = this.assertRunId(id, run);
		const admission = this.deps.sessions!.insightsOwnerAdmission(id);
		this.deps.owners!.reviews.assertDelivery(admission, run, (sourceId) => {
			const source = this.deps.sessions!.dayInsightsSource(sourceId);
			return !!source && this.sourceAllowed(source, cutoff) && this.sourceAllowed(source, Date.now());
		});
	}
	async backlog(id: string, input: unknown, worker?: import("../../sessions/workers/kernel-worker.ts").SessionWorker): Promise<unknown> {
		const request = (await import("../../insights/insights-backlog.ts")).parseInsightsBacklog(input);
		const run = this.deps.sessions!.dayInsightsRunId(id);
		const admission = this.deps.sessions!.insightsOwnerAdmission(id, worker);
		try {
			this.delivery(id, run);
		} catch (error) {
			await this.hold(id, run, "Source eligibility changed before disclosure; distinct run required");
			throw error;
		}
		// Saved tracking stays readable in native views, never inherited by a fresh model context.
		if (["list", "get", "history", "evidence", "receipt"].includes(request.action))
			return {
				items: [],
				nextCursor: null,
				state: "unavailable",
				reason: "prior_tracking_not_in_fresh_report_context",
			};
		if ((request.action === "save_report" || request.action === "save_checkpoint") && request.key !== run)
			throw new Conflict("day_insights_exact_run_key_required");
		const s = this.deps.store.current(this.deps.home, this.guard)!;
		if ("draft" in request) {
			const source = s.effective!.source;
			for (const { projectId } of request.draft.targets) {
				if (!source.projects.includes(projectId) || source.excludeProjects.includes(projectId))
					throw new Conflict("day_insights_finding_target_outside_selected_projects");
				this.deps.projects.require(projectId);
			}
		}
		const lease = this.deps.sessions!.insightsOwnerLease(this.authority(s.owner!.projectId));
		const result = await this.deps.owners!.backlog(this.deps.workspace, lease, admission, request, true);
		this.delivery(id, run);
		if (request.action === "save_report")
			await this.deps.store.runState(run, "partial", "Bounded report saved; not comprehensive coverage");
		return result;
	}
	private authority(projectId: string) {
		return deriveInsightsWorkspaceAuthority(this.deps.home, this.deps.host, this.deps.projects.require(projectId));
	}
	private guard = (a: InsightsWorkspaceAuthority) => {
		if (!same(a, this.authority(a.owner.projectId))) throw new Conflict("day_insights_identity_changed");
	};
	async status(): Promise<DayInsightsStatus> {
		const workspace = await this.deps.workspace.read(this.deps.home, this.guard);
		const saved = await this.deps.store.read(this.deps.home, this.guard);
		if (workspace && saved?.owner && !same(workspace.owner, saved.owner))
			throw new Conflict("day_insights_owner_changed");
		const result: DayInsightsStatus = saved ?? {
			schemaVersion: 1,
			revision: 0,
			owner: workspace?.owner ?? null,
			draft: null,
			effective: null,
			paused: false,
			executionSupported: false,
			uncertainOperationId: null,
			running: null,
			nextAt: null,
			holdReason: "day_insights_execution_adapter_unavailable",
			remaining: { perReportMicros: null, monthlyMicros: null, uncertainMicros: null },
		};
		result.uncertainOperationId = this.deps.store.uncertain(this.deps.home);
		result.executionSupported = !!this.deps.runtime;
		if (this.deps.runtime) {
			result.holdReason = result.uncertainOperationId ? "day_insights_operation_uncertain" : null;
			const run = result.owner ? this.deps.store.latestRun(result.owner.workspaceId) : null;
			result.running = !!run && ["preparing", "ready", "sent"].includes(String(run.state));
			if (run && ["active", "reserved"].includes(String(run.state))) result.running = true;
			if (run?.state === "held") {
				result.holdReason = String(run.detail);
				result.running = false;
			}
			if (run?.admission_epoch && run.admission_epoch !== this.deps.admissionEpoch && result.running) {
				result.running = false;
				result.uncertainOperationId ??= String(run.run_id);
				result.holdReason = "day_insights_cold_run_uncertain";
			}
			if (run && ["unknown", "interrupted"].includes(String(run.state))) {
				result.uncertainOperationId ??= String(run.run_id);
				result.holdReason = "day_insights_run_uncertain";
			}
			if (result.owner && result.effective && this.deps.allowance)
				result.remaining = await this.deps.allowance.remaining(
					result.owner.workspaceId,
					result.running && run ? String(run.run_id) : "next-report",
					result.effective.allowance,
					Date.now(),
				);
			result.nextAt = this.deps.runtime.nextAt(result.owner);
		} else {
			result.running = null;
			result.nextAt = null;
			result.remaining = { perReportMicros: null, monthlyMicros: null, uncertainMicros: null };
			result.holdReason = result.uncertainOperationId
				? "day_insights_operation_uncertain"
				: "day_insights_execution_adapter_unavailable";
		}
		return result;
	}
	owns(id: string): boolean {
		return this.deps.sessions?.isDayInsightsReport(id) ?? false;
	}
	sourceAllowed(
		source: { id: string; projectId?: string | null; archivedAt?: string | number | null; role?: string },
		now: number,
	): boolean {
		const settings = this.deps.store.current(this.deps.home, this.guard)?.effective;
		return source.role !== "insights" && !!settings && dayInsightsSourceAllowed(settings, source, now);
	}
	async finishRun(run: string, state: "held" | "unknown", detail: string) {
		await this.deps.store.finishWithoutReport(run, state, detail);
		this.deps.owners?.reviews.changed();
		this.deps.runtime?.changed?.();
	}
	async fundingRequest(
		id: string,
		request: import("@pilot/kernel/credential-rpc").CredentialRequest,
		catalog: Pick<import("../../models/shared-model-catalog.ts").SharedCatalogService, "fundingModel">,
	) {
		if (
			!this.deps.runtime ||
			!this.owns(id) ||
			!request.key ||
			!/^[A-Za-z0-9_-]{1,128}$/u.test(request.key) ||
			!this.deps.sessions ||
			!this.deps.allowance
		)
			throw new Conflict("day_insights_funding_unavailable");
		const admission = this.deps.sessions.insightsOwnerAdmission(id);
		const run = this.deps.sessions.dayInsightsRunId(id);
		const current = this.deps.store.current(this.deps.home, this.guard)!;
		const guard = () => {
			admission.revalidate();
			if (
				!same(current.effective, this.deps.store.current(this.deps.home, this.guard)?.effective) ||
				this.deps.sessions!.dayInsightsRunId(id) !== run
			)
				throw new Conflict("day_insights_funding_authority_changed");
		};
		if (request.op === "funding-settle")
			return this.deps.allowance.settle(
				current.owner!.workspaceId,
				run,
				request.key,
				request.value as import("@pilot/protocol").FundingTokens,
				guard,
			);
		try {
			this.delivery(id, run);
			const quote = await canonicalFundingQuote(catalog, request);
			if (`${quote.provider}/${quote.model}` !== current.effective!.model)
				throw new Conflict("day_insights_physical_model_changed");
			guard();
			this.delivery(id, run);
			await this.deps.allowance.reserve(
				current.owner!.workspaceId,
				run,
				request.key,
				quote,
				current.effective!.allowance,
				Date.now(),
				guard,
			);
			guard();
			this.delivery(id, run);
			return { requestId: request.key, perReportReserved: true, monthlyReserved: true };
		} catch (error) {
			await this.hold(id, run, error instanceof Error ? error.message : "day_insights_provider_admission_hold");
			throw error;
		}
	}
	async preflight(value: unknown): Promise<DayInsightsPreflight> {
		try {
			const r = dayInsightsExact(value, ["action", "expectedRevision", "projectId", "settings"]);
			if (
				!["save", "apply", "run", "pause", "resume"].includes(String(r.action)) ||
				!Number.isSafeInteger(r.expectedRevision) ||
				Number(r.expectedRevision) < 0 ||
				typeof r.projectId !== "string"
			)
				throw new Conflict("day_insights_invalid_review");
			const a = this.authority(r.projectId);
			const settings = r.action === "save" || r.action === "apply" ? validateDayInsightsSettings(r.settings) : null;
			if (!settings && r.settings !== null) throw new Conflict("day_insights_unexpected_settings");
			const status = await this.status();
			if (status.revision !== r.expectedRevision) throw new Conflict("day_insights_stale_revision");
			if (status.owner && !same(status.owner, a.owner)) throw new Conflict("day_insights_owner_changed");
			if (status.uncertainOperationId && r.action !== "pause")
				throw new Conflict("day_insights_operation_uncertain");
			if (r.action === "apply" && !status.effective && settings?.weekly !== null)
				throw new Conflict("day_insights_initial_apply_must_be_manual");
			// Do not pretend the old always-recurring/advisory executor implements this contract.
			if (!this.deps.runtime && ["run", "resume"].includes(String(r.action)))
				throw new Conflict("day_insights_execution_adapter_unavailable");
			if (settings) {
				for (const projectId of settings.source.projects) this.deps.projects.require(projectId);
				const catalog = await this.deps.models.list(a.projectPath);
				this.guard(a);
				const model = catalog.models.find((m) => m.id === settings.model);
				if (!model || (settings.thinking !== undefined && !model.thinkingLevels?.includes(settings.thinking)))
					throw new Conflict("day_insights_exact_model_unavailable");
				if (!same(status, await this.status())) throw new Conflict("day_insights_changed_during_review");
			}
			const payload: DayInsightsPayload = {
				schemaVersion: 1,
				admissionEpoch: this.deps.admissionEpoch,
				owner: a.owner,
				action: r.action as DayInsightsPayload["action"],
				expectedRevision: Number(r.expectedRevision),
				settings,
				disclosure: "day-insights-v1",
			};
			await this.deps.runtime?.preview(a, payload, status);
			return { schemaVersion: 1, state: "ready", reason: null, payload };
		} catch (error) {
			const knownJournalRefusal =
				error instanceof OperationConflict && legacyJournalReviewReasons.has(error.message);
			const knownRefusal =
				knownJournalRefusal || (error instanceof Conflict && reviewConflictReasons.has(error.message));
			return {
				schemaVersion: 1,
				state:
					knownJournalRefusal || error instanceof Conflict || error instanceof NotFound
						? "blocked"
						: "unavailable",
				reason: knownRefusal ? error.message : "day_insights_unavailable",
				payload: null,
			};
		}
	}
	async admit(op: DurableOperation, firstEntry = false): Promise<DayInsightsStatus> {
		try {
			if (op.kind !== "day-insights") throw new Conflict("day_insights_wrong_kind");
			const p = dayInsightsExact(JSON.parse(op.payload), [
				"schemaVersion",
				"admissionEpoch",
				"owner",
				"action",
				"expectedRevision",
				"settings",
				"disclosure",
			]);
			const owner = dayInsightsExact(p.owner, [
				"schemaVersion",
				"workspaceId",
				"reportSessionId",
				"scheduleId",
				"projectId",
				"expectedHome",
				"context",
			]);
			if (typeof owner.projectId !== "string") throw new Conflict("day_insights_invalid_owner");
			const a = this.authority(owner.projectId);
			if (
				p.schemaVersion !== 1 ||
				p.disclosure !== "day-insights-v1" ||
				!same(p.owner, a.owner) ||
				op.targetId !== a.owner.workspaceId ||
				op.destination.daemonId !== this.deps.host.daemonId ||
				op.destination.lineageId !== this.deps.host.lineageId
			)
				throw new Conflict("day_insights_identity_changed");
			const prior = await this.deps.store.lookup(op);
			this.guard(a);
			if (prior?.state === "committed") return prior.result;
			if (prior?.state === "superseded") throw new OperationRejected("day_insights_superseded_by_pause");
			if (prior) throw new Error("day_insights_operation_uncertain");
			if (!firstEntry) throw new OperationRejected("day_insights_fresh_confirmation_required");
			const preview = await this.preflight({
				action: p.action,
				expectedRevision: p.expectedRevision,
				projectId: owner.projectId,
				settings: p.settings,
			});
			if (!preview.payload || !same(preview.payload, p))
				throw new Conflict(preview.reason ?? "day_insights_review_changed");
			if (this.deps.runtime && preview.payload.action !== "save")
				return await this.deps.runtime.execute(a, op, preview.payload, await this.status(), this.guard);
			if (preview.payload.action === "pause" && this.owns(a.owner.reportSessionId)) {
				await this.deps.store.enter(a, op, preview.payload, this.guard);
				await this.deps.sessions!.denyUnsupportedDayInsights(a.owner.reportSessionId);
			}
			return await this.deps.store.configure(a, op, preview.payload, this.guard);
		} catch (error) {
			if (
				!this.deps.store.recorded(op) &&
				(error instanceof Conflict || error instanceof NotFound || error instanceof SyntaxError)
			)
				throw new OperationRejected(error.message);
			throw error;
		}
	}
	/** Full immutable envelope lookup only. A committed Pause is not evidence of non-execution. */
	async supersededReceipt(op: DurableOperation): Promise<import("@pilot/protocol").OperationReceipt | null> {
		if (op.kind !== "day-insights") return null;
		const payload = JSON.parse(op.payload) as DayInsightsPayload;
		const a = this.authority(payload.owner.projectId);
		if (
			!same(a.owner, payload.owner) ||
			op.targetId !== a.owner.workspaceId ||
			op.destination.daemonId !== this.deps.host.daemonId ||
			op.destination.lineageId !== this.deps.host.lineageId
		)
			throw new Conflict("day_insights_identity_changed");
		const prior = await this.deps.store.lookup(op);
		this.guard(a);
		if (prior?.state !== "superseded") return null;
		return {
			operationId: op.operationId,
			payloadHash: op.payloadHash,
			destination: op.destination,
			targetId: op.targetId,
			state: "rejected",
			reason: "day_insights_superseded_by_pause",
			result: prior.result,
		};
	}
}
