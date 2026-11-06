/** Native transition storage. Old tables are read-only; no old grant becomes v2 authority. */
import type {
	DurableOperation,
	InsightsLegacySelector,
	InsightsSettingsRecord,
	InsightsWorkspaceTransferPayload,
	InsightsWorkspaceTransferReceipt,
	ScheduledItem,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { parseInsightsBacklog } from "./insights-backlog.ts";
import { validateInsightsSettings } from "./insights-settings.ts";
import type { InsightsWorkspaceAuthority, InsightsWorkspaceDb } from "./insights-workspace-store.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

export const INSIGHTS_TRANSITION_SCHEMA = `
CREATE TABLE IF NOT EXISTS insights_transfers (
 old_session_id TEXT PRIMARY KEY, workspace_id TEXT UNIQUE NOT NULL,
 project_id TEXT NOT NULL, mission_id TEXT NOT NULL, authority TEXT NOT NULL,
 operation_id TEXT UNIQUE NOT NULL, envelope TEXT NOT NULL,
 manifest_hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS insights_transfers_old_case ON insights_transfers(lower(old_session_id));
CREATE TABLE IF NOT EXISTS insights_transfer_rows (
 workspace_id TEXT NOT NULL REFERENCES insights_transfers(workspace_id),
 table_name TEXT NOT NULL, source_key TEXT NOT NULL, original TEXT NOT NULL,
 original_hash TEXT NOT NULL, PRIMARY KEY(workspace_id,table_name,source_key)
);
CREATE TABLE IF NOT EXISTS insights_transfer_envelopes (
 workspace_id TEXT NOT NULL REFERENCES insights_transfers(workspace_id),
 operation_id TEXT NOT NULL, original TEXT NOT NULL,
 PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS insights_legacy_denials (
 old_session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
 operation_id TEXT NOT NULL, legacy_context TEXT NOT NULL, expected_home TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS insights_legacy_denials_old_case ON insights_legacy_denials(lower(old_session_id));
CREATE TABLE IF NOT EXISTS insights_workspace_origins (
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 kind TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
 transfer_operation_id TEXT NOT NULL, source_table TEXT NOT NULL,
 source_key TEXT NOT NULL, source_hash TEXT NOT NULL,
 PRIMARY KEY(workspace_id,kind,key,revision)
);
CREATE TABLE IF NOT EXISTS insights_workspace_legacy_operations (
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL,
 PRIMARY KEY(workspace_id,operation_id)
);
`;

type Row = Record<string, string | number | null>;
type Part = { table: string; rows: Row[] };
export interface InsightsTransferSnapshot {
	parts: Part[];
	manifest: { hash: string; rows: number; bytes: number; scope: string | null; counts: Record<string, number> };
	desired: InsightsSettingsRecord;
}
export interface InsightsTransferAuthority {
	legacy: InsightsLegacySelector;
	workspace: InsightsWorkspaceAuthority;
}
export type InsightsTransferResult = InsightsWorkspaceTransferReceipt;
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const MAX_ROWS = 1024,
	MAX_BYTES = 4 * 1024 * 1024;
const uuid = (value: string) => {
	const hash = payloadHash(value);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

export class InsightsTransitionStore {
	private readonly db: InsightsWorkspaceDb;
	constructor(db: InsightsWorkspaceDb) {
		this.db = db;
	}
	assertTarget(id: string): void {
		if (
			this.db.one("SELECT 1 FROM insights_transfers WHERE lower(old_session_id)=?", id.toLowerCase()) ||
			this.db.one("SELECT 1 FROM insights_legacy_denials WHERE lower(old_session_id)=?", id.toLowerCase())
		)
			throw new Conflict("legacy_transfer_identity_fenced");
	}
	assertScope(projectId: string, missionId: string): void {
		if (this.db.one("SELECT 1 FROM insights_transfers WHERE project_id=? AND mission_id=?", projectId, missionId))
			throw new Conflict("legacy_transfer_scope_fenced");
	}
	hasFence(): boolean {
		return !!this.db.one("SELECT 1 FROM insights_transfers LIMIT 1");
	}
	recorded(op: DurableOperation): boolean {
		return !!this.db.one("SELECT 1 FROM insights_transfers WHERE operation_id=?", op.operationId);
	}
	retiredReportId(workspaceId: string): string | null {
		const row = this.db.one(
			"SELECT old_session_id FROM insights_transfers WHERE workspace_id=? AND state='committed'",
			workspaceId,
		);
		return row ? String(row.old_session_id) : null;
	}
	assertTransferred(a: InsightsWorkspaceAuthority, operationId: string): void {
		const row = this.db.one(
			"SELECT * FROM insights_transfers WHERE operation_id=? AND workspace_id=? AND state='committed'",
			operationId,
			a.owner.workspaceId,
		);
		if (
			!row ||
			!same(JSON.parse(String(row.authority)).workspace, a) ||
			!this.db.one(
				"SELECT 1 FROM insights_legacy_denials WHERE operation_id=? AND workspace_id=?",
				operationId,
				a.owner.workspaceId,
			)
		)
			throw new Conflict("legacy_transfer_receipt_or_denial_unavailable");
	}
	async committed(a: InsightsWorkspaceAuthority) {
		const row = this.db.one("SELECT * FROM insights_transfers WHERE workspace_id=?", a.owner.workspaceId);
		if (!row) return null;
		if (row.state !== "committed" || !row.result) throw new Conflict("legacy_transfer_entered_use_exact_check");
		const authority = JSON.parse(String(row.authority)) as InsightsTransferAuthority;
		if (!same(authority.workspace, a)) throw new Conflict("legacy_transfer_authority_changed");
		const op = JSON.parse(String(row.envelope)) as DurableOperation;
		if (op.payloadHash !== payloadHash(op.payload)) throw new Conflict("legacy_transfer_envelope_changed");
		const payload = JSON.parse(op.payload) as InsightsWorkspaceTransferPayload;
		const denial = this.db.one("SELECT * FROM insights_legacy_denials WHERE operation_id=?", op.operationId);
		if (
			!denial ||
			denial.workspace_id !== a.owner.workspaceId ||
			denial.old_session_id !== authority.legacy.reportSessionId
		)
			throw new Conflict("legacy_transfer_denial_unavailable");
		const envelopes = this.db
			.all(
				"SELECT operation_id,original FROM insights_transfer_envelopes WHERE workspace_id=? ORDER BY operation_id",
				a.owner.workspaceId,
			)
			.map((r) => ({ operationId: String(r.operation_id), original: String(r.original) }));
		if (payload.envelopesHash !== payloadHash(JSON.stringify(envelopes)))
			throw new Conflict("legacy_transfer_archived_envelopes_changed");
		await this.db.durable();
		if (
			!same(row, this.db.one("SELECT * FROM insights_transfers WHERE workspace_id=?", a.owner.workspaceId)) ||
			!same(denial, this.db.one("SELECT * FROM insights_legacy_denials WHERE operation_id=?", op.operationId))
		)
			throw new Conflict("legacy_transfer_changed_during_read");
		return {
			operationId: op.operationId,
			payload,
			envelopes,
			result: JSON.parse(String(row.result)) as InsightsTransferResult,
		};
	}
	/** Bounded aggregate check runs before materializing any old bodies. No paging/partial transfer. */
	snapshot(
		s: InsightsLegacySelector,
		projection?: { implicit: InsightsSettingsRecord | null },
	): InsightsTransferSnapshot {
		if (
			this.db.one(
				"SELECT 1 FROM insights_replacements WHERE project_id=? AND mission_id=? AND result IS NULL LIMIT 1",
				s.projectId,
				s.missionId,
			)
		)
			throw new Conflict("legacy_replacement_pending_use_exact_recovery");
		if (
			this.db.one(
				"SELECT 1 FROM insights_runs WHERE mission_id=? AND session_id<>? LIMIT 1",
				s.missionId,
				s.reportSessionId,
			) ||
			this.db.one(
				"SELECT 1 FROM insights_operations WHERE mission_id=? AND session_id<>? LIMIT 1",
				s.missionId,
				s.reportSessionId,
			)
		)
			throw new Conflict("legacy_multiple_report_lineages_require_combined_recovery");
		if (
			this.db.one(
				"SELECT 1 FROM insights_runs WHERE session_id=? AND state IN ('preparing','ready','sent','unknown','interrupted') LIMIT 1",
				s.reportSessionId,
			)
		)
			throw new Conflict("legacy_review_active_or_uncertain");
		const specs: Array<{ table: string; where: string; params: string[]; order: string }> = [
			{ table: "insights_items", where: "mission_id=?", params: [s.missionId], order: "seq" },
			{ table: "insights_revisions", where: "mission_id=?", params: [s.missionId], order: "seq" },
			{ table: "insights_evidence", where: "mission_id=?", params: [s.missionId], order: "seq" },
			{
				table: "insights_operations",
				where: "mission_id=? AND session_id=?",
				params: [s.missionId, s.reportSessionId],
				order: "operation_id",
			},
			{
				table: "insights_settings",
				where: "mission_id=? AND session_id=?",
				params: [s.missionId, s.reportSessionId],
				order: "session_id",
			},
			{
				table: "insights_runs",
				where: "mission_id=? AND session_id=?",
				params: [s.missionId, s.reportSessionId],
				order: "seq",
			},
			{ table: "insights_patterns", where: "mission_id=?", params: [s.missionId], order: "pattern" },
			{
				table: "insights_review_reads",
				where: "run_seq IN (SELECT seq FROM insights_runs WHERE session_id=?)",
				params: [s.reportSessionId],
				order: "run_seq,cursor",
			},
			{
				table: "tasks",
				where: "id IN (SELECT task_id FROM insights_items WHERE mission_id=?)",
				params: [s.missionId],
				order: "id",
			},
			{
				table: "insights_replacements",
				where: "project_id=? AND mission_id=?",
				params: [s.projectId, s.missionId],
				order: "seq",
			},
		];
		if (
			this.db.one(
				"SELECT 1 FROM insights_runs WHERE session_id=? AND length(binding)<>64 LIMIT 1",
				s.reportSessionId,
			)
		)
			throw new Conflict("legacy_cursor_scope_unavailable");
		const scopes = this.db
			.all(
				"SELECT DISTINCT binding FROM insights_runs WHERE session_id=? ORDER BY binding LIMIT 3",
				s.reportSessionId,
			)
			.map((r) => String(r.binding));
		if (scopes.length > 1) throw new Conflict("legacy_multiple_cursor_scopes_require_combined_recovery");
		const scope = scopes[0] ?? null;
		// A cursor with no attributable run is Unknown, not empty or complete.
		if (
			this.db.one(
				"SELECT 1 FROM insights_sources WHERE scope NOT IN (SELECT binding FROM insights_runs WHERE session_id=?) LIMIT 1",
				s.reportSessionId,
			) ||
			this.db.one(
				"SELECT 1 FROM insights_inventory WHERE scope NOT IN (SELECT binding FROM insights_runs WHERE session_id=?) LIMIT 1",
				s.reportSessionId,
			)
		)
			throw new Conflict("legacy_cursor_owner_unavailable");
		if (scope) {
			specs.push(
				{ table: "insights_sources", where: "scope=?", params: [scope], order: "seq" },
				{ table: "insights_inventory", where: "scope=?", params: [scope], order: "scope" },
			);
		}
		let count = 0,
			aggregateBytes = 0;
		for (const spec of specs) {
			const columns = this.db.all(`PRAGMA table_info(${spec.table})`).map((row) => String(row.name));
			if (!columns.length || columns.some((name) => !/^[A-Za-z0-9_]+$/u.test(name)))
				throw new Conflict("legacy_snapshot_columns_unavailable");
			const expression = columns.map((name) => `COALESCE(length(CAST("${name}" AS BLOB)),0)`).join("+");
			const size = this.db.one(
				`SELECT COUNT(*) n,COALESCE(SUM(${expression}),0) bytes FROM ${spec.table} WHERE ${spec.where}`,
				...spec.params,
			)!;
			count += Number(size.n);
			aggregateBytes += Number(size.bytes);
			if (count > MAX_ROWS || aggregateBytes > MAX_BYTES / 6)
				throw new Conflict("legacy_transfer_snapshot_capacity");
		}
		const parts: Part[] = specs.map((spec) => ({
			table: spec.table,
			rows: this.db.all(
				`SELECT * FROM ${spec.table} WHERE ${spec.where} ORDER BY ${spec.order} LIMIT ${MAX_ROWS + 1}`,
				...spec.params,
			) as Row[],
		}));
		const raw = JSON.stringify(parts),
			bytes = Buffer.byteLength(raw);
		if (bytes > MAX_BYTES) throw new Conflict("legacy_transfer_snapshot_capacity");
		const setting = parts.find((p) => p.table === "insights_settings")!.rows;
		if (setting.length > 1 || (!setting.length && !projection?.implicit))
			throw new Conflict("legacy_settings_identity_unavailable");
		const desired = setting.length
			? {
					revision: Number(setting[0]!.revision) + (projection ? 1 : 0),
					settings: validateInsightsSettings(JSON.parse(String(setting[0]!.settings))),
					model: String(setting[0]!.model),
				}
			: projection!.implicit!;
		if (!setting.length && (desired.revision !== 1 || !desired.model))
			throw new Conflict("legacy_implicit_settings_projection_changed");
		validateInsightsSettings(desired.settings);
		for (const part of parts)
			if (part.table === "insights_items" || part.table === "insights_revisions")
				for (const row of part.rows) this.projectedRequest(row, { operationId: "preflight" });
		return {
			parts,
			manifest: {
				hash: payloadHash(projection ? JSON.stringify({ parts, desired }) : raw),
				rows: count,
				bytes,
				scope,
				counts: Object.fromEntries(parts.map((p) => [p.table, p.rows.length])),
			},
			desired,
		};
	}
	private row(op: DurableOperation) {
		const row = this.db.one("SELECT * FROM insights_transfers WHERE operation_id=?", op.operationId);
		if (row && (row.workspace_id !== op.targetId || row.envelope !== JSON.stringify(op)))
			throw new Conflict("legacy_transfer_operation_bytes_changed");
		return row;
	}
	async lookup(op: DurableOperation, guard: () => void) {
		guard();
		const row = this.row(op);
		await this.db.durable();
		guard();
		if (!same(row ?? null, this.row(op) ?? null)) throw new Conflict("legacy_transfer_changed_during_read");
		return !row
			? { state: "absent" as const }
			: row.state === "committed"
				? { state: "committed" as const, result: JSON.parse(String(row.result)) as InsightsTransferResult }
				: { state: "entered" as const };
	}
	async enter(
		op: DurableOperation,
		a: InsightsTransferAuthority,
		snapshot: InsightsTransferSnapshot,
		guard: () => void,
	): Promise<void> {
		this.db.transaction(() => {
			guard();
			if (this.row(op) || this.db.one("SELECT 1 FROM insights_transfers LIMIT 1"))
				throw new Conflict("legacy_transfer_already_entered_use_receipt");
			if (
				op.kind !== "insights-workspace-transfer" ||
				op.targetId !== a.workspace.owner.workspaceId ||
				a.legacy.projectId !== a.workspace.owner.projectId ||
				!same(a.legacy.expectedHome, a.workspace.owner.expectedHome) ||
				op.destination.daemonId !== a.workspace.owner.expectedHome.daemonId ||
				op.destination.lineageId !== a.workspace.owner.expectedHome.lineageId
			)
				throw new Conflict("legacy_transfer_target_changed");
			const payload = JSON.parse(op.payload);
			if (
				payload.schemaVersion !== 2 ||
				!same(payload.owner, a.workspace.owner) ||
				!same(payload.legacy, a.legacy) ||
				!same(payload.manifest, snapshot.manifest)
			)
				throw new Conflict("legacy_transfer_confirmation_changed");
			if (this.db.one("SELECT 1 FROM insights_workspace_owners LIMIT 1"))
				throw new Conflict("workspace_already_reserved");
			if (!same(snapshot.manifest, this.confirmedSnapshot(op, a.legacy).manifest))
				throw new Conflict("legacy_transfer_snapshot_changed");
			this.db.run(
				"INSERT INTO insights_transfers VALUES (?,?,?,?,?,?,?,?, 'entered',NULL)",
				a.legacy.reportSessionId,
				op.targetId,
				a.legacy.projectId,
				a.legacy.missionId,
				JSON.stringify(a),
				op.operationId,
				JSON.stringify(op),
				snapshot.manifest.hash,
			);
		});
		await this.db.durable();
		guard();
	}
	/** One exact transaction owns the tracking transfer, old-ID denial and receipt. */
	async commit(
		op: DurableOperation,
		a: InsightsTransferAuthority,
		snapshot: InsightsTransferSnapshot,
		envelopes: Array<{ operationId: string; original: string }>,
		guard: () => void,
		cancelledRules: ScheduledItem[] = [],
	): Promise<InsightsTransferResult> {
		const result = this.db.transaction(() => {
			guard();
			const old = this.row(op);
			if (old?.state === "committed") return JSON.parse(String(old.result)) as InsightsTransferResult;
			if (
				old?.state !== "entered" ||
				old.authority !== JSON.stringify(a) ||
				old.manifest_hash !== snapshot.manifest.hash ||
				!same(snapshot.manifest, this.confirmedSnapshot(op, a.legacy).manifest)
			)
				throw new Conflict("legacy_transfer_snapshot_or_marker_changed");
			if (envelopes.length > 32 || Buffer.byteLength(JSON.stringify(envelopes)) > MAX_BYTES)
				throw new Conflict("legacy_envelope_snapshot_capacity");
			if (JSON.parse(op.payload).envelopesHash !== payloadHash(JSON.stringify(envelopes)))
				throw new Conflict("legacy_envelope_snapshot_changed");
			const id = a.workspace.owner.workspaceId;
			this.db.run(
				"INSERT INTO insights_workspace_owners VALUES (?,?,?,1,'reserved',?,?)",
				id,
				a.workspace.home,
				JSON.stringify(a.workspace),
				op.operationId,
				JSON.stringify(op),
			);
			const setting = snapshot.parts.find((p) => p.table === "insights_settings")!.rows[0];
			this.db.run(
				"INSERT INTO insights_workspace_settings VALUES (?,?,?,?)",
				id,
				snapshot.desired.revision,
				setting?.settings ?? JSON.stringify(snapshot.desired.settings),
				snapshot.desired.model,
			);
			for (const part of snapshot.parts)
				for (let n = 0; n < part.rows.length; n++) {
					const row = part.rows[n]!,
						raw = JSON.stringify(row),
						key = this.sourceKey(part.table, row, n);
					this.db.run(
						"INSERT INTO insights_transfer_rows VALUES (?,?,?,?,?)",
						id,
						part.table,
						key,
						raw,
						payloadHash(raw),
					);
				}
			for (const envelope of envelopes) {
				const record = JSON.parse(envelope.original) as {
					operation: DurableOperation;
					receipt: { state: string; operationId: string };
				};
				if (
					record.operation.operationId !== envelope.operationId ||
					record.receipt.operationId !== envelope.operationId ||
					!["accepted", "rejected"].includes(record.receipt.state) ||
					record.operation.payloadHash !== payloadHash(record.operation.payload) ||
					record.operation.destination.daemonId !== a.legacy.expectedHome.daemonId ||
					record.operation.destination.lineageId !== a.legacy.expectedHome.lineageId
				)
					throw new Conflict("legacy_envelope_snapshot_unqualified");
				this.db.run(
					"INSERT INTO insights_transfer_envelopes VALUES (?,?,?)",
					id,
					envelope.operationId,
					envelope.original,
				);
			}
			this.copyTracking(
				id,
				op,
				snapshot,
				payloadHash(canonicalJSON(a.workspace.owner)),
				a.workspace.owner.reportSessionId,
			);
			const archived = this.db.all(
				"SELECT table_name,source_key,original,original_hash FROM insights_transfer_rows WHERE workspace_id=? ORDER BY table_name,source_key",
				id,
			);
			if (archived.length !== snapshot.manifest.rows) throw new Conflict("legacy_transfer_verification_failed");
			const archivedByKey = new Map(archived.map((row) => [canonicalJSON([row.table_name, row.source_key]), row]));
			for (const part of snapshot.parts)
				for (let n = 0; n < part.rows.length; n++) {
					const original = JSON.stringify(part.rows[n]),
						key = this.sourceKey(part.table, part.rows[n]!, n);
					const copy = archivedByKey.get(canonicalJSON([part.table, key]));
					if (!copy || copy.original !== original || copy.original_hash !== payloadHash(original))
						throw new Conflict("legacy_transfer_verification_failed");
				}
			this.db.run(
				"INSERT INTO insights_legacy_denials VALUES (?,?,?,?,?)",
				a.legacy.reportSessionId,
				id,
				op.operationId,
				a.legacy.context,
				JSON.stringify(a.legacy.expectedHome),
			);
			const result: InsightsTransferResult = {
				schemaVersion: 2,
				state: "transferred",
				workspace: { owner: a.workspace.owner, revision: 1, state: "reserved", activation: "not_activated" },
				legacy: a.legacy,
				manifestHash: snapshot.manifest.hash,
				rows: snapshot.manifest.rows,
				activation: "not_activated",
				cancelledRules,
			};
			this.db.run(
				"INSERT INTO insights_workspace_receipts VALUES (?,?,?,?)",
				id,
				op.operationId,
				JSON.stringify(op),
				JSON.stringify(result),
			);
			this.db.run(
				"UPDATE insights_transfers SET state='committed',result=? WHERE operation_id=?",
				JSON.stringify(result),
				op.operationId,
			);
			guard();
			return result;
		});
		await this.db.durable();
		guard();
		return result;
	}
	private confirmedSnapshot(op: DurableOperation, s: InsightsLegacySelector) {
		const p = JSON.parse(op.payload) as InsightsWorkspaceTransferPayload;
		return this.snapshot(
			s,
			p.settingsMapping === "legacy_revision_plus_one"
				? { implicit: p.settingsOrigin === "initial_enable" ? p.desired : null }
				: undefined,
		);
	}
	private sourceKey(table: string, row: Row, index: number): string {
		return row.seq !== undefined
			? String(row.seq)
			: canonicalJSON([
					row.operation_id ?? null,
					row.session_id ?? null,
					row.pattern ?? null,
					row.run_seq ?? null,
					row.cursor ?? null,
					row.scope ?? null,
					row.id ?? null,
					table,
					index,
				]);
	}
	private projectedRequest(row: Row, op: Pick<DurableOperation, "operationId">): string {
		const kind = String(row.kind),
			payload = JSON.parse(String(row.payload));
		const operationId = uuid(`legacy-tracking:${op.operationId}:${kind}:${row.key}:${row.revision}`);
		const record =
			kind === "finding"
				? { action: "propose", key: row.key, operationId, expectedRevision: 0, draft: payload, evidence: [] }
				: {
						action: kind === "report" ? "save_report" : "save_checkpoint",
						key: row.key,
						operationId,
						expectedRevision: 0,
						record: {
							status: payload.status,
							windowStart: payload.windowStart,
							windowEnd: payload.windowEnd,
							markdown: payload.markdown,
							checkpoints: payload.checkpoints,
							findingKeys: payload.findingKeys,
							gaps: payload.gaps,
						},
					};
		parseInsightsBacklog(record);
		const raw = JSON.stringify(record);
		if (Buffer.byteLength(JSON.stringify({ request: raw, payload })) > 60000)
			throw new Conflict("legacy_tracking_record_exceeds_workspace_limit");
		return raw;
	}
	private copyTracking(
		id: string,
		op: DurableOperation,
		snapshot: InsightsTransferSnapshot,
		scope: string,
		reportSessionId: string,
	): void {
		const rows = (table: string) => snapshot.parts.find((p) => p.table === table)?.rows ?? [];
		for (const row of rows("insights_items"))
			this.db.run(
				"INSERT INTO insights_workspace_items(workspace_id,kind,key,revision,request,lifecycle,updated_at) VALUES (?,?,?,?,?,?,?)",
				id,
				row.kind!,
				row.key!,
				row.revision!,
				this.projectedRequest(row, op),
				row.lifecycle!,
				row.updated_at!,
			);
		for (const row of rows("insights_revisions")) {
			this.db.run(
				"INSERT INTO insights_workspace_revisions(workspace_id,kind,key,revision,request,lifecycle,at) VALUES (?,?,?,?,?,?,?)",
				id,
				row.kind!,
				row.key!,
				row.revision!,
				this.projectedRequest(row, op),
				row.lifecycle!,
				row.at!,
			);
			this.db.run(
				"INSERT INTO insights_workspace_origins VALUES (?,?,?,?,?,?,?,?)",
				id,
				row.kind!,
				row.key!,
				row.revision!,
				op.operationId,
				"insights_revisions",
				String(row.seq),
				payloadHash(String(row.payload)),
			);
		}
		for (const row of rows("insights_evidence"))
			this.db.run(
				"INSERT INTO insights_workspace_evidence VALUES (?,?,?,?)",
				id,
				row.finding_key!,
				row.evidence_key!,
				row.payload!,
			);
		for (const row of rows("insights_patterns")) {
			this.db.run("INSERT INTO insights_workspace_patterns VALUES (?,?,?)", id, row.pattern!, row.finding_key!);
			this.db.run("INSERT INTO insights_owner_patterns VALUES (?,?,?)", id, row.pattern!, row.finding_key!);
		}
		for (const row of rows("insights_operations"))
			this.db.run(
				"INSERT INTO insights_workspace_legacy_operations VALUES (?,?,?,?)",
				id,
				row.operation_id!,
				row.request_hash!,
				row.result!,
			);
		for (const row of rows("insights_runs"))
			this.db.run(
				"INSERT INTO insights_owner_runs(seq,workspace_id,session_id,run_id,binding,request,state,detail,packet,report_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
				row.seq!,
				id,
				reportSessionId,
				row.run_id!,
				scope,
				row.request!,
				row.state!,
				`${row.detail} [Legacy historical run, not a new admission.]`,
				row.packet!,
				row.report_key!,
			);
		for (const row of rows("insights_review_reads"))
			this.db.run("INSERT INTO insights_owner_review_reads VALUES (?,?)", row.run_seq!, row.cursor!);
		for (const row of rows("insights_items"))
			if (row.kind === "report")
				this.db.run("INSERT INTO insights_owner_reports VALUES (?,?,?)", id, row.key!, row.payload!);
		// Copy the one attributable queue without changing its continuation bytes or coverage claims.
		for (const row of rows("insights_sources"))
			this.db.run(
				"INSERT INTO insights_owner_sources(scope,session_id,project_id,position,reviewed) VALUES (?,?,?,?,?)",
				scope,
				row.session_id!,
				row.project_id!,
				row.position!,
				row.reviewed!,
			);
		for (const row of rows("insights_inventory"))
			this.db.run("INSERT INTO insights_owner_inventory VALUES (?,?)", scope, row.after_id!);
	}
}
