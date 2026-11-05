import type {
	DurableOperation,
	InsightsApplyPayload,
	InsightsApplyPreflight,
	InsightsApplyProgress,
	InsightsEnableChat,
	ScheduledItem,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { InsightsEnable, type InsightsEnableDependencies } from "./insights-enable.ts";
import { resolveInsightsSettingsModel } from "./insights-settings.ts";
import { canonicalJSON, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import { RecurrenceCalendar } from "./schedule-recurrence.ts";

const equal = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const open = (rule: ScheduledItem) => rule.state === "pending" || rule.state === "dispatching";
const scheduleId = (id: string, revision: number) => {
	const h = payloadHash(`insights-apply:${id}:${revision}`);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Configuration only. Entered effects never recover by replay or by comparing resource values. */
export class InsightsApply {
	private readonly deps: InsightsEnableDependencies;
	private readonly enable: InsightsEnable;
	private readonly running = new Set<string>();
	constructor(deps: InsightsEnableDependencies, enable = new InsightsEnable(deps)) {
		this.deps = deps;
		this.enable = enable;
	}
	private rules(id: string) {
		return this.deps.schedules
			.list()
			.filter(
				(rule) =>
					rule.trigger === "recurring" &&
					rule.target.kind === "message" &&
					rule.target.sessionId === id &&
					open(rule),
			);
	}
	private reusable(payload: InsightsApplyPayload): boolean {
		return (
			!!payload.rule &&
			payload.rule.insightsSettingsRevision === payload.record.revision &&
			equal(payload.rule.recurrence, payload.record.settings.recurrence)
		);
	}
	private async pending(id: string, ownId?: string): Promise<void> {
		for (const kind of ["insights-apply", "insights-enable", "insights-settings", "chat-send", "chat-send-attached"])
			if (
				(await this.deps.journal.targetReceipts(kind, id)).some(
					(receipt) => receipt.state === "pending" && receipt.operationId !== ownId,
				)
			)
				throw new Conflict("Configuration or delivery pending; use the retained receipt");
	}
	private guard(
		payload: InsightsApplyPayload,
		chat: InsightsEnableChat,
		cancelled = false,
		checkChat = true,
		cancelledRule?: ScheduledItem,
	): void {
		const id = chat.sessionId;
		if (
			!equal(payload.expectedHome, this.deps.host) ||
			payload.context !== this.enable.context(payload.projectId, payload.missionId)
		)
			throw new Conflict("Insights home/project/backlog changed");
		this.deps.schedules.insightsEnableAvailable(payload.expectedHome);
		const admission = this.deps.sessions.insightsHostAdmission(id);
		if (admission.binding.projectId !== payload.projectId || admission.binding.missionId !== payload.missionId)
			throw new Conflict("Report binding changed");
		const candidates = this.deps.sessions.insightsEnableCandidates(payload.projectId, payload.missionId);
		if (candidates.length !== 1 || candidates[0]!.sessionId !== id) throw new Conflict("Report binding is ambiguous");
		const settings = this.deps.missions.insights.settings;
		settings.assertIdle(admission);
		if (!equal(settings.current(admission), payload.record)) throw new Conflict("Saved settings revision changed");
		if (checkChat && !equal(this.deps.sessions.insightsApplyChat(id), chat))
			throw new Conflict("Report model/Stop/idle fence changed");
		if (Array.isArray(payload.record.settings.scope.projects))
			for (const project of payload.record.settings.scope.projects) this.deps.projects.require(project);
		const rules = this.rules(id);
		if (!equal(rules, !cancelled && payload.rule ? [payload.rule] : []))
			throw new Conflict("Previewed rule changed or another rule appeared");
		if (
			cancelled &&
			payload.rule &&
			(!cancelledRule ||
				!equal(
					this.deps.schedules.list().find((rule) => rule.id === payload.rule!.id),
					cancelledRule,
				))
		)
			throw new Conflict("Acknowledged cancellation row changed or disappeared");
		admission.revalidate();
	}
	private async available(payload: InsightsApplyPayload): Promise<void> {
		const catalog = await this.deps.models.list(this.deps.projects.require(payload.projectId).path);
		const resolution = resolveInsightsSettingsModel(payload.record.settings.requestedModel, catalog.models);
		const option = catalog.models.find((model) => model.id === payload.record.model);
		if (resolution.state !== "available" || resolution.id !== payload.record.model || !option)
			throw new Conflict("Saved model is unavailable or changed");
		if (payload.chat.thinking !== undefined && !option.thinkingLevels?.includes(payload.chat.thinking))
			throw new Conflict("Saved model cannot preserve the report thinking level");
	}
	async preflight(id: string, ownId?: string): Promise<InsightsApplyPreflight> {
		const blocked: InsightsApplyPreflight = {
			state: "blocked",
			reason: null,
			payload: null,
			nextAt: null,
			cost: { pricing: "unknown", spendUsd: null },
		};
		try {
			await this.pending(id, ownId);
			const snapshot = await this.enable.settings(id);
			const admission = this.deps.sessions.insightsHostAdmission(id);
			const record = this.deps.missions.insights.settings.current(admission);
			if (!record) throw new Conflict("Save settings before Apply");
			const rules = this.rules(id);
			if (rules.length > 1) throw new Conflict("Multiple recurring rules; no rule will be changed");
			const rule = rules[0] ?? null;
			if (
				rule &&
				(rule.state !== "pending" ||
					rule.paused ||
					!rule.insightsEnableOperationId ||
					!equal(rule.insightsDestination, {
						sessionId: id,
						projectId: snapshot.projectId,
						missionId: snapshot.missionId,
					}))
			)
				throw new Conflict("Existing rule is manual, paused, dispatching or untrusted");
			const payload: InsightsApplyPayload = {
				projectId: snapshot.projectId,
				missionId: snapshot.missionId,
				expectedHome: snapshot.expectedHome,
				context: snapshot.context,
				chat: snapshot.chat,
				record,
				rule,
			};
			if (Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024)
				throw new Conflict("Apply confirmation exceeds the durable operation limit");
			// A terminal same-revision resource is not permission to recreate or replay it.
			if (
				!this.reusable(payload) &&
				this.deps.schedules
					.list()
					.some(
						(item) =>
							item.id === scheduleId(id, record.revision) ||
							(item.insightsSettingsRevision === record.revision &&
								item.insightsDestination?.sessionId === id &&
								!open(item)),
					)
			)
				throw new Conflict("This settings revision already has a stopped or unresolved rule");
			await this.available(payload);
			this.guard(payload, payload.chat);
			return {
				...blocked,
				state: "ready",
				payload,
				nextAt: this.reusable(payload)
					? (rule!.at ?? null)
					: new RecurrenceCalendar(record.settings.recurrence).next((this.deps.now ?? Date.now)()),
			};
		} catch (error) {
			return { ...blocked, reason: error instanceof Error ? error.message : "Apply unavailable" };
		}
	}
	async apply(op: DurableOperation, payload: InsightsApplyPayload): Promise<InsightsApplyProgress> {
		if (this.running.has(op.targetId)) throw new OperationRejected("Another Apply owns this report");
		this.running.add(op.targetId);
		let entered = false;
		try {
			let progress = (await this.deps.journal.lookup(op))?.result as InsightsApplyProgress | undefined;
			entered = progress !== undefined;
			if (progress?.phase === "applied") return progress; // exact persisted acknowledgement, not GET equality
			if (progress && ["model_pending", "cancel_pending", "schedule_pending"].includes(progress.phase))
				throw new Error("Entered configuration effect is status-only; never replay");
			if (!sameHost(op.destination, payload.expectedHome) || payload.chat?.sessionId !== op.targetId)
				throw new Conflict("Apply destination changed");
			await this.pending(op.targetId, op.operationId);
			if (!progress) {
				const preflight = await this.preflight(op.targetId, op.operationId);
				if (!preflight.payload || !equal(preflight.payload, payload))
					throw new Conflict("Apply preview changed; refresh before confirmation");
				progress = {
					phase: "model_ready",
					chat: payload.chat,
					scheduleId: this.reusable(payload) ? payload.rule!.id : scheduleId(op.targetId, payload.record.revision),
					settingsRevision: payload.record.revision,
				};
				if (payload.chat.model !== payload.record.model) {
					await this.available(payload);
					this.guard(payload, payload.chat);
					progress = { ...progress, phase: "model_pending" };
					await this.deps.journal.checkpoint(op, progress);
					entered = true;
					await this.pending(op.targetId, op.operationId);
					await this.available(payload);
					this.guard(payload, payload.chat);
					const chat = await this.deps.sessions.configureInsightsModel(
						op.targetId,
						payload.chat,
						payload.record.model,
						this.deps.models,
						() => this.guard(payload, payload.chat, false, false),
					);
					progress = { ...progress, phase: "model_ready", chat };
					await this.deps.journal.checkpoint(op, progress);
				}
			}
			await this.available(payload);
			this.guard(payload, progress.chat, progress.phase === "rule_cancelled", true, progress.cancelledRule);
			if (this.reusable(payload)) {
				progress = { ...progress, phase: "applied" };
				await this.deps.journal.checkpoint(op, progress);
				return progress;
			}
			if (progress.phase === "model_ready") {
				if (payload.rule) {
					progress = { ...progress, phase: "cancel_pending" };
					await this.deps.journal.checkpoint(op, progress);
					entered = true;
					await this.pending(op.targetId, op.operationId);
					await this.available(payload);
					this.guard(payload, progress.chat);
					const cancelledRule = await this.deps.schedules.cancelInsights(payload.rule, payload.expectedHome, () =>
						this.guard(payload, progress!.chat),
					);
					progress = { ...progress, cancelledRule };
				}
				progress = { ...progress, phase: "rule_cancelled" };
				await this.deps.journal.checkpoint(op, progress);
				entered = true;
			}
			await this.available(payload);
			this.guard(payload, progress.chat, true, true, progress.cancelledRule);
			progress = { ...progress, phase: "schedule_pending" };
			await this.deps.journal.checkpoint(op, progress);
			entered = true;
			await this.pending(op.targetId, op.operationId);
			await this.available(payload);
			this.guard(payload, progress.chat, true, true, progress.cancelledRule);
			const created = await this.deps.schedules.createInsights(
				{
					trigger: "recurring",
					title: payload.rule?.title ?? "Weekly Insights",
					recurrence: payload.record.settings.recurrence,
					expectedHome: payload.expectedHome,
					target: {
						kind: "message",
						sessionId: op.targetId,
						message:
							payload.rule?.target.kind === "message"
								? payload.rule.target.message
								: "Prepare the next bounded weekly Insights report.",
					},
				},
				progress.scheduleId,
				op.operationId,
				() => this.guard(payload, progress!.chat, true, true, progress!.cancelledRule),
				payload.record.revision,
			);
			if (
				created.id !== progress.scheduleId ||
				created.insightsEnableOperationId !== op.operationId ||
				created.insightsSettingsRevision !== payload.record.revision ||
				!equal(created.recurrence, payload.record.settings.recurrence)
			)
				throw new Error("Replacement acknowledgement differs; keep pending");
			// Only this live call's exact ACK authorizes advancement. Recovery never infers it from rows.
			progress = { ...progress, phase: "applied" };
			await this.deps.journal.checkpoint(op, progress);
			return progress;
		} catch (error) {
			if (!entered && (error instanceof Conflict || error instanceof NotFound || error instanceof TypeError))
				throw new OperationRejected(error.message);
			throw error;
		} finally {
			this.running.delete(op.targetId);
		}
	}
}
