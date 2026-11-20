/** Native-only compatibility reads. These do not transfer ownership or create authority. */
import { resolve } from "node:path";
import type { DayInsightsLegacyPage, InsightsLegacySelector, OperationHost } from "@pilot/protocol";
import { Conflict } from "../../runtime/contracts/errors.ts";
import { InsightsJournal } from "./insights-journal.ts";
import type { InsightsWorkspaceDb } from "../ownership/insights-workspace-store.ts";
import { canonicalJSON, type OperationJournal, payloadHash } from "../../transport/operations/operation-journal.ts";
import type { ProjectStore } from "../../projects/projects.ts";
import type { SessionManager } from "../../sessions/sessions.ts";

export type { InsightsLegacySelector } from "@pilot/protocol";

const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);

/** Pins rows before any journal I/O; later qualification cannot select unsaved replacement rows. */
export class InsightsLegacyRecords {
	private readonly db: Pick<InsightsWorkspaceDb, "one" | "all" | "durable">;
	constructor(db: Pick<InsightsWorkspaceDb, "one" | "all" | "durable">) {
		this.db = db;
	}
	hasRecords(): boolean {
		return !!this.db.one(
			"SELECT 1 FROM (SELECT 1 FROM insights_items UNION ALL SELECT 1 FROM insights_settings UNION ALL SELECT 1 FROM insights_runs) LIMIT 1",
		);
	}
	pin(selector: InsightsLegacySelector, kind: "finding" | "report" | "checkpoint" | "settings", cursor = 0) {
		if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Conflict("Invalid legacy cursor");
		if (kind === "settings" && cursor !== 0) throw new Conflict("Legacy settings do not have a continuation cursor");
		const query = () =>
			kind === "settings"
				? this.db.all(
						"SELECT mission_id,session_id,binding,revision,settings,model FROM insights_settings WHERE mission_id=? AND session_id=? LIMIT 1",
						selector.missionId,
						selector.reportSessionId,
					)
				: this.db.all(
						"SELECT seq AS cursor,kind,key,revision,task_id,lifecycle,payload,updated_at FROM insights_items WHERE mission_id=? AND kind=? AND seq>? ORDER BY seq LIMIT 21",
						selector.missionId,
						kind,
						cursor,
					);
		const rows = query();
		const revalidate = () => {
			if (!same(rows, query())) throw new Conflict("legacy_projection_changed_during_read");
		};
		return {
			revalidate,
			read: async () => {
				await this.db.durable();
				revalidate();
				const items: typeof rows = [];
				for (const row of rows.slice(0, 20)) {
					if (Buffer.byteLength(JSON.stringify([...items, row])) > 48000) break;
					items.push(row);
				}
				if (rows.length && !items.length) throw new Conflict("Legacy record exceeds passive response limit");
				return { items, nextCursor: rows.length > items.length ? Number(items.at(-1)!.cursor) : null };
			},
		};
	}
}

export class InsightsLegacy {
	private readonly deps: {
		home: string;
		host: OperationHost;
		projects: ProjectStore;
		sessions: SessionManager;
		journal: OperationJournal;
		records: InsightsLegacyRecords;
		mission(id: string): { projectId: string; status: string };
	};
	constructor(deps: InsightsLegacy["deps"]) {
		this.deps = deps;
	}
	/** Host constructs selectors. This discovery does not grant, transfer or read source messages. */
	async discover(raw?: string): Promise<DayInsightsLegacyPage> {
		let after: string | null = null,
			report: string | null = null,
			kind: "report" | "finding" = "report",
			row = 0;
		if (raw !== undefined) {
			if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(raw)) throw new Conflict("Invalid legacy discovery cursor");
			let c: Record<string, unknown>;
			try {
				c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
			} catch {
				throw new Conflict("Invalid legacy discovery cursor");
			}
			if (
				!c ||
				Object.keys(c).sort().join(",") !== "after,kind,report,row" ||
				![c.after, c.report].every((v) => v === null || (typeof v === "string" && /^[0-9a-f-]{36}$/u.test(v))) ||
				!["report", "finding"].includes(String(c.kind)) ||
				!Number.isSafeInteger(c.row) ||
				Number(c.row) < 0
			)
				throw new Conflict("Invalid legacy discovery cursor");
			after = c.after as string | null;
			report = c.report as string | null;
			kind = c.kind as "report" | "finding";
			row = Number(c.row);
		}
		try {
			const selected = this.deps.sessions.insightsLegacyDiscovery(after);
			if (!selected) {
				if (after === null && this.deps.records.hasRecords())
					throw new Conflict("legacy_discovery_identity_unavailable");
				if (report !== null) throw new Conflict("legacy_discovery_identity_changed");
				return { schemaVersion: 1, state: "available", reason: null, items: [], nextCursor: null };
			}
			if (report !== null && selected.reportSessionId !== report)
				throw new Conflict("legacy_discovery_identity_changed");
			const project = this.deps.projects.require(selected.projectId);
			const selector: InsightsLegacySelector = {
				schemaVersion: 2,
				...selected,
				expectedHome: this.deps.host,
				context: payloadHash(
					canonicalJSON([
						resolve(this.deps.home),
						this.deps.host,
						selected.projectId,
						project.path,
						selected.missionId,
					]),
				),
			};
			const projection = await this.page(selector, kind, row);
			if (!same(selected, this.deps.sessions.insightsLegacyDiscovery(after)))
				throw new Conflict("legacy_discovery_changed_during_read");
			let next: { after: string | null; report: string | null; kind: "report" | "finding"; row: number } | null;
			if (projection.nextCursor !== null)
				next = { after, report: selected.reportSessionId, kind, row: projection.nextCursor };
			else if (kind === "report") next = { after, report: selected.reportSessionId, kind: "finding", row: 0 };
			else
				next = this.deps.sessions.insightsLegacyDiscovery(selected.reportSessionId)
					? { after: selected.reportSessionId, report: null, kind: "report", row: 0 }
					: null;
			const result: DayInsightsLegacyPage = {
				schemaVersion: 1,
				state: "available",
				reason: null,
				items: [{ kind, projection }],
				nextCursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null,
			};
			if (Buffer.byteLength(JSON.stringify(result)) > 65536)
				throw new Conflict("legacy_discovery_response_capacity");
			return result;
		} catch (error) {
			return {
				schemaVersion: 1,
				state: "unavailable",
				reason: error instanceof Conflict ? error.message : "legacy_discovery_unavailable",
				items: [],
				nextCursor: null,
			};
		}
	}
	async page(s: InsightsLegacySelector, kind: "finding" | "report" | "checkpoint" | "settings", cursor = 0) {
		if (
			!s ||
			Object.keys(s).sort().join(",") !== "context,expectedHome,missionId,projectId,reportSessionId,schemaVersion" ||
			s.schemaVersion !== 2 ||
			!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(s.reportSessionId) ||
			![s.projectId, s.missionId].every((v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(v))
		)
			throw new Conflict("Invalid exact legacy selector");
		const project = this.deps.projects.require(s.projectId),
			mission = this.deps.mission(s.missionId);
		const context = payloadHash(
			canonicalJSON([resolve(this.deps.home), this.deps.host, s.projectId, project.path, s.missionId]),
		);
		if (!same(s.expectedHome, this.deps.host) || s.context !== context || mission.projectId !== s.projectId)
			throw new Conflict("legacy_projection_home_or_context_changed");
		const identity = this.deps.sessions.insightsLegacyIdentity(s.reportSessionId, s.projectId, s.missionId);
		const guard = () => {
			if (
				this.deps.projects.require(s.projectId).path !== project.path ||
				!same(this.deps.mission(s.missionId), mission) ||
				!same(this.deps.sessions.insightsLegacyIdentity(s.reportSessionId, s.projectId, s.missionId), identity)
			)
				throw new Conflict("legacy_projection_authority_changed");
		};
		const pin = this.deps.records.pin(s, kind, cursor);
		const references = await new InsightsJournal(this.deps.journal).replacementReferences(
			s.projectId,
			s.missionId,
			s.reportSessionId,
		);
		guard();
		pin.revalidate();
		const rows = await pin.read();
		const latest = await new InsightsJournal(this.deps.journal).replacementReferences(
			s.projectId,
			s.missionId,
			s.reportSessionId,
		);
		guard();
		pin.revalidate();
		if (!same(references, latest)) throw new Conflict("legacy_operations_changed_during_read");
		const immutableHomeProven =
			references.qualified &&
			!references.overflow &&
			references.qualifications.every((q) => q.context === context && same(q.home, this.deps.host));
		const result = {
			schemaVersion: 2,
			selector: s,
			ownership: "legacy_mission",
			lifecycleDependency: "mission",
			missionStatus: mission.status,
			state: "available",
			coverage: "bounded",
			identity,
			...rows,
			operations: references.items,
			operationsOverflow: references.overflow,
			transition: {
				state: "blocked",
				immutableHomeProven,
				reason: !immutableHomeProven
					? "old_identity_home_unqualified"
					: references.items.some((r) => r.state === "pending")
						? "old_operation_pending_use_receipt"
						: "native_transition_not_implemented",
			},
		};
		if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new Conflict("Legacy response exceeds 64 KiB");
		return result;
	}
}
