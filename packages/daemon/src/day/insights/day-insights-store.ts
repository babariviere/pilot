import type { DayInsightsPayload, DayInsightsStatus, DurableOperation } from "@pilot/protocol";
import { Conflict } from "../../runtime/contracts/errors.ts";
import type { InsightsWorkspaceAuthority, InsightsWorkspaceDb } from "../../insights/ownership/insights-workspace-store.ts";
import { canonicalJSON } from "../../transport/operations/operation-journal.ts";

export const DAY_INSIGHTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS day_insights_state (
 home TEXT PRIMARY KEY, authority TEXT NOT NULL, snapshot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS day_insights_operations (
 operation_id TEXT PRIMARY KEY, home TEXT NOT NULL, envelope TEXT NOT NULL,
 state TEXT NOT NULL, result TEXT
);
CREATE INDEX IF NOT EXISTS day_insights_operations_home ON day_insights_operations(home);
CREATE TABLE IF NOT EXISTS day_insights_control (
 workspace_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, settings_revision INTEGER NOT NULL,
 enabled INTEGER NOT NULL, operation_id TEXT
);
CREATE TABLE IF NOT EXISTS day_insights_runs (
 run_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL,
 settings_revision INTEGER NOT NULL, admission_epoch TEXT NOT NULL, cutoff INTEGER NOT NULL,
 state TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS day_insights_runs_owner ON day_insights_runs(workspace_id);
`;
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);

/** Desired/effective configuration and exact receipts only. Never opens source history. */
export class DayInsightsStore {
	private readonly db: InsightsWorkspaceDb;
	constructor(db: InsightsWorkspaceDb) {
		this.db = db;
	}
	recorded(op: DurableOperation): boolean {
		return !!this.db.one(
			"SELECT 1 FROM day_insights_operations WHERE operation_id=? AND envelope=?",
			op.operationId,
			JSON.stringify(op),
		);
	}
	private row(home: string) {
		if (this.db.one("SELECT 1 FROM day_insights_state WHERE home<>? LIMIT 1", home))
			throw new Conflict("day_insights_foreign_profile");
		return this.db.one("SELECT * FROM day_insights_state WHERE home=?", home);
	}
	current(home: string, guard: (a: InsightsWorkspaceAuthority) => void): DayInsightsStatus | null {
		const row = this.row(home);
		if (!row) return null;
		guard(JSON.parse(String(row.authority)));
		return JSON.parse(String(row.snapshot));
	}
	async read(home: string, guard: (a: InsightsWorkspaceAuthority) => void) {
		const before = this.current(home, guard);
		await this.db.durable();
		if (!same(before, this.current(home, guard))) throw new Conflict("day_insights_changed_during_read");
		return before;
	}
	private receipt(op: DurableOperation) {
		const row = this.db.one("SELECT * FROM day_insights_operations WHERE operation_id=?", op.operationId);
		if (row && row.envelope !== JSON.stringify(op)) throw new Conflict("day_insights_operation_bytes_changed");
		return row;
	}
	async lookup(op: DurableOperation) {
		const row = this.receipt(op);
		await this.db.durable();
		if (!same(row, this.receipt(op))) throw new Conflict("day_insights_receipt_changed");
		return row
			? { state: String(row.state), result: row.result === null ? null : JSON.parse(String(row.result)) }
			: null;
	}
	/** Commits configuration and receipt together. No scheduler, worker or grant effects. */
	async configure(
		a: InsightsWorkspaceAuthority,
		op: DurableOperation,
		p: DayInsightsPayload,
		guard: (a: InsightsWorkspaceAuthority) => void,
		executionSupported = false,
	): Promise<DayInsightsStatus> {
		const result = this.db.transaction(() => {
			guard(a);
			const receipt = this.receipt(op);
			if (receipt?.state === "committed") {
				return JSON.parse(String(receipt.result)) as DayInsightsStatus;
			}
			const current = this.current(a.home, guard);
			const control = this.control(a.owner.workspaceId);
			if (
				executionSupported &&
				p.action !== "save" &&
				p.action !== "run" &&
				control?.operation_id !== op.operationId
			)
				throw new Conflict("day_insights_control_changed");
			if ((current?.revision ?? 0) !== p.expectedRevision) throw new Conflict("day_insights_stale_revision");
			if (current?.owner && !same(current.owner, a.owner)) throw new Conflict("day_insights_owner_changed");
			if (Number(this.db.one("SELECT COUNT(*) n FROM day_insights_operations")!.n) >= 4096)
				throw new Conflict("day_insights_receipt_capacity");
			const next: DayInsightsStatus = {
				schemaVersion: 1,
				revision: p.expectedRevision + 1,
				owner: a.owner,
				draft: current?.draft ?? null,
				effective: current?.effective ?? null,
				paused: current?.paused ?? false,
				executionSupported,
				uncertainOperationId: null,
				running: executionSupported ? false : null,
				nextAt: null,
				holdReason: executionSupported ? null : "day_insights_execution_adapter_unavailable",
				remaining: { perReportMicros: null, monthlyMicros: null, uncertainMicros: null },
			};
			if (p.action === "save") next.draft = p.settings;
			else if (p.action === "apply") {
				next.effective = p.settings;
				next.draft = p.settings;
			} else if (p.action === "pause") next.paused = true;
			else if (p.action === "resume") next.paused = false;
			else if (p.action !== "run") throw new Conflict("day_insights_invalid_action");
			if (executionSupported && p.action !== "save" && p.action !== "run") {
				this.db.run(
					"UPDATE day_insights_control SET enabled=?,settings_revision=?,operation_id=NULL WHERE workspace_id=? AND operation_id=?",
					next.paused ? 0 : 1,
					p.action === "pause" ? Number(control!.settings_revision) : next.revision,
					a.owner.workspaceId,
					op.operationId,
				);
				const row = this.db.one(
					"SELECT binding FROM insights_owner_execution WHERE workspace_id=?",
					a.owner.workspaceId,
				);
				if (row)
					this.db.run(
						"UPDATE insights_owner_execution SET state=?,binding=? WHERE workspace_id=?",
						next.paused ? "paused" : "active",
						JSON.stringify({ ...JSON.parse(String(row.binding)), enabled: !next.paused }),
						a.owner.workspaceId,
					);
				if (p.action === "pause")
					this.db.run(
						"UPDATE day_insights_operations SET state='superseded',result=? WHERE home=? AND state='entered' AND operation_id<>?",
						JSON.stringify({ state: "superseded", pauseOperationId: op.operationId, execution: "not_inferred" }),
						a.home,
						op.operationId,
					);
			}
			this.db.run(
				"INSERT INTO day_insights_state VALUES (?,?,?) ON CONFLICT(home) DO UPDATE SET snapshot=excluded.snapshot",
				a.home,
				JSON.stringify(a),
				JSON.stringify(next),
			);
			this.db.run(
				"INSERT INTO day_insights_operations VALUES (?,?,?,'committed',?) ON CONFLICT(operation_id) DO UPDATE SET state='committed',result=excluded.result",
				op.operationId,
				a.home,
				JSON.stringify(op),
				JSON.stringify(next),
			);
			return next;
		});
		await this.db.durable();
		guard(a);
		return result;
	}
	/** Entry is durable before creating/configuring a report or dispatching input. */
	async enter(
		a: InsightsWorkspaceAuthority,
		op: DurableOperation,
		p: DayInsightsPayload,
		guard: (a: InsightsWorkspaceAuthority) => void,
	): Promise<void> {
		this.db.transaction(() => {
			guard(a);
			if (this.receipt(op)) throw new Conflict("day_insights_operation_already_entered");
			const current = this.current(a.home, guard);
			if ((current?.revision ?? 0) !== p.expectedRevision || current?.uncertainOperationId)
				throw new Conflict("day_insights_state_changed");
			if (
				p.action !== "pause" &&
				this.db.one("SELECT 1 FROM day_insights_operations WHERE home=? AND state='entered'", a.home)
			)
				throw new Conflict("day_insights_operation_uncertain");
			const prior = this.db.one("SELECT * FROM insights_workspace_owners WHERE profile_home=?", a.home);
			if (prior && (prior.authority !== JSON.stringify(a) || prior.state !== "reserved"))
				throw new Conflict("day_insights_workspace_unavailable");
			if (!prior)
				this.db.run(
					"INSERT INTO insights_workspace_owners VALUES (?,?,?,1,'reserved',?,?)",
					a.owner.workspaceId,
					a.home,
					JSON.stringify(a),
					op.operationId,
					JSON.stringify(op),
				);
			if (Number(this.db.one("SELECT COUNT(*) n FROM day_insights_operations")!.n) >= 4096)
				throw new Conflict("day_insights_receipt_capacity");
			this.db.run(
				"INSERT INTO day_insights_operations VALUES (?,?,?,'entered',NULL)",
				op.operationId,
				a.home,
				JSON.stringify(op),
			);
			if (p.action !== "run")
				this.db.run(
					"INSERT INTO day_insights_control VALUES (?,1,0,0,?) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1,enabled=0,operation_id=excluded.operation_id",
					a.owner.workspaceId,
					op.operationId,
				);
		});
		await this.db.durable();
		guard(a);
	}
	uncertain(home: string): string | null {
		const row = this.db.one(
			"SELECT operation_id FROM day_insights_operations WHERE home=? AND state='entered' LIMIT 1",
			home,
		);
		return row ? String(row.operation_id) : null;
	}
	latestRun(workspace: string) {
		return (
			this.db.one(
				"SELECT d.run_id,COALESCE(r.state,d.state) state,COALESCE(r.detail,d.detail) detail,d.admission_epoch FROM day_insights_runs d LEFT JOIN insights_owner_runs r ON r.run_id=d.run_id AND r.workspace_id=d.workspace_id WHERE d.workspace_id=? ORDER BY d.rowid DESC LIMIT 1",
				workspace,
			) ??
			this.db.one(
				"SELECT run_id,state FROM insights_owner_runs WHERE workspace_id=? ORDER BY seq DESC LIMIT 1",
				workspace,
			)
		);
	}
	control(workspace: string) {
		return this.db.one("SELECT * FROM day_insights_control WHERE workspace_id=?", workspace);
	}
	blockingRun(workspace: string): boolean {
		return !!this.db.one(
			"SELECT 1 FROM day_insights_runs WHERE workspace_id=? AND state IN ('reserved','active','unknown') LIMIT 1",
			workspace,
		);
	}
	isCancelledRun(workspace: string, run: string): boolean {
		return !!this.db.one(
			"SELECT 1 FROM day_insights_runs d JOIN insights_owner_runs r USING (workspace_id,run_id) WHERE d.workspace_id=? AND d.run_id=? AND d.state='cancelled' AND r.state='cancelled'",
			workspace,
			run,
		);
	}
	assertControl(workspace: string, generation: number, operationId?: string) {
		const c = this.control(workspace);
		if (!c || Number(c.generation) !== generation || (operationId !== undefined && c.operation_id !== operationId))
			throw new Conflict("day_insights_control_changed");
	}
	assertCommitted(workspace: string, revision: number) {
		const c = this.control(workspace);
		if (!c || !c.enabled || c.operation_id !== null || Number(c.settings_revision) !== revision)
			throw new Conflict("day_insights_settings_not_committed");
		return Number(c.generation);
	}
	async beginRun(workspace: string, revision: number, run: string, epoch: string, guard: () => void) {
		this.db.transaction(() => {
			guard();
			const generation = this.assertCommitted(workspace, revision);
			if (
				this.db.one(
					"SELECT 1 FROM day_insights_runs WHERE workspace_id=? AND state IN ('reserved','active','unknown') LIMIT 1",
					workspace,
				)
			)
				throw new Conflict("day_insights_run_active_or_uncertain");
			if (Number(this.db.one("SELECT COUNT(*) n FROM day_insights_runs")!.n) >= 4096)
				throw new Conflict("day_insights_run_capacity");
			this.db.run(
				"INSERT INTO day_insights_runs VALUES (?,?,?,?,?,?,'reserved','Fresh context reserved; no input receipt yet')",
				run,
				workspace,
				generation,
				revision,
				epoch,
				Date.now(),
			);
		});
		await this.db.durable();
		guard();
	}
	run(run: string) {
		return this.db.one("SELECT * FROM day_insights_runs WHERE run_id=?", run);
	}
	async claimRun(run: string, guard: () => void) {
		this.db.transaction(() => {
			guard();
			const r = this.run(run);
			if (!r || r.state !== "reserved") throw new Conflict("day_insights_run_already_entered");
			this.db.run(
				"UPDATE day_insights_runs SET state='active',detail='Fresh report input entered; not completed' WHERE run_id=?",
				run,
			);
		});
		await this.db.durable();
		guard();
	}
	assertRun(workspace: string, run: string, epoch: string) {
		const r = this.run(run);
		if (
			!r ||
			r.workspace_id !== workspace ||
			r.admission_epoch !== epoch ||
			!["reserved", "active", "partial"].includes(String(r.state))
		)
			throw new Conflict("day_insights_run_not_active");
		const generation = this.assertCommitted(workspace, Number(r.settings_revision));
		if (generation !== Number(r.generation)) throw new Conflict("day_insights_run_generation_changed");
		return Number(r.cutoff);
	}
	async runState(run: string, state: "active" | "partial" | "held" | "cancelled" | "unknown", detail: string) {
		this.db.run(
			"UPDATE day_insights_runs SET state=?,detail=? WHERE run_id=? AND state IN ('reserved','active')",
			state,
			detail.slice(0, 300),
			run,
		);
		await this.db.durable();
	}
	async cancelRuns(workspace: string) {
		this.db.run(
			"UPDATE day_insights_runs SET state='cancelled',detail='Native Pause denied prior input; never replay' WHERE workspace_id=? AND state IN ('reserved','active','unknown')",
			workspace,
		);
		await this.db.durable();
	}
	async finishWithoutReport(run: string, state: "held" | "unknown", detail: string) {
		this.db.transaction(() => {
			const row = this.run(run);
			if (!row || !["reserved", "active"].includes(String(row.state))) return;
			const review = this.db.one(
				"SELECT state FROM insights_owner_runs WHERE run_id=? AND workspace_id=?",
				run,
				row.workspace_id!,
			);
			const terminal =
				review && ["partial", "held", "cancelled"].includes(String(review.state)) ? String(review.state) : state;
			this.db.run(
				"UPDATE day_insights_runs SET state=?,detail=? WHERE run_id=?",
				terminal,
				detail.slice(0, 300),
				run,
			);
			if (!["partial", "held", "cancelled"].includes(String(review?.state)))
				this.db.run(
					"UPDATE insights_owner_runs SET state=?,detail=? WHERE run_id=? AND workspace_id=?",
					terminal,
					detail.slice(0, 300),
					run,
					row.workspace_id!,
				);
		});
		await this.db.durable();
	}
}
