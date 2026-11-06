/** App-owned tracking storage. No mission/task foreign keys or executor effects. */
import type {
	DurableOperation,
	InsightsFindingDraft,
	InsightsLifecycle,
	InsightsWorkspaceHistoryPage,
	InsightsWorkspaceItem,
	InsightsWorkspaceOwner,
	InsightsWorkspacePage,
	InsightsWorkspaceSettings,
	InsightsWorkspaceSnapshot,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { parseInsightsBacklog } from "./insights-backlog.ts";
import { validateInsightsSettings } from "./insights-settings.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import type { KnowledgeDb } from "./project-knowledge-store.ts";

export const INSIGHTS_WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS insights_workspace_owners (
 workspace_id TEXT PRIMARY KEY, profile_home TEXT UNIQUE NOT NULL,
 authority TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
 operation_id TEXT UNIQUE NOT NULL, envelope TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insights_workspace_items (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 kind TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
 request TEXT NOT NULL, lifecycle TEXT, updated_at INTEGER NOT NULL,
 UNIQUE(workspace_id,kind,key)
);
CREATE TABLE IF NOT EXISTS insights_workspace_revisions (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 kind TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
 request TEXT NOT NULL, lifecycle TEXT, at INTEGER NOT NULL,
 UNIQUE(workspace_id,kind,key,revision)
);
CREATE TABLE IF NOT EXISTS insights_workspace_evidence (
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 finding_key TEXT NOT NULL, evidence_key TEXT NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(workspace_id,finding_key,evidence_key)
);
CREATE TABLE IF NOT EXISTS insights_workspace_patterns (
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 pattern TEXT NOT NULL, finding_key TEXT NOT NULL,
 PRIMARY KEY(workspace_id,pattern), UNIQUE(workspace_id,finding_key)
);
CREATE TABLE IF NOT EXISTS insights_workspace_receipts (
 workspace_id TEXT NOT NULL REFERENCES insights_workspace_owners(workspace_id),
 operation_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL,
 PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS insights_workspace_settings (
 workspace_id TEXT PRIMARY KEY REFERENCES insights_workspace_owners(workspace_id),
 revision INTEGER NOT NULL, settings TEXT NOT NULL, model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS insights_workspace_page ON insights_workspace_items(workspace_id,kind,seq);
CREATE INDEX IF NOT EXISTS insights_workspace_history_page ON insights_workspace_revisions(workspace_id,kind,key,seq);
`;

export interface InsightsWorkspaceAuthority {
	owner: InsightsWorkspaceOwner;
	home: string;
	projectPath: string;
}
/** Only a trusted host bridge can supply this lease. A reservation alone is not a grant. */
export interface InsightsWorkspaceAdmission {
	authority: InsightsWorkspaceAuthority;
	revision: number;
	revalidate(): void;
}
export interface InsightsWorkspaceDb extends Omit<KnowledgeDb, "changed"> {
	durable(): Promise<void>;
}

const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const lifecycleValues = ["proposed", "approved", "in_progress", "shipped", "verified", "deferred", "dismissed"];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const LIMIT = 64 * 1024;
function bytes(raw: string): void {
	if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMIT || Buffer.from(raw).toString("utf8") !== raw)
		throw new Conflict("Invalid or oversized Insights UTF-8 request");
}

export class InsightsWorkspaceStore {
	private readonly db: InsightsWorkspaceDb;
	constructor(db: InsightsWorkspaceDb) {
		this.db = db;
	}

	/** Conservative refusal fence. Old records are never migrated by a read. */
	hasLegacyRecords(): boolean {
		return !!this.db.one(`SELECT 1 FROM (
 SELECT 1 FROM insights_items UNION ALL SELECT 1 FROM insights_settings
 UNION ALL SELECT 1 FROM insights_runs UNION ALL SELECT 1 FROM insights_replacements
 UNION ALL SELECT 1 FROM insights_operations UNION ALL SELECT 1 FROM insights_revisions
 UNION ALL SELECT 1 FROM insights_evidence
 ) LIMIT 1`);
	}
	hasOwner(home: string): boolean {
		this.assertProfile(home);
		return !!this.db.one("SELECT 1 FROM insights_workspace_owners WHERE profile_home=?", home);
	}
	private assertProfile(home: string): void {
		if (this.db.one("SELECT 1 FROM insights_workspace_owners WHERE profile_home<>? LIMIT 1", home))
			throw new Conflict("workspace_foreign_profile");
	}
	private row(home: string) {
		this.assertProfile(home);
		return this.db.one("SELECT * FROM insights_workspace_owners WHERE profile_home=?", home);
	}
	private snapshot(row: NonNullable<ReturnType<InsightsWorkspaceStore["row"]>>): InsightsWorkspaceSnapshot {
		const a = JSON.parse(String(row.authority)) as InsightsWorkspaceAuthority;
		return {
			owner: a.owner,
			revision: Number(row.revision),
			state: row.state as InsightsWorkspaceSnapshot["state"],
			activation: "not_activated",
		};
	}
	current(a: InsightsWorkspaceAuthority): InsightsWorkspaceSnapshot | null {
		const row = this.row(a.home);
		if (!row) return null;
		if (!same(JSON.parse(String(row.authority)), a)) throw new Conflict("workspace_identity_changed");
		return this.snapshot(row);
	}
	/** Pin before invocation-time durability; never select a later unsaved owner. */
	async read(home: string, guard: (a: InsightsWorkspaceAuthority) => void): Promise<InsightsWorkspaceSnapshot | null> {
		const row = this.row(home);
		const authority = row ? (JSON.parse(String(row.authority)) as InsightsWorkspaceAuthority) : null;
		if (authority) guard(authority);
		await this.db.durable();
		if (!same(row, this.row(home))) throw new Conflict("workspace_changed_during_read");
		if (authority) guard(authority);
		return row ? this.snapshot(row) : null;
	}
	private validate(lease: InsightsWorkspaceAdmission, writing = false): InsightsWorkspaceSnapshot {
		lease.revalidate();
		const current = this.current(lease.authority);
		if (!current || current.revision !== lease.revision || (writing && current.state !== "reserved"))
			throw new Conflict("workspace_authority_changed");
		return current;
	}
	private receipt(id: string, operationId: string, raw: string): unknown | undefined {
		const row = this.db.one(
			"SELECT request,result FROM insights_workspace_receipts WHERE workspace_id=? AND operation_id=?",
			id,
			operationId,
		);
		if (row && row.request !== raw) throw new Conflict("workspace_operation_bytes_changed");
		return row ? JSON.parse(String(row.result)) : undefined;
	}
	/** Refusal fence only. Never turns an uncertain native journal receipt into acceptance. */
	committed(op: DurableOperation): boolean {
		return !!this.db.one(
			"SELECT 1 FROM insights_workspace_receipts WHERE workspace_id=? AND operation_id=? AND request=?",
			op.targetId,
			op.operationId,
			JSON.stringify(op),
		);
	}
	private saveReceipt(id: string, operationId: string, raw: string, result: unknown): void {
		if (Number(this.db.one("SELECT COUNT(*) n FROM insights_workspace_receipts WHERE workspace_id=?", id)!.n) >= 4096)
			throw new Conflict("workspace_receipt_capacity");
		this.db.run(
			"INSERT INTO insights_workspace_receipts VALUES (?,?,?,?)",
			id,
			operationId,
			raw,
			JSON.stringify(result),
		);
	}
	async exactReceipt(a: InsightsWorkspaceAuthority, op: DurableOperation, guard: () => void) {
		guard();
		const owner = this.current(a);
		const result = owner ? this.receipt(a.owner.workspaceId, op.operationId, JSON.stringify(op)) : undefined;
		await this.db.durable();
		guard();
		if (!same(owner, this.current(a))) throw new Conflict("workspace_authority_changed");
		return result;
	}

	async reserve(a: InsightsWorkspaceAuthority, op: DurableOperation, model: string, guard: () => void) {
		const raw = JSON.stringify(op);
		const result = this.db.transaction(() => {
			guard();
			const row = this.row(a.home);
			if (row) {
				this.current(a);
				const prior = this.receipt(a.owner.workspaceId, op.operationId, raw);
				if (prior) return prior as InsightsWorkspaceSnapshot;
				throw new Conflict("workspace_already_reserved_use_retained_operation");
			}
			if (Number(this.db.one("SELECT COUNT(*) n FROM insights_workspace_owners")!.n) >= 64)
				throw new Conflict("workspace_owner_capacity");
			this.db.run(
				"INSERT INTO insights_workspace_owners VALUES (?,?,?,1,'reserved',?,?)",
				a.owner.workspaceId,
				a.home,
				JSON.stringify(a),
				op.operationId,
				raw,
			);
			const payload = JSON.parse(op.payload);
			const settings = validateInsightsSettings(payload.settings);
			this.db.run(
				"INSERT INTO insights_workspace_settings VALUES (?,1,?,?)",
				a.owner.workspaceId,
				JSON.stringify(settings),
				model,
			);
			const snapshot = this.current(a)!;
			this.saveReceipt(a.owner.workspaceId, op.operationId, raw, snapshot);
			guard();
			return snapshot;
		});
		const committed = this.current(a);
		await this.db.durable();
		guard();
		if (!same(committed, this.current(a))) throw new Conflict("workspace_authority_changed");
		return result;
	}

	async mutate(
		lease: InsightsWorkspaceAdmission,
		op: DurableOperation,
		change:
			| { kind: "state"; state: "paused" | "revoked"; expectedRevision: number }
			| { kind: "settings"; settings: unknown; model: string; expectedRevision: number }
			| { kind: "lifecycle"; key: string; lifecycle: InsightsLifecycle; expectedRevision: number },
	): Promise<unknown> {
		const id = lease.authority.owner.workspaceId;
		const raw = JSON.stringify(op);
		const result = this.db.transaction(() => {
			const snapshot = this.validate(lease);
			const prior = this.receipt(id, op.operationId, raw);
			if (prior) return prior;
			if (change.kind === "state") {
				if (snapshot.revision !== change.expectedRevision || snapshot.state === "revoked")
					throw new Conflict("workspace_revision_changed");
				this.db.run(
					"UPDATE insights_workspace_owners SET revision=revision+1,state=? WHERE workspace_id=?",
					change.state,
					id,
				);
				const next = this.current(lease.authority)!;
				this.saveReceipt(id, op.operationId, raw, next);
				return next;
			}
			if (snapshot.state === "revoked") throw new Conflict("workspace_revoked");
			if (change.kind === "settings") {
				const settings = validateInsightsSettings(change.settings);
				const current = this.settingsNow(id);
				if (current?.revision !== change.expectedRevision)
					throw new Conflict("workspace_settings_revision_changed");
				this.db.run(
					"UPDATE insights_workspace_settings SET revision=revision+1,settings=?,model=? WHERE workspace_id=?",
					JSON.stringify(settings),
					change.model,
					id,
				);
				const next = this.settingsNow(id)!;
				this.saveReceipt(id, op.operationId, raw, next);
				return next;
			}
			if (!uuid.test(change.key) || !lifecycleValues.includes(change.lifecycle))
				throw new Conflict("Invalid finding");
			const current = this.itemNow(id, "finding", change.key);
			if (current.revision !== change.expectedRevision) throw new Conflict("workspace_finding_revision_changed");
			if (change.lifecycle === "verified" && current.lifecycle !== "shipped")
				throw new Conflict("Only shipped findings can be verified");
			this.saveItem(id, "finding", current.key, current.revision + 1, current.request, change.lifecycle);
			const next = { key: current.key, revision: current.revision + 1, lifecycle: change.lifecycle };
			this.saveReceipt(id, op.operationId, raw, next);
			return next;
		});
		const committed = this.current(lease.authority);
		await this.db.durable();
		lease.revalidate();
		if (!same(committed, this.current(lease.authority))) throw new Conflict("workspace_authority_changed");
		return result;
	}

	private settingsNow(id: string): InsightsWorkspaceSettings | null {
		const row = this.db.one("SELECT * FROM insights_workspace_settings WHERE workspace_id=?", id);
		return row
			? {
					revision: Number(row.revision),
					settings: validateInsightsSettings(JSON.parse(String(row.settings))),
					model: String(row.model),
					activationRequired: true,
				}
			: null;
	}
	async settings(lease: InsightsWorkspaceAdmission): Promise<InsightsWorkspaceSettings | null> {
		this.validate(lease);
		const result = this.settingsNow(lease.authority.owner.workspaceId);
		await this.db.durable();
		this.validate(lease);
		if (!same(result, this.settingsNow(lease.authority.owner.workspaceId)))
			throw new Conflict("workspace_settings_changed");
		return result;
	}
	private itemNow(id: string, kind: string, key: string): InsightsWorkspaceItem {
		const row = this.db.one(
			"SELECT * FROM insights_workspace_items WHERE workspace_id=? AND kind=? AND key=?",
			id,
			kind,
			key,
		);
		if (!row) throw new NotFound("Unknown workspace record");
		return {
			key: String(row.key),
			kind: row.kind as InsightsWorkspaceItem["kind"],
			revision: Number(row.revision),
			lifecycle: row.lifecycle as InsightsLifecycle | null,
			request: String(row.request),
			updatedAt: Number(row.updated_at),
		};
	}
	async item(lease: InsightsWorkspaceAdmission, kind: string, key: string) {
		this.validate(lease);
		const result = this.itemNow(lease.authority.owner.workspaceId, kind, key);
		await this.db.durable();
		this.validate(lease);
		if (!same(result, this.itemNow(lease.authority.owner.workspaceId, kind, key)))
			throw new Conflict("workspace_item_changed");
		return result;
	}
	async history(
		lease: InsightsWorkspaceAdmission,
		kind: string,
		key: string,
		cursor = 0,
	): Promise<InsightsWorkspaceHistoryPage> {
		if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Conflict("Invalid workspace cursor");
		this.validate(lease);
		const id = lease.authority.owner.workspaceId;
		this.itemNow(id, kind, key);
		const query = () =>
			this.db.all(
				"SELECT * FROM insights_workspace_revisions WHERE workspace_id=? AND kind=? AND key=? AND seq>? ORDER BY seq LIMIT 21",
				id,
				kind,
				key,
				cursor,
			);
		const rows = query();
		const items: InsightsWorkspaceHistoryPage["items"] = [];
		for (const row of rows.slice(0, 20)) {
			const item = {
				key,
				kind: kind as InsightsWorkspaceItem["kind"],
				revision: Number(row.revision),
				request: String(row.request),
				lifecycle: row.lifecycle as InsightsLifecycle | null,
				updatedAt: Number(row.at),
				cursor: Number(row.seq),
			};
			if (Buffer.byteLength(JSON.stringify([...items, item])) > 64000) break;
			items.push(item);
		}
		if (rows.length && !items.length) throw new Conflict("Workspace history response exceeds 64 KiB");
		await this.db.durable();
		this.validate(lease);
		if (!same(rows, query())) throw new Conflict("workspace_history_changed");
		return { items, nextCursor: rows.length > items.length ? items.at(-1)!.cursor : null };
	}
	async writeReceipt(lease: InsightsWorkspaceAdmission, operationId: string, originalRequest: string) {
		bytes(originalRequest);
		this.validate(lease);
		const id = lease.authority.owner.workspaceId;
		const result = this.receipt(id, operationId, originalRequest);
		await this.db.durable();
		this.validate(lease);
		if (!same(result, this.receipt(id, operationId, originalRequest)))
			throw new Conflict("workspace_receipt_changed");
		return result === undefined ? { state: "unknown" as const } : { state: "committed" as const, receipt: result };
	}
	async page(
		lease: InsightsWorkspaceAdmission,
		kind: "finding" | "report",
		cursor = 0,
	): Promise<InsightsWorkspacePage> {
		if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Conflict("Invalid workspace cursor");
		const workspace = this.validate(lease);
		const query = () =>
			this.db.all(
				"SELECT seq,key,revision,lifecycle,request,updated_at FROM insights_workspace_items WHERE workspace_id=? AND kind=? AND seq>? ORDER BY seq LIMIT 21",
				workspace.owner.workspaceId,
				kind,
				cursor,
			);
		const rows = query();
		const items: InsightsWorkspacePage["items"] = [];
		for (const row of rows.slice(0, 20)) {
			const parsed = parseInsightsBacklog(JSON.parse(String(row.request)));
			const draft = "draft" in parsed ? parsed.draft : null;
			const item = {
				key: String(row.key),
				revision: Number(row.revision),
				lifecycle: row.lifecycle as InsightsLifecycle | null,
				title: draft?.title ?? ("record" in parsed ? parsed.record.windowEnd : "Report"),
				priority: draft?.priority ?? null,
				targets: draft?.targets ?? [],
				cost: draft?.cost ?? null,
				updatedAt: Number(row.updated_at),
			};
			if (Buffer.byteLength(JSON.stringify([...items, item])) > 60000) break;
			items.push(item);
		}
		await this.db.durable();
		this.validate(lease);
		if (!same(rows, query())) throw new Conflict("workspace_page_changed");
		return {
			schemaVersion: 2,
			state: "available",
			reason: null,
			workspace,
			items,
			nextCursor: rows.length > items.length ? Number(rows[items.length - 1]!.seq) : null,
		};
	}
	private saveItem(
		id: string,
		kind: string,
		key: string,
		revision: number,
		raw: string,
		lifecycle: InsightsLifecycle | null,
	) {
		if (
			Buffer.byteLength(JSON.stringify({ key, kind, revision, request: raw, lifecycle, updatedAt: Date.now() })) >
			LIMIT
		)
			throw new Conflict("Workspace record response exceeds 64 KiB");
		if (
			Number(this.db.one("SELECT COUNT(*) n FROM insights_workspace_revisions WHERE workspace_id=?", id)!.n) >= 4096
		)
			throw new Conflict("workspace_record_capacity");
		const now = Date.now();
		this.db.run(
			"INSERT INTO insights_workspace_items(workspace_id,kind,key,revision,request,lifecycle,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,kind,key) DO UPDATE SET revision=excluded.revision,request=excluded.request,lifecycle=excluded.lifecycle,updated_at=excluded.updated_at",
			id,
			kind,
			key,
			revision,
			raw,
			lifecycle,
			now,
		);
		this.db.run(
			"INSERT INTO insights_workspace_revisions(workspace_id,kind,key,revision,request,lifecycle,at) VALUES (?,?,?,?,?,?,?)",
			id,
			kind,
			key,
			revision,
			raw,
			lifecycle,
			now,
		);
	}

	/** Trusted bridge only. Keeps original request bytes, never projects to a task. */
	async write(lease: InsightsWorkspaceAdmission, raw: string): Promise<unknown> {
		bytes(raw);
		const x = parseInsightsBacklog(JSON.parse(raw));
		if (!["propose", "amend", "save_report", "save_checkpoint"].includes(x.action) || !("expectedRevision" in x))
			throw new Conflict("Expected a workspace tracking write");
		const id = lease.authority.owner.workspaceId;
		const result = this.db.transaction(() => {
			this.validate(lease, true);
			const priorReceipt = this.receipt(id, x.operationId, raw);
			if (priorReceipt) return priorReceipt;
			const finding = "draft" in x;
			const kind = finding ? "finding" : x.action === "save_report" ? "report" : "checkpoint";
			const row = this.db.one(
				"SELECT 1 FROM insights_workspace_items WHERE workspace_id=? AND kind=? AND key=?",
				id,
				kind,
				x.key,
			);
			const prior = row ? this.itemNow(id, kind, x.key) : null;
			if ((prior?.revision ?? 0) !== x.expectedRevision) throw new Conflict("workspace_record_revision_changed");
			if (finding && (x.action === "propose" ? !!prior : !prior))
				throw new Conflict("Invalid finding creation/amendment");
			if (finding) {
				if (x.patternKey) {
					const pattern = this.db.one(
						"SELECT pattern,finding_key FROM insights_workspace_patterns WHERE workspace_id=? AND (pattern=? OR finding_key=?)",
						id,
						x.patternKey,
						x.key,
					);
					if (pattern && (pattern.pattern !== x.patternKey || pattern.finding_key !== x.key))
						throw new Conflict("workspace_pattern_already_recorded");
					this.db.run("INSERT OR IGNORE INTO insights_workspace_patterns VALUES (?,?,?)", id, x.patternKey, x.key);
				}
				if (prior) {
					const old = parseInsightsBacklog(JSON.parse(prior.request));
					if (!("draft" in old)) throw new Conflict("Invalid stored finding");
					if (old.draft.implementationLinks.some((link) => !x.draft.implementationLinks.includes(link)))
						throw new Conflict("Implementation links are append-only");
					const scope = (d: InsightsFindingDraft) => ({
						...d,
						implementationLinks: [],
						...(d.cost ? { cost: { ...d.cost, laterResult: "" } } : {}),
					});
					if (prior.lifecycle !== "proposed" && !same(scope(old.draft), scope(x.draft)))
						throw new Conflict("Confirmed finding scope is frozen");
				}
				for (const e of x.evidence) {
					const payload = canonicalJSON({ ...e, host: lease.authority.owner.expectedHome });
					const old = this.db.one(
						"SELECT payload FROM insights_workspace_evidence WHERE workspace_id=? AND finding_key=? AND evidence_key=?",
						id,
						x.key,
						e.key,
					);
					if (old && old.payload !== payload) throw new Conflict("Evidence is immutable");
					this.db.run(
						"INSERT OR IGNORE INTO insights_workspace_evidence VALUES (?,?,?,?)",
						id,
						x.key,
						e.key,
						payload,
					);
				}
			} else if ("record" in x) {
				for (const key of x.record.findingKeys) this.itemNow(id, "finding", key);
				// A record is a claim, not a completed host review or certified source cursor.
				if (x.record.status === "completed") throw new Conflict("Workspace reports must remain partial claims");
				const seen = new Set<string>();
				const old = prior ? parseInsightsBacklog(JSON.parse(prior.request)) : null;
				for (const point of x.record.checkpoints) {
					if (seen.has(point.sessionId)) throw new Conflict("Duplicate checkpoint session");
					seen.add(point.sessionId);
					const before =
						old && "record" in old ? old.record.checkpoints.find((p) => p.sessionId === point.sessionId) : null;
					if (
						(!point.streamId || (before && before.streamId !== point.streamId)) &&
						(!point.gaps.length || point.coverage === "sampled")
					)
						throw new Conflict("Unknown stream requires a gap");
					if (
						before?.streamId === point.streamId &&
						before?.throughEntry != null &&
						point.throughEntry !== null &&
						point.throughEntry < before.throughEntry &&
						!point.gaps.length
					)
						throw new Conflict("Checkpoint regression requires a gap");
				}
			}
			const revision = x.expectedRevision + 1;
			this.saveItem(id, kind, x.key, revision, raw, finding ? (prior?.lifecycle ?? "proposed") : null);
			const receipt = { operationId: x.operationId, kind, key: x.key, revision, requestHash: payloadHash(raw) };
			this.saveReceipt(id, x.operationId, raw, receipt);
			this.validate(lease, true);
			return receipt;
		});
		await this.db.durable();
		this.validate(lease, true);
		return result;
	}
}
