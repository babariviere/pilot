/** Fresh owner execution bridge. Deliberately not advertised until native operations are joined. */
import { randomUUID } from "node:crypto";
import type { DurableOperation, InsightsWorkspaceOwner } from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { type InsightsOwnerStore, projectOwnerExecution } from "./insights-owner-store.ts";
import type { InsightsWorkspaceAuthority, InsightsWorkspaceStore } from "./insights-workspace-store.ts";
import type { ModelCatalog } from "./models.ts";
import { canonicalJSON, type OperationJournal, OperationRejected } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { ScheduleService } from "./schedules.ts";
import type { SessionManager } from "./sessions.ts";

const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
export function isInsightsOwnerOperation(kind: string): boolean {
	return [
		"insights-workspace-enable",
		"insights-workspace-apply",
		"insights-workspace-pause",
		"insights-workspace-revoke",
	].includes(kind);
}
export interface InsightsOwnerDependencies {
	home: string;
	projects: ProjectStore;
	models: Pick<ModelCatalog, "list">;
	workspace: InsightsWorkspaceStore;
	store: InsightsOwnerStore;
	sessions: SessionManager;
	schedules: ScheduleService;
	journal: OperationJournal;
	transition?: {
		admission(a: InsightsWorkspaceAuthority): Promise<{
			operationId: string;
			control: import("@pilot/protocol").InsightsWorkspaceTransferPayload["identity"] | null;
			effective: import("@pilot/protocol").InsightsSettingsRecord;
			thinking?: string;
			guard: () => void;
		} | null>;
	};
}
export class InsightsOwner {
	private readonly deps: InsightsOwnerDependencies;
	private readonly running = new Set<string>();
	constructor(deps: InsightsOwnerDependencies) {
		this.deps = deps;
	}
	async admit(op: DurableOperation, firstEntry = false): Promise<unknown> {
		try {
			const a = this.authority(JSON.parse(op.payload).owner);
			const prior = await this.deps.store.lookup(this.deps.sessions.insightsOwnerLease(a), op);
			if (prior.state === "committed") return prior.result;
			if (prior.state === "entered") throw new Error("Owner operation entered; exact Check only, never replay");
			if (!firstEntry)
				throw new OperationRejected(
					"Owner confirmation interrupted before entry; fresh native confirmation required",
				);
			if (op.kind === "insights-workspace-enable") return await this.enable(op);
			if (op.kind === "insights-workspace-apply") return await this.apply(op);
			if (isInsightsOwnerOperation(op.kind)) return await this.pause(op);
			throw new Conflict("Unsupported owner operation");
		} catch (error) {
			if (
				!this.deps.store.recorded(op) &&
				(error instanceof Conflict ||
					error instanceof NotFound ||
					error instanceof SyntaxError ||
					error instanceof TypeError)
			)
				throw new OperationRejected(error.message);
			throw error;
		}
	}
	async previewState(owner: InsightsWorkspaceOwner, state: "pause" | "revoke") {
		const a = this.authority(owner),
			lease = this.deps.sessions.insightsOwnerLease(a);
		this.deps.store.assertNoEntered(a);
		const current = await this.deps.store.read(lease);
		if (!current || !["active", "paused"].includes(current.state)) throw new Conflict("owner_state_unavailable");
		const report = this.deps.sessions.insightsOwnerControl(owner.reportSessionId),
			rule = this.deps.schedules.store.require(owner.scheduleId);
		if (
			!same(rule.insightsOwnerDestination, owner) ||
			(rule.state !== "pending" &&
				!(state === "revoke" && rule.state === "cancelled" && this.deps.store.pausedReceipt(current)))
		)
			throw new Conflict("owner_state_rule_unavailable");
		return {
			schemaVersion: 2 as const,
			admissionEpoch: this.deps.sessions.insightsAdmissionEpoch,
			owner,
			expectedRevision: lease.revision,
			reportInputGeneration: report.inputGeneration,
			grantRevision: current.binding.revision,
			rule,
			disclosure:
				state === "pause" ? ("insights-workspace-pause-v2" as const) : ("insights-workspace-revoke-v2" as const),
		};
	}
	async status(owner: InsightsWorkspaceOwner) {
		const a = this.authority(owner),
			lease = this.deps.sessions.insightsOwnerLease(a);
		const current = await this.deps.store.read(lease);
		if (!current) return { schemaVersion: 2, owner, state: "not_activated" };
		const status = projectOwnerExecution(current);
		if (current.state === "active") {
			const report = this.deps.sessions.insightsOwnerStatus(owner.reportSessionId);
			const rule = this.deps.schedules.store.require(owner.scheduleId);
			if (
				!report?.available ||
				!same(rule.insightsOwnerDestination, owner) ||
				!["pending", "dispatching"].includes(rule.state) ||
				rule.insightsSettingsRevision !== current.settings.revision
			)
				status.state = "blocked";
		}
		lease.revalidate();
		return status;
	}
	/** Passive exact operation lookup. Never settles entered markers or grants based on resources. */
	async check(op: DurableOperation) {
		const a = this.authority(JSON.parse(op.payload).owner),
			lease = this.deps.sessions.insightsOwnerLease(a);
		const receipt = await this.deps.store.lookup(lease, op);
		return { receipt, current: await this.status(a.owner) };
	}
	private authority(owner: InsightsWorkspaceOwner): InsightsWorkspaceAuthority {
		const a = { owner, home: this.deps.home, projectPath: this.deps.projects.require(owner.projectId).path };
		this.deps.sessions.insightsOwnerLease(a).revalidate();
		return a;
	}
	private async legacyFence(a: InsightsWorkspaceAuthority, expected?: { legacyControl?: unknown }) {
		const transferred = await this.deps.transition?.admission(a);
		if (transferred) {
			if (expected && !same(expected.legacyControl, transferred.control))
				throw new Conflict("owner_legacy_control_changed_since_confirmation");
			transferred.guard();
			return transferred.guard;
		}
		const journal = await this.deps.journal.legacyInsightsGuard();
		const guard = () => {
			journal();
			this.deps.sessions.assertNoLegacyInsights();
			this.deps.schedules.assertNoLegacyOwnerExecution(this.deps.journal.destination);
			if (this.deps.workspace.hasLegacyRecords()) throw new Conflict("legacy_transition_required");
		};
		guard();
		return guard;
	}
	/** Passive metadata/catalog preview only. No report, rule, grant or history read. */
	async preview(owner: InsightsWorkspaceOwner) {
		const a = this.authority(owner),
			lease = this.deps.sessions.insightsOwnerLease(a);
		const legacy = await this.legacyFence(a);
		if (this.deps.store.current(a)) throw new Conflict("owner_execution_exists_check_status");
		if (
			this.deps.sessions.get(owner.reportSessionId) ||
			this.deps.schedules.store.hasReportOrRule(owner.reportSessionId, owner.scheduleId)
		)
			throw new Conflict("owner_resource_identity_already_present");
		const desired = await this.deps.workspace.settings(lease);
		if (!desired) throw new Conflict("owner_settings_missing");
		const configured = this.deps.workspace.reservedConfiguration(lease);
		const transferred = await this.deps.transition?.admission(a);
		const selected = transferred?.effective ?? desired;
		if (selected.model !== configured.model) throw new Conflict("owner_changed_settings_require_separate_apply");
		const catalog = await this.deps.models.list(a.projectPath);
		lease.revalidate();
		legacy();
		if (!same(desired, await this.deps.workspace.settings(lease))) throw new Conflict("owner_settings_changed");
		const model = catalog.models.find((m) => m.id === configured.model);
		if (!model || (configured.thinking !== undefined && !model.thinkingLevels?.includes(configured.thinking)))
			throw new Conflict("owner_exact_model_unavailable");
		this.deps.schedules.insightsEnableAvailable(owner.expectedHome);
		return {
			schemaVersion: 2 as const,
			admissionEpoch: this.deps.sessions.insightsAdmissionEpoch,
			owner,
			expectedRevision: lease.revision,
			settingsRevision: selected.revision,
			model: configured.model,
			...(configured.thinking === undefined ? {} : { thinking: configured.thinking }),
			settings: selected.settings,
			...(transferred
				? {
						transitionId: transferred.operationId,
						desiredSettingsRevision: desired.revision,
						legacyControl: transferred.control,
					}
				: {}),
			disclosure: "insights-workspace-enable-v2" as const,
		};
	}
	/** Exact native-confirmed payload only. Entered effects never run again, even after restart. */
	async enable(op: DurableOperation): Promise<unknown> {
		if (op.kind !== "insights-workspace-enable") throw new Conflict("owner_enable_kind_required");
		const payload = JSON.parse(op.payload);
		const a = this.authority(payload.owner),
			lease = this.deps.sessions.insightsOwnerLease(a);
		if (
			op.targetId !== a.owner.workspaceId ||
			!same(op.destination.daemonId, a.owner.expectedHome.daemonId) ||
			!same(op.destination.lineageId, a.owner.expectedHome.lineageId)
		)
			throw new Conflict("owner_operation_identity_changed");
		if (this.running.has(op.targetId)) throw new Conflict("owner_confirmation_in_progress");
		this.running.add(op.targetId);
		try {
			// Exact prior receipt must be checked without a catalog read or another effect.
			const prior = await this.deps.store.lookup(lease, op);
			if (prior.state === "committed") return prior.result;
			if (prior.state === "entered") throw new Error("Owner Enable entered; status only, never replay");
			if (!same(payload, await this.preview(a.owner))) throw new Conflict("owner_preview_changed");
			const legacy = await this.legacyFence(a, payload);
			const marker = await this.deps.store.enter(lease, op);
			if (!marker.entered) throw new Error("Owner Enable already entered; status only");
			lease.revalidate();
			legacy();
			await this.deps.store.provision(
				lease,
				{
					schemaVersion: 2,
					owner: a.owner,
					grantId: randomUUID(),
					revision: 1,
					enabled: true,
					reportSessionId: a.owner.reportSessionId,
					projectId: a.owner.projectId,
					host: a.owner.expectedHome,
				},
				{ revision: payload.settingsRevision, settings: payload.settings, model: payload.model },
				payload.thinking,
			);
			lease.revalidate();
			legacy();
			const current = this.deps.store.current(a)!;
			await this.deps.sessions.spawnInsightsOwnerDurable(current, op.operationId);
			const report = this.deps.sessions.insightsOwnerControl(a.owner.reportSessionId, op.operationId);
			lease.revalidate();
			legacy();
			await this.deps.schedules.createOwnerInsights(
				{
					title: "Weekly Insights",
					trigger: "recurring",
					recurrence: current.settings.settings.recurrence,
					expectedHome: a.owner.expectedHome,
					target: {
						kind: "message",
						sessionId: a.owner.reportSessionId,
						message: "Prepare the next bounded weekly Insights report.",
					},
				},
				a.owner,
				op.operationId,
				current.settings.revision,
				() => {
					lease.revalidate();
					legacy();
					report.revalidate();
				},
			);
			lease.revalidate();
			legacy();
			report.revalidate();
			const catalog = await this.deps.models.list(a.projectPath);
			lease.revalidate();
			legacy();
			report.revalidate();
			const exactModel = catalog.models.find((m) => m.id === current.settings.model);
			if (!exactModel || (current.thinking !== undefined && !exactModel.thinkingLevels?.includes(current.thinking)))
				throw new Conflict("owner_exact_model_unavailable");
			return await this.deps.store.activate(lease, op);
		} finally {
			this.running.delete(op.targetId);
		}
	}
	/** Fence synchronously before Stop and cancellation; any lost ACK remains entered/blocked. */
	async previewApply(owner: InsightsWorkspaceOwner) {
		const a = this.authority(owner),
			lease = this.deps.sessions.insightsOwnerLease(a),
			legacy = await this.legacyFence(a);
		this.deps.store.assertNoEntered(a);
		this.deps.store.assertApplyIdle(a);
		const current = this.deps.store.current(a);
		if (!current || !["active", "paused"].includes(current.state)) throw new Conflict("owner_apply_not_available");
		const chat = this.deps.sessions.insightsOwnerApplySnapshot(owner.reportSessionId),
			rule = this.deps.schedules.store.require(owner.scheduleId);
		if (
			!same(rule.insightsOwnerDestination, owner) ||
			(rule.state !== "pending" && !(rule.state === "cancelled" && this.deps.store.pausedReceipt(current)))
		)
			throw new Conflict("owner_apply_rule_unavailable");
		if (chat.model !== current.settings.model || chat.thinking !== (current.effectiveThinking ?? current.thinking))
			throw new Conflict("owner_effective_model_changed");
		const desired = await this.deps.workspace.settings(lease);
		if (!desired) throw new Conflict("owner_desired_settings_unavailable");
		const catalog = await this.deps.models.list(a.projectPath);
		lease.revalidate();
		legacy();
		this.deps.store.assertNoEntered(a);
		this.deps.store.assertApplyIdle(a);
		if (
			!same(current, this.deps.store.current(a)) ||
			!same(chat, this.deps.sessions.insightsOwnerApplySnapshot(owner.reportSessionId)) ||
			!same(rule, this.deps.schedules.store.require(owner.scheduleId)) ||
			!same(desired, await this.deps.workspace.settings(lease))
		)
			throw new Conflict("owner_apply_preview_changed");
		const model = catalog.models.find((m) => m.id === desired.model);
		if (!model || (chat.thinking !== undefined && !model.thinkingLevels?.includes(chat.thinking)))
			throw new Conflict("owner_exact_model_unavailable");
		this.deps.schedules.insightsEnableAvailable(owner.expectedHome);
		return {
			schemaVersion: 2 as const,
			admissionEpoch: this.deps.sessions.insightsAdmissionEpoch,
			owner,
			expectedRevision: lease.revision,
			grantRevision: current.binding.revision,
			chat,
			record: { revision: desired.revision, model: desired.model, settings: desired.settings },
			rule,
			disclosure: "insights-workspace-apply-v2" as const,
		};
	}
	async apply(op: DurableOperation): Promise<unknown> {
		if (op.kind !== "insights-workspace-apply") throw new Conflict("owner_apply_kind_required");
		const p = JSON.parse(op.payload),
			a = this.authority(p.owner),
			lease = this.deps.sessions.insightsOwnerLease(a);
		if (
			op.targetId !== a.owner.workspaceId ||
			op.destination.daemonId !== a.owner.expectedHome.daemonId ||
			op.destination.lineageId !== a.owner.expectedHome.lineageId
		)
			throw new Conflict("owner_operation_identity_changed");
		if (this.running.has(op.targetId)) throw new Conflict("owner_confirmation_in_progress");
		this.running.add(op.targetId);
		try {
			const prior = await this.deps.store.lookup(lease, op);
			if (prior.state === "committed") return prior.result;
			if (prior.state === "entered") throw new Error("Owner Apply entered; status only, never replay");
			if (!same(p, await this.previewApply(a.owner))) throw new Conflict("owner_apply_preview_changed");
			const expected = this.deps.store.current(a)!,
				report = this.deps.sessions.insightsOwnerControl(a.owner.reportSessionId),
				legacy = await this.legacyFence(a);
			const guard = (generation = p.chat.reportInputGeneration) => {
				lease.revalidate();
				report.revalidateAt(generation);
				legacy();
			};
			if (!(await this.deps.store.enter(lease, op)).entered)
				throw new Error("Owner Apply already entered; status only");
			guard();
			await this.deps.sessions.closeInsightsOwnerIdle(a.owner.reportSessionId, () => guard());
			const binding = {
				schemaVersion: 2 as const,
				owner: a.owner,
				grantId: randomUUID(),
				revision: expected.binding.revision + 1,
				enabled: true,
				reportSessionId: a.owner.reportSessionId,
				projectId: a.owner.projectId,
				host: a.owner.expectedHome,
			};
			await this.deps.store.beginApply(lease, op, expected, binding, p.record);
			guard();
			await this.deps.sessions.admitInsightsOwnerBinding(a.owner.reportSessionId, p.chat, () => guard());
			guard();
			const cancelled =
				p.rule.state === "cancelled"
					? p.rule
					: await this.deps.schedules.cancelOwnerInsights(p.rule, a.owner, () => guard());
			let generation = p.chat.reportInputGeneration;
			if (p.chat.model !== p.record.model) {
				await this.deps.sessions.configureInsightsOwnerModel(
					a.owner.reportSessionId,
					p.record.model,
					p.chat.thinking,
					this.deps.models,
					guard,
				);
				generation++;
			}
			guard(generation);
			await this.deps.sessions.closeInsightsOwnerIdle(a.owner.reportSessionId, () => guard(generation));
			guard(generation);
			await this.deps.store.stageApply(lease, op, p.record);
			guard(generation);
			await this.deps.schedules.rearmOwnerInsights(cancelled, a.owner, op.operationId, p.record, () =>
				guard(generation),
			);
			guard(generation);
			const catalog = await this.deps.models.list(a.projectPath);
			guard(generation);
			const model = catalog.models.find((m) => m.id === p.record.model);
			if (!model || (p.chat.thinking !== undefined && !model.thinkingLevels?.includes(p.chat.thinking)))
				throw new Conflict("owner_exact_model_unavailable");
			return await this.deps.store.activate(lease, op);
		} finally {
			this.running.delete(op.targetId);
		}
	}
	/** Fence synchronously before Stop and cancellation; any lost ACK remains entered/blocked. */
	async pause(op: DurableOperation): Promise<unknown> {
		if (op.kind !== "insights-workspace-pause" && op.kind !== "insights-workspace-revoke")
			throw new Conflict("owner_state_kind_required");
		const p = JSON.parse(op.payload),
			a = this.authority(p.owner),
			lease = this.deps.sessions.insightsOwnerLease(a);
		if (
			op.targetId !== a.owner.workspaceId ||
			!same(op.destination.daemonId, a.owner.expectedHome.daemonId) ||
			!same(op.destination.lineageId, a.owner.expectedHome.lineageId)
		)
			throw new Conflict("owner_operation_identity_changed");
		const prior = await this.deps.store.lookup(lease, op);
		if (prior.state === "committed") return prior.result;
		if (prior.state === "entered") throw new Error("Owner state change entered; status only, never replay");
		const current = this.deps.store.current(a);
		const report = this.deps.sessions.insightsOwnerControl(a.owner.reportSessionId);
		const rule = this.deps.schedules.store.require(a.owner.scheduleId);
		const cancellationAcknowledged =
			current?.state === "paused" && rule.state === "cancelled" && this.deps.store.pausedReceipt(current);
		if (
			!current ||
			!same(p, {
				schemaVersion: 2,
				admissionEpoch: this.deps.sessions.insightsAdmissionEpoch,
				owner: a.owner,
				expectedRevision: lease.revision,
				reportInputGeneration: report.inputGeneration,
				grantRevision: current.binding.revision,
				rule,
				disclosure:
					op.kind === "insights-workspace-pause" ? "insights-workspace-pause-v2" : "insights-workspace-revoke-v2",
			}) ||
			!same(rule.insightsOwnerDestination, a.owner) ||
			(rule.state !== "pending" && !(op.kind === "insights-workspace-revoke" && cancellationAcknowledged))
		)
			throw new Conflict("owner_state_preview_changed");
		const marker = await this.deps.store.enter(lease, op);
		if (!marker.entered) throw new Error("Owner state change already entered; status only");
		report.revalidate();
		await this.deps.store.fence(lease, op.kind === "insights-workspace-pause" ? "paused" : "revoked");
		report.revalidate();
		try {
			if (!cancellationAcknowledged)
				await this.deps.schedules.cancelOwnerInsights(rule, a.owner, () => {
					lease.revalidate();
					report.revalidate();
				});
		} finally {
			// Unknown rule cancellation still reaches the executor. No state action restores authority.
			await this.deps.sessions.stop(a.owner.reportSessionId);
		}
		const stopped = this.deps.sessions.insightsOwnerControl(a.owner.reportSessionId);
		if (stopped.inputGeneration !== report.inputGeneration + 1) throw new Conflict("owner_stop_generation_changed");
		await this.deps.sessions.drainInsightsOwner(a.owner.reportSessionId);
		stopped.revalidate();
		const result = projectOwnerExecution(this.deps.store.current(a)!);
		await this.deps.store.settle(lease, op, result);
		return result;
	}
}
