/** Small, indexed daemon-owned SQLite store. No network or agent loop lives here. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
	InboxHiddenLabel,
	LinearSourceSummary,
	SessionPullRequest,
	SlackCorrection,
	SlackOverrides,
	SlackTriage,
	TrackedItem,
	TrackedItemList,
	TrackedItemPatch,
	TrackedKind,
	TrackingJson,
} from "@pilot/protocol";
import { NotFound } from "./errors.ts";
import { parseSlackClassification, type SlackClassification } from "./slack-classifier.ts";

export type SlackCache = { state: "pending" | "error" } | { state: "done"; result: SlackClassification };
export type SlackReservation = SlackCache | { state: "reserved" } | { state: "budget" };
export const SLACK_DAILY_BUDGET = 100;

export type TrackedInput = Pick<TrackedItem, "externalId" | "title" | "url" | "status" | "metadata" | "updatedAt">;
export interface SlackPullRequestObservation {
	projectId: string;
	sessionId: string;
	prs: SessionPullRequest[];
	/** Unknown explicitly bound heads must not count as merged. */
	pending: boolean;
}
export interface SourceCheckpoint {
	configKey: string;
	lastPolledAt: number;
	cursor?: TrackingJson;
	linear?: LinearSourceSummary;
}
type Row = {
	id: string;
	project_id: string;
	kind: TrackedKind;
	external_id: string;
	title: string;
	url: string;
	status: string;
	metadata: string;
	dismissed: number;
	session_id: string | null;
	mission_id: string | null;
	links: string | null;
	linear_start: string | null;
	slack_start: string | null;
	slack_overrides: string;
	slack_status: SlackTriage["status"];
	closed_by_label: string | null;
	slack_completion: string;
	created_at: number;
	updated_at: number;
};
export interface TrackedQuery {
	projectId: string;
	kind?: TrackedKind;
	/** Internal scope guard for mixed-source lists. */
	kinds?: TrackedKind[];
	dismissed?: boolean;
	/** Only Slack messages a close label dismissed. Implies dismissed. */
	closedByLabel?: boolean;
	limit?: number;
	offset?: number;
}
/** Projects whose synced sources the Inbox lists, with each project's hidden Slack labels. */
export interface InboxQuery {
	linear: string[];
	slack: Array<{ projectId: string; hidden: string[] }>;
	limit: number;
}
export interface InboxTracked {
	linear: TrackedItemList;
	slack: TrackedItemList & { hidden: InboxHiddenLabel[] };
}
// What the Inbox lists: my Linear tickets not done, and Slack messages still open or in progress.
const LINEAR_OPEN =
	"kind = 'linear' AND active = 1 AND dismissed = 0 AND coalesce(json_extract(metadata, '$.statusType'), '') NOT IN ('completed', 'canceled')";
const SLACK_OPEN = "kind = 'slack' AND active = 1 AND dismissed = 0 AND slack_status IN ('open', 'in_progress')";
/** The effective label: a user override (an explicit null clears it) wins over the classifier's. */
const SLACK_LABEL =
	"CASE WHEN json_type(slack_overrides, '$.label') IS NOT NULL THEN json_extract(slack_overrides, '$.label') ELSE json_extract(metadata, '$.label') END";
/** Pairs of [projectId, label] in the second parameter. */
const SLACK_HIDDEN = `EXISTS (SELECT 1 FROM json_each(?) AS hidden WHERE json_extract(hidden.value, '$[0]') = project_id AND json_extract(hidden.value, '$[1]') = ${SLACK_LABEL})`;
const IN_PROJECTS = "project_id IN (SELECT value FROM json_each(?))";
/** Labels in the bound JSON array. A missing label never matches (configured names are never empty). */
const SLACK_LABEL_IN = `coalesce(${SLACK_LABEL}, '') IN (SELECT value FROM json_each(?))`;

export class TrackedItemDisk {
	private readonly db: DatabaseSync;
	private readonly listeners = new Set<(projectId: string) => void>();
	/** Each project's close labels, as last set by the daemon. A project without an entry is never reconciled. */
	private readonly closeLabels = new Map<string, string>();
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode=WAL;
			BEGIN IMMEDIATE;
			CREATE TABLE IF NOT EXISTS tracked_items (
			 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
			 title TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, metadata TEXT NOT NULL,
			 dismissed INTEGER NOT NULL DEFAULT 0, session_id TEXT, mission_id TEXT,
			 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
			 UNIQUE(project_id, kind, external_id)
			);
			CREATE INDEX IF NOT EXISTS tracked_project_kind ON tracked_items(project_id, kind, dismissed, updated_at DESC, id);
			CREATE INDEX IF NOT EXISTS tracked_project ON tracked_items(project_id, dismissed, updated_at DESC, id);
			CREATE TABLE IF NOT EXISTS source_checkpoints (id TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS slack_classifications (
			 channel TEXT NOT NULL, thread_ts TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
			 PRIMARY KEY(channel, thread_ts)
			);
			CREATE TABLE IF NOT EXISTS slack_budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL);
		`);
		if (
			!this.db
				.prepare("PRAGMA table_info(tracked_items)")
				.all()
				.some((column) => column.name === "active")
		)
			this.db.exec("ALTER TABLE tracked_items ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
		if (
			!this.db
				.prepare("PRAGMA table_info(tracked_items)")
				.all()
				.some((column) => column.name === "links")
		)
			this.db.exec("ALTER TABLE tracked_items ADD COLUMN links TEXT");
		if (
			!this.db
				.prepare("PRAGMA table_info(tracked_items)")
				.all()
				.some((column) => column.name === "linear_start")
		)
			this.db.exec("ALTER TABLE tracked_items ADD COLUMN linear_start TEXT");
		if (
			!this.db
				.prepare("PRAGMA table_info(tracked_items)")
				.all()
				.some((column) => column.name === "slack_start")
		)
			this.db.exec("ALTER TABLE tracked_items ADD COLUMN slack_start TEXT");
		// A prior process may have exited after admission but before the remote result was durable.
		this.db
			.prepare(`UPDATE tracked_items SET slack_start=json_set(slack_start, '$.outcome', 'error',
			'$.error', ?) WHERE slack_start IS NOT NULL AND json_extract(slack_start, '$.outcome') IS NULL`)
			.run("Couldn't add eyes reaction in Slack.");
		const columns = this.db.prepare("PRAGMA table_info(tracked_items)").all();
		if (!columns.some((column) => column.name === "slack_overrides"))
			this.db.exec("ALTER TABLE tracked_items ADD COLUMN slack_overrides TEXT NOT NULL DEFAULT '{}'");
		if (!columns.some((column) => column.name === "slack_status")) {
			this.db.exec("ALTER TABLE tracked_items ADD COLUMN slack_status TEXT NOT NULL DEFAULT 'open'");
			this.db.exec(
				"UPDATE tracked_items SET slack_status=CASE WHEN dismissed=1 THEN 'dismissed' WHEN session_id IS NOT NULL OR mission_id IS NOT NULL THEN 'in_progress' ELSE 'open' END WHERE kind='slack'",
			);
		}
		// The close label that dismissed a Slack message, while no status of the user's replaced it.
		if (!columns.some((column) => column.name === "closed_by_label"))
			this.db.exec("ALTER TABLE tracked_items ADD COLUMN closed_by_label TEXT");
		if (!columns.some((column) => column.name === "slack_completion"))
			this.db.exec("ALTER TABLE tracked_items ADD COLUMN slack_completion TEXT NOT NULL DEFAULT '{}'");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS slack_pr_observations (
			 session_id TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL, checked_at INTEGER NOT NULL,
			 merge_seen INTEGER NOT NULL, PRIMARY KEY(session_id, url)
			);
			CREATE TABLE IF NOT EXISTS slack_done_events (
			 item_id TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(item_id, event)
			);
		`);
		if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='tracked_item_links'").get()) {
			this.db.exec(`
				CREATE TABLE tracked_item_links (item_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
				 PRIMARY KEY(kind, target, item_id));
				CREATE INDEX tracked_links_item ON tracked_item_links(item_id);
				INSERT OR IGNORE INTO tracked_item_links
				 SELECT tracked_items.id, 'sessions', value FROM tracked_items, json_each(links, '$.sessions');
				INSERT OR IGNORE INTO tracked_item_links
				 SELECT tracked_items.id, 'missions', value FROM tracked_items, json_each(links, '$.missions');
				INSERT OR IGNORE INTO tracked_item_links
				 SELECT id, 'sessions', session_id FROM tracked_items WHERE links IS NULL AND session_id IS NOT NULL;
				INSERT OR IGNORE INTO tracked_item_links
				 SELECT id, 'missions', mission_id FROM tracked_items WHERE links IS NULL AND mission_id IS NOT NULL;
			`);
		}
		// Legacy global results have no project label. Keep them for lazy, scoped adoption without model calls.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS slack_project_classifications (
			 project_id TEXT NOT NULL, channel TEXT NOT NULL, thread_ts TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
			 PRIMARY KEY(project_id, channel, thread_ts)
			);
			CREATE TABLE IF NOT EXISTS slack_corrections (
			 seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, value TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS slack_corrections_project ON slack_corrections(project_id, seq DESC);
		`);
		if (Number(this.db.prepare("PRAGMA user_version").get()!.user_version) < 1)
			this.db.exec(`
			UPDATE slack_classifications SET result=json_object(
			 'type', CASE json_extract(result, '$.isBugReport') WHEN 1 THEN 'bug' ELSE 'unknown' END,
			 'label', NULL, 'confidence', json_extract(result, '$.confidence'),
			 'severity', json_extract(result, '$.severity'), 'summary', json_extract(result, '$.summary'))
			 WHERE state='done' AND json_type(result, '$.isBugReport') IS NOT NULL;
			UPDATE tracked_items SET metadata=json_remove(json_set(metadata, '$.type', CASE json_extract(metadata, '$.isBugReport') WHEN 0 THEN 'unknown' ELSE 'bug' END, '$.label', NULL), '$.isBugReport', '$.guessedProject')
			 WHERE kind='slack' AND json_type(metadata, '$.type') IS NULL;
			PRAGMA user_version=1;
		`);
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS tracked_active_project_kind ON tracked_items(project_id, kind, dismissed, updated_at DESC, id) WHERE active=1;
			CREATE INDEX IF NOT EXISTS tracked_active_project ON tracked_items(project_id, dismissed, updated_at DESC, id) WHERE active=1;
			COMMIT;
		`);
	}
	close(): void {
		this.db.close();
	}
	/** Project-scoped thread cache. Legacy global entries are lazily adopted with no label. No raw text. */
	slackCached(channel: string, ts: string, projectId: string): SlackCache | undefined {
		validateSlackKey(channel, ts, projectId);
		let row = this.db
			.prepare(
				"SELECT state, result FROM slack_project_classifications WHERE project_id=? AND channel=? AND thread_ts=?",
			)
			.get(projectId, channel, ts);
		if (!row) {
			row = this.db
				.prepare("SELECT state, result FROM slack_classifications WHERE channel=? AND thread_ts=?")
				.get(channel, ts);
			if (row)
				this.db
					.prepare("INSERT OR IGNORE INTO slack_project_classifications VALUES (?, ?, ?, ?, ?)")
					.run(projectId, channel, ts, row.state!, row.result!);
		}
		if (!row) return undefined;
		return row.state === "done"
			? { state: "done", result: parseSlackClassification(String(row.result)) }
			: { state: row.state === "error" ? "error" : "pending" };
	}
	/** Crash-safe admission before any model call. One attempt per project/thread, across restarts. */
	reserveSlack(channel: string, ts: string, now: number, projectId: string): SlackReservation {
		validateSlackKey(channel, ts, projectId);
		const day = new Date(now).toISOString().slice(0, 10);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const cached = this.slackCached(channel, ts, projectId);
			let result: SlackReservation;
			if (cached) result = cached;
			else {
				const used = Number(this.db.prepare("SELECT used FROM slack_budget WHERE day=?").get(day)?.used ?? 0);
				if (used >= SLACK_DAILY_BUDGET) result = { state: "budget" };
				else {
					this.db
						.prepare("INSERT INTO slack_project_classifications VALUES (?, ?, ?, 'pending', NULL)")
						.run(projectId, channel, ts);
					this.db
						.prepare("INSERT INTO slack_budget VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET used=used+1")
						.run(day);
					this.db
						.prepare("DELETE FROM slack_budget WHERE day < ?")
						.run(new Date(now - 7 * 86_400_000).toISOString().slice(0, 10));
					result = { state: "reserved" };
				}
			}
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	finishSlack(channel: string, ts: string, result: SlackClassification | undefined, projectId: string): void {
		validateSlackKey(channel, ts, projectId);
		const value = result ? JSON.stringify(parseSlackClassification(JSON.stringify(result))) : null;
		this.db
			.prepare(
				"UPDATE slack_project_classifications SET state=?, result=? WHERE project_id=? AND channel=? AND thread_ts=? AND state='pending'",
			)
			.run(value ? "done" : "error", value, projectId, channel, ts);
	}
	corrections(projectId: string): SlackCorrection[] {
		return this.db
			.prepare("SELECT value FROM slack_corrections WHERE project_id=? ORDER BY seq DESC LIMIT 20")
			.all(projectId)
			.map((row) => JSON.parse(String(row.value)) as SlackCorrection);
	}
	/**
	 * Sets a project's close labels and applies them to every stored Slack message. Returns whether a row changed.
	 * Called at startup and on settings changes, so effects edited while pilotd was stopped still apply.
	 */
	slackLabelEffects(projectId: string, close: string[]): boolean {
		if (
			typeof projectId !== "string" ||
			!projectId ||
			!Array.isArray(close) ||
			close.length > 50 ||
			close.some((label) => typeof label !== "string" || !label || label.length > 80)
		)
			throw new Error("Invalid Slack label effects");
		this.closeLabels.set(projectId, JSON.stringify(close));
		this.db.exec("BEGIN");
		try {
			const changed = this.reconcile(projectId, "", []);
			this.db.exec("COMMIT");
			if (changed) this.emit(projectId);
			return changed;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	/**
	 * Applies close labels to a project's Slack rows, optionally narrowed by an extra condition. Idempotent:
	 * - a label-closed row whose effective label no longer closes reopens (it was open before Pilot closed it);
	 * - a label-closed row relabelled to another close label keeps closed, under the new label;
	 * - an open row with a close label and no status of the user's is dismissed, naming the label.
	 * Rows whose status the user set (overrides.status) are never touched. Call inside a transaction.
	 */
	private reconcile(projectId: string, scope: string, scopeArgs: string[]): boolean {
		const close = this.closeLabels.get(projectId);
		if (close === undefined) return false;
		const base = `project_id=? AND kind='slack'${scope}`;
		let changes = 0;
		for (const [set, where] of [
			[
				"slack_status='open', dismissed=0, closed_by_label=NULL",
				`closed_by_label IS NOT NULL AND NOT ${SLACK_LABEL_IN}`,
			],
			[
				`closed_by_label=${SLACK_LABEL}`,
				`closed_by_label IS NOT NULL AND closed_by_label != ${SLACK_LABEL} AND ${SLACK_LABEL_IN}`,
			],
			[
				`slack_status='dismissed', dismissed=1, closed_by_label=${SLACK_LABEL}`,
				`closed_by_label IS NULL AND slack_status='open' AND dismissed=0 AND json_type(slack_overrides, '$.status') IS NULL AND ${SLACK_LABEL_IN}`,
			],
		] as const)
			changes += Number(
				this.db
					.prepare(`UPDATE tracked_items SET ${set} WHERE ${base} AND ${where}`)
					.run(projectId, ...scopeArgs, close).changes,
			);
		return changes > 0;
	}
	onChange(listener: (projectId: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	require(id: string): TrackedItem {
		const row = this.db.prepare("SELECT * FROM tracked_items WHERE id = ?").get(id) as Row | undefined;
		if (!row) throw new NotFound(`Unknown tracked item: ${id}`);
		return decode(row);
	}
	list(query: TrackedQuery): TrackedItemList {
		const limit = query.limit ?? 100,
			offset = query.offset ?? 0;
		if (
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100 ||
			!Number.isInteger(offset) ||
			offset < 0 ||
			offset > 1_000_000
		)
			throw new Error("limit must be 1..100 and offset 0..1000000");
		if (query.kind !== undefined && query.kind !== "linear" && query.kind !== "slack")
			throw new Error("Unknown tracking kind");
		const kinds = query.kind ? [query.kind] : query.kinds;
		if (kinds?.some((kind) => kind !== "linear" && kind !== "slack")) throw new Error("Unknown tracking kind");
		if (kinds && !kinds.length) return { items: [], total: 0 };
		const filter = `project_id = ? AND active = 1 AND dismissed = ?${kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : ""}${query.closedByLabel ? " AND closed_by_label IS NOT NULL" : ""}`;
		const args = [query.projectId, query.dismissed || query.closedByLabel ? 1 : 0, ...(kinds ?? [])];
		const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tracked_items WHERE ${filter}`).get(...args)!.n);
		const items = (
			this.db
				.prepare(`SELECT * FROM tracked_items WHERE ${filter} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
				.all(...args, limit, offset) as Row[]
		).map(decode);
		return { total, items };
	}
	checkpoint(id: string): SourceCheckpoint | undefined {
		const row = this.db.prepare("SELECT value FROM source_checkpoints WHERE id = ?").get(id);
		return row ? (JSON.parse(String(row.value)) as SourceCheckpoint) : undefined;
	}
	/** Inbox counts of a source by effective label ("" for none; Linear has only ""), so hidden labels can be
	 * subtracted without reading rows. One small grouped query per source. */
	inboxCounts(projectId: string, kind: TrackedKind): Record<string, number> {
		const sql =
			kind === "linear"
				? `SELECT '' AS label, COUNT(*) AS n FROM tracked_items WHERE project_id = ? AND ${LINEAR_OPEN}`
				: `SELECT coalesce(${SLACK_LABEL}, '') AS label, COUNT(*) AS n FROM tracked_items WHERE project_id = ? AND ${SLACK_OPEN} GROUP BY 1`;
		const counts: Record<string, number> = {};
		for (const row of this.db.prepare(sql).all(projectId))
			if (Number(row.n) > 0) counts[String(row.label)] = Number(row.n);
		return counts;
	}
	/** Open tracked work of several projects for the Inbox, bounded, most pressing first. */
	inbox(query: InboxQuery): InboxTracked {
		const limit = query.limit;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1..100");
		const linear = JSON.stringify(query.linear);
		const slack = JSON.stringify(query.slack.map((entry) => entry.projectId));
		const hidden = JSON.stringify(
			query.slack.flatMap((entry) => entry.hidden.map((label) => [entry.projectId, label])),
		);
		const count = (sql: string, ...args: string[]) =>
			Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tracked_items WHERE ${sql}`).get(...args)!.n);
		const rows = (sql: string, order: string, ...args: string[]) =>
			(
				this.db
					.prepare(`SELECT * FROM tracked_items WHERE ${sql} ORDER BY ${order} LIMIT ?`)
					.all(...args, limit) as Row[]
			).map(decode);
		const linearWhere = `${IN_PROJECTS} AND ${LINEAR_OPEN}`;
		const slackWhere = `${IN_PROJECTS} AND ${SLACK_OPEN} AND NOT ${SLACK_HIDDEN}`;
		return {
			linear: {
				total: count(linearWhere, linear),
				items: rows(
					linearWhere,
					`CASE json_extract(metadata, '$.statusType') WHEN 'started' THEN 0 ELSE 1 END,
					 CASE WHEN json_extract(metadata, '$.priority') BETWEEN 1 AND 4 THEN json_extract(metadata, '$.priority') ELSE 5 END,
					 updated_at DESC, id`,
					linear,
				),
			},
			slack: {
				total: count(slackWhere, slack, hidden),
				items: rows(
					slackWhere,
					`CASE coalesce(json_extract(slack_overrides, '$.severity'), json_extract(metadata, '$.severity'))
					 WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC, id`,
					slack,
					hidden,
				),
				hidden: this.db
					.prepare(
						`SELECT ${SLACK_LABEL} AS label, COUNT(*) AS n FROM tracked_items
						 WHERE ${IN_PROJECTS} AND ${SLACK_OPEN} AND ${SLACK_HIDDEN} GROUP BY 1 ORDER BY 2 DESC, 1`,
					)
					.all(slack, hidden)
					.map((row): InboxHiddenLabel => ({ label: String(row.label), count: Number(row.n) }))
					.concat(
						this.db
							.prepare(
								`SELECT closed_by_label AS label, COUNT(*) AS n FROM tracked_items
								 WHERE ${IN_PROJECTS} AND kind = 'slack' AND active = 1 AND dismissed = 1 AND closed_by_label IS NOT NULL
								 GROUP BY 1 ORDER BY 2 DESC, 1`,
							)
							.all(slack)
							.map((row) => ({ label: String(row.label), count: Number(row.n), closed: true as const })),
					),
			},
		};
	}
	/** Only current projects are loaded into the daemon's bounded dashboard cache. */
	preview(projectId: string, kind: TrackedKind): import("@pilot/protocol").DashboardTrackedSource {
		const label = kind === "linear" ? "Linear" : "Slack";
		if (kind !== "linear") {
			const page = this.list({ projectId, kind, limit: 5 });
			return { source: kind, label, status: "idle", total: page.total, items: page.items.map(previewItem) };
		}
		// Open issues lead (in progress, then to do, by priority); done ones are a separate, collapsed group.
		const filter = "project_id = ? AND kind = 'linear' AND active = 1 AND dismissed = 0";
		const closed = "coalesce(json_extract(metadata, '$.statusType'), '') IN ('completed', 'canceled')";
		const count = (where: string) =>
			Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tracked_items WHERE ${where}`).get(projectId)!.n);
		const rows = (where: string, order: string) =>
			(
				this.db
					.prepare(`SELECT * FROM tracked_items WHERE ${where} ORDER BY ${order} LIMIT 5`)
					.all(projectId) as Row[]
			).map((row) => previewItem(decode(row)));
		const openTotal = count(`${filter} AND NOT ${closed}`),
			doneTotal = count(`${filter} AND ${closed}`);
		return {
			source: kind,
			label,
			status: "idle",
			total: openTotal + doneTotal,
			items: rows(
				`${filter} AND NOT ${closed}`,
				`CASE json_extract(metadata, '$.statusType') WHEN 'started' THEN 0 ELSE 1 END,
				 CASE WHEN json_extract(metadata, '$.priority') BETWEEN 1 AND 4 THEN json_extract(metadata, '$.priority') ELSE 5 END,
				 updated_at DESC, id`,
			),
			done: { total: doneTotal, items: rows(`${filter} AND ${closed}`, "updated_at DESC, id") },
		};
	}
	/** Bounded, atomic commit of a poll page and its cursor. Validate the whole page first. */
	commit(
		projectId: string,
		kind: TrackedKind,
		items: TrackedInput[],
		checkpoint?: SourceCheckpoint,
		activeIds?: string[],
	): void {
		if (items.length > 500) throw new Error("A poll batch may contain at most 500 items");
		for (const item of items) validateInput(item);
		if (Buffer.byteLength(JSON.stringify(items)) > 1024 * 1024) throw new Error("Poll batch exceeds 1 MiB");
		if (activeIds && (activeIds.length > 500 || activeIds.some((id) => typeof id !== "string" || id.length > 500)))
			throw new Error("Invalid active issue set");
		if (checkpoint && Buffer.byteLength(JSON.stringify(checkpoint)) > 32 * 1024)
			throw new Error("Checkpoint too large");
		const put = this.db.prepare(`INSERT INTO tracked_items
		 (id, project_id, kind, external_id, title, url, status, metadata, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(project_id, kind, external_id) DO UPDATE SET
		 title=excluded.title, url=excluded.url, status=excluded.status, metadata=excluded.metadata, updated_at=excluded.updated_at
		 WHERE excluded.updated_at >= tracked_items.updated_at AND
		 (title != excluded.title OR url != excluded.url OR status != excluded.status OR metadata != excluded.metadata OR updated_at != excluded.updated_at)`);
		let changed = false;
		this.db.exec("BEGIN");
		try {
			for (const item of items)
				changed =
					!!put.run(
						randomUUID(),
						projectId,
						kind,
						item.externalId,
						item.title,
						item.url,
						item.status,
						JSON.stringify(item.metadata),
						Date.now(),
						item.updatedAt,
					).changes || changed;
			if (activeIds) {
				const ids = JSON.stringify(activeIds);
				// Indexed active rows and bounded external IDs, not the whole retained history.
				for (const [next, previous, operator] of [
					[0, 1, "NOT IN"],
					[1, 0, "IN"],
				] as const)
					changed =
						!!this.db
							.prepare(`UPDATE tracked_items SET active=? WHERE project_id=? AND kind=? AND active=?
						AND external_id ${operator} (SELECT value FROM json_each(?))`)
							.run(next, projectId, kind, previous, ids).changes || changed;
			}
			// A new or reclassified message takes its label's effect at once.
			if (kind === "slack" && items.length)
				changed =
					this.reconcile(projectId, " AND external_id IN (SELECT value FROM json_each(?))", [
						JSON.stringify(items.map((item) => item.externalId)),
					]) || changed;
			if (checkpoint)
				this.db
					.prepare(
						"INSERT INTO source_checkpoints VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
					)
					.run(`${projectId}:${kind}`, JSON.stringify(checkpoint));
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		if (changed) this.emit(projectId);
	}
	/** Local start outcome is independent of source-owned metadata and timestamps. */
	linearStartResult(id: string, outcome: "moved" | "skipped" | "error"): void {
		if (!["moved", "skipped", "error"].includes(outcome)) throw new Error("Invalid start outcome");
		const item = this.require(id);
		if (item.kind !== "linear") return;
		const result = {
			outcome,
			attemptedAt: Date.now(),
			...(outcome === "error" ? { error: "Couldn't move ticket to In progress." } : {}),
		};
		this.db.prepare("UPDATE tracked_items SET linear_start=? WHERE id=?").run(JSON.stringify(result), id);
		this.emit(item.projectId);
	}

	/** Reserve before MCP. An interrupted attempt stays a quiet error and is never retried automatically. */
	reserveSlackStart(id: string): boolean {
		const item = this.require(id);
		if (item.kind !== "slack") return false;
		// No outcome while in flight. The reservation is private, so a pending request never flashes an error.
		const result = { attemptedAt: Date.now() };
		const changed = this.db
			.prepare("UPDATE tracked_items SET slack_start=? WHERE id=? AND slack_start IS NULL")
			.run(JSON.stringify(result), id).changes;
		if (changed) this.emit(item.projectId);
		return !!changed;
	}
	slackStartResult(id: string, outcome: "reacted" | "skipped" | "error"): void {
		if (!["reacted", "skipped", "error"].includes(outcome)) throw new Error("Invalid Slack start outcome");
		const item = this.require(id);
		const row = this.db.prepare("SELECT slack_start FROM tracked_items WHERE id=?").get(id) as Pick<
			Row,
			"slack_start"
		>;
		if (item.kind !== "slack" || !row.slack_start) return;
		const prior = JSON.parse(row.slack_start);
		const result = {
			outcome,
			attemptedAt: prior.attemptedAt,
			...(outcome === "error" ? { error: "Couldn't add eyes reaction in Slack." } : {}),
		};
		this.db.prepare("UPDATE tracked_items SET slack_start=? WHERE id=?").run(JSON.stringify(result), id);
		this.emit(item.projectId);
	}

	/** Fresh observations and the status change share one transaction. Initial terminal observations are silent. */
	observeSlackPullRequests(observation: SlackPullRequestObservation): void {
		const { projectId, sessionId, prs, pending } = observation;
		this.db.exec("BEGIN IMMEDIATE");
		let changed = false;
		try {
			const transitioned: SessionPullRequest[] = [];
			let stale = false;
			for (const pr of prs) {
				const url = pr.url.toLowerCase();
				const previous = this.db
					.prepare("SELECT * FROM slack_pr_observations WHERE session_id=? AND url=?")
					.get(sessionId, url);
				if (
					previous &&
					(Number(previous.checked_at) > pr.checkedAt || (previous.merge_seen === 1 && pr.state !== "merged"))
				) {
					stale = true;
					continue;
				}
				const merged = pr.state === "merged";
				if (merged && previous && previous.state !== "merged" && !previous.merge_seen) transitioned.push(pr);
				if (!previous || previous.state !== pr.state || Number(previous.checked_at) < pr.checkedAt)
					this.db
						.prepare(`INSERT INTO slack_pr_observations VALUES (?, ?, ?, ?, ?)
						ON CONFLICT(session_id,url) DO UPDATE SET state=excluded.state, checked_at=excluded.checked_at,
						merge_seen=max(merge_seen,excluded.merge_seen)`)
						.run(sessionId, url, pr.state, pr.checkedAt, merged ? 1 : 0);
			}
			if (!stale && !pending && prs.length && prs.every((pr) => pr.state === "merged") && transitioned.length) {
				const pr = transitioned.toSorted((a, b) => (b.mergedAt ?? b.checkedAt) - (a.mergedAt ?? a.checkedAt))[0]!;
				changed = this.finishLinkedSlack(projectId, "sessions", sessionId, `pr:${pr.url.toLowerCase()}`, {
					reason: `Done · PR #${pr.number} merged`,
					mergeDone: { pr: pr.url, at: Date.now() },
				});
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		if (changed) this.emit(projectId);
	}

	completeSlackMission(projectId: string, missionId: string, completedAt: number): void {
		this.db.exec("BEGIN IMMEDIATE");
		let changed = false;
		try {
			changed = this.finishLinkedSlack(projectId, "missions", missionId, `mission:${missionId}:${completedAt}`, {
				reason: "Done · Mission completed",
				missionDone: { id: missionId, at: completedAt },
			});
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		if (changed) this.emit(projectId);
	}

	/** Runs off the event loop, reading only indexed links for this chat or mission. */
	private finishLinkedSlack(
		projectId: string,
		kind: "sessions" | "missions",
		id: string,
		event: string,
		completion: Record<string, TrackingJson>,
	): boolean {
		// CROSS JOIN keeps the tiny target-link set outermost; without statistics SQLite otherwise scans a project.
		const rows = this.db
			.prepare(`SELECT i.id, i.slack_status, i.dismissed, i.slack_completion
				FROM tracked_item_links l CROSS JOIN tracked_items i ON i.id=l.item_id
				WHERE l.kind=? AND l.target=? AND i.project_id=? AND i.kind='slack'`)
			.iterate(kind, id, projectId) as Iterable<Pick<Row, "id" | "slack_status" | "dismissed" | "slack_completion">>;
		let changed = false;
		for (const row of rows) {
			const admitted = this.db.prepare("INSERT OR IGNORE INTO slack_done_events VALUES (?, ?)").run(row.id, event);
			if (!admitted.changes || !["open", "in_progress"].includes(row.slack_status) || row.dismissed) continue;
			this.db
				.prepare(
					"UPDATE tracked_items SET slack_status='done', closed_by_label=NULL, slack_completion=? WHERE id=?",
				)
				.run(JSON.stringify({ ...JSON.parse(row.slack_completion), ...completion }), row.id);
			changed = true;
		}
		return changed;
	}

	patch(id: string, patch: TrackedItemPatch): TrackedItem {
		validatePatch(patch);
		const item = this.require(id);
		if (patch.slack && item.kind !== "slack") throw new Error("Slack overrides require a Slack item");
		const sessions = bind(item.sessionIds ?? [], patch.sessionId),
			missions = bind(item.missionIds ?? [], patch.missionId);
		const overrides: SlackOverrides = { ...item.slack?.overrides, ...patch.slack };
		let status = item.slack?.status ?? "open";
		// Linking occurs on confirmed send/create, never on prefill. Local only.
		const started =
			patch.start &&
			((patch.sessionId && !item.sessionIds?.includes(patch.sessionId)) ||
				(patch.missionId && !item.missionIds?.includes(patch.missionId)));
		if (started) status = "in_progress";
		if (patch.dismissed !== undefined) status = patch.dismissed ? "dismissed" : "open";
		if (patch.slack?.status !== undefined) status = patch.slack.status;
		// A status the user sets or confirms is theirs, even when it matches what a close label set. Other edits
		// (type, severity, label, links) never turn the label's dismissal into a user status.
		const explicit = !!started || patch.dismissed !== undefined || patch.slack?.status !== undefined;
		const userStatus = !!item.slack && explicit;
		if (userStatus) overrides.status = status;
		const closedByLabel = userStatus ? undefined : item.slack?.closedByLabel;
		const dismissed = item.slack ? status === "dismissed" : (patch.dismissed ?? item.dismissed);
		const links = JSON.stringify({ sessions, missions });
		const correction =
			(patch.dismissed !== undefined && patch.dismissed !== item.dismissed && item.kind === "slack") ||
			(patch.slack &&
				Object.keys(patch.slack).some(
					(key) => patch.slack![key as keyof SlackOverrides] !== item.slack?.[key as keyof SlackOverrides],
				));
		if (
			dismissed === item.dismissed &&
			status === (item.slack?.status ?? "open") &&
			closedByLabel === item.slack?.closedByLabel &&
			links === JSON.stringify({ sessions: item.sessionIds ?? [], missions: item.missionIds ?? [] }) &&
			JSON.stringify(overrides) === JSON.stringify(item.slack?.overrides ?? {})
		)
			return item;
		this.db.exec("BEGIN");
		try {
			if (userStatus)
				this.db
					.prepare(
						"UPDATE tracked_items SET slack_completion=json_remove(slack_completion, '$.reason') WHERE id=?",
					)
					.run(id);
			this.db
				.prepare(
					"UPDATE tracked_items SET dismissed=?, session_id=?, mission_id=?, links=?, slack_overrides=?, slack_status=?, closed_by_label=? WHERE id=?",
				)
				.run(
					dismissed ? 1 : 0,
					sessions.at(-1) ?? null,
					missions.at(-1) ?? null,
					links,
					JSON.stringify(overrides),
					status,
					closedByLabel ?? null,
					id,
				);
			this.db.prepare("DELETE FROM tracked_item_links WHERE item_id=?").run(id);
			for (const [kind, targets] of [
				["sessions", sessions],
				["missions", missions],
			] as const)
				for (const target of targets)
					this.db.prepare("INSERT INTO tracked_item_links VALUES (?, ?, ?)").run(id, kind, target);
			// A label the user picks takes its effect, and leaving a close label reopens what it closed.
			if (item.kind === "slack") this.reconcile(item.projectId, " AND id = ?", [id]);
			if (correction) {
				// The outcome after the label's effect, so the classifier learns what the user ended with. A reopened
				// label-closed message records its label with an open status.
				const after = this.require(id).slack!;
				const value: SlackCorrection = {
					itemId: id,
					summary: item.title.slice(0, 240),
					correctedAt: Date.now(),
					values: {
						type: after.type,
						label: after.label,
						severity: after.severity,
						status: after.status,
					},
				};
				this.db
					.prepare("INSERT INTO slack_corrections(project_id, value) VALUES (?, ?)")
					.run(item.projectId, JSON.stringify(value));
				this.db
					.prepare(
						"DELETE FROM slack_corrections WHERE project_id=? AND seq NOT IN (SELECT seq FROM slack_corrections WHERE project_id=? ORDER BY seq DESC LIMIT 20)",
					)
					.run(item.projectId, item.projectId);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		const next = this.require(id);
		if (JSON.stringify(next) !== JSON.stringify(item)) this.emit(item.projectId);
		return next;
	}

	/** Slack rows stay stored when a channel is removed, with their links, and show again if it is re-added. */
	retainSlack(projectId: string, channels: string[]): void {
		if (!Array.isArray(channels) || channels.length > 100 || channels.some((channel) => typeof channel !== "string"))
			throw new Error("Invalid Slack channel list");
		const scope = JSON.stringify(channels.map((channel) => channel.replace(/^#/, "")));
		const match = `(json_extract(metadata, '$.channel') IN (SELECT value FROM json_each(?))
		 OR json_extract(metadata, '$.channelName') IN (SELECT value FROM json_each(?)))`;
		let changed = false;
		for (const [next, previous, condition] of [
			[0, 1, `NOT ${match}`],
			[1, 0, match],
		] as const)
			changed =
				!!this.db
					.prepare(
						`UPDATE tracked_items SET active=? WHERE project_id=? AND kind='slack' AND active=? AND ${condition}`,
					)
					.run(next, projectId, previous, scope, scope).changes || changed;
		if (changed) this.emit(projectId);
	}
	private emit(projectId: string): void {
		for (const listener of this.listeners) listener(projectId);
	}
}
function validateSlackKey(channel: string, ts: string, projectId: string): void {
	if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 200)
		throw new Error("Invalid Slack project");
	if (
		typeof channel !== "string" ||
		typeof ts !== "string" ||
		!/^[CDG][A-Z0-9]{1,199}$/.test(channel) ||
		!/^\d{1,12}\.\d{6}$/.test(ts)
	)
		throw new Error("Invalid Slack thread key");
}
function decode(row: Row): TrackedItem {
	const links = row.links ? (JSON.parse(row.links) as { sessions?: string[]; missions?: string[] }) : {};
	// Rows linked before link history existed have only their single latest link.
	const sessionIds = links.sessions ?? (row.session_id ? [row.session_id] : []),
		missionIds = links.missions ?? (row.mission_id ? [row.mission_id] : []);
	const metadata = JSON.parse(row.metadata);
	const slackStart = row.slack_start ? JSON.parse(row.slack_start) : undefined;
	const completion = JSON.parse(row.slack_completion);
	const overrides: SlackOverrides = JSON.parse(row.slack_overrides);
	const slack: SlackTriage | undefined =
		row.kind === "slack"
			? {
					type: metadata.type ?? "unknown",
					label: metadata.label ?? null,
					severity: metadata.severity ?? "low",
					...overrides,
					status: row.slack_status,
					overrides,
					...(row.closed_by_label ? { closedByLabel: row.closed_by_label } : {}),
					...(row.slack_status === "done" && completion.reason ? { doneReason: completion.reason } : {}),
				}
			: undefined;
	return {
		id: row.id,
		projectId: row.project_id,
		kind: row.kind,
		externalId: row.external_id,
		title: row.title,
		url: row.url,
		status: slack?.status ?? row.status,
		metadata: slack
			? {
					...metadata,
					...completion,
					type: slack.type,
					label: slack.label,
					severity: slack.severity,
					...(slackStart?.outcome ? { slackStart } : {}),
				}
			: { ...metadata, ...(row.linear_start ? { linearStart: JSON.parse(row.linear_start) } : {}) },
		...(slack ? { slack } : {}),
		dismissed: !!row.dismissed,
		...(row.session_id ? { sessionId: row.session_id } : {}),
		...(row.mission_id ? { missionId: row.mission_id } : {}),
		...(sessionIds.length ? { sessionIds } : {}),
		...(missionIds.length ? { missionIds } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
const LINK_LIMIT = 20;
/** The fields a dashboard row needs. */
function previewItem(item: TrackedItem): import("@pilot/protocol").DashboardTrackedItem {
	const { id, title, url, status, updatedAt, externalId, metadata, sessionId, missionId, sessionIds, missionIds } =
		item;
	return {
		id,
		title,
		url,
		status,
		updatedAt,
		externalId,
		metadata,
		...(item.slack ? { slack: item.slack } : {}),
		...(sessionId ? { sessionId } : {}),
		...(missionId ? { missionId } : {}),
		...(sessionIds ? { sessionIds } : {}),
		...(missionIds ? { missionIds } : {}),
	};
}
/** A new link moves to the end (latest). null clears every link of that kind. */
function bind(current: string[], link: string | null | undefined): string[] {
	if (link === undefined) return current;
	if (link === null) return [];
	return [...current.filter((id) => id !== link), link].slice(-LINK_LIMIT);
}
function validateInput(item: TrackedInput): void {
	for (const [value, max] of [
		[item.externalId, 500],
		[item.title, 2000],
		[item.url, 4000],
		[item.status, 200],
	] as const)
		if (typeof value !== "string" || !value.trim() || value.length > max)
			throw new Error("Invalid tracked item text");
	const url = new URL(item.url);
	if (!["https:", "http:"].includes(url.protocol)) throw new Error("Tracked item URL must be HTTP(S)");
	if (!Number.isFinite(item.updatedAt) || item.updatedAt < 0) throw new Error("Invalid updatedAt");
	if (
		!item.metadata ||
		typeof item.metadata !== "object" ||
		Array.isArray(item.metadata) ||
		Buffer.byteLength(JSON.stringify(item.metadata)) > 16 * 1024
	)
		throw new Error("Invalid tracked item metadata");
}
export function validatePatch(value: unknown): asserts value is TrackedItemPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tracked item patch");
	const patch = value as TrackedItemPatch;
	if (Object.keys(value).some((key) => !["dismissed", "sessionId", "missionId", "slack", "start"].includes(key)))
		throw new Error("Unknown tracked item field");
	if (patch.start !== undefined && typeof patch.start !== "boolean") throw new Error("start must be a boolean");
	if (
		patch.start &&
		(Number(!!patch.sessionId) + Number(!!patch.missionId) !== 1 ||
			patch.dismissed !== undefined ||
			patch.sessionId === null ||
			patch.missionId === null)
	)
		throw new Error("start requires exactly one chat or mission link");
	if (patch.slack !== undefined) {
		const fields = patch.slack;
		if (
			!fields ||
			typeof fields !== "object" ||
			Array.isArray(fields) ||
			Object.keys(fields).some((key) => !["type", "label", "severity", "status"].includes(key))
		)
			throw new Error("Invalid Slack overrides");
		if (fields.type !== undefined && !["bug", "question", "request", "unknown"].includes(fields.type))
			throw new Error("Invalid Slack type");
		if (fields.severity !== undefined && !["low", "medium", "high", "critical"].includes(fields.severity))
			throw new Error("Invalid Slack severity");
		if (fields.status !== undefined && !["open", "in_progress", "done", "dismissed"].includes(fields.status))
			throw new Error("Invalid Slack status");
		if (
			fields.status !== undefined &&
			patch.dismissed !== undefined &&
			patch.dismissed !== (fields.status === "dismissed")
		)
			throw new Error("Conflicting Slack status and dismissed fields");
		if (
			fields.label !== undefined &&
			fields.label !== null &&
			(typeof fields.label !== "string" ||
				!fields.label.trim() ||
				fields.label.length > 80 ||
				/[\x00-\x1f]/.test(fields.label))
		)
			throw new Error("Invalid Slack label");
	}
	if (patch.dismissed !== undefined && typeof patch.dismissed !== "boolean")
		throw new Error("dismissed must be a boolean");
	for (const link of [patch.sessionId, patch.missionId])
		if (link !== undefined && link !== null && (typeof link !== "string" || !link.trim() || link.length > 200))
			throw new Error("Invalid tracked item link");
}
