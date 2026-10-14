/** Small, indexed daemon-owned SQLite store. No network or agent loop lives here. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
	LinearSourceSummary,
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
	created_at: number;
	updated_at: number;
};
export interface TrackedQuery {
	projectId: string;
	kind?: TrackedKind;
	/** Internal scope guard for mixed-source lists. */
	kinds?: TrackedKind[];
	dismissed?: boolean;
	limit?: number;
	offset?: number;
}

export class TrackedItemDisk {
	private readonly db: DatabaseSync;
	private readonly listeners = new Set<(projectId: string) => void>();
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode=WAL;
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
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS tracked_active_project_kind ON tracked_items(project_id, kind, dismissed, updated_at DESC, id) WHERE active=1;
			CREATE INDEX IF NOT EXISTS tracked_active_project ON tracked_items(project_id, dismissed, updated_at DESC, id) WHERE active=1;
		`);
	}
	close(): void {
		this.db.close();
	}
	/** Global thread cache, including negative results and failed/interrupted attempts. No raw text. */
	slackCached(channel: string, ts: string): SlackCache | undefined {
		validateSlackKey(channel, ts);
		const row = this.db
			.prepare("SELECT state, result FROM slack_classifications WHERE channel=? AND thread_ts=?")
			.get(channel, ts);
		if (!row) return undefined;
		return row.state === "done"
			? { state: "done", result: parseSlackClassification(String(row.result)) }
			: { state: row.state === "error" ? "error" : "pending" };
	}
	/** Crash-safe admission before any model call. One attempt per thread, across projects/restarts. */
	reserveSlack(channel: string, ts: string, now: number): SlackReservation {
		validateSlackKey(channel, ts);
		const day = new Date(now).toISOString().slice(0, 10);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const cached = this.slackCached(channel, ts);
			let result: SlackReservation;
			if (cached) result = cached;
			else {
				const used = Number(this.db.prepare("SELECT used FROM slack_budget WHERE day=?").get(day)?.used ?? 0);
				if (used >= SLACK_DAILY_BUDGET) result = { state: "budget" };
				else {
					this.db.prepare("INSERT INTO slack_classifications VALUES (?, ?, 'pending', NULL)").run(channel, ts);
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
	finishSlack(channel: string, ts: string, result?: SlackClassification): void {
		validateSlackKey(channel, ts);
		const value = result ? JSON.stringify(parseSlackClassification(JSON.stringify(result))) : null;
		this.db
			.prepare(
				"UPDATE slack_classifications SET state=?, result=? WHERE channel=? AND thread_ts=? AND state='pending'",
			)
			.run(value ? "done" : "error", value, channel, ts);
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
		const filter = `project_id = ? AND active = 1 AND dismissed = ?${kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : ""}`;
		const args = [query.projectId, query.dismissed ? 1 : 0, ...(kinds ?? [])];
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

	patch(id: string, patch: TrackedItemPatch): TrackedItem {
		validatePatch(patch);
		const item = this.require(id);
		const sessions = bind(item.sessionIds ?? [], patch.sessionId),
			missions = bind(item.missionIds ?? [], patch.missionId);
		const next = {
			dismissed: patch.dismissed ?? item.dismissed,
			sessionId: sessions.at(-1),
			missionId: missions.at(-1),
		};
		const links = JSON.stringify({ sessions, missions });
		if (
			next.dismissed !== item.dismissed ||
			links !== JSON.stringify({ sessions: item.sessionIds ?? [], missions: item.missionIds ?? [] })
		) {
			this.db
				.prepare("UPDATE tracked_items SET dismissed=?, session_id=?, mission_id=?, links=? WHERE id=?")
				.run(next.dismissed ? 1 : 0, next.sessionId ?? null, next.missionId ?? null, links, id);
			this.emit(item.projectId);
		}
		return this.require(id);
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
function validateSlackKey(channel: string, ts: string): void {
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
	return {
		id: row.id,
		projectId: row.project_id,
		kind: row.kind,
		externalId: row.external_id,
		title: row.title,
		url: row.url,
		status: row.status,
		metadata: {
			...JSON.parse(row.metadata),
			...(row.linear_start ? { linearStart: JSON.parse(row.linear_start) } : {}),
		},
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
	if (Object.keys(value).some((key) => !["dismissed", "sessionId", "missionId", "start"].includes(key)))
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
	if (patch.dismissed !== undefined && typeof patch.dismissed !== "boolean")
		throw new Error("dismissed must be a boolean");
	for (const link of [patch.sessionId, patch.missionId])
		if (link !== undefined && link !== null && (typeof link !== "string" || !link.trim() || link.length > 200))
			throw new Error("Invalid tracked item link");
}
