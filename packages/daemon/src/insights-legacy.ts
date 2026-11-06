/** Native-only compatibility reads. These do not transfer ownership or create authority. */
import { resolve } from "node:path";
import type { InsightsLegacySelector, OperationHost } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { InsightsWorkspaceDb } from "./insights-workspace-store.ts";
import { canonicalJSON, type OperationJournal, payloadHash } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

export type { InsightsLegacySelector } from "@pilot/protocol";

const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);

/** Pins rows before any journal I/O; later qualification cannot select unsaved replacement rows. */
export class InsightsLegacyRecords {
	private readonly db: Pick<InsightsWorkspaceDb, "one" | "all" | "durable">;
	constructor(db: Pick<InsightsWorkspaceDb, "one" | "all" | "durable">) {
		this.db = db;
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
		const references = await this.deps.journal.replacementReferences(s.projectId, s.missionId, s.reportSessionId);
		guard();
		pin.revalidate();
		const rows = await pin.read();
		const latest = await this.deps.journal.replacementReferences(s.projectId, s.missionId, s.reportSessionId);
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
