import type {
	DurableOperation,
	InsightsEnablePayload,
	InsightsReplacementPayload,
	InsightsReplacementPreview,
	InsightsReplacementProgress,
	InsightsReplacementRule,
	InsightsReplacementStatus,
	ScheduledItem,
} from "@pilot/protocol";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import { INSIGHTS_INITIAL_DEFAULTS, resolveInsightsInitialModel } from "./insights-defaults.ts";
import { InsightsEnable, type InsightsEnableDependencies } from "./insights-enable.ts";
import { canonicalJSON, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import { RecurrenceCalendar } from "./schedule-recurrence.ts";

const equal = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const digest = (v: unknown) => payloadHash(canonicalJSON(v));
const uuid = (s: string) => {
	const h = payloadHash(s);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const validId = (s: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(s);
const open = (r: ScheduledItem) => r.state === "pending" || r.state === "dispatching";
const MESSAGE = "Prepare the next bounded weekly Insights report.";

/** Confirmed replacement only. Missing metadata is never proof of extinguished authority. */
export class InsightsReplacement {
	private readonly deps: InsightsEnableDependencies;
	private readonly enable: InsightsEnable;
	private readonly running = new Set<string>();
	constructor(deps: InsightsEnableDependencies) {
		this.deps = deps;
		this.enable = new InsightsEnable(deps);
	}
	private get store() {
		return this.deps.missions.insights.replacements;
	}
	private rules(oldId: string, projectId: string, missionId: string, successorId?: string): ScheduledItem[] {
		return this.deps.schedules
			.list()
			.filter(
				(r) =>
					(r.target.kind === "message" && r.target.sessionId.toLowerCase() === oldId) ||
					r.insightsDestination?.sessionId.toLowerCase() === oldId ||
					(r.insightsDestination?.projectId === projectId &&
						r.insightsDestination.missionId === missionId &&
						r.insightsDestination.sessionId !== successorId &&
						!this.store.resolves(
							r.insightsDestination.sessionId,
							oldId,
							projectId,
							missionId,
							this.enable.context(projectId, missionId),
						)),
			);
	}
	private projectRule(r: ScheduledItem, oldId: string, projectId: string, missionId: string): InsightsReplacementRule {
		const uncertain = r.runs?.some(
			(run) => run.insightsReview && !["partial", "cancelled"].includes(run.insightsReview.state),
		);
		const trusted =
			r.target.kind === "message" &&
			r.target.sessionId === oldId &&
			r.projectId === projectId &&
			equal(r.insightsDestination, { sessionId: oldId, projectId, missionId }) &&
			!!r.insightsEnableOperationId;
		return {
			id: r.id,
			revision: r.revision,
			digest: digest(r),
			title: r.title,
			trigger: r.trigger,
			state: r.state,
			paused: !!r.paused,
			targetSessionId: r.target.kind === "message" ? r.target.sessionId : "",
			recurrence: r.recurrence ?? null,
			disposition: uncertain || r.state === "dispatching" || !trusted ? "blocked" : open(r) ? "cancel" : "keep",
		};
	}
	private guard(p: InsightsReplacementPayload, progress?: InsightsReplacementProgress): void {
		if (!equal(p.expectedHome, this.deps.host) || p.context !== this.enable.context(p.projectId, p.missionId))
			throw new Conflict("replacement_home_or_context_changed");
		this.deps.sessions.insightsReplacementGuard(p.oldSessionId, p.projectId, p.missionId, p.expectedHome);
		this.deps.schedules.insightsReplacementAvailable(p.expectedHome);
		if (progress && progress.phase !== "fence_pending") {
			const link = this.store.link(p.oldSessionId);
			if (
				!link ||
				link.successorSessionId !== p.successorSessionId ||
				link.context !== p.context ||
				link.projectId !== p.projectId ||
				link.missionId !== p.missionId
			)
				throw new Conflict("replacement_fence_unavailable");
		}
		const candidates = this.deps.sessions.insightsEnableCandidates(p.projectId, p.missionId);
		if (candidates.length && (!progress || ["fence_pending", "fenced", "rules_fenced"].includes(progress.phase)))
			throw new Conflict("successor_appeared_before_admission");
		if (candidates.some((c) => c.sessionId !== p.successorSessionId)) throw new Conflict("report_binding_ambiguous");
		const rows = this.rules(p.oldSessionId, p.projectId, p.missionId, p.successorSessionId);
		if (rows.length !== p.rules.length) throw new Conflict("old_rules_changed");
		for (const row of rows) {
			const ack = progress?.cancelledRules.find((r) => r.id === row.id);
			if (
				ack
					? row.revision !== ack.revision || digest(row) !== ack.digest
					: !equal(
							this.projectRule(row, p.oldSessionId, p.projectId, p.missionId),
							p.rules.find((r) => r.id === row.id),
						)
			)
				throw new Conflict("old_rule_revision_changed");
		}
		if (progress?.chat) {
			const admission = this.deps.sessions.insightsHostAdmission(p.successorSessionId);
			if (
				!equal(admission.binding.host, p.expectedHome) ||
				admission.binding.projectId !== p.projectId ||
				admission.binding.missionId !== p.missionId
			)
				throw new Conflict("successor_host_or_binding_changed");
			this.deps.missions.insights.settings.assertDispatch(admission);
			this.deps.missions.insights.settings.assertIdle(admission);
			if (
				!equal(this.deps.sessions.insightsApplyChat(p.successorSessionId), progress.chat) ||
				progress.chat.inputGeneration !== 0 ||
				progress.chat.revision !== 1
			)
				throw new Conflict("successor_stop_or_authority_changed");
		}
	}
	private async references(projectId: string, missionId: string, oldId: string, ownId?: string) {
		return this.deps.journal.replacementReferences(projectId, missionId, oldId, ownId);
	}
	private async revalidate(
		p: InsightsReplacementPayload,
		op: DurableOperation,
		progress: InsightsReplacementProgress,
	): Promise<void> {
		await this.deps.sessions.insightsReplacementAbsent(p.oldSessionId, p.projectId, p.missionId, p.expectedHome);
		const refs = await this.references(p.projectId, p.missionId, p.oldSessionId, op.operationId);
		if (refs.overflow || !equal(refs.items, p.references)) throw new Conflict("old_operations_changed_use_receipts");
		for (const kind of ["insights-enable", "insights-settings", "insights-apply", "chat-send", "chat-send-attached"])
			if ((await this.deps.journal.targetReceipts(kind, p.successorSessionId)).some((r) => r.state === "pending"))
				throw new Conflict("successor_operation_pending_use_receipt");
		const catalog = await this.deps.models.list(this.deps.projects.require(p.projectId).path);
		const model = catalog.models.find((m) => m.id === p.enable.model);
		if (!model || (p.enable.thinking !== undefined && !model.thinkingLevels?.includes(p.enable.thinking)))
			throw new Conflict("successor_model_unavailable");
		this.guard(p, progress);
	}

	async preview(
		projectId: string,
		missionId: string,
		oldSessionId: string,
		model?: string,
		thinking?: string,
		ownId?: string,
	): Promise<InsightsReplacementPreview> {
		const context = this.enable.context(projectId, missionId); // exact active backlog; no title matching
		if (!validId(oldSessionId)) throw new Conflict("invalid_old_identity");
		const result: InsightsReplacementPreview = {
			projectId,
			missionId,
			oldSessionId,
			state: "blocked",
			reason: null,
			coverage: "bounded",
			references: [],
			rules: [],
			supersession: null,
			payload: null,
			nextAt: null,
			model: { state: "unavailable", reason: "catalog_unavailable" },
			cost: { pricing: "unknown", spendUsd: null },
		};
		const block = (reason: string) => ({ ...result, reason });
		try {
			const link = await this.store.readLink(oldSessionId);
			if (link) {
				if (link.context !== context || link.projectId !== projectId || link.missionId !== missionId)
					return block("replacement_home_or_binding_changed");
				return {
					...result,
					state: link.state === "replaced" ? "replaced" : "blocked",
					supersession: link,
					reason: link.state === "replaced" ? "use_exact_successor" : "replacement_pending_use_status",
				};
			}
			const refs = await this.references(projectId, missionId, oldSessionId, ownId);
			result.references = refs.items;
			if (refs.overflow) return { ...block("reference_overflow"), coverage: "overflow" };
			if (
				!refs.qualified ||
				refs.qualifications.some((q) => q.context !== context || !equal(q.home, this.deps.host))
			)
				return block("old_identity_home_unqualified");
			if (refs.items.some((r) => r.state === "pending")) return block("old_operation_pending_use_receipt");
			if (
				refs.items.some(
					(r) =>
						r.state !== "rejected" &&
						r.targetId !== oldSessionId &&
						!this.store.resolves(r.targetId, oldSessionId, projectId, missionId, context),
				)
			)
				return block("report_references_ambiguous");
			const rules = this.rules(oldSessionId, projectId, missionId);
			if (
				rules.some(
					(r) =>
						r.projectId !== projectId ||
						(r.insightsDestination &&
							(r.insightsDestination.projectId !== projectId || r.insightsDestination.missionId !== missionId)),
				)
			)
				return { ...block("old_automation_binding_unavailable"), coverage: "unavailable" };
			result.rules = rules.slice(0, 8).map((r) => this.projectRule(r, oldSessionId, projectId, missionId));
			if (rules.length > 8) return { ...block("rule_overflow"), coverage: "overflow" };
			if (result.rules.some((r) => r.disposition === "blocked"))
				return block("old_automation_untrusted_or_uncertain");
			await this.deps.sessions.insightsReplacementAbsent(oldSessionId, projectId, missionId, this.deps.host);
			const successorSessionId = uuid(`insights-replacement:${context}:${oldSessionId}`);
			await this.deps.sessions.insightsReplacementAbsent(successorSessionId, projectId, missionId, this.deps.host);
			if (this.deps.sessions.insightsEnableCandidates(projectId, missionId).length)
				return block("report_binding_ambiguous");
			const catalog = await this.deps.models.list(this.deps.projects.require(projectId).path);
			result.model = resolveInsightsInitialModel(catalog.models);
			const selected = model ?? (result.model.state === "available" ? result.model.id : undefined);
			if (!selected) return block(`model_${result.model.state}`);
			const option = catalog.models.find((m) => m.id === selected);
			if (!option) return block("model_unavailable");
			if (thinking !== undefined && !option.thinkingLevels?.includes(thinking)) return block("thinking_unavailable");
			result.model = { state: "available", id: selected };
			const defaults = structuredClone(INSIGHTS_INITIAL_DEFAULTS);
			const enable: InsightsEnablePayload = {
				projectId,
				missionId,
				context,
				expectedHome: { ...this.deps.host },
				model: selected,
				...(thinking === undefined ? {} : { thinking }),
				recurrence: defaults.recurrence,
				scope: defaults.scope,
				bounds: defaults.bounds,
				budget: defaults.budget,
				disclosure: "insights-weekly-v1",
				chat: null,
				schedule: null,
			};
			const payload: InsightsReplacementPayload = {
				projectId,
				missionId,
				context,
				expectedHome: { ...this.deps.host },
				oldSessionId,
				successorSessionId,
				expectedReplacementRevision: 0,
				references: result.references,
				rules: result.rules,
				enable,
				disclosure: "insights-replacement-v1",
			};
			const currentRefs = await this.references(projectId, missionId, oldSessionId, ownId);
			if (currentRefs.overflow || !equal(currentRefs.items, refs.items)) return block("preview_changed");
			this.guard(payload);
			if (Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024) return block("preview_too_large");
			return {
				...result,
				state: "ready",
				payload,
				nextAt: new RecurrenceCalendar(enable.recurrence).next((this.deps.now ?? Date.now)()),
			};
		} catch (error) {
			if (!(error instanceof Conflict || error instanceof NotFound)) result.coverage = "unavailable";
			return block(
				error instanceof Conflict
					? error.message
					: error instanceof ServiceUnavailable && error.message === "Automations are disabled"
						? "automations_disabled"
						: "replacement_observation_unavailable",
			);
		}
	}
	private matchingRule(p: InsightsReplacementPayload, progress: InsightsReplacementProgress) {
		const rules = this.deps.schedules
			.list()
			.filter((r) => r.target.kind === "message" && r.target.sessionId === p.successorSessionId && open(r));
		const r = rules[0];
		if (
			rules.length !== 1 ||
			!r ||
			r.id !== progress.scheduleId ||
			r.revision !== 1 ||
			r.paused ||
			r.state !== "pending" ||
			r.insightsEnableOperationId === undefined ||
			!equal(r.recurrence, p.enable.recurrence) ||
			!equal(r.insightsDestination, {
				sessionId: p.successorSessionId,
				projectId: p.projectId,
				missionId: p.missionId,
			}) ||
			r.runs?.length
		)
			throw new Conflict("successor_schedule_unresolved_or_changed");
		return r;
	}
	async replace(op: DurableOperation, p: InsightsReplacementPayload): Promise<InsightsReplacementProgress> {
		const key = `${p.projectId}:${p.missionId}`;
		if (this.running.has(key)) throw new OperationRejected("Another replacement is admitted; use its receipt");
		this.running.add(key);
		let entered = false;
		try {
			if (
				!validId(p.oldSessionId) ||
				!validId(p.successorSessionId) ||
				![p.projectId, p.missionId].every((s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(s))
			)
				throw new Conflict("invalid_replacement_identity");
			let progress = (await this.deps.journal.lookup(op))?.result as InsightsReplacementProgress | undefined;
			entered = progress !== undefined;
			if (p.successorSessionId !== op.targetId || !sameHost(op.destination, p.expectedHome))
				throw new Conflict("replacement_target_changed");
			const retained = await this.store.lookup(op, p.oldSessionId);
			if (retained?.result) return retained.result; // exact transaction receipt, never GET value equality
			if (!progress) {
				const preview = await this.preview(
					p.projectId,
					p.missionId,
					p.oldSessionId,
					p.enable?.model,
					p.enable?.thinking,
					op.operationId,
				);
				if (!preview.payload || !equal(preview.payload, p))
					throw new Conflict("replacement_preview_changed_refresh");
				progress = {
					phase: "fence_pending",
					oldSessionId: p.oldSessionId,
					sessionId: op.targetId,
					scheduleId: uuid(`insights-replacement-rule:${op.targetId}`),
					chat: null,
					cancelledRules: [],
				};
				await this.deps.journal.checkpoint(op, progress);
				entered = true;
				await this.revalidate(p, op, progress);
				await this.store.fence(op, p, () => this.guard(p, progress));
			} else if (progress.phase === "fence_pending" && !retained) {
				throw new Error("Entered fence has no exact receipt; lookup only");
			}
			if (progress.phase !== "fence_pending" && !retained) throw new Error("Replacement fence receipt unavailable");
			if (progress.phase === "cancel_pending")
				throw new Error("Cancellation outcome unknown; never replay or infer from rows");
			if (progress.phase === "fence_pending") {
				progress = { ...progress, phase: "fenced" };
				await this.deps.journal.checkpoint(op, progress);
			}
			await this.revalidate(p, op, progress);
			if (progress.phase === "fenced") {
				for (const rule of p.rules.filter((r) => r.disposition === "cancel")) {
					if (progress.cancelledRules.some((r) => r.id === rule.id)) continue;
					const expected = this.rules(p.oldSessionId, p.projectId, p.missionId).find((r) => r.id === rule.id)!;
					progress = { ...progress, phase: "cancel_pending" };
					await this.deps.journal.checkpoint(op, progress);
					await this.revalidate(p, op, progress);
					const ack = await this.deps.schedules.cancelInsights(expected, p.expectedHome, () =>
						this.guard(p, progress),
					);
					progress = {
						...progress,
						phase: "fenced",
						cancelledRules: [
							...progress.cancelledRules,
							{ id: ack.id, revision: ack.revision, digest: digest(ack) },
						],
					};
					await this.deps.journal.checkpoint(op, progress);
				}
				progress = { ...progress, phase: "rules_fenced" };
				await this.deps.journal.checkpoint(op, progress);
			}
			if (progress.phase === "rules_fenced") {
				await this.revalidate(p, op, progress);
				await this.deps.sessions.insightsReplacementAbsent(op.targetId, p.projectId, p.missionId, p.expectedHome);
				progress = { ...progress, phase: "chat_pending" };
				await this.deps.journal.checkpoint(op, progress);
				await this.revalidate(p, op, progress);
				await this.deps.sessions.spawnInsightsDurable(
					{
						projectId: p.projectId,
						missionId: p.missionId,
						model: p.enable.model,
						thinking: p.enable.thinking,
						message: MESSAGE,
					},
					op.targetId,
					op.operationId,
					true,
				);
			}
			if (progress.phase === "chat_pending") {
				const chat = this.deps.sessions.insightsEnableCreated(op.targetId, op.operationId);
				if (
					chat.model !== p.enable.model ||
					chat.thinking !== p.enable.thinking ||
					!equal(chat, await this.deps.sessions.insightsEnableCommitted(op.targetId))
				)
					throw new Conflict("successor_identity_changed");
				progress = { ...progress, phase: "chat_ready", chat };
				this.guard(p, progress);
				await this.deps.journal.checkpoint(op, progress);
			}
			if (progress.phase === "chat_ready") {
				await this.revalidate(p, op, progress);
				progress = { ...progress, phase: "schedule_pending" };
				await this.deps.journal.checkpoint(op, progress);
				await this.revalidate(p, op, progress);
				await this.deps.schedules.createInsights(
					{
						trigger: "recurring",
						title: "Weekly Insights",
						recurrence: p.enable.recurrence,
						expectedHome: p.expectedHome,
						target: { kind: "message", sessionId: op.targetId, message: MESSAGE },
					},
					progress.scheduleId,
					op.operationId,
					() => this.guard(p, progress),
				);
			}
			await this.revalidate(p, op, progress);
			if (this.matchingRule(p, progress).insightsEnableOperationId !== op.operationId)
				throw new Conflict("successor_rule_owner_changed");
			const completed: InsightsReplacementProgress = { ...progress, phase: "replaced" };
			await this.store.complete(op, p.oldSessionId, completed, () => this.guard(p, progress));
			return completed;
		} catch (error) {
			if (!entered && (error instanceof Conflict || error instanceof NotFound || error instanceof TypeError))
				throw new OperationRejected(error.message);
			throw error;
		} finally {
			this.running.delete(key);
		}
	}
	async status(op: DurableOperation): Promise<InsightsReplacementStatus> {
		const receipt = await this.deps.journal.lookup(op);
		const progress = receipt?.result as InsightsReplacementProgress | undefined;
		const result: InsightsReplacementStatus = {
			receipt: receipt ?? { state: "unknown" },
			state: receipt ? "unknown" : "not_found",
			reason: null,
			supersession: null,
			sessionId: op.targetId,
			scheduleId: progress?.scheduleId ?? null,
			nextAt: null,
		};
		if (!receipt) return result;
		if (receipt.state === "rejected")
			return { ...result, state: "blocked", reason: receipt.reason ?? "replacement_refused" };
		try {
			const p = JSON.parse(op.payload) as InsightsReplacementPayload;
			const row = await this.store.lookup(op, p.oldSessionId);
			result.supersession = row?.link ?? null;
			if (!progress) return result;
			// Current observation validates partial state but never writes/promotes the entered marker.
			const observed =
				!progress.chat && this.deps.sessions.get(op.targetId)
					? { ...progress, chat: this.deps.sessions.insightsEnableCreated(op.targetId, op.operationId) }
					: progress;
			if (progress.phase === "cancel_pending")
				return { ...result, state: "unknown", reason: "old_cancellation_unknown_use_retained_receipt" };
			this.guard(p, observed);
			if (row?.result && row.link.state === "replaced") {
				const rule = this.matchingRule(p, row.result);
				if (rule.insightsEnableOperationId !== op.operationId) throw new Conflict("successor_rule_owner_changed");
				return { ...result, state: "replaced", nextAt: rule.at ?? null };
			}
			return { ...result, state: "partial", reason: "replacement_incomplete_use_retained_receipt" };
		} catch (error) {
			return {
				...result,
				state: "blocked",
				reason: error instanceof Conflict ? error.message : "replacement_unavailable",
			};
		}
	}
}
