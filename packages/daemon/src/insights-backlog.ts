/** Closed own-backlog persistence. No scheduler, worker, repository or repair effects. */
import { createHash } from "node:crypto";
import type {
	InsightsBacklogRequest,
	InsightsCheckpoint,
	InsightsEvidence,
	InsightsFindingDraft,
	InsightsLifecycle,
	InsightsReviewRecord,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { InsightsAdmission } from "./insights-admission.ts";
import { INSIGHTS_REPLACEMENT_SCHEMA, InsightsReplacementStore } from "./insights-replacement-store.ts";
import { INSIGHTS_REVIEW_SCHEMA, InsightsReviews } from "./insights-review.ts";
import { INSIGHTS_SETTINGS_SCHEMA, InsightsSettings } from "./insights-settings.ts";
import type { KnowledgeDb } from "./project-knowledge-store.ts";

export const INSIGHTS_SCHEMA = `${INSIGHTS_REVIEW_SCHEMA}${INSIGHTS_SETTINGS_SCHEMA}${INSIGHTS_REPLACEMENT_SCHEMA}
CREATE TABLE IF NOT EXISTS insights_items (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
 task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
 payload TEXT NOT NULL, lifecycle TEXT, updated_at INTEGER NOT NULL,
 UNIQUE(mission_id, kind, key)
);
CREATE TABLE IF NOT EXISTS insights_revisions (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
 lifecycle TEXT, authority TEXT, at INTEGER NOT NULL, UNIQUE(mission_id, kind, key, revision)
);
CREATE TABLE IF NOT EXISTS insights_evidence (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 finding_key TEXT NOT NULL, evidence_key TEXT NOT NULL, payload TEXT NOT NULL,
 UNIQUE(mission_id, finding_key, evidence_key)
);
CREATE INDEX IF NOT EXISTS insights_evidence_page ON insights_evidence(mission_id, finding_key, seq);
CREATE INDEX IF NOT EXISTS insights_history_page ON insights_revisions(mission_id, key, seq);
CREATE TABLE IF NOT EXISTS insights_operations (
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 result TEXT NOT NULL, PRIMARY KEY(mission_id, session_id, operation_id)
);
`;

type ObjectValue = Record<string, unknown>;
function object(v: unknown, allowed: string[]): ObjectValue {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Conflict("Expected an object");
	if (Object.keys(v).some((k) => !allowed.includes(k))) throw new Conflict("Unknown Insights field");
	return v as ObjectValue;
}
function string(v: unknown, max = 1000): string {
	if (typeof v !== "string" || !v.trim() || v.length > max) throw new Conflict("Invalid Insights text");
	return v;
}
function uuid(v: unknown): string {
	const s = string(v, 36);
	if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(s)) throw new Conflict("Expected a lowercase UUID");
	return s;
}
function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max)
		throw new Conflict("Invalid Insights integer");
	return v;
}
function choice<T extends string>(v: unknown, values: readonly T[]): T {
	if (!values.includes(v as T)) throw new Conflict("Invalid Insights selector");
	return v as T;
}
function array<T>(v: unknown, max: number, parse: (v: unknown) => T): T[] {
	if (
		!Array.isArray(v) ||
		v.length > max ||
		Object.keys(v).length !== v.length ||
		Object.keys(v).some((k, i) => k !== String(i))
	)
		throw new Conflict("Expected a bounded dense array");
	return v.map(parse);
}
function date(v: unknown): string {
	const s = string(v, 40);
	if (!/^\d{4}-\d\d-\d\dT/u.test(s) || !Number.isFinite(Date.parse(s))) throw new Conflict("Expected an ISO date");
	return s;
}
function operation(v: unknown): string {
	const s = string(v, 128);
	if (!/^[\x21-\x7e]+$/u.test(s)) throw new Conflict("Invalid operation ID");
	return s;
}
function draft(v: unknown): InsightsFindingDraft {
	const x = object(v, [
		"title",
		"priority",
		"observation",
		"uncertainty",
		"proposedChange",
		"expectedBenefit",
		"targets",
		"implementationLinks",
		"cost",
	]);
	const result: InsightsFindingDraft = {
		title: string(x.title, 200),
		priority: choice(x.priority, ["low", "medium", "high"]),
		observation: string(x.observation),
		uncertainty: string(x.uncertainty),
		proposedChange: string(x.proposedChange),
		expectedBenefit: string(x.expectedBenefit),
		targets: array(x.targets, 8, (v) => {
			const t = object(v, ["projectId", "label"]);
			return { projectId: string(t.projectId, 128), label: string(t.label, 200) };
		}),
		implementationLinks: array(x.implementationLinks, 20, (v) => {
			const url = string(v, 512);
			if (!/^(https:\/\/|pilot:\/\/)/u.test(url)) throw new Conflict("Invalid reference link");
			return url;
		}),
	};
	if (x.cost !== undefined) {
		const c = object(x.cost, ["baseline", "assumptions", "estimate", "qualityRisks", "laterResult"]);
		result.cost = {
			baseline: string(c.baseline),
			assumptions: string(c.assumptions),
			estimate: string(c.estimate),
			qualityRisks: string(c.qualityRisks),
			laterResult: string(c.laterResult),
		};
	}
	return result;
}
function evidence(v: unknown): InsightsEvidence {
	const x = object(v, ["key", "sessionId", "ref", "observedAt", "classification", "summary"]);
	return {
		key: uuid(x.key),
		sessionId: uuid(x.sessionId),
		ref: string(x.ref, 512),
		observedAt: date(x.observedAt),
		classification: choice(x.classification, ["observed", "inferred"]),
		summary: string(x.summary),
	};
}
function checkpoint(v: unknown): InsightsCheckpoint {
	const x = object(v, ["sessionId", "streamId", "before", "after", "throughEntry", "coverage", "gaps"]);
	return {
		sessionId: uuid(x.sessionId),
		streamId: x.streamId === null ? null : string(x.streamId, 128),
		before: x.before === null ? null : integer(x.before),
		after: x.after === null ? null : uuid(x.after),
		throughEntry: x.throughEntry === null ? null : integer(x.throughEntry),
		coverage: choice(x.coverage, ["partial", "unavailable", "sampled"]),
		gaps: array(x.gaps, 8, (v) => string(v, 500)),
	};
}
function record(v: unknown): InsightsReviewRecord {
	const x = object(v, ["status", "windowStart", "windowEnd", "markdown", "checkpoints", "findingKeys", "gaps"]);
	const result: InsightsReviewRecord = {
		status: choice(x.status, ["partial", "interrupted", "completed"]),
		windowStart: date(x.windowStart),
		windowEnd: date(x.windowEnd),
		markdown: string(x.markdown, 16000),
		checkpoints: array(x.checkpoints, 20, checkpoint),
		findingKeys: array(x.findingKeys, 20, uuid),
		gaps: array(x.gaps, 20, (v) => string(v, 500)),
	};
	if (Date.parse(result.windowEnd) < Date.parse(result.windowStart)) throw new Conflict("Invalid review window");
	return result;
}

/** Validate forged IPC independently of the tool schema. Canonical order also binds idempotency. */
export function parseInsightsBacklog(input: unknown): InsightsBacklogRequest {
	const action = object(input, [
		"action",
		"kind",
		"key",
		"cursor",
		"limit",
		"operationId",
		"expectedRevision",
		"draft",
		"evidence",
		"record",
		"patternKey",
	]).action;
	const fields: Record<string, string[]> = {
		review_context: ["cursor"],
		list: ["kind", "cursor", "limit"],
		get: ["kind", "key"],
		history: ["kind", "key", "cursor", "limit"],
		evidence: ["key", "cursor", "limit"],
		receipt: ["operationId"],
		propose: ["key", "expectedRevision", "operationId", "draft", "evidence", "patternKey"],
		amend: ["key", "expectedRevision", "operationId", "draft", "evidence", "patternKey"],
		save_report: ["key", "expectedRevision", "operationId", "record"],
		save_checkpoint: ["key", "expectedRevision", "operationId", "record"],
	};
	if (typeof action !== "string" || !Object.hasOwn(fields, action)) throw new Conflict("Unknown Insights action");
	const x = object(input, ["action", ...fields[action]!]);
	if (action === "review_context") return { action, ...(x.cursor === undefined ? {} : { cursor: integer(x.cursor) }) };
	if (action === "receipt") return { action, operationId: operation(x.operationId) };
	if (action === "list" || action === "history" || action === "evidence") {
		const page = {
			...(x.cursor === undefined ? {} : { cursor: integer(x.cursor) }),
			...(x.limit === undefined ? {} : { limit: integer(x.limit, 20) }),
		};
		if (page.limit === 0) throw new Conflict("Page limit must be positive");
		if (action === "list") return { action, kind: choice(x.kind, ["finding", "report", "checkpoint"]), ...page };
		if (action === "history")
			return { action, kind: choice(x.kind, ["finding", "report", "checkpoint"]), key: uuid(x.key), ...page };
		return { action, key: uuid(x.key), ...page };
	}
	const key = uuid(x.key);
	if (action === "get") return { action, key, kind: choice(x.kind, ["finding", "report", "checkpoint"]) };
	const common = { key, expectedRevision: integer(x.expectedRevision), operationId: operation(x.operationId) };
	if (action === "propose" || action === "amend")
		return {
			action,
			...common,
			draft: draft(x.draft),
			evidence: array(x.evidence, 20, evidence),
			...(x.patternKey === undefined
				? {}
				: { patternKey: string(x.patternKey, 200).trim().toLowerCase().replace(/\s+/gu, " ") }),
		};
	return { action: action as "save_report" | "save_checkpoint", ...common, record: record(x.record) };
}

export interface InsightsDb extends KnowledgeDb {
	durable(): Promise<void>;
	validateMission(missionId: string, projectId: string): void;
	createTask(missionId: string, draft: InsightsFindingDraft, sessionId: string): string;
	projectTask(missionId: string, taskId: string, draft: InsightsFindingDraft, lifecycle: InsightsLifecycle): void;
}

export class InsightsBacklog {
	private readonly db: InsightsDb;
	readonly reviews: InsightsReviews;
	readonly settings: InsightsSettings;
	readonly replacements: InsightsReplacementStore;
	constructor(db: InsightsDb) {
		this.db = db;
		this.reviews = new InsightsReviews(db);
		this.settings = new InsightsSettings(db);
		this.replacements = new InsightsReplacementStore(db);
	}
	/** Finding tracking tasks must not be edited, claimed or executed through generic task APIs. */
	assertOrdinaryTask(taskId: string): void {
		if (this.db.one("SELECT 1 FROM insights_items WHERE task_id=?", taskId))
			throw new Conflict(
				"Finding tracking record: use scoped finding maintenance; implementation needs a separate approved task",
			);
	}
	private validate(admission: InsightsAdmission): string {
		admission.revalidate();
		this.db.validateMission(admission.binding.missionId, admission.binding.projectId);
		return admission.binding.missionId;
	}
	async call(admission: InsightsAdmission, input: unknown): Promise<unknown> {
		const request = parseInsightsBacklog(input);
		if (Buffer.byteLength(JSON.stringify(request)) > 64000) throw new Conflict("Insights request exceeds 64 KB");
		const result = this.db.transaction(() => {
			const mission = this.validate(admission);
			const session = admission.binding.reportSessionId;
			const x = request;
			if (x.action === "review_context") return this.reviews.context(admission, x.cursor ?? 0);
			if (x.action === "receipt") {
				const row = this.db.one(
					"SELECT result FROM insights_operations WHERE mission_id=? AND session_id=? AND operation_id=?",
					mission,
					session,
					x.operationId,
				);
				return row ? { state: "committed", receipt: JSON.parse(row.result as string) } : { state: "unknown" };
			}
			if (x.action === "list") {
				const rows = this.db.all(
					"SELECT seq AS cursor, kind, key, revision, task_id AS taskId, lifecycle, updated_at AS updatedAt FROM insights_items WHERE mission_id=? AND kind=? AND seq>? ORDER BY seq LIMIT ?",
					mission,
					x.kind,
					x.cursor ?? 0,
					(x.limit ?? 20) + 1,
				);
				return this.page(rows, x.limit ?? 20);
			}
			if (x.action === "get") return this.item(mission, x.kind, x.key);
			if (x.action === "history" || x.action === "evidence") {
				this.item(mission, x.action === "history" ? x.kind : "finding", x.key);
				const rows =
					x.action === "history"
						? this.db.all(
								"SELECT seq AS cursor, revision, payload, lifecycle, authority, at FROM insights_revisions WHERE mission_id=? AND kind=? AND key=? AND seq>? ORDER BY seq LIMIT ?",
								mission,
								x.kind,
								x.key,
								x.cursor ?? 0,
								(x.limit ?? 20) + 1,
							)
						: this.db.all(
								"SELECT seq AS cursor, payload FROM insights_evidence WHERE mission_id=? AND finding_key=? AND seq>? ORDER BY seq LIMIT ?",
								mission,
								x.key,
								x.cursor ?? 0,
								(x.limit ?? 20) + 1,
							);
				return this.page(
					rows.map((r) => ({ ...r, payload: JSON.parse(r.payload as string) })),
					x.limit ?? 20,
				);
			}
			if (!("expectedRevision" in x)) throw new Conflict("Invalid write");
			const hash = createHash("sha256")
				.update(JSON.stringify({ binding: admission.binding, request: x }))
				.digest("hex");
			const old = this.db.one(
				"SELECT request_hash, result FROM insights_operations WHERE mission_id=? AND session_id=? AND operation_id=?",
				mission,
				session,
				x.operationId,
			);
			if (old) {
				if (old.request_hash !== hash) throw new Conflict("Operation ID already used with another request");
				return JSON.parse(old.result as string);
			}
			const finding = "draft" in x;
			const kind = finding ? "finding" : x.action === "save_report" ? "report" : "checkpoint";
			const previous = this.db.one(
				"SELECT * FROM insights_items WHERE mission_id=? AND kind=? AND key=?",
				mission,
				kind,
				x.key,
			);
			if (Number(previous?.revision ?? 0) !== x.expectedRevision)
				throw new Conflict("Insights revision changed; read before amending");
			if (finding && (x.action === "propose" ? !!previous : !previous))
				throw new Conflict("Propose requires a new key; amend requires an existing finding");
			const revision = x.expectedRevision + 1;
			const lifecycle = finding ? ((previous?.lifecycle as InsightsLifecycle | undefined) ?? "proposed") : null;
			let taskId = previous?.task_id as string | undefined;
			if (finding) {
				this.reviews.pattern(admission, x.key, x.patternKey);
				if (previous) {
					const oldDraft = JSON.parse(previous.payload as string) as InsightsFindingDraft;
					if (oldDraft.implementationLinks.some((link) => !x.draft.implementationLinks.includes(link)))
						throw new Conflict("Implementation references are append-only");
					const subject = (d: InsightsFindingDraft) =>
						JSON.stringify({
							...d,
							implementationLinks: [],
							...(d.cost ? { cost: { ...d.cost, laterResult: "" } } : {}),
						});
					if (lifecycle !== "proposed" && subject(oldDraft) !== subject(x.draft))
						throw new Conflict(
							"User-confirmed finding scope is frozen; append evidence/links/result claims only",
						);
				}
				// New evidence cannot replace an earlier observation, even with a new operation ID.
				for (const e of x.evidence) {
					const payload = JSON.stringify({ ...e, host: admission.binding.host });
					const prior = this.db.one(
						"SELECT payload FROM insights_evidence WHERE mission_id=? AND finding_key=? AND evidence_key=?",
						mission,
						x.key,
						e.key,
					);
					if (prior && prior.payload !== payload)
						throw new Conflict("Evidence keys are immutable; append a correction with a new key");
					this.db.run(
						"INSERT OR IGNORE INTO insights_evidence(mission_id,finding_key,evidence_key,payload) VALUES (?,?,?,?)",
						mission,
						x.key,
						e.key,
						payload,
					);
				}
				taskId ??= this.db.createTask(mission, x.draft, session);
				this.db.projectTask(mission, taskId, x.draft, lifecycle!);
			} else {
				for (const key of x.record.findingKeys) this.item(mission, "finding", key);
				const priorRecord = previous ? (JSON.parse(previous.payload as string) as InsightsReviewRecord) : undefined;
				const sessions = new Set<string>();
				for (const point of x.record.checkpoints) {
					if (sessions.has(point.sessionId)) throw new Conflict("Duplicate checkpoint session");
					sessions.add(point.sessionId);
					const prior = priorRecord?.checkpoints.find((p) => p.sessionId === point.sessionId);
					if (
						(!point.streamId || (prior && prior.streamId !== point.streamId)) &&
						(!point.gaps.length || point.coverage === "sampled")
					)
						throw new Conflict("Unknown or changed streams require an explicit partial/unavailable gap");
					if (
						prior &&
						point.streamId &&
						point.streamId === prior.streamId &&
						prior.throughEntry !== null &&
						point.throughEntry !== null &&
						point.throughEntry < prior.throughEntry &&
						!point.gaps.length
					)
						throw new Conflict("Checkpoint regression requires an explicit gap");
				}
			}
			const payload = JSON.stringify(
				finding
					? x.draft
					: {
							...(x.action === "save_report" ? this.reviews.finish(admission, x.key, x.record) : x.record),
							authority: "review_claim_only",
							host: admission.binding.host,
						},
			);
			this.save(mission, kind, x.key, revision, taskId, payload, lifecycle);
			const receipt = { operationId: x.operationId, kind, key: x.key, revision, taskId: taskId ?? null };
			this.db.run(
				"INSERT INTO insights_operations(mission_id,session_id,operation_id,request_hash,result) VALUES (?,?,?,?,?)",
				mission,
				session,
				x.operationId,
				hash,
				JSON.stringify(receipt),
			);
			this.validate(admission);
			return receipt;
		});
		await this.db.durable();
		if (request.action === "save_report") this.reviews.changed();
		if (["propose", "amend", "save_report", "save_checkpoint"].includes(request.action))
			this.db.changed(admission.binding.missionId);
		this.validate(admission);
		if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024)
			throw new Conflict("Insights response exceeds 64 KiB; use a smaller page");
		return result;
	}
	private page<T extends Record<string, unknown>>(rows: T[], limit: number) {
		const items: T[] = [];
		let bytes = 0;
		for (const row of rows.slice(0, limit)) {
			const size = Buffer.byteLength(JSON.stringify(row));
			if (items.length && bytes + size > 64000) break;
			items.push(row);
			bytes += size;
		}
		return { items, nextCursor: rows.length > items.length ? items.at(-1)!.cursor : null };
	}
	private item(mission: string, kind: string, key: string) {
		const row = this.db.one(
			"SELECT key, revision, task_id AS taskId, lifecycle, payload, updated_at AS updatedAt FROM insights_items WHERE mission_id=? AND kind=? AND key=?",
			mission,
			kind,
			key,
		);
		if (!row) throw new NotFound("Unknown own-backlog record");
		const pattern =
			kind === "finding"
				? this.db.one("SELECT pattern FROM insights_patterns WHERE mission_id=? AND finding_key=?", mission, key)
				: undefined;
		return {
			key: String(row.key),
			...(pattern ? { patternKey: String(pattern.pattern) } : {}),
			revision: Number(row.revision),
			taskId: row.taskId === null ? null : String(row.taskId),
			lifecycle: row.lifecycle as InsightsLifecycle | null,
			updatedAt: Number(row.updatedAt),
			payload: JSON.parse(row.payload as string),
		};
	}
	private save(
		mission: string,
		kind: string,
		key: string,
		revision: number,
		taskId: string | undefined,
		payload: string,
		lifecycle: InsightsLifecycle | null,
		authority: string | null = null,
	) {
		const now = Date.now();
		this.db.run(
			"INSERT INTO insights_items(mission_id,kind,key,revision,task_id,payload,lifecycle,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(mission_id,kind,key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,lifecycle=excluded.lifecycle,updated_at=excluded.updated_at",
			mission,
			kind,
			key,
			revision,
			taskId ?? null,
			payload,
			lifecycle,
			now,
		);
		this.db.run(
			"INSERT INTO insights_revisions(mission_id,kind,key,revision,payload,lifecycle,authority,at) VALUES (?,?,?,?,?,?,?,?)",
			mission,
			kind,
			key,
			revision,
			payload,
			lifecycle,
			authority,
			now,
		);
	}
	/** Host-only explicit user confirmation seam, NOT a model tool or generic mission write.
	 * The native action must supply its own durable operation ID, never an ID copied from model prose.
	 * No workers are started. Automatic delivery/benefit inference is deliberately unsupported.
	 */
	async confirmLifecycle(
		admission: InsightsAdmission,
		key: string,
		expectedRevision: number,
		lifecycle: InsightsLifecycle,
		operationId: string,
	): Promise<unknown> {
		uuid(key);
		integer(expectedRevision);
		operation(operationId);
		choice(lifecycle, ["proposed", "approved", "in_progress", "shipped", "verified", "deferred", "dismissed"]);
		const result = this.db.transaction(() => {
			const mission = this.validate(admission);
			const session = admission.binding.reportSessionId;
			const hash = createHash("sha256")
				.update(
					JSON.stringify({
						action: "user_lifecycle",
						key,
						expectedRevision,
						lifecycle,
						binding: admission.binding,
					}),
				)
				.digest("hex");
			const old = this.db.one(
				"SELECT request_hash,result FROM insights_operations WHERE mission_id=? AND session_id=? AND operation_id=?",
				mission,
				session,
				operationId,
			);
			if (old) {
				if (old.request_hash !== hash) throw new Conflict("Operation ID already used");
				return JSON.parse(old.result as string);
			}
			const current = this.item(mission, "finding", key);
			if (current.revision !== expectedRevision) throw new Conflict("Insights revision changed");
			if (lifecycle === "verified" && current.lifecycle !== "shipped")
				throw new Conflict("Only shipped findings can be verified by the user");
			const revision = expectedRevision + 1;
			this.db.projectTask(mission, current.taskId as string, current.payload, lifecycle);
			this.save(
				mission,
				"finding",
				key,
				revision,
				current.taskId as string,
				JSON.stringify(current.payload),
				lifecycle,
				"explicit_user_confirmation",
			);
			const receipt = { operationId, kind: "finding", key, revision, taskId: current.taskId };
			this.db.run(
				"INSERT INTO insights_operations VALUES (?,?,?,?,?)",
				mission,
				session,
				operationId,
				hash,
				JSON.stringify(receipt),
			);
			this.validate(admission);
			return receipt;
		});
		await this.db.durable();
		this.db.changed(admission.binding.missionId);
		this.validate(admission);
		return result;
	}
}
