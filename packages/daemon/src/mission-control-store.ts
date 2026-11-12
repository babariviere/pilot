import type { SQLInputValue } from "node:sqlite";
import type { MissionControl, MissionControlOperation, MissionReport } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON } from "./operation-journal.ts";
import type { MissionContinuation } from "./mission-continuation.ts";

export const MISSION_CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_controls (mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mission_control_operations (operation_id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mission_reports (report_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, task_id TEXT NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS mission_report_scope ON mission_reports(mission_id,task_id);
CREATE TABLE IF NOT EXISTS mission_continuations (operation_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS mission_continuation_state ON mission_continuations(json_extract(record,'$.state'),mission_id);
CREATE TABLE IF NOT EXISTS mission_order_pins (mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE);
INSERT OR IGNORE INTO mission_order_pins
SELECT DISTINCT e.mission_id FROM events e JOIN tasks t ON t.id=e.task_id AND t.mission_id=e.mission_id
WHERE e.kind='task' AND e.session_id IS NULL
AND substr(e.text,1,length('Task #' || t.number || ' reordered: '))='Task #' || t.number || ' reordered: ';
`;

interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	all(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue>[];
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	durable(): Promise<void>;
	changed(id: string): void;
}

/** Shares canonical mission SQLite, transactions and the off-thread durable writer. */
export class MissionControlStore {
	private readonly port: Port;
	private readonly flushing = new Map<string, Promise<void>>();
	private readonly failed = new Set<string>();
	constructor(port: Port) {
		this.port = port;
	}
	durable() {
		return this.port.durable();
	}
	private flush(missionId: string): void {
		const pending = this.port.durable();
		this.flushing.set(missionId, pending);
		void pending.then(
			() => {
				if (this.flushing.get(missionId) === pending) this.flushing.delete(missionId);
			},
			() => {
				this.failed.add(missionId);
			},
		);
	}
	fenceCurrent(missionId: string): MissionControl {
		if (this.flushing.has(missionId) || this.failed.has(missionId))
			throw new Conflict("Mission controls are not durably available");
		const current = this.current(missionId);
		if (current.version !== 1) throw new Conflict("Mission control version is unavailable");
		return current;
	}
	current(missionId: string): MissionControl {
		const row = this.port.one("SELECT record FROM mission_controls WHERE mission_id=?", missionId);
		return row
			? JSON.parse(String(row.record))
			: { version: 1, missionId, revision: 0, pauseGeneration: 0, stopGeneration: 0, held: false, state: "running" };
	}
	operation(id: string): MissionControlOperation | undefined {
		const row = this.port.one("SELECT record FROM mission_control_operations WHERE operation_id=?", id);
		return row ? JSON.parse(String(row.record)) : undefined;
	}
	write(record: MissionControlOperation, expectedRevision: number): void {
		this.port.transaction(() => {
			if (this.current(record.missionId).revision !== expectedRevision)
				throw new Conflict("Mission controls changed");
			if (
				!this.operation(record.command.operationId) &&
				Number(this.port.one("SELECT COUNT(*) n FROM mission_control_operations")!.n) >= 16384
			)
				throw new Conflict("Mission control receipt storage is full");
			this.port.run(
				"INSERT INTO mission_control_operations VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET record=excluded.record",
				record.command.operationId,
				canonicalJSON(record),
			);
			this.port.run(
				"INSERT INTO mission_controls VALUES(?,?) ON CONFLICT(mission_id) DO UPDATE SET record=excluded.record",
				record.missionId,
				canonicalJSON(record.control),
			);
		});
		this.flush(record.missionId);
		this.port.changed(record.missionId);
	}
	/** Later Stop invalidates selective resume, including after restart. */
	stop(missionId: string): void {
		this.port.transaction(() => {
			const current = this.current(missionId);
			current.stopGeneration++;
			current.revision++;
			this.port.run(
				"INSERT INTO mission_controls VALUES(?,?) ON CONFLICT(mission_id) DO UPDATE SET record=excluded.record",
				missionId,
				canonicalJSON(current),
			);
		});
		this.flush(missionId);
		this.port.changed(missionId);
	}
	report(id: string): MissionReport | undefined {
		const row = this.port.one("SELECT record FROM mission_reports WHERE report_id=?", id);
		return row ? JSON.parse(String(row.record)) : undefined;
	}
	reports(missionId: string): MissionReport[] {
		return this.port
			.all(
				"SELECT record FROM mission_reports WHERE rowid IN (SELECT MAX(rowid) FROM mission_reports WHERE mission_id=? GROUP BY task_id) ORDER BY rowid",
				missionId,
			)
			.map((row) => JSON.parse(String(row.record)));
	}
	latestReport(missionId: string, taskId: string): MissionReport | undefined {
		const row = this.port.one(
			"SELECT record FROM mission_reports WHERE mission_id=? AND task_id=? ORDER BY rowid DESC LIMIT 1",
			missionId,
			taskId,
		);
		return row ? JSON.parse(String(row.record)) : undefined;
	}
	insertReport(report: MissionReport): void {
		this.port.transaction(() => {
			if (Number(this.port.one("SELECT COUNT(*) n FROM mission_reports")!.n) >= 16384)
				throw new Conflict("Report storage is full");
			this.port.run(
				"INSERT INTO mission_reports VALUES(?,?,?,?)",
				report.write.reportId,
				report.missionId,
				report.write.taskId,
				canonicalJSON(report),
			);
		});
		this.port.changed(report.missionId);
	}
	continuation(id: string): MissionContinuation | undefined {
		const row = this.port.one("SELECT record FROM mission_continuations WHERE operation_id=?", id);
		return row ? JSON.parse(String(row.record)) : undefined;
	}
	unsettledContinuationCount(): number {
		return Number(
			this.port.one(
				"SELECT COUNT(*) n FROM mission_continuations WHERE json_extract(record,'$.state') IN ('waiting','entered','unknown')",
			)!.n,
		);
	}
	orderPinned(missionId: string): boolean {
		return !!this.port.one("SELECT mission_id FROM mission_order_pins WHERE mission_id=?", missionId);
	}
	pinOrder(missionId: string): void {
		this.port.run("INSERT OR IGNORE INTO mission_order_pins VALUES(?)", missionId);
	}
	continuations(missionId?: string, unsettledOnly = false): MissionContinuation[] {
		return this.port
			.all(
				`SELECT record FROM mission_continuations WHERE 1=1 ${missionId ? "AND mission_id=?" : ""}
				${unsettledOnly ? "AND json_extract(record,'$.state') IN ('waiting','entered','unknown')" : ""} ORDER BY rowid`,
				...(missionId ? [missionId] : []),
			)
			.map((row) => JSON.parse(String(row.record)));
	}
	/** Exact start intents and waiting reasons, never task status or execution grants. */
	saveContinuation(record: MissionContinuation): void {
		const previous = this.continuation(record.operationId);
		if (canonicalJSON(previous) === canonicalJSON(record)) return;
		this.port.transaction(() => {
			if (!previous && Number(this.port.one("SELECT COUNT(*) n FROM mission_continuations")!.n) >= 4096)
				throw new Conflict("Continuation receipt storage is full");
			this.port.run(
				"INSERT INTO mission_continuations VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET record=excluded.record",
				record.operationId,
				record.missionId,
				canonicalJSON(record),
			);
		});
	}
}
