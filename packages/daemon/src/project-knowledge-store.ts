/** Project knowledge rows inside missions.sqlite. Projects own entries; missions only hold versioned links. */
import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type {
	KnowledgeAuthor,
	KnowledgeDetail,
	KnowledgeFreshness,
	KnowledgeKind,
	KnowledgeObservation,
	KnowledgeOrigin,
	KnowledgeRevision,
	KnowledgeRevisionSummary,
	KnowledgeSource,
	KnowledgeSummary,
	KnowledgeWriteResult,
	MissionKnowledgeLink,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";

type Row = Record<string, SQLInputValue>;

/**
 * Catalog tables plus small observation/origin rows. Origin and source IDs are provenance locators, not
 * foreign keys, so deleting or archiving a mission never removes knowledge; deleting a mission removes its links.
 */
export const KNOWLEDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS project_knowledge (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	origin TEXT NOT NULL,
	revision INTEGER NOT NULL,
	title TEXT NOT NULL,
	synopsis TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_knowledge_order ON project_knowledge(project_id, created_at, id);
CREATE INDEX IF NOT EXISTS project_knowledge_kind_order ON project_knowledge(project_id, kind, created_at, id);
CREATE TABLE IF NOT EXISTS project_knowledge_revisions (
	knowledge_id TEXT NOT NULL REFERENCES project_knowledge(id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	project_id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	title TEXT NOT NULL,
	synopsis TEXT NOT NULL,
	body TEXT NOT NULL,
	sources TEXT NOT NULL,
	reason TEXT,
	author TEXT NOT NULL,
	recorded_at INTEGER NOT NULL,
	PRIMARY KEY (knowledge_id, revision),
	UNIQUE (project_id, operation_id)
);
CREATE TABLE IF NOT EXISTS mission_knowledge_links (
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	knowledge_id TEXT NOT NULL REFERENCES project_knowledge(id) ON DELETE CASCADE,
	link_revision INTEGER NOT NULL,
	linked INTEGER NOT NULL,
	pinned_revision INTEGER,
	updated_at INTEGER NOT NULL,
	updated_by TEXT NOT NULL,
	PRIMARY KEY (mission_id, knowledge_id)
);
CREATE INDEX IF NOT EXISTS mission_knowledge_by_entry ON mission_knowledge_links(knowledge_id);
CREATE TABLE IF NOT EXISTS project_knowledge_checks (
	knowledge_id TEXT PRIMARY KEY REFERENCES project_knowledge(id) ON DELETE CASCADE,
	checked_revision INTEGER,
	checked_at INTEGER,
	checker TEXT,
	coverage TEXT,
	source_versions TEXT,
	pending_generation INTEGER NOT NULL DEFAULT 0,
	cleared_generation INTEGER NOT NULL DEFAULT 0,
	pending_since INTEGER,
	pending_reasons TEXT,
	pending_triggers TEXT,
	task_id TEXT,
	failure_at INTEGER,
	failure_reason TEXT
);
CREATE TABLE IF NOT EXISTS project_knowledge_observations (
	knowledge_id TEXT PRIMARY KEY REFERENCES project_knowledge(id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	at INTEGER NOT NULL,
	sources TEXT NOT NULL
);
-- Host-recorded origin survives task completion and later batches. It is not an agent payload label.
CREATE TABLE IF NOT EXISTS project_knowledge_documentation_tasks (
	mission_id TEXT NOT NULL,
	task_id TEXT PRIMARY KEY
);
`;

/** The few MissionStore primitives the catalog uses: the same in-memory connection, transactions and replica. */
export interface KnowledgeDb {
	all(sql: string, ...params: SQLInputValue[]): Row[];
	one(sql: string, ...params: SQLInputValue[]): Row | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	/** Notifies mission listeners after a commit, so mission views reread their linked subset. */
	changed(missionId: string): void;
}

export interface PreparedKnowledgeWrite {
	operationId: string;
	requestHash: string;
	expectedRevision: number;
	kind: KnowledgeKind;
	title: string;
	synopsis: string;
	body: string;
	sources: KnowledgeSource[];
	reason?: string;
	author: KnowledgeAuthor;
	/** Create only. */
	origin?: Omit<KnowledgeOrigin, "recordedAt">;
}

export interface KnowledgeListFilter {
	kind?: KnowledgeKind;
	missionId?: string;
	needsCheck?: boolean;
	q?: string;
}

const MAX_PENDING_REASONS = 16;
const MAX_PENDING_TRIGGERS = 64;

function json<T>(value: SQLInputValue | undefined, fallback: T): T {
	if (typeof value !== "string") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export class ProjectKnowledgeStore {
	private readonly db: KnowledgeDb;
	constructor(db: KnowledgeDb) {
		this.db = db;
	}

	private freshness(row: Row | undefined, revision: number, current: number, detailed = false): KnowledgeFreshness {
		if (!row) return { state: "not_checked" };
		const isCurrent = revision === current;
		const pending = isCurrent && Number(row.pending_generation) > Number(row.cleared_generation);
		// A historical revision never inherits a newer revision's check, and a save is never a check.
		const checked =
			row.checked_revision !== null && Number(row.checked_revision) === revision
				? {
						at: Number(row.checked_at),
						checker: String(row.checker),
						coverage: String(row.coverage ?? ""),
						...(detailed ? { sourceVersions: json<unknown>(row.source_versions, null) } : {}),
					}
				: undefined;
		const triggers = json<unknown[]>(row.pending_triggers, []);
		return {
			state: pending ? "needs_check" : checked ? "checked" : "not_checked",
			...(checked ? { checked } : {}),
			...(pending
				? {
						pending: {
							generation: Number(row.pending_generation),
							since: Number(row.pending_since ?? 0),
							reasons: json<string[]>(row.pending_reasons, []),
							triggers: triggers.length,
							...(row.task_id ? { taskId: String(row.task_id) } : {}),
						},
					}
				: {}),
			...(isCurrent && row.failure_at !== null && row.failure_at !== undefined
				? { failure: { at: Number(row.failure_at), reason: String(row.failure_reason ?? "") } }
				: {}),
		};
	}

	private summaryFrom(row: Row, check: Row | undefined): KnowledgeSummary {
		const revision = Number(row.revision);
		return {
			id: String(row.id),
			projectId: String(row.project_id),
			kind: String(row.kind) as KnowledgeKind,
			title: String(row.title),
			synopsis: String(row.synopsis),
			revision,
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
			origin: json<KnowledgeOrigin>(row.origin, { recordedAt: Number(row.created_at) }),
			freshness: this.freshness(check, revision, revision),
			...(row.link_revision !== undefined && row.link_revision !== null
				? {
						link: {
							linkRevision: Number(row.link_revision),
							...(row.pinned_revision !== null ? { pinnedRevision: Number(row.pinned_revision) } : {}),
						},
					}
				: {}),
		};
	}

	private check(id: string): Row | undefined {
		return this.db.one("SELECT * FROM project_knowledge_checks WHERE knowledge_id = ?", id);
	}

	private entryRow(projectId: string, id: string): Row | undefined {
		return this.db.one("SELECT * FROM project_knowledge WHERE id = ? AND project_id = ?", id, projectId);
	}

	summary(projectId: string, id: string): KnowledgeSummary | undefined {
		const row = this.entryRow(projectId, id);
		return row ? this.summaryFrom(row, this.check(id)) : undefined;
	}

	/** Newest first by immutable creation time, then ID. Reads stored rows only. */
	list(
		projectId: string,
		filter: KnowledgeListFilter,
		after: { createdAt: number; id: string } | undefined,
		limit: number,
	): { entries: KnowledgeSummary[]; more: boolean } {
		const where = ["k.project_id = ?"];
		const params: SQLInputValue[] = [projectId];
		let join = "";
		let columns = "k.*";
		if (filter.missionId !== undefined) {
			join += " JOIN mission_knowledge_links l ON l.knowledge_id = k.id AND l.mission_id = ? AND l.linked = 1";
			params.unshift(filter.missionId);
			columns += ", l.link_revision, l.pinned_revision";
		}
		if (filter.needsCheck) {
			join += " JOIN project_knowledge_checks c ON c.knowledge_id = k.id";
			where.push("c.pending_generation > c.cleared_generation");
		}
		if (filter.kind) {
			where.push("k.kind = ?");
			params.push(filter.kind);
		}
		if (filter.q) {
			where.push("(instr(lower(k.title), lower(?)) > 0 OR instr(lower(k.synopsis), lower(?)) > 0)");
			params.push(filter.q, filter.q);
		}
		if (after) {
			where.push("(k.created_at < ? OR (k.created_at = ? AND k.id < ?))");
			params.push(after.createdAt, after.createdAt, after.id);
		}
		const rows = this.db.all(
			`SELECT ${columns} FROM project_knowledge k${join} WHERE ${where.join(" AND ")}
			ORDER BY k.created_at DESC, k.id DESC LIMIT ?`,
			...params,
			limit + 1,
		);
		return {
			entries: rows.slice(0, limit).map((row) => this.summaryFrom(row, this.check(String(row.id)))),
			more: rows.length > limit,
		};
	}

	private revisionFrom(row: Row): KnowledgeRevision {
		return {
			knowledgeId: String(row.knowledge_id),
			...this.revisionSummaryFrom(row),
			body: String(row.body),
			sources: json<KnowledgeSource[]>(row.sources, []),
		};
	}

	private revisionSummaryFrom(row: Row): KnowledgeRevisionSummary {
		return {
			revision: Number(row.revision),
			title: String(row.title),
			synopsis: String(row.synopsis),
			...(row.reason !== null && row.reason !== undefined ? { reason: String(row.reason) } : {}),
			author: json<KnowledgeAuthor>(row.author, { type: "user" }),
			recordedAt: Number(row.recorded_at),
		};
	}

	/** One exact stored revision, current when omitted. */
	detail(projectId: string, id: string, revision?: number): KnowledgeDetail | undefined {
		const entry = this.entryRow(projectId, id);
		if (!entry) return undefined;
		const current = Number(entry.revision);
		const row = this.db.one(
			"SELECT * FROM project_knowledge_revisions WHERE knowledge_id = ? AND revision = ?",
			id,
			revision ?? current,
		);
		if (!row) return undefined;
		const check = this.check(id);
		const observation = this.observation(id);
		return {
			entry: this.summaryFrom(entry, check),
			revision: this.revisionFrom(row),
			freshness: this.freshness(check, Number(row.revision), current, true),
			...(observation?.revision === Number(row.revision) ? { observation } : {}),
		};
	}

	revisions(
		projectId: string,
		id: string,
		before: number | undefined,
		limit: number,
	): { revisions: KnowledgeRevisionSummary[]; more: boolean } | undefined {
		if (!this.entryRow(projectId, id)) return undefined;
		const rows = this.db.all(
			`SELECT revision, title, synopsis, reason, author, recorded_at FROM project_knowledge_revisions
			WHERE knowledge_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?`,
			id,
			before ?? Number.MAX_SAFE_INTEGER,
			limit + 1,
		);
		return { revisions: rows.slice(0, limit).map((row) => this.revisionSummaryFrom(row)), more: rows.length > limit };
	}

	/** Whether this project already saved an operation ID. */
	operation(projectId: string, operationId: string): boolean {
		return !!this.db.one(
			"SELECT 1 FROM project_knowledge_revisions WHERE project_id = ? AND operation_id = ?",
			projectId,
			operationId,
		);
	}

	/** The first cited mission record that does not exist, by exact ID. */
	missingMissionCitation(source: Extract<KnowledgeSource, { type: "mission" }>): string | undefined {
		const exists = (sql: string, value: SQLInputValue) => !!this.db.one(sql, source.missionId, value);
		if (
			source.decisionId !== undefined &&
			!exists("SELECT 1 FROM decisions WHERE mission_id = ? AND id = ?", source.decisionId)
		)
			return "decision";
		if (source.taskId !== undefined && !exists("SELECT 1 FROM tasks WHERE mission_id = ? AND id = ?", source.taskId))
			return "task";
		if (
			source.eventId !== undefined &&
			!exists("SELECT 1 FROM events WHERE mission_id = ? AND id = ?", source.eventId)
		)
			return "event";
		if (
			source.briefRevision !== undefined &&
			!exists("SELECT 1 FROM brief_revisions WHERE mission_id = ? AND revision = ?", source.briefRevision)
		)
			return "brief revision";
		return undefined;
	}

	/** Whether the exact revision exists in this project, for knowledge citations. */
	hasRevision(projectId: string, id: string, revision: number): boolean {
		return !!this.db.one(
			"SELECT 1 FROM project_knowledge_revisions WHERE knowledge_id = ? AND project_id = ? AND revision = ?",
			id,
			projectId,
			revision,
		);
	}

	private linkedMissions(id: string): string[] {
		return this.db
			.all("SELECT mission_id FROM mission_knowledge_links WHERE knowledge_id = ? AND linked = 1", id)
			.map((row) => String(row.mission_id));
	}

	/**
	 * Create (knowledgeId undefined, expectedRevision 0) or append. An operation ID is project-scoped: the same
	 * request returns its saved revision, different content conflicts. The caller awaits durable() before ACK.
	 */
	write(projectId: string, knowledgeId: string | undefined, write: PreparedKnowledgeWrite): KnowledgeWriteResult {
		let notify: string[] = [];
		const result = this.db.transaction((): KnowledgeWriteResult => {
			const saved = this.db.one(
				"SELECT * FROM project_knowledge_revisions WHERE project_id = ? AND operation_id = ?",
				projectId,
				write.operationId,
			);
			if (saved) {
				if (saved.request_hash !== write.requestHash)
					throw new Conflict("This operation ID was already used for a different knowledge write");
				const id = String(saved.knowledge_id);
				return {
					operationId: write.operationId,
					replayed: true,
					entry: this.summary(projectId, id)!,
					revision: this.revisionSummaryFrom(saved),
				};
			}
			const now = Date.now();
			let id: string;
			let revision: number;
			if (knowledgeId === undefined) {
				if (write.expectedRevision !== 0) throw new Conflict("Create requires expectedRevision 0");
				for (const missionId of write.origin?.missionId ? [write.origin.missionId] : []) {
					const mission = this.db.one("SELECT project_id FROM missions WHERE id = ?", missionId);
					if (!mission || mission.project_id !== projectId)
						throw new Conflict("The originating mission is not in this project");
				}
				id = randomUUID();
				revision = 1;
				const origin: KnowledgeOrigin = { ...write.origin, recordedAt: now };
				this.db.run(
					"INSERT INTO project_knowledge VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
					id,
					projectId,
					write.kind,
					JSON.stringify(origin),
					write.title,
					write.synopsis,
					now,
					now,
				);
			} else {
				const entry = this.entryRow(projectId, knowledgeId);
				if (!entry) throw new NotFound("Knowledge entry not found in this project");
				if (entry.kind !== write.kind) throw new Conflict("An entry's kind cannot change");
				if (Number(entry.revision) !== write.expectedRevision)
					throw new Conflict(
						`Knowledge changed: current revision is ${entry.revision}, not ${write.expectedRevision}. Reread before appending.`,
					);
				id = knowledgeId;
				revision = Number(entry.revision) + 1;
				this.db.run(
					"UPDATE project_knowledge SET revision = ?, title = ?, synopsis = ?, updated_at = ? WHERE id = ?",
					revision,
					write.title,
					write.synopsis,
					now,
					id,
				);
				notify = this.linkedMissions(id);
			}
			this.db.run(
				"INSERT INTO project_knowledge_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				revision,
				projectId,
				write.operationId,
				write.requestHash,
				write.title,
				write.synopsis,
				write.body,
				JSON.stringify(write.sources),
				write.reason ?? null,
				JSON.stringify(write.author),
				now,
			);
			// Catalog revisions have host-recorded documentation origin. Mark citations, never launch work.
			const dependents = this.db.all(
				`SELECT DISTINCT k.id FROM project_knowledge k
				JOIN project_knowledge_revisions r ON r.knowledge_id=k.id AND r.revision=k.revision, json_each(r.sources) s
				WHERE k.project_id=? AND json_extract(s.value, '$.type')='knowledge'
				AND json_extract(s.value, '$.knowledgeId')=?`,
				projectId,
				id,
			);
			for (const dependent of dependents)
				this.markPending(
					projectId,
					String(dependent.id),
					"Documentation source revised; original citation retained",
					`knowledge:${id}:${revision}`,
				);
			return {
				operationId: write.operationId,
				replayed: false,
				entry: this.summary(projectId, id)!,
				revision: {
					revision,
					title: write.title,
					synopsis: write.synopsis,
					...(write.reason !== undefined ? { reason: write.reason } : {}),
					author: write.author,
					recordedAt: now,
				},
			};
		});
		for (const missionId of notify) this.db.changed(missionId);
		return result;
	}

	private linkFrom(missionId: string, knowledgeId: string, row: Row | undefined): MissionKnowledgeLink {
		if (!row) return { missionId, knowledgeId, linked: false, linkRevision: 0 };
		return {
			missionId,
			knowledgeId,
			linked: Number(row.linked) === 1,
			linkRevision: Number(row.link_revision),
			...(row.pinned_revision !== null ? { pinnedRevision: Number(row.pinned_revision) } : {}),
			updatedAt: Number(row.updated_at),
			updatedBy: json<KnowledgeAuthor>(row.updated_by, { type: "user" }),
		};
	}

	/** Same-project mission and entry, else NotFound. Returns the entry's current revision. */
	private admitLink(missionId: string, knowledgeId: string): number {
		const mission = this.db.one("SELECT project_id FROM missions WHERE id = ?", missionId);
		if (!mission) throw new NotFound("Mission not found");
		const entry = this.db.one("SELECT project_id, revision FROM project_knowledge WHERE id = ?", knowledgeId);
		if (!entry || entry.project_id !== mission.project_id)
			throw new NotFound("Knowledge entry not found in this mission's project");
		return Number(entry.revision);
	}

	/** Stored state only. Never linked is {linked:false, linkRevision:0} without creating a row. */
	link(missionId: string, knowledgeId: string): MissionKnowledgeLink {
		this.admitLink(missionId, knowledgeId);
		return this.linkFrom(
			missionId,
			knowledgeId,
			this.db.one(
				"SELECT * FROM mission_knowledge_links WHERE mission_id = ? AND knowledge_id = ?",
				missionId,
				knowledgeId,
			),
		);
	}

	/**
	 * Compare-and-set on one retained counter: link, repin and unlink all increment it, so a stale request conflicts
	 * even when its pin value matches again. Unlink keeps a tombstone; relink continues the counter.
	 */
	setLink(
		missionId: string,
		knowledgeId: string,
		expectedLinkRevision: number,
		next: { linked: true; pinnedRevision?: number } | { linked: false },
		actor: KnowledgeAuthor,
	): MissionKnowledgeLink {
		const result = this.db.transaction(() => {
			const current = this.admitLink(missionId, knowledgeId);
			if (
				next.linked &&
				next.pinnedRevision !== undefined &&
				(next.pinnedRevision < 1 || next.pinnedRevision > current)
			)
				throw new NotFound(`Knowledge revision ${next.pinnedRevision} does not exist`);
			const row = this.db.one(
				"SELECT link_revision, linked FROM mission_knowledge_links WHERE mission_id = ? AND knowledge_id = ?",
				missionId,
				knowledgeId,
			);
			const revision = Number(row?.link_revision ?? 0);
			if (expectedLinkRevision !== revision)
				throw new Conflict(`Mission link changed: current link revision is ${revision}. Reread before retrying.`);
			if (!next.linked && Number(row?.linked ?? 0) !== 1)
				throw new Conflict("This entry is not linked to the mission");
			this.db.run(
				`INSERT INTO mission_knowledge_links VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(mission_id, knowledge_id) DO UPDATE SET link_revision = excluded.link_revision,
				linked = excluded.linked, pinned_revision = excluded.pinned_revision, updated_at = excluded.updated_at,
				updated_by = excluded.updated_by`,
				missionId,
				knowledgeId,
				revision + 1,
				next.linked ? 1 : 0,
				next.linked ? (next.pinnedRevision ?? null) : null,
				Date.now(),
				JSON.stringify(actor),
			);
			return this.linkFrom(
				missionId,
				knowledgeId,
				this.db.one(
					"SELECT * FROM mission_knowledge_links WHERE mission_id = ? AND knowledge_id = ?",
					missionId,
					knowledgeId,
				),
			);
		});
		this.db.changed(missionId);
		return result;
	}

	/**
	 * Host-internal: one coalesced pending generation per entry. Never reachable from GETs or agent tools.
	 * Returns the new generation.
	 */
	markPending(projectId: string, id: string, reason: string, trigger?: string): number {
		return this.db.transaction(() => {
			if (!this.entryRow(projectId, id)) throw new NotFound("Knowledge entry not found in this project");
			const row = this.check(id);
			const active = row && Number(row.pending_generation) > Number(row.cleared_generation);
			const reasons = active ? json<string[]>(row.pending_reasons, []) : [];
			const triggers = active ? json<string[]>(row.pending_triggers, []) : [];
			if (active && trigger !== undefined && triggers.includes(trigger) && reasons.includes(reason))
				return Number(row.pending_generation);
			if (!reasons.includes(reason) && reasons.length < MAX_PENDING_REASONS) reasons.push(reason);
			// Overflow is visible as broader pending coverage, not silently dropped work.
			if (trigger !== undefined && !triggers.includes(trigger)) {
				if (triggers.length < MAX_PENDING_TRIGGERS) triggers.push(trigger);
				else if (!reasons.includes("More triggers than retained")) reasons.push("More triggers than retained");
			}
			const generation = Number(row?.pending_generation ?? 0) + 1;
			this.db.run(
				`INSERT INTO project_knowledge_checks (knowledge_id, pending_generation, pending_since, pending_reasons, pending_triggers)
				VALUES (?, ?, ?, ?, ?) ON CONFLICT(knowledge_id) DO UPDATE SET pending_generation = excluded.pending_generation,
				pending_since = ${active ? "pending_since" : "excluded.pending_since"}, pending_reasons = excluded.pending_reasons,
				pending_triggers = excluded.pending_triggers`,
				id,
				generation,
				Date.now(),
				JSON.stringify(reasons),
				JSON.stringify(triggers),
			);
			return generation;
		});
	}

	/** Bounded keyset scan for maintenance, separate from all passive catalog reads. */
	maintenanceEntries(after = "", projectId?: string): { id: string; projectId: string }[] {
		return this.db
			.all(
				`SELECT id, project_id FROM project_knowledge WHERE id > ? ${projectId === undefined ? "" : "AND project_id = ?"}
			ORDER BY id LIMIT 50`,
				after,
				...(projectId === undefined ? [] : [projectId]),
			)
			.map((row) => ({ id: String(row.id), projectId: String(row.project_id) }));
	}

	observation(id: string): KnowledgeObservation | undefined {
		const row = this.db.one("SELECT * FROM project_knowledge_observations WHERE knowledge_id = ?", id);
		return row ? { revision: Number(row.revision), at: Number(row.at), sources: json(row.sources, []) } : undefined;
	}

	pendingGeneration(id: string): number {
		return Number(this.check(id)?.pending_generation ?? 0);
	}

	/** Persist only changed observations. Comparing source bytes makes duplicate/missed hints cheap. */
	observe(projectId: string, id: string, observation: KnowledgeObservation, expectedGeneration: number): void {
		this.db.transaction(() => {
			if (Number(this.entryRow(projectId, id)?.revision) !== observation.revision)
				throw new Conflict("Knowledge changed during source observation");
			if (this.pendingGeneration(id) !== expectedGeneration)
				throw new Conflict("Pending work changed during source observation");
			const previous = this.observation(id);
			const encoded = JSON.stringify(observation.sources);
			if (previous?.revision === observation.revision && JSON.stringify(previous.sources) === encoded) return;
			this.db.run(
				`INSERT INTO project_knowledge_observations VALUES (?, ?, ?, ?)
				ON CONFLICT(knowledge_id) DO UPDATE SET revision = excluded.revision, at = excluded.at, sources = excluded.sources`,
				id,
				observation.revision,
				observation.at,
				encoded,
			);
			this.markPending(
				projectId,
				id,
				"Registered sources need a check",
				`observation:${observation.revision}:${createHash("sha256").update(encoded).digest("hex")}`,
			);
			const unavailable = observation.sources.filter((source) => source.version === null);
			if (unavailable.length)
				this.recordFailure(
					projectId,
					id,
					`Unavailable coverage: ${unavailable
						.map((s) => s.coverage)
						.join("; ")
						.slice(0, 900)}`,
				);
		});
	}

	recordFailure(projectId: string, id: string, reason: string): void {
		this.db.transaction(() => {
			if (!this.entryRow(projectId, id)) throw new NotFound("Knowledge entry not found in this project");
			if (!this.summary(projectId, id)?.freshness.pending)
				this.markPending(projectId, id, "Check failed; needs another check");
			this.db.run(
				`INSERT INTO project_knowledge_checks (knowledge_id, failure_at, failure_reason) VALUES (?, ?, ?)
			ON CONFLICT(knowledge_id) DO UPDATE SET failure_at = excluded.failure_at, failure_reason = excluded.failure_reason`,
				id,
				Date.now(),
				reason.slice(0, 1000),
			);
		});
	}

	/** Atomic with canonical mutations in this database. No source fanout or worker launch. */
	invalidateMission(missionId: string, field: "decisionId" | "taskId" | "briefRevision", ref: string | number): void {
		const rows = this.db.all(
			`SELECT DISTINCT k.id, k.project_id FROM project_knowledge k
			JOIN project_knowledge_revisions r ON r.knowledge_id=k.id AND r.revision=k.revision, json_each(r.sources) s
			WHERE json_extract(s.value, '$.type')='mission' AND json_extract(s.value, '$.missionId')=?
			AND ${field === "briefRevision" ? "json_extract(s.value, '$.briefRevision') IS NOT NULL" : `json_extract(s.value, '$.${field}')=?`}`,
			missionId,
			...(field === "briefRevision" ? [] : [ref]),
		);
		for (const row of rows)
			this.markPending(
				String(row.project_id),
				String(row.id),
				"Canonical mission source changed",
				`${missionId}:${field}:${ref}:generation:${this.pendingGeneration(String(row.id)) + 1}`,
			);
	}

	/** A coordinator explicitly reuses a task. This does not create, assign, start or complete one. */
	bindDocumentationTask(projectId: string, ids: string[], missionId: string, taskId: string): void {
		this.db.transaction(() => {
			for (const id of ids) {
				if (!this.summary(projectId, id)?.freshness.pending) throw new Conflict("Entry has no pending check");
				const previous = this.check(id)?.task_id;
				if (
					previous &&
					previous !== taskId &&
					this.db.one("SELECT 1 FROM tasks WHERE id = ? AND status NOT IN ('done', 'dropped')", previous)
				)
					throw new Conflict("Reuse the existing open documentation task");
				this.db.run("UPDATE project_knowledge_checks SET task_id = ? WHERE knowledge_id = ?", taskId, id);
			}
			this.db.run("INSERT OR IGNORE INTO project_knowledge_documentation_tasks VALUES (?, ?)", missionId, taskId);
		});
	}

	/** Completion receipts carry no changed-path proof. Keep mapping explicitly unknown, not 'unaffected'. */
	invalidateDelivery(projectId: string, missionId: string, taskId: string, commit: string): void {
		const rows = this.db.all(
			`SELECT DISTINCT k.id FROM project_knowledge k
			JOIN project_knowledge_revisions r ON r.knowledge_id=k.id AND r.revision=k.revision, json_each(r.sources) s
			WHERE k.project_id=? AND json_extract(s.value, '$.type')='repository'`,
			projectId,
		);
		const origin = this.isDocumentationTask(missionId, taskId) ? "Documentation-origin delivery" : "Delivery";
		for (const row of rows)
			this.markPending(
				projectId,
				String(row.id),
				`${origin}: changed-path mapping unknown`,
				`${missionId}:task:${taskId}:commit:${commit}`,
			);
	}

	isDocumentationTask(missionId: string, taskId: string): boolean {
		return !!this.db.one(
			"SELECT 1 FROM project_knowledge_documentation_tasks WHERE mission_id = ? AND task_id = ?",
			missionId,
			taskId,
		);
	}

	/** Current canonical state, not the historical quotation/pin. Exact body pins remain in the revision. */
	missionSourceVersion(source: Extract<KnowledgeSource, { type: "mission" }>, projectId: string): unknown {
		if (this.db.one("SELECT project_id FROM missions WHERE id = ?", source.missionId)?.project_id !== projectId)
			throw new NotFound("Mission source is unavailable in this project");
		const records: unknown[] = [];
		if (source.decisionId) {
			const decision = this.db.one(
				"SELECT id, text, audience, replacement FROM decisions WHERE mission_id = ? AND id = ?",
				source.missionId,
				source.decisionId,
			);
			// Preserve pre-link observation tokens for unchanged legacy decisions.
			if (decision && !decision.replacement) delete decision.replacement;
			records.push(decision);
		}
		if (source.taskId)
			records.push(
				this.db.one(
					`SELECT t.id, t.title, t.body, t.status, t.updated_at, c.record FROM tasks t
			LEFT JOIN task_completions c ON c.task_id=t.id WHERE t.mission_id = ? AND t.id = ?`,
					source.missionId,
					source.taskId,
				),
			);
		if (source.eventId)
			records.push(
				this.db.one("SELECT * FROM events WHERE mission_id = ? AND id = ?", source.missionId, source.eventId),
			);
		if (source.briefRevision !== undefined)
			records.push(this.db.one("SELECT brief_revision FROM missions WHERE id = ?", source.missionId));
		if (!records.length)
			records.push(this.db.one("SELECT brief_revision, status FROM missions WHERE id = ?", source.missionId));
		if (records.some((record) => !record)) throw new NotFound("Registered mission source is unavailable");
		return records;
	}

	/**
	 * Host-internal: records a successful scoped check of the current revision. A newer pending generation or
	 * revision conflicts, so later triggers stay queued.
	 */
	recordCheck(
		projectId: string,
		id: string,
		check: {
			revision: number;
			pendingGeneration: number;
			checker: string;
			coverage: string;
			sourceVersions: unknown;
		},
	): void {
		this.db.transaction(() => {
			const entry = this.entryRow(projectId, id);
			if (!entry) throw new NotFound("Knowledge entry not found in this project");
			if (Number(entry.revision) !== check.revision) throw new Conflict("Knowledge changed since the check began");
			const row = this.check(id);
			if (Number(row?.pending_generation ?? 0) !== check.pendingGeneration)
				throw new Conflict("Newer pending work arrived since the check began");
			const observation = this.observation(id);
			if (
				observation &&
				(observation.revision !== check.revision ||
					JSON.stringify(observation.sources) !== JSON.stringify(check.sourceVersions))
			)
				throw new Conflict("Observed sources changed since the check began");
			this.db.run(
				`INSERT INTO project_knowledge_checks (knowledge_id, checked_revision, checked_at, checker, coverage,
				source_versions, pending_generation, cleared_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(knowledge_id) DO UPDATE SET checked_revision = excluded.checked_revision,
				checked_at = excluded.checked_at, checker = excluded.checker, coverage = excluded.coverage,
				source_versions = excluded.source_versions, cleared_generation = excluded.cleared_generation,
				pending_reasons = NULL, pending_triggers = NULL, pending_since = NULL, failure_at = NULL, failure_reason = NULL`,
				id,
				check.revision,
				Date.now(),
				check.checker,
				check.coverage,
				JSON.stringify(check.sourceVersions ?? null),
				check.pendingGeneration,
				check.pendingGeneration,
			);
		});
	}
}
