import { resolve } from "node:path";
import type {
	DurableOperation,
	InsightsEnableChat,
	InsightsEnablePayload,
	InsightsEnablePreflight,
	InsightsEnableProgress,
	InsightsEnableStatus,
	OperationHost,
	ScheduledItem,
} from "@pilot/protocol";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import { INSIGHTS_INITIAL_DEFAULTS, resolveInsightsInitialModel } from "./insights-defaults.ts";
import type { MissionStore } from "./missions.ts";
import type { ModelCatalog } from "./models.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import { RecurrenceCalendar } from "./schedule-recurrence.ts";
import type { ScheduleService } from "./schedules.ts";
import type { SessionManager } from "./sessions.ts";

const equal = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const uuid = (value: string) => {
	const h = payloadHash(value);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const MESSAGE = "Prepare the next bounded weekly Insights report.";
const OPEN = new Set(["pending", "dispatching"]);

interface Dependencies {
	home: string;
	host: OperationHost;
	projects: Pick<ProjectStore, "require">;
	missions: Pick<MissionStore, "require">;
	models: Pick<ModelCatalog, "list">;
	sessions: Pick<
		SessionManager,
		| "insightsEnableCandidates"
		| "get"
		| "insightsEnableChat"
		| "insightsEnableCreated"
		| "insightsEnableCommitted"
		| "insightsHostAdmission"
		| "spawnInsightsDurable"
	>;
	schedules: Pick<ScheduleService, "list" | "createInsights" | "insightsEnableAvailable">;
	journal: OperationJournal;
	now?: () => number;
}

/** Uses the existing operation journal for step markers, never a second permission/configuration store. */
export class InsightsEnable {
	private readonly running = new Map<string, string>();
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}

	private context(projectId: string, missionId: string): string {
		const project = this.deps.projects.require(projectId);
		const mission = this.deps.missions.require(missionId);
		if (mission.projectId !== projectId || mission.status !== "active")
			throw new Conflict("Backlog is not active in this project");
		return payloadHash(canonicalJSON([resolve(this.deps.home), this.deps.host, projectId, project.path, missionId]));
	}
	private candidates(projectId: string, missionId: string) {
		return this.deps.sessions.insightsEnableCandidates(projectId, missionId);
	}
	private rules(id: string) {
		return this.deps.schedules
			.list()
			.filter(
				(s) =>
					s.trigger === "recurring" &&
					s.target.kind === "message" &&
					s.target.sessionId === id &&
					OPEN.has(s.state),
			);
	}

	async preflight(
		projectId: string,
		missionId: string,
		explicitModel?: string,
		thinking?: string,
		ownOperationId?: string,
		reportSessionId?: string,
	): Promise<InsightsEnablePreflight> {
		const context = this.context(projectId, missionId);
		const candidates = this.candidates(projectId, missionId);
		let targetId =
			reportSessionId ?? (candidates.length === 1 ? candidates[0]!.sessionId : uuid(`insights-chat:${context}`));
		const result: InsightsEnablePreflight = {
			projectId,
			missionId,
			cost: { pricing: "unknown", spendUsd: null },
			targetId,
			state: "blocked",
			reason: null,
			payload: null,
			nextAt: null,
			model: { state: "unavailable", reason: "catalog_unavailable" },
		};
		const block = (reason: string) => ({ ...result, reason });
		try {
			// Intent may outlive a readable session. Never interpret a missing index row as deletion
			// or use changed home/path/lineage to derive a substitute report target.
			const references = new Set(
				await this.deps.journal.retainedTargets(
					["insights-create", "insights-enable"],
					{ projectId, missionId },
					ownOperationId,
				),
			);
			if (reportSessionId !== undefined) references.add(reportSessionId);
			for (const rule of this.deps.schedules.list()) {
				if (rule.insightsDestination?.projectId === projectId && rule.insightsDestination.missionId === missionId)
					references.add(rule.insightsDestination.sessionId);
			}
			if (reportSessionId === undefined && !candidates.length && references.size === 1)
				result.targetId = targetId = [...references][0]!;
			const receipts = await this.deps.journal.targetReceipts("insights-enable", targetId);
			if (receipts.some((r) => r.operationId !== ownOperationId && r.state === "pending"))
				return block("enable_pending_use_status");
			if ([...references].some((id) => !candidates.some((candidate) => candidate.sessionId === id)))
				return block("report_identity_unavailable");
			this.deps.schedules.insightsEnableAvailable(this.deps.host);
			if (candidates.length > 1) return block("multiple_report_chats");
			if (candidates[0] && !candidates[0].available) return block("report_chat_unavailable");
			if (candidates[0] && (candidates[0].projectId !== projectId || candidates[0].missionId !== missionId))
				return block("report_binding_mismatch");
			const chat = candidates[0] ? this.deps.sessions.insightsEnableChat(targetId) : null;
			const rules = this.rules(targetId);
			if (rules.length > 1) return block("multiple_recurring_rules");
			const rule = rules[0];
			if (rule && (rule.state !== "pending" || rule.paused || !rule.recurrence))
				return block("existing_rule_not_ready");
			if (rule && !equal(rule.insightsDestination, { sessionId: targetId, projectId, missionId }))
				return block("existing_rule_identity_unavailable");
			const catalog = await this.deps.models.list(this.deps.projects.require(projectId).path);
			result.model = resolveInsightsInitialModel(catalog.models);
			const model =
				chat?.model ?? explicitModel ?? (result.model.state === "available" ? result.model.id : undefined);
			if (!model) return block(`model_${result.model.state}`);
			if (
				chat &&
				((explicitModel !== undefined && explicitModel !== chat.model) ||
					(thinking !== undefined && thinking !== chat.thinking))
			)
				return block("existing_model_choice_differs");
			const option = catalog.models.find((m) => m.id === model);
			if (!option) {
				result.model = { state: "unavailable", reason: "not_found" };
				return block("model_unavailable");
			}
			const effectiveThinking = chat?.thinking ?? thinking;
			if (effectiveThinking !== undefined && !option.thinkingLevels?.includes(effectiveThinking))
				return block("thinking_unavailable");
			result.model = { state: "available", id: model };
			if (
				context !== this.context(projectId, missionId) ||
				!equal(candidates, this.candidates(projectId, missionId)) ||
				!equal(rules, this.rules(targetId)) ||
				(chat && !equal(chat, this.deps.sessions.insightsEnableChat(targetId)))
			)
				return block("preflight_changed");
			this.deps.schedules.insightsEnableAvailable(this.deps.host);
			const payload: InsightsEnablePayload = {
				projectId,
				missionId,
				expectedHome: { ...this.deps.host },
				context,
				model,
				...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
				recurrence: structuredClone(rule?.recurrence ?? INSIGHTS_INITIAL_DEFAULTS.recurrence),
				scope: { ...INSIGHTS_INITIAL_DEFAULTS.scope },
				bounds: { ...INSIGHTS_INITIAL_DEFAULTS.bounds },
				budget: { ...INSIGHTS_INITIAL_DEFAULTS.budget },
				disclosure: "insights-weekly-v1",
				chat,
				schedule: rule ? { id: rule.id, revision: rule.revision } : null,
			};
			return {
				...result,
				state: rule ? "existing" : "ready",
				payload,
				nextAt: rule?.at ?? new RecurrenceCalendar(payload.recurrence).next((this.deps.now ?? Date.now)()),
			};
		} catch (error) {
			return block(
				error instanceof Conflict || error instanceof NotFound
					? "binding_unavailable"
					: error instanceof ServiceUnavailable
						? "scheduling_unavailable"
						: "setup_unavailable",
			);
		}
	}

	private current(payload: InsightsEnablePayload, chat: InsightsEnableChat): void {
		if (
			!equal(payload.expectedHome, this.deps.host) ||
			payload.context !== this.context(payload.projectId, payload.missionId)
		)
			throw new Conflict("Insights home/project/backlog changed");
		this.deps.schedules.insightsEnableAvailable(payload.expectedHome);
		const candidates = this.candidates(payload.projectId, payload.missionId);
		if (candidates.length !== 1 || candidates[0]!.sessionId !== chat.sessionId)
			throw new Conflict("Report binding is no longer unambiguous");
		const admission = this.deps.sessions.insightsHostAdmission(chat.sessionId);
		if (
			admission.binding.projectId !== payload.projectId ||
			admission.binding.missionId !== payload.missionId ||
			!equal(chat, this.deps.sessions.insightsEnableChat(chat.sessionId))
		)
			throw new Conflict("Insights admission/settings/Stop fence changed");
		admission.revalidate();
	}
	private matchingRule(rule: ScheduledItem | undefined, payload: InsightsEnablePayload, sessionId: string): boolean {
		return (
			!!rule &&
			rule.state === "pending" &&
			!rule.paused &&
			rule.trigger === "recurring" &&
			equal(rule.recurrence, payload.recurrence) &&
			rule.target.kind === "message" &&
			rule.target.sessionId === sessionId &&
			equal(rule.insightsDestination, { sessionId, projectId: payload.projectId, missionId: payload.missionId })
		);
	}

	async enable(op: DurableOperation, payload: InsightsEnablePayload): Promise<InsightsEnableProgress> {
		if (this.running.has(op.targetId))
			throw new OperationRejected("Another enable operation owns this report target");
		this.running.set(op.targetId, op.operationId);
		let entered = false;
		try {
			let progress = (await this.deps.journal.lookup(op))?.result as InsightsEnableProgress | undefined;
			entered = progress !== undefined;
			if (!progress) {
				if (
					typeof payload.projectId !== "string" ||
					typeof payload.missionId !== "string" ||
					typeof payload.model !== "string" ||
					!payload.model.trim() ||
					payload.model.length > 512
				)
					throw new OperationRejected("Invalid weekly Insights identity/model");
				const preflight = await this.preflight(
					payload.projectId,
					payload.missionId,
					payload.model,
					payload.thinking,
					op.operationId,
					payload.chat?.sessionId,
				);
				if (
					!preflight.payload ||
					preflight.targetId !== op.targetId ||
					!equal(preflight.payload, payload) ||
					!equal(op.destination, payload.expectedHome)
				)
					throw new OperationRejected("Insights confirmation changed; refresh preflight");
				progress = {
					phase: "chat_pending",
					sessionId: op.targetId,
					scheduleId: payload.schedule?.id ?? uuid(`insights-rule:${op.targetId}`),
					chat: payload.chat,
				};
				await this.deps.journal.checkpoint(op, progress);
				entered = true;
				if (!payload.chat) {
					// Recheck the frozen local identities after marker durability, before minting authority.
					if (payload.context !== this.context(payload.projectId, payload.missionId))
						throw new Conflict("Insights context changed");
					if (this.candidates(payload.projectId, payload.missionId).length)
						throw new Conflict("An existing report binding appeared; do not create a substitute");
					this.deps.schedules.insightsEnableAvailable(payload.expectedHome);
					await this.deps.sessions.spawnInsightsDurable(
						{
							projectId: payload.projectId,
							missionId: payload.missionId,
							model: payload.model,
							thinking: payload.thinking,
							message: MESSAGE,
						},
						op.targetId,
						op.operationId,
						true,
					);
				}
			}
			if (progress.phase === "chat_pending") {
				// Recovery is lookup only for an entered step, even when no resource can be found.
				const chat = payload.chat ?? this.deps.sessions.insightsEnableCreated(op.targetId, op.operationId);
				if (chat.model !== payload.model || chat.thinking !== payload.thinking)
					throw new Conflict("Created report model differs");
				this.current(payload, chat);
				if (!equal(chat, await this.deps.sessions.insightsEnableCommitted(op.targetId)))
					throw new Conflict("Report identity changed");
				progress = { ...progress, phase: "chat_ready", chat };
				await this.deps.journal.checkpoint(op, progress);
			}
			if (!progress.chat) throw new Error("Missing admitted report identity");
			this.current(payload, progress.chat);
			const admission = this.deps.sessions.insightsHostAdmission(op.targetId);
			const guard = () => {
				admission.revalidate();
				this.current(payload, progress!.chat!);
			};
			if (progress.phase === "chat_ready") {
				progress = { ...progress, phase: "schedule_pending" };
				await this.deps.journal.checkpoint(op, progress);
				guard();
				if (!payload.schedule) {
					if (this.rules(op.targetId).length) throw new Conflict("A recurring rule appeared; do not add another");
					await this.deps.schedules.createInsights(
						{
							trigger: "recurring",
							title: "Weekly Insights",
							recurrence: payload.recurrence,
							expectedHome: payload.expectedHome,
							target: { kind: "message", sessionId: op.targetId, message: MESSAGE },
						},
						progress.scheduleId,
						op.operationId,
						guard,
					);
				}
			}
			guard();
			const rule = this.deps.schedules.list().find((s) => s.id === progress!.scheduleId);
			if (
				!this.matchingRule(rule, payload, op.targetId) ||
				(payload.schedule
					? rule!.revision !== payload.schedule.revision
					: rule!.insightsEnableOperationId !== op.operationId) ||
				this.rules(op.targetId).length !== 1
			)
				throw new Error("Schedule outcome unresolved or changed; never replay create");
			return { ...progress, phase: "enabled" };
		} catch (error) {
			// Before effects, stable refusal. After entry, preserve pending progress and resources.
			if (error instanceof OperationRejected) throw error;
			if (!entered && (error instanceof Conflict || error instanceof NotFound || error instanceof TypeError))
				throw new OperationRejected("Invalid weekly Insights confirmation");
			throw new Error("Insights enable incomplete; use passive status, never replay entered steps", {
				cause: error,
			});
		} finally {
			this.running.delete(op.targetId);
		}
	}

	async status(op: DurableOperation): Promise<InsightsEnableStatus> {
		const receipt = await this.deps.journal.lookup(op);
		const progress = receipt?.result as InsightsEnableProgress | undefined;
		const result: InsightsEnableStatus = {
			receipt: receipt ?? { state: "unknown" },
			state: receipt ? "unknown" : "not_found",
			sessionId: op.targetId,
			scheduleId: progress?.scheduleId ?? null,
			nextAt: null,
			reason: null,
		};
		if (!receipt || !progress)
			return {
				...result,
				...(receipt?.state === "rejected" ? { state: "blocked", reason: receipt.reason ?? "refused" } : {}),
			};
		try {
			const payload = JSON.parse(op.payload) as InsightsEnablePayload;
			const chat =
				progress.chat ?? payload.chat ?? this.deps.sessions.insightsEnableCreated(op.targetId, op.operationId);
			this.current(payload, chat);
			if (!equal(chat, await this.deps.sessions.insightsEnableCommitted(op.targetId)))
				throw new Conflict("Report identity changed");
			this.current(payload, chat);
			const rule = this.deps.schedules.list().find((s) => s.id === progress.scheduleId);
			if (
				this.matchingRule(rule, payload, op.targetId) &&
				this.rules(op.targetId).length === 1 &&
				(payload.schedule
					? rule!.revision >= payload.schedule.revision
					: rule!.insightsEnableOperationId === op.operationId)
			)
				return { ...result, state: "enabled", nextAt: rule!.at ?? null };
			const conflict = rule || this.rules(op.targetId).length;
			return {
				...result,
				state: conflict ? "blocked" : "partial",
				reason: conflict ? "schedule_changed" : "schedule_unresolved",
			};
		} catch {
			return {
				...result,
				state: this.deps.sessions.get(op.targetId) ? "blocked" : "unknown",
				reason: "report_identity_unavailable",
			};
		}
	}
}
