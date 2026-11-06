/** Native-confirmed tracking transfer. Entered effects are lookup-only, including after restart. */
import { resolve } from "node:path";
import type {
	DurableOperation,
	InsightsLegacySelector,
	InsightsSettingsRecord,
	InsightsWorkspaceTransferPayload,
	InsightsWorkspaceTransferPreview,
	InsightsWorkspaceTransferStatus,
	ScheduledItem,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { INSIGHTS_INITIAL_DEFAULTS } from "./insights-defaults.ts";
import { legacyInsightsWriterLease } from "./insights-legacy-lease.ts";
import { initialInsightsSettings, validateInsightsSettings } from "./insights-settings.ts";
import type { InsightsTransitionStore } from "./insights-transition-store.ts";
import { deriveInsightsWorkspaceAuthority } from "./insights-workspace.ts";
import type { InsightsWorkspaceAuthority, InsightsWorkspaceStore } from "./insights-workspace-store.ts";
import {
	canonicalJSON,
	OperationConflict,
	type OperationJournal,
	OperationRejected,
	payloadHash,
} from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { ScheduleService } from "./schedules.ts";
import type { SessionManager } from "./sessions.ts";

const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const byId = (a: { operationId: string }, b: { operationId: string }) =>
	a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0;
interface Dependencies {
	home: string;
	projects: ProjectStore;
	mission(id: string): { projectId: string; status: string };
	workspace: InsightsWorkspaceStore;
	store: InsightsTransitionStore;
	journal: OperationJournal;
	sessions: SessionManager;
	schedules: ScheduleService;
}
export class InsightsTransition {
	private running = false;
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	private authority(projectId: string) {
		return deriveInsightsWorkspaceAuthority(
			this.deps.home,
			this.deps.journal.destination,
			this.deps.projects.require(projectId),
		);
	}
	private guardHome(a: InsightsWorkspaceAuthority) {
		if (!same(a, this.authority(a.owner.projectId))) throw new Conflict("legacy_transfer_home_or_lineage_changed");
	}
	private validateSelector(s: InsightsLegacySelector) {
		if (
			!s ||
			Object.keys(s).sort().join(",") !== "context,expectedHome,missionId,projectId,reportSessionId,schemaVersion" ||
			s.schemaVersion !== 2 ||
			!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(s.reportSessionId) ||
			![s.projectId, s.missionId].every((v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(v))
		)
			throw new Conflict("invalid_exact_legacy_selector");
		const a = this.authority(s.projectId),
			mission = this.deps.mission(s.missionId);
		if (
			mission.projectId !== s.projectId ||
			!same(s.expectedHome, a.owner.expectedHome) ||
			s.context !==
				payloadHash(
					canonicalJSON([resolve(this.deps.home), a.owner.expectedHome, s.projectId, a.projectPath, s.missionId]),
				)
		)
			throw new Conflict("legacy_transfer_home_or_context_changed");
		return { a, mission };
	}
	private operationAuthority(op: DurableOperation) {
		if (op.kind !== "insights-workspace-transfer") throw new Conflict("exact_transfer_operation_required");
		const p = JSON.parse(op.payload) as InsightsWorkspaceTransferPayload;
		if (p?.schemaVersion !== 2 || p.disclosure !== "insights-workspace-transfer-v2" || !p.owner?.projectId)
			throw new Conflict("invalid_transfer_payload");
		const a = this.authority(p.owner.projectId);
		if (
			!same(a.owner, p.owner) ||
			op.targetId !== a.owner.workspaceId ||
			op.destination.daemonId !== a.owner.expectedHome.daemonId ||
			op.destination.lineageId !== a.owner.expectedHome.lineageId
		)
			throw new Conflict("legacy_transfer_operation_identity_changed");
		return { a, p };
	}
	private async capture(s: InsightsLegacySelector) {
		const { a, mission } = this.validateSelector(s);
		if (this.deps.store.hasFence()) throw new Conflict("legacy_transfer_entered_use_exact_check");
		if (this.deps.workspace.current(a)) throw new Conflict("workspace_already_reserved_use_exact_transfer_check");
		if (!this.deps.sessions.get(s.reportSessionId))
			throw new Conflict("legacy_report_unavailable_use_exact_D14_recovery");
		const identity = this.deps.sessions.insightsLegacyQuiescence(s.reportSessionId, s.projectId, s.missionId);
		this.deps.sessions.assertOnlyTransferredLegacy(s);
		if (!identity.model) throw new Conflict("legacy_effective_model_unavailable");
		const captured = await this.deps.journal.legacyTransitionCapture(s.projectId, s.missionId, s.reportSessionId);
		if (
			captured.references.overflow ||
			!captured.references.qualified ||
			!captured.references.qualifications.length ||
			!captured.references.qualifications.every((q) => q.context === s.context && same(q.home, s.expectedHome))
		)
			throw new Conflict("legacy_immutable_home_proof_unavailable_use_exact_recovery");
		if (captured.references.items.some((r) => r.state !== "accepted"))
			throw new Conflict("legacy_operation_pending_use_exact_check");
		const rules = this.deps.schedules.store.legacyInsightsItems(s.reportSessionId);
		const records = captured.envelopes.map(
			(e) =>
				JSON.parse(e.original) as {
					operation: DurableOperation;
					receipt: {
						state: string;
						result?: {
							cancelledRule?: ScheduledItem;
							cancelledRules?: Array<{ id: string; revision: number; digest: string }>;
						};
					};
				},
		);
		for (const r of rules) {
			if (
				!r.insightsEnableOperationId ||
				!same(r.insightsDestination, {
					sessionId: s.reportSessionId,
					projectId: s.projectId,
					missionId: s.missionId,
				}) ||
				r.target.kind !== "message" ||
				r.target.sessionId !== s.reportSessionId ||
				!captured.references.items.some(
					(ref) => ref.operationId === r.insightsEnableOperationId && ref.state === "accepted",
				)
			)
				throw new Conflict("legacy_rule_requires_combined_exact_recovery");
			if (
				r.state !== "pending" &&
				!(
					r.state === "cancelled" &&
					records.some(
						({ receipt }) =>
							same(receipt.result?.cancelledRule, r) ||
							receipt.result?.cancelledRules?.some(
								(ack) =>
									ack.id === r.id &&
									ack.revision === r.revision &&
									ack.digest === payloadHash(canonicalJSON(r)),
							),
					)
				)
			)
				throw new Conflict("legacy_rule_cancellation_ack_unavailable_use_exact_recovery");
			if (
				r.runs?.some(
					(run) => run.insightsReview && !["cancelled", "complete", "partial"].includes(run.insightsReview.state),
				)
			)
				throw new Conflict("legacy_rule_review_uncertain_use_exact_check");
		}
		const pending = rules.filter((r) => r.state === "pending");
		if (pending.length !== 1) throw new Conflict("legacy_effective_rule_unavailable_use_exact_recovery");
		const rule = pending[0]!;
		const implicitEnvelopes = records
			.filter(
				({ operation }) =>
					operation.kind === "insights-enable" &&
					operation.operationId === rule.insightsEnableOperationId &&
					operation.targetId === s.reportSessionId,
			)
			.map(({ operation }) => JSON.parse(operation.payload))
			.filter(
				(p) =>
					p.settingsRevision === undefined &&
					same(p.scope, INSIGHTS_INITIAL_DEFAULTS.scope) &&
					same(p.bounds, INSIGHTS_INITIAL_DEFAULTS.bounds) &&
					same(p.budget, INSIGHTS_INITIAL_DEFAULTS.budget) &&
					same(p.recurrence, rule.recurrence),
			);
		const implicit: InsightsSettingsRecord | null =
			implicitEnvelopes.length === 1
				? { revision: 1, settings: initialInsightsSettings(identity.model, rule.recurrence), model: identity.model }
				: null;
		const projection = { implicit };
		const snapshot = this.deps.store.snapshot(s, projection);
		const candidates: InsightsSettingsRecord[] = [{ ...snapshot.desired, revision: snapshot.desired.revision - 1 }];
		if (implicit) candidates.push({ ...implicit, revision: 0 });
		for (const row of snapshot.parts.find((part) => part.table === "insights_operations")?.rows ?? []) {
			const value = JSON.parse(String(row.result));
			if (
				value &&
				Number.isSafeInteger(value.revision) &&
				value.revision >= 1 &&
				typeof value.model === "string" &&
				value.settings
			)
				candidates.push({
					revision: value.revision,
					model: value.model,
					settings: validateInsightsSettings(value.settings),
				});
		}
		const matching = candidates.filter(
			(r) =>
				r.revision === (rule.insightsSettingsRevision ?? 0) &&
				r.model === identity.model &&
				same(r.settings.recurrence, rule.recurrence),
		);
		if (!matching.length || !matching.every((r) => same(r, matching[0])))
			throw new Conflict("legacy_effective_settings_proof_unavailable");
		const effective = { ...matching[0]!, revision: matching[0]!.revision + 1 };
		let writer: Awaited<ReturnType<typeof legacyInsightsWriterLease>> | undefined;
		let allowOwner = false,
			expectedRules = rules;
		const guard = () => {
			writer?.revalidate();
			this.guardHome(a);
			captured.guard();
			if (
				!same(this.deps.mission(s.missionId), mission) ||
				!same(this.deps.sessions.insightsLegacyQuiescence(s.reportSessionId, s.projectId, s.missionId), identity)
			)
				throw new Conflict("legacy_transfer_authority_or_Stop_changed");
			this.deps.sessions.assertOnlyTransferredLegacy(s);
			this.deps.sessions.insightsReplacementGuard(a.owner.reportSessionId, s.projectId, s.missionId, s.expectedHome);
			if (!allowOwner && this.deps.workspace.current(a)) throw new Conflict("workspace_already_reserved");
			this.deps.schedules.store.assertSettled();
			if (!same(expectedRules, this.deps.schedules.store.legacyInsightsItems(s.reportSessionId)))
				throw new Conflict("legacy_rules_changed_during_transfer");
			if (!same(snapshot.manifest, this.deps.store.snapshot(s, projection).manifest))
				throw new Conflict("legacy_tracking_changed_during_transfer");
		};
		await this.deps.sessions.insightsReplacementAbsent(
			a.owner.reportSessionId,
			s.projectId,
			s.missionId,
			s.expectedHome,
		);
		guard();
		writer = await legacyInsightsWriterLease(
			this.deps.sessions.insightsLegacyStorageDirectory(s.reportSessionId, s.projectId, s.missionId),
			guard,
		);
		try {
			const payload: InsightsWorkspaceTransferPayload = {
				schemaVersion: 2,
				admissionEpoch: this.deps.sessions.insightsAdmissionEpoch,
				owner: a.owner,
				legacy: s,
				identity,
				executorProof: writer.proof,
				manifest: snapshot.manifest,
				envelopesHash: captured.hash,
				references: [...captured.references.items].sort(byId),
				rules,
				desired: snapshot.desired,
				effective,
				settingsMapping: "legacy_revision_plus_one",
				settingsOrigin: snapshot.parts.find((part) => part.table === "insights_settings")!.rows.length
					? "stored"
					: "initial_enable",
				model: effective.model,
				...(identity.thinking === null ? {} : { thinking: identity.thinking }),
				disclosure: "insights-workspace-transfer-v2",
			};
			if (Buffer.byteLength(JSON.stringify(payload)) > 48000)
				throw new Conflict("legacy_native_confirmation_capacity");
			return {
				close: writer.close,
				a,
				payload,
				snapshot,
				captured,
				guard,
				allowOwner: () => {
					allowOwner = true;
				},
				acknowledge: (ack: ScheduledItem) => {
					expectedRules = expectedRules.map((r) => (r.id === ack.id ? ack : r));
				},
			};
		} catch (error) {
			writer.close();
			throw error;
		}
	}
	async preview(s: InsightsLegacySelector): Promise<InsightsWorkspaceTransferPreview> {
		try {
			const c = await this.capture(s);
			try {
				c.guard();
				return { schemaVersion: 2, state: "ready", reason: null, payload: c.payload };
			} finally {
				c.close();
			}
		} catch (error) {
			if (error instanceof Conflict || error instanceof NotFound || error instanceof OperationConflict)
				return { schemaVersion: 2, state: "blocked", reason: error.message, payload: null };
			throw error;
		}
	}
	async check(op: DurableOperation): Promise<InsightsWorkspaceTransferStatus> {
		const { a } = this.operationAuthority(op);
		const receipt = (await this.deps.journal.lookup(op)) ?? { state: "unknown" as const };
		const transfer = await this.deps.store.lookup(op, () => this.guardHome(a));
		return { receipt, transfer, current: this.deps.workspace.current(a) };
	}
	async admit(op: DurableOperation, firstEntry = false) {
		try {
			return await this.execute(op, firstEntry);
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
	private async execute(op: DurableOperation, firstEntry: boolean) {
		const { a, p } = this.operationAuthority(op);
		const prior = await this.deps.store.lookup(op, () => this.guardHome(a));
		if (prior.state === "committed") return prior.result;
		if (prior.state === "entered")
			throw new Error("Transfer entered; exact Check only, never repeat cancellation or copying");
		if (!firstEntry)
			throw new OperationRejected(
				"Transfer confirmation was interrupted before entry; authority cannot be reconstructed",
			);
		if (this.running) throw new OperationRejected("Another native transfer confirmation is in progress");
		this.running = true;
		let captured: Awaited<ReturnType<InsightsTransition["capture"]>> | undefined;
		let entered = false;
		try {
			const c = await this.capture(p.legacy);
			captured = c;
			if (!same(c.payload, p)) throw new Conflict("legacy_transfer_preview_changed");
			await this.deps.store.enter(op, { legacy: p.legacy, workspace: a }, c.snapshot, c.guard);
			entered = true;
			c.allowOwner();
			const acknowledged: ScheduledItem[] = [];
			for (const rule of p.rules.filter((r) => r.state === "pending")) {
				await this.deps.journal.checkpoint(op, {
					phase: "cancel_pending",
					ruleId: rule.id,
					cancelledRules: acknowledged,
				});
				c.guard();
				const ack = await this.deps.schedules.cancelLegacyForTransfer(rule, p.legacy, c.guard);
				c.acknowledge(ack);
				acknowledged.push(ack);
				c.guard();
				await this.deps.journal.checkpoint(op, { phase: "rules_fenced", cancelledRules: acknowledged });
				c.guard();
			}
			return await this.deps.store.commit(
				op,
				{ legacy: p.legacy, workspace: a },
				c.snapshot,
				c.captured.envelopes,
				c.guard,
				acknowledged,
			);
		} catch (error) {
			// enter() may have committed before its durability acknowledgement failed.
			const marker = await this.deps.store.lookup(op, () => this.guardHome(a));
			if (!entered && marker.state === "absent" && (error instanceof Conflict || error instanceof NotFound))
				throw new OperationRejected(error.message);
			throw error;
		} finally {
			try {
				captured?.close();
			} finally {
				this.running = false;
			}
		}
	}
	/** A committed tracking receipt selects old effective settings, but grants nothing. */
	async admission(a: InsightsWorkspaceAuthority) {
		const record = await this.deps.store.committed(a);
		if (!record) return null;
		if (
			record.payload.settingsMapping !== "legacy_revision_plus_one" ||
			record.payload.executorProof?.kind !== "closed_writer_lease" ||
			!/^[0-9a-f]{64}$/u.test(record.payload.executorProof.digest)
		)
			throw new Conflict("legacy_settings_projection_unqualified");
		const journal = await this.deps.journal.transferredLegacyGuard(record.envelopes, [
			record.payload.legacy.reportSessionId,
		]);
		const acknowledged = record.payload.rules.map(
			(r) => record.result.cancelledRules.find((ack) => ack.id === r.id) ?? r,
		);
		const controlNow = () =>
			this.deps.sessions.get(record.payload.legacy.reportSessionId)
				? this.deps.sessions.insightsLegacyQuiescence(
						record.payload.legacy.reportSessionId,
						record.payload.legacy.projectId,
						record.payload.legacy.missionId,
					)
				: null;
		const control = controlNow();
		const guard = () => {
			this.guardHome(a);
			journal();
			this.deps.store.assertTransferred(a, record.operationId);
			this.deps.sessions.assertOnlyTransferredLegacy(record.payload.legacy);
			if (!same(control, controlNow())) throw new Conflict("legacy_Stop_or_control_changed_after_transfer");
			this.deps.schedules.assertTransferredLegacy(
				a.owner.expectedHome,
				acknowledged,
				record.payload.legacy.reportSessionId,
			);
		};
		guard();
		return {
			operationId: record.operationId,
			control,
			effective: record.payload.effective,
			...(record.payload.thinking === undefined ? {} : { thinking: record.payload.thinking }),
			guard,
		};
	}
}
