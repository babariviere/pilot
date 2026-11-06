/** Versioned execution authority. No mission keys, v1 grants or inferred receipts. */
import type {
	DurableOperation,
	InsightsOwnerBinding,
	InsightsOwnerExecutionStatus,
	InsightsSettingsRecord,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { InsightsOwnerAdmission } from "./insights-admission.ts";
import { parseInsightsBacklog } from "./insights-backlog.ts";
import { InsightsReviews } from "./insights-review.ts";
import { validateInsightsSettings } from "./insights-settings.ts";
import type {
	InsightsWorkspaceAdmission,
	InsightsWorkspaceAuthority,
	InsightsWorkspaceDb,
	InsightsWorkspaceStore,
} from "./insights-workspace-store.ts";
import { canonicalJSON } from "./operation-journal.ts";

export const INSIGHTS_OWNER_SCHEMA = `
CREATE TABLE IF NOT EXISTS insights_owner_execution (
 workspace_id TEXT PRIMARY KEY REFERENCES insights_workspace_owners(workspace_id),
 authority TEXT NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL,
 settings_revision INTEGER NOT NULL, settings TEXT NOT NULL, model TEXT NOT NULL,
 thinking TEXT, effective_thinking TEXT
);
CREATE TABLE IF NOT EXISTS insights_owner_effects (
 operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 envelope TEXT NOT NULL, state TEXT NOT NULL, result TEXT
);
CREATE TABLE IF NOT EXISTS insights_owner_grants (
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 grant_id TEXT PRIMARY KEY, binding TEXT NOT NULL, operation_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insights_owner_runs (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 session_id TEXT NOT NULL, run_id TEXT NOT NULL, binding TEXT NOT NULL, request TEXT NOT NULL,
 state TEXT NOT NULL, detail TEXT NOT NULL, packet TEXT, report_key TEXT,
 UNIQUE(session_id,run_id)
);
CREATE INDEX IF NOT EXISTS insights_owner_runs_scope ON insights_owner_runs(session_id,seq);
CREATE TABLE IF NOT EXISTS insights_owner_inventory (scope TEXT PRIMARY KEY, after_id TEXT);
CREATE TABLE IF NOT EXISTS insights_owner_sources (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, session_id TEXT NOT NULL,
 project_id TEXT, position TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0,
 UNIQUE(scope,session_id)
);
CREATE INDEX IF NOT EXISTS insights_owner_sources_queue ON insights_owner_sources(scope,reviewed,seq);
CREATE TABLE IF NOT EXISTS insights_owner_patterns (
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 pattern TEXT NOT NULL, finding_key TEXT NOT NULL, PRIMARY KEY(workspace_id,pattern)
);
CREATE TABLE IF NOT EXISTS insights_owner_review_reads (
 run_seq INTEGER NOT NULL REFERENCES insights_owner_runs(seq), cursor INTEGER NOT NULL,
 PRIMARY KEY(run_seq,cursor)
);
CREATE TABLE IF NOT EXISTS insights_owner_reports (
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(workspace_id,key)
);
`;

const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
export interface InsightsOwnerExecution {
	authority: InsightsWorkspaceAuthority;
	binding: InsightsOwnerBinding;
	state: "provisioning" | "configuring" | "active" | "paused" | "revoked";
	settings: InsightsSettingsRecord;
	thinking?: string;
	effectiveThinking?: string;
}

export function projectOwnerExecution(current: InsightsOwnerExecution): InsightsOwnerExecutionStatus {
	return {
		schemaVersion: 2,
		owner: current.authority.owner,
		state:
			current.state === "active"
				? "enabled"
				: current.state === "provisioning" || current.state === "configuring"
					? "pending"
					: current.state,
		grantRevision: current.binding.revision,
		settingsRevision: current.settings.revision,
		model: current.settings.model,
		thinkingSource: current.thinking === undefined ? "default" : "explicit",
		...((current.effectiveThinking ?? current.thinking) === undefined
			? {}
			: { thinking: current.effectiveThinking ?? current.thinking }),
	};
}

export class InsightsOwnerStore {
	readonly reviews: InsightsReviews<InsightsOwnerAdmission>;
	private readonly db: InsightsWorkspaceDb;
	constructor(db: InsightsWorkspaceDb) {
		this.db = db;
		this.reviews = new InsightsReviews(
			{
				...db,
				validateMission: () => {
					throw new Conflict("Mission authority is not owner authority");
				},
			},
			{
				owner: "workspace",
				settings: {
					current: (a) => this.settings(a),
					assertDispatch: (a, revision) => {
						const record = this.settings(a);
						if (record.revision !== revision) throw new Conflict("Owner settings require explicit activation");
						return record;
					},
				},
			},
		);
	}
	current(a: InsightsWorkspaceAuthority): InsightsOwnerExecution | null {
		const row = this.db.one("SELECT * FROM insights_owner_execution WHERE workspace_id=?", a.owner.workspaceId);
		if (!row) return null;
		if (!same(JSON.parse(String(row.authority)), a)) throw new Conflict("owner_execution_identity_changed");
		return {
			authority: a,
			binding: JSON.parse(String(row.binding)),
			state: row.state as InsightsOwnerExecution["state"],
			settings: {
				revision: Number(row.settings_revision),
				settings: validateInsightsSettings(JSON.parse(String(row.settings))),
				model: String(row.model),
			},
			...(row.thinking === null ? {} : { thinking: String(row.thinking) }),
			...(row.effective_thinking == null ? {} : { effectiveThinking: String(row.effective_thinking) }),
		};
	}
	async read(lease: InsightsWorkspaceAdmission): Promise<InsightsOwnerExecution | null> {
		lease.revalidate();
		const current = this.current(lease.authority);
		await this.db.durable();
		lease.revalidate();
		if (!same(current, this.current(lease.authority))) throw new Conflict("owner_execution_changed_during_read");
		return current;
	}
	/** Native ready metadata only. It records Default's actual level, never changes a preference/grant. */
	async resolveDefaultThinking(
		a: InsightsWorkspaceAuthority,
		binding: InsightsOwnerBinding,
		model: string,
		thinking: string,
		guard: () => void,
	): Promise<void> {
		this.db.transaction(() => {
			guard();
			const current = this.current(a);
			if (
				!current ||
				!["active", "configuring"].includes(current.state) ||
				!same(current.binding, binding) ||
				current.settings.model !== model ||
				!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking)
			)
				throw new Conflict("owner_ready_thinking_unqualified");
			const expected = current.effectiveThinking ?? current.thinking;
			if (expected !== undefined && expected !== thinking) throw new Conflict("owner_ready_thinking_changed");
			if (current.thinking === undefined && current.effectiveThinking === undefined)
				this.db.run(
					"UPDATE insights_owner_execution SET effective_thinking=? WHERE workspace_id=?",
					thinking,
					a.owner.workspaceId,
				);
		});
		await this.db.durable();
		guard();
	}
	private settings(a: InsightsOwnerAdmission): InsightsSettingsRecord {
		a.revalidate();
		const row = this.db.one(
			"SELECT * FROM insights_owner_execution WHERE workspace_id=?",
			a.binding.owner.workspaceId,
		);
		if (row?.state !== "active" || !same(JSON.parse(String(row.binding)), a.binding))
			throw new Conflict("owner_execution_not_active");
		return {
			revision: Number(row.settings_revision),
			settings: validateInsightsSettings(JSON.parse(String(row.settings))),
			model: String(row.model),
		};
	}
	/** Uses the same closed request parser. No mission/task API or arbitrary source read. */
	async backlog(
		store: InsightsWorkspaceStore,
		lease: InsightsWorkspaceAdmission,
		a: InsightsOwnerAdmission,
		input: unknown,
	): Promise<unknown> {
		a.revalidate();
		const request = parseInsightsBacklog(input);
		const raw = JSON.stringify(request);
		const id = lease.authority.owner.workspaceId;
		if (Buffer.byteLength(raw) > 64000) throw new Conflict("Owner request exceeds 64 KB");
		let result: unknown;
		if (["propose", "amend", "save_report", "save_checkpoint"].includes(request.action)) {
			result = await store.write(lease, raw, () => {
				a.revalidate();
				if ("draft" in request) this.reviews.pattern(a, request.key, request.patternKey);
				if (request.action === "save_report") {
					const record = this.reviews.finish(a, request.key, request.record);
					this.db.run(
						"INSERT INTO insights_owner_reports VALUES (?,?,?) ON CONFLICT(workspace_id,key) DO UPDATE SET record=excluded.record",
						id,
						request.key,
						JSON.stringify(record),
					);
				}
			});
			if (request.action === "save_report") this.reviews.changed();
		} else if (request.action === "list") {
			result = await store.page(lease, request.kind, request.cursor ?? 0);
		} else if (request.action === "get") {
			const derivedNow = () =>
				request.kind === "report"
					? this.db.one(
							"SELECT record FROM insights_owner_reports WHERE workspace_id=? AND key=?",
							id,
							request.key,
						)
					: null;
			const derived = derivedNow();
			const item = await store.item(lease, request.kind, request.key);
			if (!same(derived, derivedNow())) throw new Conflict("owner_report_changed_during_read");
			const parsed = parseInsightsBacklog(JSON.parse(item.request));
			result = {
				...item,
				payload: derived
					? JSON.parse(String(derived.record))
					: "draft" in parsed
						? parsed.draft
						: "record" in parsed
							? parsed.record
							: null,
			};
		} else if (request.action === "history") {
			result = await store.history(lease, request.kind, request.key, request.cursor ?? 0);
		} else {
			result = this.db.transaction(() => {
				a.revalidate();
				if (request.action === "review_context") return this.reviews.context(a, request.cursor ?? 0);
				if (request.action === "receipt") {
					const row = this.db.one(
						"SELECT result FROM insights_workspace_receipts WHERE workspace_id=? AND operation_id=?",
						id,
						request.operationId,
					);
					if (row) return { state: "committed", receipt: JSON.parse(String(row.result)) };
					const legacy = this.db.one(
						"SELECT result FROM insights_workspace_legacy_operations WHERE workspace_id=? AND operation_id=?",
						id,
						request.operationId,
					);
					return legacy
						? {
								state: "legacy_committed",
								receipt: JSON.parse(String(legacy.result)),
								authority: "historical_receipt_only",
							}
						: { state: "unknown" };
				}
				if (request.action !== "evidence") throw new Conflict("Unsupported owner request");
				const rows = this.db.all(
					"SELECT rowid AS cursor,payload FROM insights_workspace_evidence WHERE workspace_id=? AND finding_key=? AND rowid>? ORDER BY rowid LIMIT ?",
					id,
					request.key,
					request.cursor ?? 0,
					(request.limit ?? 20) + 1,
				);
				const items = rows
					.slice(0, request.limit ?? 20)
					.map((r) => ({ cursor: Number(r.cursor), payload: JSON.parse(String(r.payload)) }));
				return { items, nextCursor: rows.length > items.length ? items.at(-1)!.cursor : null };
			});
		}
		await this.db.durable();
		a.revalidate();
		if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new Conflict("Owner response exceeds 64 KiB");
		return result;
	}
	/** The marker is durable BEFORE an external call. A retained entered marker is lookup-only. */
	async lookup(
		lease: InsightsWorkspaceAdmission,
		op: DurableOperation,
	): Promise<{ state: "absent" | "entered" | "committed"; result?: unknown }> {
		lease.revalidate();
		const query = () => this.db.one("SELECT * FROM insights_owner_effects WHERE operation_id=?", op.operationId);
		const row = query();
		if (row && (row.workspace_id !== lease.authority.owner.workspaceId || row.envelope !== JSON.stringify(op)))
			throw new Conflict("owner_operation_bytes_changed");
		await this.db.durable();
		lease.revalidate();
		if (!same(row ?? null, query() ?? null)) throw new Conflict("owner_effect_changed_during_read");
		return !row
			? { state: "absent" }
			: row.state === "committed"
				? { state: "committed", result: JSON.parse(String(row.result)) }
				: { state: "entered" };
	}
	/** Refusal fence only, never a receipt inferred from resource equality. */
	recorded(op: DurableOperation): boolean {
		return !!this.db.one("SELECT 1 FROM insights_owner_effects WHERE operation_id=?", op.operationId);
	}
	async enter(
		lease: InsightsWorkspaceAdmission,
		op: DurableOperation,
	): Promise<{ entered: boolean; result?: unknown }> {
		const result = this.db.transaction(() => {
			lease.revalidate();
			const id = lease.authority.owner.workspaceId;
			if (op.targetId !== id) throw new Conflict("owner_operation_target_changed");
			const row = this.db.one("SELECT * FROM insights_owner_effects WHERE operation_id=?", op.operationId);
			if (row) {
				if (row.workspace_id !== id || row.envelope !== JSON.stringify(op))
					throw new Conflict("owner_operation_bytes_changed");
				return row.state === "committed"
					? { entered: false, result: JSON.parse(String(row.result)) as unknown }
					: { entered: false };
			}
			if (this.db.one("SELECT 1 FROM insights_owner_effects WHERE workspace_id=? AND state='entered' LIMIT 1", id))
				throw new Conflict("owner_entered_effect_requires_status_only");
			if (Number(this.db.one("SELECT COUNT(*) n FROM insights_owner_effects WHERE workspace_id=?", id)!.n) >= 4096)
				throw new Conflict("owner_effect_capacity");
			this.db.run(
				"INSERT INTO insights_owner_effects VALUES (?,?,?,'entered',NULL)",
				op.operationId,
				id,
				JSON.stringify(op),
			);
			return { entered: true };
		});
		await this.db.durable();
		lease.revalidate();
		return result;
	}
	async provision(
		lease: InsightsWorkspaceAdmission,
		binding: InsightsOwnerBinding,
		settings: InsightsSettingsRecord,
		thinking?: string,
	): Promise<void> {
		this.db.transaction(() => {
			lease.revalidate();
			const a = lease.authority;
			if (
				!same(binding.owner, a.owner) ||
				binding.reportSessionId !== a.owner.reportSessionId ||
				binding.projectId !== a.owner.projectId ||
				!same(binding.host, a.owner.expectedHome) ||
				binding.schemaVersion !== 2 ||
				binding.revision !== 1 ||
				!binding.enabled
			)
				throw new Conflict("owner_binding_changed");
			if (this.current(a)) throw new Conflict("owner_execution_already_exists");
			const marker = this.db.one(
				"SELECT * FROM insights_owner_effects WHERE workspace_id=? AND state='entered'",
				a.owner.workspaceId,
			);
			if (!marker) throw new Conflict("owner_effect_not_entered");
			this.assertEnableSelection(a, settings, JSON.parse(String(marker.envelope)));
			this.db.run(
				"INSERT INTO insights_owner_grants VALUES (?,?,?,?)",
				a.owner.workspaceId,
				binding.grantId,
				JSON.stringify(binding),
				marker.operation_id!,
			);
			this.db.run(
				"INSERT INTO insights_owner_execution(workspace_id,authority,binding,state,settings_revision,settings,model,thinking) VALUES (?,?,?,'provisioning',?,?,?,?)",
				a.owner.workspaceId,
				JSON.stringify(a),
				JSON.stringify(binding),
				settings.revision,
				JSON.stringify(validateInsightsSettings(settings.settings)),
				settings.model,
				thinking ?? null,
			);
		});
		await this.db.durable();
		lease.revalidate();
	}
	assertApplyIdle(a: InsightsWorkspaceAuthority): void {
		if (
			this.db.one(
				"SELECT 1 FROM insights_owner_runs WHERE workspace_id=? AND state IN ('preparing','ready','sent','unknown','interrupted') LIMIT 1",
				a.owner.workspaceId,
			)
		)
			throw new Conflict("owner_review_active_or_uncertain");
	}
	assertNoEntered(a: InsightsWorkspaceAuthority): void {
		if (
			this.db.one(
				"SELECT 1 FROM insights_owner_effects WHERE workspace_id=? AND state='entered' LIMIT 1",
				a.owner.workspaceId,
			)
		)
			throw new Conflict("owner_entered_effect_requires_status_only");
	}
	async beginApply(
		lease: InsightsWorkspaceAdmission,
		op: DurableOperation,
		expected: InsightsOwnerExecution,
		binding: InsightsOwnerBinding,
		desired: InsightsSettingsRecord,
	): Promise<void> {
		this.db.transaction(() => {
			lease.revalidate();
			if (!same(this.current(lease.authority), expected) || !["active", "paused"].includes(expected.state))
				throw new Conflict("owner_apply_state_changed");
			this.assertApplyIdle(lease.authority);
			this.assertDesired(lease.authority, desired);
			const marker = this.db.one("SELECT * FROM insights_owner_effects WHERE operation_id=?", op.operationId);
			if (marker?.state !== "entered" || marker.envelope !== JSON.stringify(op))
				throw new Conflict("owner_effect_changed");
			if (
				binding.schemaVersion !== 2 ||
				!binding.enabled ||
				binding.revision !== expected.binding.revision + 1 ||
				binding.grantId === expected.binding.grantId ||
				!same(binding.owner, lease.authority.owner) ||
				binding.reportSessionId !== lease.authority.owner.reportSessionId ||
				binding.projectId !== lease.authority.owner.projectId ||
				!same(binding.host, lease.authority.owner.expectedHome)
			)
				throw new Conflict("owner_fresh_binding_required");
			this.db.run(
				"INSERT INTO insights_owner_grants VALUES (?,?,?,?)",
				lease.authority.owner.workspaceId,
				binding.grantId,
				JSON.stringify(binding),
				op.operationId,
			);
			this.db.run(
				"UPDATE insights_owner_execution SET state='configuring',binding=? WHERE workspace_id=?",
				JSON.stringify(binding),
				lease.authority.owner.workspaceId,
			);
		});
		await this.db.durable();
		lease.revalidate();
	}
	async stageApply(
		lease: InsightsWorkspaceAdmission,
		op: DurableOperation,
		desired: InsightsSettingsRecord,
	): Promise<void> {
		this.db.transaction(() => {
			lease.revalidate();
			this.assertDesired(lease.authority, desired);
			const current = this.current(lease.authority),
				marker = this.db.one("SELECT * FROM insights_owner_effects WHERE operation_id=?", op.operationId);
			if (current?.state !== "configuring" || marker?.state !== "entered" || marker.envelope !== JSON.stringify(op))
				throw new Conflict("owner_apply_effect_changed");
			this.db.run(
				"UPDATE insights_owner_execution SET state='provisioning',settings_revision=?,settings=?,model=? WHERE workspace_id=?",
				desired.revision,
				JSON.stringify(desired.settings),
				desired.model,
				lease.authority.owner.workspaceId,
			);
		});
		await this.db.durable();
		lease.revalidate();
	}
	async activate(lease: InsightsWorkspaceAdmission, op: DurableOperation): Promise<InsightsOwnerExecutionStatus> {
		const result = this.db.transaction(() => {
			lease.revalidate();
			const current = this.current(lease.authority);
			if (current?.state !== "provisioning") throw new Conflict("owner_execution_changed");
			this.assertEnableSelection(lease.authority, current.settings, op);
			const marker = this.db.one("SELECT * FROM insights_owner_effects WHERE operation_id=?", op.operationId);
			if (marker?.state !== "entered" || marker.envelope !== JSON.stringify(op))
				throw new Conflict("owner_effect_changed");
			this.db.run(
				"UPDATE insights_owner_execution SET state='active' WHERE workspace_id=?",
				lease.authority.owner.workspaceId,
			);
			const result = projectOwnerExecution(this.current(lease.authority)!);
			this.db.run(
				"UPDATE insights_owner_effects SET state='committed',result=? WHERE operation_id=?",
				JSON.stringify(result),
				op.operationId,
			);
			return result;
		});
		await this.db.durable();
		lease.revalidate();
		return result;
	}
	private assertDesired(a: InsightsWorkspaceAuthority, expected: InsightsSettingsRecord): void {
		const row = this.db.one("SELECT * FROM insights_workspace_settings WHERE workspace_id=?", a.owner.workspaceId);
		if (
			!row ||
			Number(row.revision) !== expected.revision ||
			row.model !== expected.model ||
			!same(JSON.parse(String(row.settings)), expected.settings)
		)
			throw new Conflict("owner_desired_settings_changed");
	}
	private assertEnableSelection(
		a: InsightsWorkspaceAuthority,
		expected: InsightsSettingsRecord,
		op: DurableOperation,
	): void {
		const payload = JSON.parse(op.payload);
		if (op.kind !== "insights-workspace-enable" || payload.transitionId === undefined) {
			this.assertDesired(a, expected);
			return;
		}
		const row = this.db.one(
			"SELECT * FROM insights_transfers WHERE workspace_id=? AND operation_id=? AND state='committed'",
			a.owner.workspaceId,
			payload.transitionId,
		);
		const desired = this.db.one(
			"SELECT revision FROM insights_workspace_settings WHERE workspace_id=?",
			a.owner.workspaceId,
		);
		if (
			!row ||
			!desired ||
			Number(desired.revision) !== payload.desiredSettingsRevision ||
			!same(JSON.parse(String(row.authority)).workspace, a) ||
			!same(JSON.parse(JSON.parse(String(row.envelope)).payload).effective, expected)
		)
			throw new Conflict("owner_transferred_selection_changed");
	}
	async settle(lease: InsightsWorkspaceAdmission, op: DurableOperation, result: unknown): Promise<void> {
		this.db.transaction(() => {
			lease.revalidate();
			const row = this.db.one("SELECT * FROM insights_owner_effects WHERE operation_id=?", op.operationId);
			if (
				!row ||
				row.workspace_id !== lease.authority.owner.workspaceId ||
				row.envelope !== JSON.stringify(op) ||
				row.state !== "entered"
			)
				throw new Conflict("owner_effect_changed");
			this.db.run(
				"UPDATE insights_owner_effects SET state='committed',result=? WHERE operation_id=?",
				JSON.stringify(result),
				op.operationId,
			);
		});
		await this.db.durable();
		lease.revalidate();
	}
	/** Only the prior operation's durable receipt can justify skipping another cancellation. */
	pausedReceipt(current: InsightsOwnerExecution): boolean {
		const row = this.db.one(
			"SELECT result FROM insights_owner_effects WHERE workspace_id=? AND state='committed' AND json_extract(envelope,'$.kind')='insights-workspace-pause' AND json_extract(result,'$.grantRevision')=? LIMIT 1",
			current.authority.owner.workspaceId,
			current.binding.revision,
		);
		return (
			current.state === "paused" && !!row && same(JSON.parse(String(row.result)), projectOwnerExecution(current))
		);
	}
	/** Synchronous denial precedes Stop/drain. An uncertain cancellation never re-enables. */
	async fence(lease: InsightsWorkspaceAdmission, state: "paused" | "revoked"): Promise<void> {
		this.db.transaction(() => {
			lease.revalidate();
			const current = this.current(lease.authority);
			if (!current || current.state === "revoked") throw new Conflict("owner_execution_revoked_or_absent");
			this.db.run(
				"UPDATE insights_owner_execution SET state=?,binding=? WHERE workspace_id=?",
				state,
				JSON.stringify({ ...current.binding, enabled: false, revision: current.binding.revision + 1 }),
				lease.authority.owner.workspaceId,
			);
		});
		await this.db.durable();
		lease.revalidate();
	}
}
