/** Missions: daemon-owned state shared by the chats of one goal. pilotd is the sole writer. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
	ArtifactKind,
	GitHubAction,
	Mission,
	MissionArtifactLink,
	MissionBrief,
	MissionBriefRevision,
	MissionComment,
	MissionCommentWrite,
	MissionDecision,
	MissionDetail,
	MissionEvent,
	MissionEventKind,
	MissionEventWrite,
	MissionHealth,
	MissionResource,
	MissionResourceKind,
	MissionResourceWrite,
	MissionStatus,
	MissionTask,
	MissionTaskStatus,
	MissionTaskWrite,
	SessionPullRequest,
	SessionSummary,
	UpdateMissionRequest,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { PullRequestBinding } from "./sessions.ts";

/** Who changed mission state. Omitted sessionId means the user (or pilotd itself). */
export interface MissionActor {
	sessionId?: string;
}

const USER: MissionActor = {};
const STATUSES: MissionStatus[] = ["active", "done", "archived"];
const TASK_STATUSES: MissionTaskStatus[] = ["todo", "in_progress", "blocked", "in_review", "done", "dropped"];
const HEALTH: MissionHealth[] = ["on_track", "at_risk", "off_track"];
const MAX_TITLE = 200;
const MAX_TEXT = 8_000;
const MAX_GOAL = 4_000;
const MAX_BRIEF = 256 * 1024;
const MAX_URL = 2_048;
const DETAIL_EVENTS = 50;
const DETAIL_RESOLVED_COMMENTS = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	title TEXT NOT NULL,
	goal TEXT NOT NULL,
	status TEXT NOT NULL,
	coordinator_session_id TEXT,
	autopilot INTEGER NOT NULL DEFAULT 0,
	brief_revision INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	completed_at INTEGER,
	archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS brief_revisions (
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	markdown TEXT NOT NULL,
	author_session_id TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (mission_id, revision)
);
CREATE TABLE IF NOT EXISTS decisions (
	id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	text TEXT NOT NULL,
	author_session_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
	id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	text TEXT NOT NULL,
	anchor TEXT,
	revision INTEGER,
	author_session_id TEXT,
	target_session_id TEXT,
	created_at INTEGER NOT NULL,
	resolved_at INTEGER,
	resolved_by_session_id TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	number INTEGER NOT NULL,
	title TEXT NOT NULL,
	body TEXT,
	status TEXT NOT NULL,
	sort REAL NOT NULL,
	milestone TEXT,
	depends_on TEXT,
	session_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	completed_at INTEGER,
	UNIQUE (mission_id, number)
);
CREATE TABLE IF NOT EXISTS artifact_links (
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	artifact_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	title TEXT NOT NULL,
	kind TEXT NOT NULL,
	revision INTEGER,
	linked_by_session_id TEXT,
	linked_at INTEGER NOT NULL,
	task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS resources (
	id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	title TEXT,
	kind TEXT NOT NULL,
	external_id TEXT,
	added_by_session_id TEXT,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	text TEXT NOT NULL,
	session_id TEXT,
	task_id TEXT,
	health TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_mission ON events (mission_id, id);
CREATE INDEX IF NOT EXISTS events_by_mission_kind ON events (mission_id, kind, id);
CREATE TABLE IF NOT EXISTS github_action_events (
	session_id TEXT NOT NULL,
	action_id TEXT NOT NULL,
	event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
	PRIMARY KEY (session_id, action_id)
);
CREATE TABLE IF NOT EXISTS github_action_retention (
	mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
	pruned_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
	session_id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS members_by_mission ON members (mission_id);
CREATE TABLE IF NOT EXISTS pull_request_binding_operations (
	id TEXT PRIMARY KEY,
	applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pull_request_bindings (
	session_id TEXT NOT NULL,
	url TEXT NOT NULL COLLATE NOCASE,
	bound INTEGER NOT NULL,
	mission_id TEXT,
	task_id TEXT,
	PRIMARY KEY (session_id, url)
);
CREATE TABLE IF NOT EXISTS pending_notices (
	event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	at INTEGER NOT NULL,
	text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_notices_by_mission ON pending_notices (mission_id, event_id);
CREATE TABLE IF NOT EXISTS pending_notice_summaries (
	event_id INTEGER NOT NULL REFERENCES pending_notices(event_id) ON DELETE CASCADE,
	group_key TEXT NOT NULL,
	text TEXT NOT NULL,
	state TEXT,
	PRIMARY KEY (event_id, group_key)
);
CREATE INDEX IF NOT EXISTS pending_summary_groups ON pending_notice_summaries (group_key, event_id);
CREATE TABLE IF NOT EXISTS notice_activity (
	mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
	busy INTEGER NOT NULL,
	idle_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notices (
	request_id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	last_event_id INTEGER NOT NULL,
	session_id TEXT NOT NULL,
	content TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS notices_by_mission ON notices (mission_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_notice ON notices (mission_id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS notices_by_delivery ON notices (mission_id, delivered_at);
CREATE TABLE IF NOT EXISTS member_completions (
	session_id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	outcome_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blocked_tasks_by_mission ON tasks (mission_id) WHERE status = 'blocked';
CREATE TABLE IF NOT EXISTS member_runs (
	session_id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	done_tasks TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pull_request_transitions (
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	url TEXT NOT NULL COLLATE NOCASE,
	state TEXT NOT NULL,
	PRIMARY KEY (mission_id, url, state)
);
CREATE TABLE IF NOT EXISTS member_pull_requests (
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	url TEXT NOT NULL COLLATE NOCASE,
	pull_request TEXT NOT NULL,
	PRIMARY KEY (mission_id, url)
);
CREATE INDEX IF NOT EXISTS needs_you_comments_by_mission ON comments (mission_id)
	WHERE resolved_at IS NULL AND target_session_id IS NULL AND author_session_id IS NOT NULL;
`;

export interface MissionNotice {
	requestId: string;
	missionId: string;
	lastEventId: number;
	sessionId: string;
	content: string;
}

export const NOTICE_DEBOUNCE_MS = 30_000;
export const NOTICE_MAX_DELAY_MS = 30 * 60_000;
export const NOTICE_WINDOW_MS = 3_600_000;
export const NOTICE_HOURLY_CAP = 20;

/** Summary-only attention counts, without loading task/comment bodies or any other detail. */
const MISSION_SELECT = `SELECT missions.*,
	(SELECT COUNT(*) FROM tasks WHERE mission_id = missions.id AND status = 'blocked') +
	CASE WHEN coordinator_session_id IS NULL THEN
		(SELECT COUNT(*) FROM comments WHERE mission_id = missions.id AND resolved_at IS NULL
			AND target_session_id IS NULL AND author_session_id IS NOT NULL)
	ELSE 0 END AS needs_you_count
	FROM missions`;

type Row = Record<string, SQLInputValue>;

function noticeFrom(row: Row): MissionNotice {
	return {
		requestId: String(row.request_id),
		missionId: String(row.mission_id),
		lastEventId: Number(row.last_event_id),
		sessionId: String(row.session_id),
		content: String(row.content),
	};
}

function text(value: unknown, name: string, max: number, options: { optional?: boolean; empty?: boolean } = {}) {
	if (value === undefined && options.optional) return undefined;
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	const trimmed = value.trim();
	if (!trimmed && !options.empty) throw new Error(`${name} is required`);
	if (value.length > max) throw new Error(`${name} is too long (max ${max} characters)`);
	return trimmed;
}

function optional<T>(value: SQLInputValue | undefined, map: (value: SQLInputValue) => T): T | undefined {
	return value === null || value === undefined ? undefined : map(value);
}

const str = (value: SQLInputValue) => String(value);
const num = (value: SQLInputValue) => Number(value);

/** Shared validation for saved resources and start references, before any side effects. */
export function normalizeResourceWrite(write: MissionResourceWrite) {
	if (!write || typeof write !== "object") throw new Error("Expected a resource object");
	const parsed = parseResourceUrl(text(write.url, "url", MAX_URL)!);
	const title = text(write.title, "title", MAX_TITLE, { optional: true, empty: true }) || undefined;
	return { ...parsed, ...(title ? { title } : {}) };
}

/** Recognize tracker links so later automation can act on them without a migration. */
export function parseResourceUrl(raw: string): { url: string; kind: MissionResourceKind; externalId?: string } {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error("url must be an absolute http(s) URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("url must be an absolute http(s) URL");
	const parts = url.pathname.split("/").filter(Boolean);
	const href = url.toString();
	if (url.hostname === "linear.app") {
		if (parts[1] === "issue" && parts[2])
			return { url: href, kind: "linear.issue", externalId: parts[2].toUpperCase() };
		if (parts[1] === "project" && parts[2]) return { url: href, kind: "linear.project", externalId: parts[2] };
	}
	if (url.hostname === "github.com" && parts.length >= 4 && /^\d+$/.test(parts[3]!)) {
		const id = `${parts[0]}/${parts[1]}#${parts[3]}`;
		if (parts[2] === "pull")
			return {
				url: `https://github.com/${parts[0]}/${parts[1]}/pull/${Number(parts[3])}`,
				kind: "github.pr",
				externalId: id,
			};
		if (parts[2] === "issues") return { url: href, kind: "github.issue", externalId: id };
	}
	if (url.hostname.endsWith(".slack.com") && parts[0] === "archives" && parts[1] && /^p\d{16}$/.test(parts[2] ?? "")) {
		const ts = parts[2]!.slice(1);
		return { url: href, kind: "slack.thread", externalId: `${parts[1]}/${ts.slice(0, 10)}.${ts.slice(10)}` };
	}
	return { url: href, kind: "url" };
}

export class MissionStore {
	private readonly db: DatabaseSync;
	private readonly listeners = new Set<(missionId: string) => void>();
	private readonly memberListeners = new Set<(sessionId: string) => void>();
	private writing = false;
	private referenceBatch?: string;

	/** ":memory:" keeps state in memory, for tests. */
	constructor(file: string) {
		if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(file);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		const migratePrTransitions = !this.one("SELECT 1 FROM sqlite_master WHERE name = 'pull_request_transitions'");
		this.db.exec(SCHEMA);
		if (!this.all("PRAGMA table_info(decisions)").some((row) => row.name === "audience"))
			this.db.exec("ALTER TABLE decisions ADD COLUMN audience TEXT NOT NULL DEFAULT 'reference'");
		if (!this.all("PRAGMA table_info(tasks)").some((row) => row.name === "decision_ids"))
			this.db.exec("ALTER TABLE tasks ADD COLUMN decision_ids TEXT");
		if (!this.all("PRAGMA table_info(notice_activity)").some((row) => row.name === "job_deadline"))
			this.db.exec("ALTER TABLE notice_activity ADD COLUMN job_deadline INTEGER");
		// Upgrade already queued events without losing their stable event IDs.
		this.db.exec(`INSERT OR IGNORE INTO pending_notice_summaries (event_id, group_key, text, state)
			SELECT p.event_id, COALESCE('task:' || e.task_id, 'task:' || t.id,
				CASE WHEN p.text LIKE '%: chat %' THEN 'chat:' || e.session_id ELSE 'note:' || COALESCE(e.session_id, 'user') END), p.text,
				CASE WHEN p.text LIKE '%chat failed%' THEN 'failed'
					WHEN p.text LIKE '%chat finished%' THEN 'done' END
			FROM pending_notices p JOIN events e ON e.id = p.event_id
			LEFT JOIN tasks t ON t.mission_id = p.mission_id AND t.session_id = e.session_id
				AND e.kind = 'update' AND p.text LIKE '%: chat %'
			WHERE NOT EXISTS (SELECT 1 FROM pending_notice_summaries s WHERE s.event_id = p.event_id)`);
		if (!this.all("PRAGMA table_info(member_completions)").some((row) => row.name === "signature"))
			this.db.exec("ALTER TABLE member_completions ADD COLUMN signature TEXT");
		if (migratePrTransitions)
			this.db.exec(`INSERT OR IGNORE INTO pull_request_transitions (mission_id, url, state)
				SELECT c.mission_id, json_extract(p.value, '$[0]'), json_extract(p.value, '$[1]')
				FROM member_completions c, json_each(c.signature, '$[3]') p
				WHERE json_extract(p.value, '$[1]') IN ('merged', 'closed')`);
		if (!this.all("PRAGMA table_info(artifact_links)").some((row) => row.name === "task_id")) {
			this.db.exec(`BEGIN;
				ALTER TABLE artifact_links RENAME TO artifact_links_legacy;
				CREATE TABLE artifact_links (
					mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
					artifact_id TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL,
					kind TEXT NOT NULL, revision INTEGER, linked_by_session_id TEXT, linked_at INTEGER NOT NULL,
					task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE
				);
				INSERT INTO artifact_links (mission_id, artifact_id, session_id, title, kind, revision, linked_by_session_id, linked_at)
					SELECT mission_id, artifact_id, session_id, title, kind, revision, linked_by_session_id, linked_at FROM artifact_links_legacy;
				DROP TABLE artifact_links_legacy;
				COMMIT;`);
		}
		this.db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS artifact_link_scope ON artifact_links(mission_id, artifact_id, COALESCE(task_id, ''))",
		);
		if (!this.all("PRAGMA table_info(resources)").some((row) => row.name === "task_id"))
			this.db.exec("ALTER TABLE resources ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL");
		if (!this.all("PRAGMA table_info(resources)").some((row) => row.name === "pull_request"))
			this.db.exec("ALTER TABLE resources ADD COLUMN pull_request TEXT");
		if (!this.all("PRAGMA table_info(resources)").some((row) => row.name === "relationship"))
			this.transaction(() => {
				this.db.exec("ALTER TABLE resources ADD COLUMN relationship TEXT NOT NULL DEFAULT 'reference'");
				this.db.exec(
					"UPDATE resources SET relationship = 'ownership' WHERE kind = 'github.pr' AND task_id IS NOT NULL",
				);
			});
		if (!this.all("PRAGMA table_info(tasks)").some((row) => row.name === "pr_sync_disabled"))
			this.db.exec("ALTER TABLE tasks ADD COLUMN pr_sync_disabled INTEGER NOT NULL DEFAULT 0");
		if (!this.all("PRAGMA table_info(events)").some((row) => row.name === "is_user_note"))
			this.transaction(() => {
				this.db.exec("ALTER TABLE events ADD COLUMN is_user_note INTEGER NOT NULL DEFAULT 0");
				// Legacy updates mix authored notes with automatic goal/title edits. Exclude that known
				// automatic text; new writes use the marker so even identically worded notes are distinct.
				this.db.exec(`UPDATE events SET is_user_note = 1 WHERE session_id IS NULL AND
					(kind = 'handoff' OR (kind = 'update' AND (text <> 'Mission title or goal changed' OR health IS NOT NULL)))`);
			});
		this.db.exec(`CREATE INDEX IF NOT EXISTS user_notes_by_mission ON events (mission_id, id)
			WHERE is_user_note = 1`);
	}

	close(): void {
		this.db.close();
	}

	/** Called after every committed change of a mission, including membership and deletion. */
	onChange(listener: (missionId: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Called after a session joins or leaves a mission, or its mission is deleted. */
	onMembershipChange(listener: (sessionId: string) => void): () => void {
		this.memberListeners.add(listener);
		return () => this.memberListeners.delete(listener);
	}

	private changed(missionId: string, sessions: string[] = []): void {
		if (this.referenceBatch === missionId) return;
		for (const listener of this.listeners) listener(missionId);
		for (const sessionId of sessions) for (const listener of this.memberListeners) listener(sessionId);
	}

	private all(sql: string, ...params: SQLInputValue[]): Row[] {
		return this.db.prepare(sql).all(...params) as Row[];
	}

	private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
		return this.db.prepare(sql).get(...params) as Row | undefined;
	}

	private run(sql: string, ...params: SQLInputValue[]): void {
		this.db.prepare(sql).run(...params);
	}

	private transaction<T>(work: () => T): T {
		// Reference batches reuse the ordinary validators/writers inside one outer transaction.
		if (this.writing) return work();
		this.db.exec("BEGIN IMMEDIATE");
		this.writing = true;
		try {
			const result = work();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.writing = false;
		}
	}

	private event(
		missionId: string,
		kind: MissionEventKind,
		eventText: string,
		actor: MissionActor,
		extra: {
			taskId?: string;
			health?: MissionHealth;
			at?: number;
			wake?: boolean;
			noticeText?: string;
			noticeSummaries?: { key: string; text: string; state?: string }[];
			userNote?: boolean;
		} = {},
	): MissionEvent {
		const at = extra.at ?? Date.now();
		const result = this.db
			.prepare(
				"INSERT INTO events (mission_id, kind, text, session_id, task_id, health, at, is_user_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				missionId,
				kind,
				eventText,
				actor.sessionId ?? null,
				extra.taskId ?? null,
				extra.health ?? null,
				at,
				extra.userNote ? 1 : 0,
			);
		this.run("UPDATE missions SET updated_at = MAX(updated_at, ?) WHERE id = ?", at, missionId);
		const eventId = Number(result.lastInsertRowid);
		if (extra.wake && (!actor.sessionId || actor.sessionId !== this.require(missionId).coordinatorSessionId)) {
			this.run(
				"INSERT INTO pending_notices (event_id, mission_id, at, text) VALUES (?, ?, ?, ?)",
				eventId,
				missionId,
				at,
				extra.noticeText ?? eventText,
			);
			const summaries = extra.noticeSummaries ?? [
				{
					key: extra.taskId ? `task:${extra.taskId}` : `note:${actor.sessionId ?? "user"}`,
					text: extra.noticeText ?? eventText,
				},
			];
			for (const summary of summaries)
				this.run(
					"INSERT INTO pending_notice_summaries (event_id, group_key, text, state) VALUES (?, ?, ?, ?)",
					eventId,
					summary.key,
					summary.text,
					summary.state ?? null,
				);
		}
		return {
			id: eventId,
			kind,
			text: eventText,
			...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
			...(extra.taskId ? { taskId: extra.taskId } : {}),
			...(extra.health ? { health: extra.health } : {}),
			at,
		};
	}

	// Missions
	/** Ownership links are independent of PR references and of the chat's outcome snapshot. */
	pullRequestMembers(url: string): string[] {
		return this.all(
			`SELECT DISTINCT t.session_id FROM resources r JOIN tasks t ON t.id = r.task_id
			JOIN members m ON m.session_id = t.session_id AND m.mission_id = r.mission_id
			WHERE r.url = ? COLLATE NOCASE AND r.kind = 'github.pr' AND r.relationship = 'ownership'`,
			url,
		).map((row) => str(row.session_id!));
	}

	/** Latest owned cache also keeps archived chat-only PRs on the linked polling path. */
	memberPullRequest(id: string, pr: SessionPullRequest): SessionPullRequest {
		const row = this.one(
			"SELECT pull_request FROM member_pull_requests WHERE mission_id = ? AND url = ?",
			id,
			pr.url,
		);
		const cached = row ? (JSON.parse(str(row.pull_request!)) as SessionPullRequest) : undefined;
		return cached && cached.checkedAt >= pr.checkedAt ? cached : pr;
	}

	/** The transition ledger and pending event commit atomically, including chat-only PR caches. */
	recordMemberPullRequests(
		session: SessionSummary,
		prs: SessionPullRequest[],
		notify = true,
		contextPrs: SessionPullRequest[] = [],
	): boolean {
		const id = this.missionOf(session.id);
		if (!id) return false;
		const mission = this.require(id);
		if (mission.status !== "active" || mission.coordinatorSessionId === session.id) return false;
		const joinedAt = num(this.one("SELECT joined_at FROM members WHERE session_id = ?", session.id)!.joined_at!);
		let changed = false;
		this.transaction(() => {
			for (const pr of prs) {
				const cached = this.memberPullRequest(id, pr);
				if (
					cached.checkedAt > pr.checkedAt ||
					(cached.checkedAt === pr.checkedAt &&
						(cached.state === "merged" || cached.state === "closed") &&
						(pr.state === "open" || pr.state === "draft"))
				)
					continue;
				this.run(
					`INSERT INTO member_pull_requests (mission_id, url, pull_request) VALUES (?, ?, ?)
					ON CONFLICT (mission_id, url) DO UPDATE SET pull_request = excluded.pull_request`,
					id,
					pr.url,
					JSON.stringify(pr),
				);
				if (pr.state !== "merged" && pr.state !== "closed") continue;
				if (pr.state === "merged" && pr.mergedAt === undefined) continue;
				if (
					this.one(
						"SELECT 1 FROM pull_request_transitions WHERE mission_id = ? AND url = ? AND state = ?",
						id,
						pr.url,
						pr.state,
					)
				)
					continue;
				this.run(
					"INSERT INTO pull_request_transitions (mission_id, url, state) VALUES (?, ?, ?)",
					id,
					pr.url,
					pr.state,
				);
				// Closed PRs have no close timestamp in the cache. Their successful lookup is the best
				// available boundary; merged PRs must have a real merge time, not a refresh timestamp.
				if ((pr.state === "merged" ? (pr.mergedAt ?? 0) : pr.checkedAt) < joinedAt) continue;
				const tasks = this.all(
					`SELECT DISTINCT t.* FROM tasks t JOIN resources r ON r.task_id = t.id
					WHERE r.mission_id = ? AND r.url = ? COLLATE NOCASE AND r.relationship = 'ownership'`,
					id,
					pr.url,
				).map(taskFrom);
				const taskText = tasks.map(
					(task) => `task #${task.number}${pr.state === "merged" && task.status === "done" ? " marked done" : ""}`,
				);
				const note = `PR #${pr.number}${pr.state === "merged" ? ` ${pr.title} merged` : " closed without merging"} (chat ${session.title}${taskText.length ? `, ${taskText.join(", ")}` : ""})`;
				const doneIds = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
				const allTasks = this.tasks(id);
				const allDoneIds = new Set(allTasks.filter((task) => task.status === "done").map((task) => task.id));
				const unblocked =
					pr.state === "merged"
						? allTasks.filter(
								(task) =>
									task.status !== "done" &&
									task.status !== "dropped" &&
									task.dependsOn?.some((dep) => doneIds.has(dep)) &&
									task.dependsOn.every((dep) => allDoneIds.has(dep)),
							)
						: [];
				const stacked =
					pr.state === "merged" && pr.stack
						? this.all(
								`SELECT pull_request FROM resources
					WHERE mission_id = ? AND relationship = 'ownership' AND pull_request IS NOT NULL`,
								id,
							)
								.map((row) => JSON.parse(str(row.pull_request!)) as SessionPullRequest)
								.concat(contextPrs)
								.map((other) => this.memberPullRequest(id, other))
								.filter(
									(other) =>
										(other.state === "open" || other.state === "draft") &&
										other.stack?.number === pr.stack!.number &&
										other.stack.position > pr.stack!.position &&
										other.url.slice(0, other.url.lastIndexOf("/")).toLowerCase() ===
											pr.url.slice(0, pr.url.lastIndexOf("/")).toLowerCase(),
								)
								.filter(
									(other, index, all) =>
										all.findIndex((candidate) => candidate.url.toLowerCase() === other.url.toLowerCase()) ===
										index,
								)
						: [];
				const context = `${unblocked.length ? `; unblocks ${unblocked.map((task) => `task #${task.number} ${task.title}`).join(", ")}` : ""}${stacked.length ? `; open stacked PRs: ${stacked.map((other) => `#${other.number} ${other.title}`).join(", ")}` : ""}`;
				this.event(
					id,
					"update",
					note + context,
					{ sessionId: session.id },
					{
						wake: true,
						noticeSummaries: [{ key: `pr:${pr.url.toLowerCase()}`, text: note + context, state: pr.state }],
					},
				);
				changed = true;
			}
		});
		if (changed && notify) this.changed(id);
		return changed;
	}

	/** Snapshot completed work once per run, before a new turn can change task state. */
	recordMemberRun(session: SessionSummary): void {
		const id = this.missionOf(session.id);
		if (!id || this.require(id).coordinatorSessionId === session.id) return;
		this.run(
			"INSERT INTO member_runs (session_id, mission_id, done_tasks) VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING",
			session.id,
			id,
			JSON.stringify(
				this.tasks(id)
					.filter((task) => task.sessionId === session.id && task.status === "done")
					.map((task) => task.id),
			),
		);
	}

	/** Durable high-water mark prevents ready snapshots/restarts from announcing a completion twice. */
	recordMemberCompletion(session: SessionSummary, recovering = false): void {
		if (!session.outcome || session.outcomeAt === undefined) return;
		const id = this.missionOf(session.id);
		if (!id || this.require(id).coordinatorSessionId === session.id) return;
		const previous = this.one("SELECT * FROM member_completions WHERE session_id = ?", session.id);
		if (previous && num(previous.outcome_at!) > session.outcomeAt) return;
		const jobs = session.runningJobs ?? [];
		const waiting = jobs.length > 0;
		const previousWaiting = previous?.signature && JSON.parse(str(previous.signature))[0] === "waiting";
		if (previous && num(previous.outcome_at!) === session.outcomeAt && !waiting && !previousWaiting) return;
		const ownedTasks = this.tasks(id).filter((task) => task.sessionId === session.id);
		const run = this.one(
			"SELECT done_tasks FROM member_runs WHERE session_id = ? AND mission_id = ?",
			session.id,
			id,
		);
		const alreadyDone = new Set<string>(run ? JSON.parse(str(run.done_tasks!)) : []);
		const tasks = ownedTasks.filter((task) =>
			run
				? !alreadyDone.has(task.id)
				: task.status !== "done" ||
					(task.completedAt ?? task.updatedAt) >
						(session.lastUserMessageAt ?? (previous ? num(previous.outcome_at!) : session.createdAt)),
		);
		const activeTaskIds = new Set(tasks.map((task) => task.id));
		const linkedPrs = this.all(
			"SELECT r.url, r.task_id FROM resources r JOIN tasks t ON t.id = r.task_id WHERE r.mission_id = ? AND t.session_id = ? AND r.kind = 'github.pr' AND r.relationship = 'ownership'",
			id,
			session.id,
		);
		const activePrs = new Set(
			linkedPrs.filter((row) => activeTaskIds.has(str(row.task_id!))).map((row) => str(row.url!)),
		);
		const excludedPrs = new Set(linkedPrs.filter((row) => !activePrs.has(str(row.url!))).map((row) => str(row.url!)));
		const prs = (session.pullRequests ?? (session.pullRequest ? [session.pullRequest] : [])).filter(
			(pr) => !excludedPrs.has(pr.url),
		);
		// Poll timestamps, titles and stack positions do not change the state being announced.
		const signature = JSON.stringify([
			waiting ? "waiting" : session.outcome,
			session.outcomeReason ?? null,
			tasks.map((task) => task.id).sort(),
			(waiting ? [] : prs).map((pr) => [pr.url, pr.state]).sort(),
			jobs.map((job) => [job.id, job.name, job.startedAt]).sort(),
		]);
		const label = tasks.length ? tasks.map((task) => `#${task.number} ${task.title}`).join(", ") : session.title;
		const legacyNote = `${label}: chat ${session.outcome === "done" ? "finished" : session.outcome === "question" ? "asked a question" : session.outcome}${prs.length ? `, ${prs.map((pr) => `PR #${pr.number} ${pr.state}`).join(", ")}` : ""}${session.outcomeReason ? `: ${session.outcomeReason}` : ""}`;
		const unchangedLegacy =
			previous &&
			previous.signature === null &&
			this.one(
				"SELECT text FROM events WHERE mission_id = ? AND session_id = ? AND kind = 'update' AND text LIKE '%: chat %' ORDER BY id DESC LIMIT 1",
				id,
				session.id,
			)?.text === legacyNote;
		const joinedAt = num(this.one("SELECT joined_at FROM members WHERE session_id = ?", session.id)!.joined_at!);
		this.transaction(() => {
			this.run(
				"INSERT INTO member_completions (session_id, mission_id, outcome_at, signature) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET mission_id = excluded.mission_id, outcome_at = excluded.outcome_at, signature = excluded.signature",
				session.id,
				id,
				session.outcomeAt!,
				signature,
			);
			if (!waiting) this.run("DELETE FROM member_runs WHERE session_id = ?", session.id);
			if (ownedTasks.length && !tasks.length) return;
			// Startup is recovery, not a replay of all historical outcomes of newly attached chats.
			if (recovering && !previous && session.outcomeAt! < joinedAt) return;
			// Distinct failures remain useful (and can be counted), but unchanged successful/stopped
			// snapshots must not produce another notice just because their outcome version advanced.
			if ((previous?.signature === signature || unchangedLegacy) && (waiting || session.outcome !== "failed"))
				return;
			// Terminal PRs have their own durable PR-keyed events, never repeat them in outcomes.
			const previousPrs = new Map<string, string>(previous?.signature ? JSON.parse(str(previous.signature))[3] : []);
			const relevantPrs = prs.filter(
				(pr) => pr.state !== "merged" && pr.state !== "closed" && previousPrs.get(pr.url) !== pr.state,
			);
			const prior = previous?.signature ? JSON.parse(str(previous.signature)) : undefined;
			if (
				prior &&
				session.outcome !== "failed" &&
				prior[0] === session.outcome &&
				prior[1] === (session.outcomeReason ?? null) &&
				tasks.every((task) => prior[2].includes(task.id)) &&
				!relevantPrs.length
			)
				return;
			const note = waiting
				? `${label}: waiting on background job`
				: `${label}: chat ${session.outcome === "done" ? "finished" : session.outcome === "question" ? "asked a question" : session.outcome}${relevantPrs.length ? `, ${relevantPrs.map((pr) => `PR #${pr.number} ${pr.state}`).join(", ")}` : ""}${session.outcomeReason ? `: ${session.outcomeReason}` : ""}`;
			const suffix = note.slice(label.length);
			this.event(
				id,
				"update",
				note,
				{ sessionId: session.id },
				{
					wake: true,
					noticeSummaries: tasks.length
						? tasks.map((task) => ({
								key: `task:${task.id}`,
								text: `#${task.number} ${task.title}${suffix}`,
								state: waiting ? "waiting" : session.outcome,
							}))
						: [{ key: `chat:${session.id}`, text: note, state: waiting ? "waiting" : session.outcome }],
				},
			);
		});
		this.changed(id);
	}

	/** Persist only activity transitions, not streaming summary updates. */
	setNoticeActivity(id: string, busy: boolean, now: number, jobDeadline?: number): void {
		this.run(
			`INSERT INTO notice_activity (mission_id, busy, idle_at, job_deadline) VALUES (?, ?, ?, ?)
			ON CONFLICT(mission_id) DO UPDATE SET busy = excluded.busy,
				idle_at = CASE WHEN notice_activity.busy <> excluded.busy THEN ? ELSE notice_activity.idle_at END,
				job_deadline = excluded.job_deadline
			WHERE notice_activity.busy <> excluded.busy OR notice_activity.job_deadline IS NOT excluded.job_deadline`,
			id,
			busy ? 1 : 0,
			busy ? now : 0,
			jobDeadline ?? null,
			now,
		);
	}

	/** Only pending missions are scanned. The oldest event anchors the safety valve. */
	noticeDeadlines(now: number, id?: string): { missionId: string; at: number }[] {
		const rows = this.all(
			`WITH pending AS (
				SELECT mission_id, MIN(at) AS first_at, MAX(at) AS last_at
				FROM pending_notices ${id ? "WHERE mission_id = ?" : ""} GROUP BY mission_id
			), recent AS (
				SELECT mission_id, delivered_at, ROW_NUMBER() OVER (PARTITION BY mission_id ORDER BY delivered_at DESC) AS rank
				FROM notices WHERE delivered_at > ?
			)
			SELECT p.*, n.request_id, a.busy, a.idle_at, a.job_deadline, r.delivered_at AS capped_at FROM pending p
			LEFT JOIN notice_activity a ON a.mission_id = p.mission_id
			LEFT JOIN notices n ON n.mission_id = p.mission_id AND n.delivered_at IS NULL
			LEFT JOIN recent r ON r.mission_id = p.mission_id AND r.rank = ?`,
			...(id ? [id] : []),
			now - NOTICE_WINDOW_MS,
			NOTICE_HOURLY_CAP,
		);
		return rows.map((row) => {
			const missionId = str(row.mission_id!);
			const settled =
				row.busy === 1 ? Infinity : Math.max(num(row.last_at!), num(row.idle_at ?? 0)) + NOTICE_DEBOUNCE_MS;
			const due = Math.min(
				row.request_id && row.busy !== 1 ? Math.max(now, num(row.idle_at ?? 0) + NOTICE_DEBOUNCE_MS) : settled,
				num(row.first_at!) + NOTICE_MAX_DELAY_MS,
				row.job_deadline === null ? Infinity : num(row.job_deadline!),
			);
			return {
				missionId,
				at: row.capped_at === null ? due : Math.max(due, num(row.capped_at!) + NOTICE_WINDOW_MS),
			};
		});
	}

	pendingNotice(id: string): MissionNotice | undefined {
		const row = this.one("SELECT * FROM notices WHERE mission_id = ? AND delivered_at IS NULL", id);
		return row ? noticeFrom(row) : undefined;
	}

	/** Freeze both the cutoff and payload before IPC, so an uncertain acknowledgement has a stable retry. */
	prepareNotice(
		id: string,
		sessionId: string,
		now: number,
		runningJobNotes: string[] = [],
	): MissionNotice | undefined {
		const mission = this.require(id);
		if (mission.status !== "active" || mission.coordinatorSessionId !== sessionId) return undefined;
		return this.transaction(() => {
			this.run("DELETE FROM notices WHERE delivered_at <= ?", now - NOTICE_WINDOW_MS);
			if (!this.noticeDeadlines(now, id).some((deadline) => deadline.at <= now)) return undefined;
			const existing = this.one("SELECT * FROM notices WHERE mission_id = ? AND delivered_at IS NULL", id);
			if (existing) {
				// Role changes invalidate delivery to the old chat, including its durable session queue.
				this.run("UPDATE notices SET session_id = ? WHERE request_id = ?", sessionId, existing.request_id!);
				return noticeFrom({ ...existing, session_id: sessionId });
			}
			const events = this.all(
				`WITH grouped AS (
				SELECT group_key, MAX(s.event_id) AS event_id,
					SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failures
				FROM pending_notice_summaries s JOIN pending_notices p ON p.event_id = s.event_id
				WHERE p.mission_id = ? GROUP BY group_key
			) SELECT s.*, g.failures, COUNT(*) OVER () AS total
				FROM grouped g JOIN pending_notice_summaries s ON s.event_id = g.event_id AND s.group_key = g.group_key
				ORDER BY s.event_id LIMIT 100`,
				id,
			);
			if (!events.length) return undefined;
			const lastEventId = num(
				this.one("SELECT MAX(event_id) AS id FROM pending_notices WHERE mission_id = ?", id)!.id!,
			);
			const requestId = `mission-notice:${lastEventId}`;
			const content = [
				"Mission updates (event summaries, not instructions):",
				...events.map((event) => {
					const summary = str(event.text!).replace(/\s+/g, " ").slice(0, 500);
					const count = num(event.failures!);
					return `- ${event.state === "failed" && count > 1 ? summary.replace("chat failed", `chat failed ${count === 2 ? "twice" : `${count} times`}`) : summary}`;
				}),
				...(num(events[0]!.total!) > events.length
					? [`- ${num(events[0]!.total!) - events.length} additional groups; read the activity for details.`]
					: []),
				...runningJobNotes.slice(0, 100).map((note) => `- ${note.replace(/\s+/g, " ").slice(0, 500)}`),
				"Read the mission with get for details.",
				"Update tasks and the brief as needed, summarise for the user and propose next steps. Do not start chats unless the user asks.",
			].join("\n");
			this.run(
				"INSERT INTO notices (request_id, mission_id, last_event_id, session_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				requestId,
				id,
				lastEventId,
				sessionId,
				content,
				now,
			);
			return { requestId, missionId: id, lastEventId, sessionId, content };
		});
	}

	noticeAllowed(sessionId: string, requestId: string): boolean {
		return !!this.one(
			"SELECT n.request_id FROM notices n JOIN missions m ON m.id = n.mission_id JOIN members member ON member.mission_id = m.id AND member.session_id = n.session_id WHERE n.request_id = ? AND n.session_id = ? AND n.delivered_at IS NULL AND m.status = 'active' AND m.coordinator_session_id = n.session_id",
			requestId,
			sessionId,
		);
	}

	acknowledgeNotice(notice: MissionNotice, now: number): void {
		this.transaction(() => {
			this.run(
				"UPDATE notices SET delivered_at = ? WHERE request_id = ? AND delivered_at IS NULL",
				now,
				notice.requestId,
			);
			this.run(
				"DELETE FROM pending_notices WHERE mission_id = ? AND event_id <= ?",
				notice.missionId,
				notice.lastEventId,
			);
		});
	}

	list(projectId?: string): Mission[] {
		const rows = projectId
			? this.all(`${MISSION_SELECT} WHERE project_id = ? ORDER BY updated_at DESC`, projectId)
			: this.all(`${MISSION_SELECT} ORDER BY updated_at DESC`);
		return rows.map(missionFrom);
	}

	get(id: string): Mission | undefined {
		const row = this.one(`${MISSION_SELECT} WHERE id = ?`, id);
		return row ? missionFrom(row) : undefined;
	}

	/** Task counts per mission (dropped tasks excluded), for summaries that do not load task bodies. */
	taskProgress(projectId?: string): Map<string, { done: number; total: number }> {
		const rows = this.all(
			`SELECT t.mission_id AS id, SUM(t.status = 'done') AS done, COUNT(*) AS total
				FROM tasks t JOIN missions m ON m.id = t.mission_id
				WHERE t.status != 'dropped'${projectId ? " AND m.project_id = ?" : ""}
				GROUP BY t.mission_id`,
			...(projectId ? [projectId] : []),
		);
		return new Map(rows.map((row) => [str(row.id!), { done: num(row.done!), total: num(row.total!) }]));
	}

	require(id: string): Mission {
		const mission = this.get(id);
		if (!mission) throw new NotFound(`Unknown mission: ${id}`);
		return mission;
	}

	detail(id: string, history = true): MissionDetail {
		const mission = this.require(id);
		const brief = history && mission.briefRevision ? this.brief(id) : undefined;
		return {
			mission,
			...(brief ? { brief } : {}),
			decisions: this.all("SELECT * FROM decisions WHERE mission_id = ? ORDER BY created_at, id", id).map(
				decisionFrom,
			),
			comments: [
				...this.all(
					"SELECT * FROM comments WHERE mission_id = ? AND resolved_at IS NULL ORDER BY created_at, id",
					id,
				),
				...(history
					? this.all(
							"SELECT * FROM comments WHERE mission_id = ? AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?",
							id,
							DETAIL_RESOLVED_COMMENTS,
						)
					: []),
			].map(commentFrom),
			tasks: this.tasks(id),
			artifacts: this.all("SELECT * FROM artifact_links WHERE mission_id = ? ORDER BY linked_at DESC", id).map(
				artifactFrom,
			),
			resources: this.all("SELECT * FROM resources WHERE mission_id = ? ORDER BY created_at, id", id).map(
				resourceFrom,
			),
			events: history ? this.events(id, undefined, DETAIL_EVENTS) : [],
		};
	}

	create(
		input: {
			projectId: string;
			title: unknown;
			goal?: unknown;
			brief?: unknown;
			tasks?: Array<{ title: unknown; body?: unknown }>;
		},
		actor: MissionActor = USER,
	): Mission {
		const title = text(input.title, "title", MAX_TITLE)!;
		const goal = text(input.goal ?? "", "goal", MAX_GOAL, { empty: true })!;
		const brief = input.brief === undefined ? undefined : text(input.brief, "brief", MAX_BRIEF, { empty: true });
		if (input.tasks !== undefined && !Array.isArray(input.tasks)) throw new Error("tasks must be an array");
		const tasks = (input.tasks ?? []).map((task) => ({
			title: text(task?.title, "task title", MAX_TITLE)!,
			body: text(task?.body, "task body", MAX_TEXT, { optional: true, empty: true }),
		}));
		const id = randomUUID();
		const now = Date.now();
		this.transaction(() => {
			this.run(
				"INSERT INTO missions (id, project_id, title, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
				id,
				input.projectId,
				title,
				goal,
				now,
				now,
			);
			this.event(id, "created", `Mission created: ${title}`, actor, { at: now });
			if (brief) this.insertBrief(id, brief, 1, actor, now);
			for (const task of tasks) this.insertTask(id, { title: task.title, body: task.body }, actor);
		});
		this.changed(id);
		return this.require(id);
	}

	update(id: string, patch: UpdateMissionRequest, actor: MissionActor = USER): Mission {
		const mission = this.require(id);
		const next = { ...mission };
		const notes: Array<[MissionEventKind, string]> = [];
		if (patch.title !== undefined) next.title = text(patch.title, "title", MAX_TITLE)!;
		if (patch.goal !== undefined) next.goal = text(patch.goal, "goal", MAX_GOAL, { empty: true })!;
		if (patch.title !== undefined || patch.goal !== undefined)
			if (next.title !== mission.title || next.goal !== mission.goal)
				notes.push(["update", "Mission title or goal changed"]);
		if (patch.status !== undefined) {
			if (!STATUSES.includes(patch.status)) throw new Error("status must be active, done or archived");
			if (patch.status !== mission.status) notes.push(["status", `Mission marked ${patch.status}`]);
			next.status = patch.status;
		}
		if (patch.autopilot !== undefined) {
			if (typeof patch.autopilot !== "boolean") throw new Error("autopilot must be a boolean");
			next.autopilot = patch.autopilot;
		}
		let coordinator = mission.coordinatorSessionId ?? null;
		if (patch.coordinatorSessionId !== undefined) {
			if (patch.coordinatorSessionId !== null) {
				if (typeof patch.coordinatorSessionId !== "string")
					throw new Error("coordinatorSessionId must be a string or null");
				if (this.missionOf(patch.coordinatorSessionId) !== id)
					throw new Conflict("The coordinator must be a chat in this mission");
			}
			if (patch.coordinatorSessionId !== coordinator)
				notes.push([
					"coordinator",
					patch.coordinatorSessionId ? "Coordinator changed" : "The user coordinates this mission",
				]);
			coordinator = patch.coordinatorSessionId;
		}
		const now = Date.now();
		this.transaction(() => {
			this.run(
				"UPDATE missions SET title = ?, goal = ?, status = ?, autopilot = ?, coordinator_session_id = ?, updated_at = ?, completed_at = ?, archived_at = ? WHERE id = ?",
				next.title,
				next.goal,
				next.status,
				next.autopilot ? 1 : 0,
				coordinator,
				now,
				next.status === "done" ? (mission.completedAt ?? now) : null,
				next.status === "archived" ? (mission.archivedAt ?? now) : null,
				id,
			);
			for (const [kind, note] of notes) this.event(id, kind, note, actor, { at: now });
			if (next.status === "active" && mission.status !== "active")
				for (const task of this.tasks(id)) this.reconcileTaskPullRequests(id, task.id);
		});
		// Status and coordinator changes alter every member's context.
		this.changed(id, this.members(id));
		return this.require(id);
	}

	/** Detaches member chats; they keep their history. */
	remove(id: string): void {
		this.require(id);
		const members = this.members(id);
		this.transaction(() => this.run("DELETE FROM missions WHERE id = ?", id));
		this.changed(id, members);
	}

	// Brief

	brief(id: string, revision?: number): MissionBrief | undefined {
		const mission = this.require(id);
		if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
			throw new Error("revision must be a positive integer");
		const row = this.one(
			"SELECT * FROM brief_revisions WHERE mission_id = ? AND revision = ?",
			id,
			revision ?? mission.briefRevision,
		);
		return row ? briefFrom(row) : undefined;
	}

	briefRevisions(id: string): MissionBriefRevision[] {
		this.require(id);
		return this.all(
			"SELECT revision, author_session_id, created_at FROM brief_revisions WHERE mission_id = ? ORDER BY revision DESC",
			id,
		).map((row) => ({
			revision: num(row.revision!),
			...optionalAuthor(row.author_session_id),
			createdAt: num(row.created_at!),
		}));
	}

	writeBrief(id: string, markdown: unknown, expectedRevision: unknown, actor: MissionActor = USER): MissionBrief {
		const content = text(markdown, "markdown", MAX_BRIEF, { empty: true })!;
		if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new Error("expectedRevision must be a non-negative integer");
		const brief = this.transaction(() => {
			const mission = this.require(id);
			if (mission.briefRevision !== expectedRevision)
				throw new Conflict(
					`Brief revision conflict: expected ${expectedRevision}, latest is ${mission.briefRevision}. Read the latest brief and reapply your change.`,
				);
			const current = mission.briefRevision ? this.brief(id) : undefined;
			if (current && current.markdown === content) return current;
			return this.insertBrief(id, content, mission.briefRevision + 1, actor, Date.now());
		});
		this.changed(id);
		return brief;
	}

	private insertBrief(id: string, markdown: string, revision: number, actor: MissionActor, now: number): MissionBrief {
		this.run(
			"INSERT INTO brief_revisions (mission_id, revision, markdown, author_session_id, created_at) VALUES (?, ?, ?, ?, ?)",
			id,
			revision,
			markdown,
			actor.sessionId ?? null,
			now,
		);
		this.run("UPDATE missions SET brief_revision = ? WHERE id = ?", revision, id);
		this.event(id, "brief", `Brief revision ${revision}`, actor, { at: now });
		return { missionId: id, revision, markdown, ...optionalAuthor(actor.sessionId), createdAt: now };
	}

	// Tasks

	tasks(id: string): MissionTask[] {
		return this.all("SELECT * FROM tasks WHERE mission_id = ? ORDER BY sort, number", id).map(taskFrom);
	}

	task(id: string, taskId: string): MissionTask {
		const row = this.one("SELECT * FROM tasks WHERE mission_id = ? AND id = ?", id, taskId);
		if (!row) throw new NotFound(`Unknown task: ${taskId}`);
		return taskFrom(row);
	}

	/** Agents may also refer to tasks by their display number. */
	resolveTask(id: string, ref: unknown): MissionTask {
		if (typeof ref === "number" || (typeof ref === "string" && /^#?\d+$/.test(ref))) {
			const row = this.one(
				"SELECT * FROM tasks WHERE mission_id = ? AND number = ?",
				id,
				Number(String(ref).replace("#", "")),
			);
			if (!row) throw new NotFound(`Unknown task: #${String(ref).replace("#", "")}`);
			return taskFrom(row);
		}
		if (typeof ref !== "string") throw new Error("task id is required");
		return this.task(id, ref);
	}

	addTask(id: string, write: MissionTaskWrite, actor: MissionActor = USER): MissionTask {
		this.require(id);
		const task = this.transaction(() => this.insertTask(id, write, actor));
		this.changed(id, task.sessionId ? [task.sessionId] : []);
		return task;
	}

	private insertTask(id: string, write: MissionTaskWrite, actor: MissionActor): MissionTask {
		const title = text(write.title, "title", MAX_TITLE)!;
		const fields = this.taskFields(id, write);
		const now = Date.now();
		const number = num(this.one("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE mission_id = ?", id)!.n!);
		const order =
			fields.order ??
			num(this.one("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM tasks WHERE mission_id = ?", id)!.n!);
		const status = fields.status ?? "todo";
		const taskId = randomUUID();
		const owner = write.sessionId ?? null;
		if (owner !== null) this.assertMember(id, owner);
		this.run(
			"INSERT INTO tasks (id, mission_id, number, title, body, status, sort, milestone, depends_on, session_id, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			taskId,
			id,
			number,
			title,
			fields.body ?? null,
			status,
			order,
			fields.milestone ?? null,
			fields.dependsOn?.length ? JSON.stringify(fields.dependsOn) : null,
			owner,
			now,
			now,
			status === "done" ? now : null,
		);
		this.event(id, "task", `Task #${number} added: ${title}`, actor, {
			taskId,
			at: now,
			wake: status === "blocked",
			noticeText: `#${number} ${title} blocked${fields.body ? `: ${fields.body}` : ""}`,
		});
		if (fields.decisionIds !== undefined)
			this.run("UPDATE tasks SET decision_ids = ? WHERE id = ?", JSON.stringify(fields.decisionIds), taskId);
		return this.task(id, taskId);
	}

	private taskFields(id: string, write: MissionTaskWrite, self?: string) {
		if (!write || typeof write !== "object") throw new Error("Expected a task object");
		const body = write.body === undefined ? undefined : text(write.body, "body", MAX_TEXT, { empty: true });
		if (write.status !== undefined && !TASK_STATUSES.includes(write.status))
			throw new Error(`status must be one of ${TASK_STATUSES.join(", ")}`);
		if (write.order !== undefined && (typeof write.order !== "number" || !Number.isFinite(write.order)))
			throw new Error("order must be a number");
		const milestone =
			write.milestone === undefined ? undefined : text(write.milestone, "milestone", MAX_TITLE, { empty: true });
		let dependsOn: string[] | undefined;
		if (write.dependsOn !== undefined) {
			if (!Array.isArray(write.dependsOn)) throw new Error("dependsOn must be an array of task IDs");
			dependsOn = [...new Set(write.dependsOn.map((ref) => this.resolveTask(id, ref).id))];
			if (self && dependsOn.includes(self)) throw new Error("A task cannot depend on itself");
		}
		let decisionIds: string[] | undefined;
		if (write.decisionIds !== undefined) {
			if (!Array.isArray(write.decisionIds) || write.decisionIds.length > 1000)
				throw new Error("decisionIds must be an array of at most 1000 decision IDs");
			decisionIds = [...new Set(write.decisionIds.map((ref) => this.decision(id, ref).id))];
		}
		return { body, status: write.status, order: write.order, milestone, dependsOn, decisionIds };
	}

	updateTask(id: string, taskId: string, write: MissionTaskWrite, actor: MissionActor = USER): MissionTask {
		if (write.sessionId === null && Object.keys(write).length === 1 && !actor.sessionId)
			return this.releaseTask(id, taskId, actor);
		const before = this.resolveTask(id, taskId);
		const fields = this.taskFields(id, write, before.id);
		const title = write.title === undefined ? before.title : text(write.title, "title", MAX_TITLE)!;
		let owner = before.sessionId ?? null;
		if (write.sessionId !== undefined) {
			if (actor.sessionId) throw new Error("Chats claim tasks with the claim action; only the user assigns them");
			if (write.sessionId !== null) this.assertMember(id, write.sessionId);
			owner = write.sessionId;
		}
		const status = fields.status ?? before.status;
		const now = Date.now();
		this.transaction(() => {
			if (fields.decisionIds !== undefined)
				this.run("UPDATE tasks SET decision_ids = ? WHERE id = ?", JSON.stringify(fields.decisionIds), before.id);
			// A user moving work back opts out permanently, across restarts and new links.
			const rank = (state: MissionTaskStatus) =>
				state === "todo" ? 0 : state === "in_review" ? 2 : state === "done" || state === "dropped" ? 3 : 1;
			if (!actor.sessionId && rank(status) < rank(before.status))
				this.run("UPDATE tasks SET pr_sync_disabled = 1 WHERE id = ?", before.id);
			this.run(
				"UPDATE tasks SET title = ?, body = ?, status = ?, sort = ?, milestone = ?, depends_on = ?, session_id = ?, updated_at = ?, completed_at = ? WHERE id = ?",
				title,
				(fields.body === undefined ? before.body : fields.body) || null,
				status,
				fields.order ?? before.order,
				(fields.milestone === undefined ? before.milestone : fields.milestone) || null,
				fields.dependsOn === undefined
					? before.dependsOn?.length
						? JSON.stringify(before.dependsOn)
						: null
					: fields.dependsOn.length
						? JSON.stringify(fields.dependsOn)
						: null,
				owner,
				now,
				status === "done" ? (before.completedAt ?? now) : null,
				before.id,
			);
			if (status !== before.status)
				this.event(id, "task", `Task #${before.number} ${statusLabel(status)}: ${title}`, actor, {
					taskId: before.id,
					at: now,
					wake: status === "blocked",
					noticeText: `#${before.number} ${title} blocked${(fields.body ?? before.body) ? `: ${fields.body ?? before.body}` : ""}`,
				});
			else if (title !== before.title)
				this.event(id, "task", `Task #${before.number} renamed: ${title}`, actor, { taskId: before.id, at: now });
			if (fields.order !== undefined && fields.order !== before.order)
				this.event(id, "task", `Task #${before.number} reordered: ${title}`, actor, { taskId: before.id, at: now });
			if (fields.milestone !== undefined && fields.milestone !== (before.milestone ?? ""))
				this.event(
					id,
					"task",
					`Task #${before.number} milestone ${fields.milestone || "cleared"}: ${title}`,
					actor,
					{
						taskId: before.id,
						at: now,
					},
				);
			if (owner !== (before.sessionId ?? null))
				this.event(
					id,
					"claim",
					owner ? `Task #${before.number} assigned` : `Task #${before.number} released`,
					actor,
					{ taskId: before.id, at: now },
				);
		});
		this.changed(id, [...new Set([before.sessionId, owner].filter((value): value is string => !!value))]);
		return this.task(id, before.id);
	}

	/** Validate the whole selection before writing, then publish one update rather than one per task. */
	groupTasks(id: string, refs: string[], milestone: string, actor: MissionActor = USER): MissionTask[] {
		this.require(id);
		const group = text(milestone, "milestone", MAX_TITLE, { empty: true })!;
		const tasks = [
			...new Map(
				refs.map((ref) => {
					const task = this.resolveTask(id, ref);
					return [task.id, task] as const;
				}),
			).values(),
		];
		const changed = tasks.filter((task) => (task.milestone ?? "") !== group);
		if (!changed.length) return tasks;
		const now = Date.now();
		this.transaction(() => {
			const update = this.db.prepare("UPDATE tasks SET milestone = ?, updated_at = ? WHERE id = ?");
			for (const task of changed) update.run(group || null, now, task.id);
			this.event(id, "task", `${changed.length} task milestones ${group ? `set to ${group}` : "cleared"}`, actor, {
				at: now,
			});
		});
		this.changed(id, [...new Set(changed.flatMap((task) => (task.sessionId ? [task.sessionId] : [])))]);
		return tasks.map((task) =>
			(task.milestone ?? "") !== group ? { ...task, milestone: group || undefined, updatedAt: now } : task,
		);
	}

	removeTask(id: string, taskId: string, actor: MissionActor = USER): void {
		const task = this.resolveTask(id, taskId);
		this.transaction(() => {
			// Match resource-link deletion semantics without overwriting an existing mission pin.
			this.run(
				`INSERT OR IGNORE INTO artifact_links (mission_id, artifact_id, session_id, title, kind, revision, linked_by_session_id, linked_at)
				 SELECT mission_id, artifact_id, session_id, title, kind, revision, linked_by_session_id, linked_at
				 FROM artifact_links WHERE mission_id = ? AND task_id = ?`,
				id,
				task.id,
			);
			this.run("DELETE FROM tasks WHERE id = ?", task.id);
			for (const other of this.tasks(id))
				if (other.dependsOn?.includes(task.id)) {
					const rest = other.dependsOn.filter((dep) => dep !== task.id);
					this.run(
						"UPDATE tasks SET depends_on = ? WHERE id = ?",
						rest.length ? JSON.stringify(rest) : null,
						other.id,
					);
				}
			this.event(id, "task", `Task #${task.number} removed: ${task.title}`, actor);
		});
		this.changed(id, task.sessionId ? [task.sessionId] : []);
	}

	/** Atomic: a task owned by another chat is never taken over. */
	claimTask(id: string, taskId: unknown, sessionId: string, actor: MissionActor = { sessionId }): MissionTask {
		this.assertMember(id, sessionId);
		const task = this.transaction(() => {
			const task = this.resolveTask(id, taskId);
			return this.takeTask(id, task, sessionId, actor);
		});
		this.changed(id, [sessionId]);
		return task;
	}

	/** The user and current coordinator may release any claim; members only their own. */
	releaseTask(id: string, taskId: unknown, actor: MissionActor = USER): MissionTask {
		const mission = this.require(id);
		if (actor.sessionId) this.assertMember(id, actor.sessionId);
		const before = this.resolveTask(id, taskId);
		const task = this.transaction(() => {
			if (
				actor.sessionId &&
				actor.sessionId !== mission.coordinatorSessionId &&
				before.sessionId &&
				before.sessionId !== actor.sessionId
			)
				throw new Conflict(
					`Task #${before.number} is claimed by another chat; only the coordinator can release it`,
				);
			if (!before.sessionId) return before;
			const status = before.status === "in_progress" || before.status === "blocked" ? "todo" : before.status;
			this.run(
				"UPDATE tasks SET session_id = NULL, status = ?, updated_at = ? WHERE id = ?",
				status,
				Date.now(),
				before.id,
			);
			this.event(
				id,
				"claim",
				`Task #${before.number} claim released from chat ${before.sessionId}: ${before.title}`,
				actor,
				{ taskId: before.id },
			);
			return this.task(id, before.id);
		});
		if (!this.writing && before.sessionId) this.changed(id, [before.sessionId]);
		return task;
	}

	releaseTasks(id: string, refs: string[], actor: MissionActor = USER) {
		if (actor.sessionId) this.assertMember(id, actor.sessionId);
		const affected = new Set<string>();
		const result = this.transaction(() => {
			const released: MissionTask[] = [];
			const skipped: Array<{ ref: string; reason: string; task?: MissionTask }> = [];
			const seen = new Set<string>();
			for (const ref of refs) {
				let task: MissionTask;
				try {
					task = this.resolveTask(id, ref);
				} catch (error) {
					if (!(error instanceof NotFound)) throw error;
					skipped.push({ ref, reason: error.message });
					continue;
				}
				if (seen.has(task.id)) continue;
				seen.add(task.id);
				if (
					actor.sessionId &&
					actor.sessionId !== this.require(id).coordinatorSessionId &&
					task.sessionId &&
					task.sessionId !== actor.sessionId
				) {
					skipped.push({
						ref,
						reason: `Task #${task.number} is claimed by another chat; only the coordinator can release it`,
						task,
					});
					continue;
				}
				if (task.sessionId) affected.add(task.sessionId);
				released.push(this.releaseTask(id, task.id, actor));
			}
			return { released, skipped };
		});
		if (result.released.length) this.changed(id, [...affected]);
		return result;
	}

	/** Partial success for a batch, without exposing intermediate state to member contexts. */
	claimTasks(id: string, refs: string[], sessionId: string, actor: MissionActor = { sessionId }) {
		this.assertMember(id, sessionId);
		const result = this.transaction(() => {
			const claimed: MissionTask[] = [];
			const skipped: Array<{ ref: string; reason: string; task?: MissionTask }> = [];
			const seen = new Set<string>();
			for (const ref of refs) {
				let task: MissionTask;
				try {
					task = this.resolveTask(id, ref);
				} catch (error) {
					if (!(error instanceof NotFound)) throw error;
					skipped.push({ ref, reason: error.message });
					continue;
				}
				if (seen.has(task.id)) continue;
				seen.add(task.id);
				if (task.sessionId && task.sessionId !== sessionId) {
					skipped.push({ ref, reason: `Task #${task.number} is already claimed by another chat`, task });
					continue;
				}
				claimed.push(this.takeTask(id, task, sessionId, actor));
			}
			return { claimed, skipped };
		});
		if (result.claimed.length) this.changed(id, [sessionId]);
		return result;
	}

	private takeTask(id: string, task: MissionTask, sessionId: string, actor: MissionActor): MissionTask {
		if (task.sessionId === sessionId) return task;
		if (task.sessionId) throw new Conflict(`Task #${task.number} is already claimed by another chat`);
		const now = Date.now();
		const status = task.status === "todo" ? "in_progress" : task.status;
		this.run(
			"UPDATE tasks SET session_id = ?, status = ?, updated_at = ? WHERE id = ?",
			sessionId,
			status,
			now,
			task.id,
		);
		this.event(id, "claim", `Task #${task.number} claimed: ${task.title}`, actor, { taskId: task.id, at: now });
		return this.task(id, task.id);
	}

	// Decisions

	addDecision(
		id: string,
		value: unknown,
		actor: MissionActor = USER,
		audience: unknown = "reference",
	): MissionDecision {
		this.require(id);
		const decisionText = text(value, "text", MAX_TEXT)!;
		const scope = decisionAudience(audience);
		const now = Date.now();
		const decision: MissionDecision = {
			id: randomUUID(),
			audience: scope,
			text: decisionText,
			...optionalAuthor(actor.sessionId),
			createdAt: now,
			updatedAt: now,
		};
		this.transaction(() => {
			this.run(
				"INSERT INTO decisions (id, mission_id, text, author_session_id, created_at, updated_at, audience) VALUES (?, ?, ?, ?, ?, ?, ?)",
				decision.id,
				id,
				decision.text,
				actor.sessionId ?? null,
				now,
				now,
				scope,
			);
			this.event(id, "decision", `Decision: ${decision.text}`, actor, { at: now });
		});
		this.changed(id, this.members(id));
		return decision;
	}

	/** Only the user edits or removes decisions. */
	updateDecision(
		id: string,
		decisionId: string,
		value: unknown,
		actor: MissionActor = USER,
		audience?: unknown,
	): MissionDecision {
		if (actor.sessionId) throw new Error("Only the user can change recorded decisions");
		const before = this.decision(id, decisionId);
		const decisionText = value === undefined ? before.text : text(value, "text", MAX_TEXT)!;
		const scope = audience === undefined ? before.audience : decisionAudience(audience);
		const now = Date.now();
		this.transaction(() => {
			this.run(
				"UPDATE decisions SET text = ?, audience = ?, updated_at = ? WHERE id = ?",
				decisionText,
				scope,
				now,
				before.id,
			);
			this.event(id, "decision", `Decision changed: ${decisionText}`, actor, { at: now });
		});
		this.changed(id, this.members(id));
		return this.decision(id, decisionId);
	}

	removeDecision(id: string, decisionId: string, actor: MissionActor = USER): void {
		if (actor.sessionId) throw new Error("Only the user can change recorded decisions");
		const before = this.decision(id, decisionId);
		this.transaction(() => {
			for (const task of this.tasks(id)) {
				if (task.decisionIds?.includes(before.id))
					this.run(
						"UPDATE tasks SET decision_ids = ? WHERE id = ?",
						JSON.stringify(task.decisionIds.filter((ref) => ref !== before.id)),
						task.id,
					);
			}
			this.run("DELETE FROM decisions WHERE id = ?", before.id);
			this.event(id, "decision", `Decision removed: ${before.text}`, actor);
		});
		this.changed(id, this.members(id));
	}

	private decision(id: string, decisionId: string): MissionDecision {
		const row = this.one("SELECT * FROM decisions WHERE mission_id = ? AND id = ?", id, decisionId);
		if (!row) throw new NotFound(`Unknown decision: ${decisionId}`);
		return decisionFrom(row);
	}

	// Comments

	addComment(id: string, write: MissionCommentWrite, actor: MissionActor = USER): MissionComment {
		const mission = this.require(id);
		if (!write || typeof write !== "object") throw new Error("Expected a comment object");
		const commentText = text(write.text, "text", MAX_TEXT)!;
		const anchor = text(write.anchor, "anchor", MAX_TEXT, { optional: true, empty: true }) || undefined;
		if (write.targetSessionId !== undefined) this.assertMember(id, write.targetSessionId);
		const now = Date.now();
		const comment: MissionComment = {
			id: randomUUID(),
			text: commentText,
			...(anchor ? { anchor, revision: mission.briefRevision } : {}),
			...optionalAuthor(actor.sessionId),
			...(write.targetSessionId ? { targetSessionId: write.targetSessionId } : {}),
			createdAt: now,
		};
		this.transaction(() => {
			this.run(
				"INSERT INTO comments (id, mission_id, text, anchor, revision, author_session_id, target_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				comment.id,
				id,
				comment.text,
				comment.anchor ?? null,
				comment.revision ?? null,
				actor.sessionId ?? null,
				comment.targetSessionId ?? null,
				now,
			);
			this.event(id, "comment", `Comment: ${comment.text}`, actor, {
				at: now,
				wake: !write.targetSessionId || write.targetSessionId === mission.coordinatorSessionId,
			});
		});
		this.changed(id);
		return comment;
	}

	resolveComment(id: string, commentId: string, actor: MissionActor = USER): MissionComment {
		const before = this.comment(id, commentId);
		if (before.resolvedAt !== undefined) return before;
		const now = Date.now();
		this.transaction(() => {
			this.run(
				"UPDATE comments SET resolved_at = ?, resolved_by_session_id = ? WHERE id = ?",
				now,
				actor.sessionId ?? null,
				before.id,
			);
			this.event(id, "comment", `Comment resolved: ${before.text}`, actor, { at: now });
		});
		this.changed(id);
		return this.comment(id, commentId);
	}

	removeComment(id: string, commentId: string): void {
		const before = this.comment(id, commentId);
		this.transaction(() => this.run("DELETE FROM comments WHERE id = ?", before.id));
		this.changed(id);
	}

	private comment(id: string, commentId: string): MissionComment {
		const row = this.one("SELECT * FROM comments WHERE mission_id = ? AND id = ?", id, commentId);
		if (!row) throw new NotFound(`Unknown comment: ${commentId}`);
		return commentFrom(row);
	}

	// Resources and artifacts
	/** Indexed source authorization lookup, without materializing tasks, activity or the brief. */
	artifactReferences(id: string, artifactId: string): MissionArtifactLink[] {
		return this.all("SELECT * FROM artifact_links WHERE mission_id = ? AND artifact_id = ?", id, artifactId).map(
			artifactFrom,
		);
	}

	/** One commit and one detail/context broadcast, rather than one per reference. */
	attachTaskReferences(
		id: string,
		taskId: string,
		artifacts: Omit<MissionArtifactLink, "linkedAt" | "linkedBySessionId">[],
		links: MissionResourceWrite[],
	): void {
		if (!artifacts.length && !links.length) return;
		if (this.referenceBatch) throw new Error("A reference batch is already active");
		this.resolveTask(id, taskId);
		this.referenceBatch = id;
		try {
			this.transaction(() => {
				for (const item of artifacts) this.linkArtifact(id, { ...item, taskId });
				for (const item of links) this.addResource(id, { ...item, taskId, relationship: "reference" });
			});
		} finally {
			this.referenceBatch = undefined;
		}
		this.changed(id);
	}

	addResource(id: string, write: MissionResourceWrite, actor: MissionActor = USER): MissionResource {
		this.require(id);
		const { title, ...parsed } = normalizeResourceWrite(write);
		const taskId = write.taskId === undefined ? undefined : this.resolveTask(id, write.taskId).id;
		if (write.relationship !== undefined && write.relationship !== "ownership" && write.relationship !== "reference")
			throw new Error("Invalid link relationship");
		const relationship = write.relationship ?? (taskId && parsed.kind === "github.pr" ? "ownership" : "reference");
		if (relationship === "ownership" && (!taskId || parsed.kind !== "github.pr"))
			throw new Error("Ownership links require a task and a GitHub PR");
		const existing = this.one(
			"SELECT * FROM resources WHERE mission_id = ? AND url = ? COLLATE NOCASE AND task_id IS ? AND relationship = ?",
			id,
			parsed.url,
			taskId ?? null,
			relationship,
		);
		if (existing) return resourceFrom(existing);
		const now = Date.now();
		const resource: MissionResource = {
			relationship,
			id: randomUUID(),
			...(taskId ? { taskId } : {}),
			url: parsed.url,
			...(title ? { title } : {}),
			kind: parsed.kind,
			...(parsed.externalId ? { externalId: parsed.externalId } : {}),
			...(actor.sessionId ? { addedBySessionId: actor.sessionId } : {}),
			createdAt: now,
		};
		this.transaction(() => {
			this.run(
				"INSERT INTO resources (id, mission_id, url, title, kind, external_id, added_by_session_id, created_at, task_id, relationship) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				resource.id,
				id,
				resource.url,
				resource.title ?? null,
				resource.kind,
				resource.externalId ?? null,
				actor.sessionId ?? null,
				now,
				taskId ?? null,
				relationship,
			);
			this.event(id, "resource", `Linked ${title ?? parsed.externalId ?? parsed.url}`, actor, { at: now, taskId });
			const cached = this.one(
				"SELECT pull_request FROM resources WHERE url = ? COLLATE NOCASE AND pull_request IS NOT NULL LIMIT 1",
				resource.url,
			);
			if (cached) {
				this.run("UPDATE resources SET pull_request = ? WHERE id = ?", cached.pull_request!, resource.id);
				resource.pullRequest = JSON.parse(str(cached.pull_request!)) as SessionPullRequest;
				if (taskId) this.reconcileTaskPullRequests(id, taskId);
			}
		});
		this.changed(id);
		return resource;
	}

	removeResource(id: string, resourceId: string, actor: MissionActor = USER): void {
		const row = this.one("SELECT * FROM resources WHERE mission_id = ? AND id = ?", id, resourceId);
		if (!row) throw new NotFound(`Unknown resource: ${resourceId}`);
		const resource = resourceFrom(row);
		if (
			actor.sessionId &&
			actor.sessionId !== this.require(id).coordinatorSessionId &&
			resource.addedBySessionId !== actor.sessionId
		)
			throw new Conflict("Members may only remove links they added");
		this.transaction(() => {
			this.run("DELETE FROM resources WHERE id = ?", resourceId);
			this.event(id, "resource", `Unlinked ${resource.title ?? resource.externalId ?? resource.url}`, actor, {
				taskId: resource.taskId,
			});
			if (resource.taskId) this.reconcileTaskPullRequests(id, resource.taskId);
		});
		this.changed(id);
	}

	/** URL + scope identify one link. Prefer a reference when both kinds share a scope. */
	unlinkResource(
		id: string,
		url: string,
		taskRef?: string,
		actor: MissionActor = USER,
	): { removed: boolean; resource?: MissionResource } {
		const mission = this.require(id);
		const parsed = normalizeResourceWrite({ url });
		const taskId = taskRef === undefined ? undefined : this.resolveTask(id, taskRef).id;
		const row = this.one(
			`SELECT * FROM resources WHERE mission_id = ? AND url = ? COLLATE NOCASE AND task_id IS ?
			ORDER BY CASE WHEN ? = 1 OR added_by_session_id = ? THEN 0 ELSE 1 END,
			relationship DESC, created_at, id LIMIT 1`,
			id,
			parsed.url,
			taskId ?? null,
			!actor.sessionId || actor.sessionId === mission.coordinatorSessionId ? 1 : 0,
			actor.sessionId ?? null,
		);
		if (!row) return { removed: false };
		const resource = resourceFrom(row);
		this.removeResource(id, resource.id, actor);
		return { removed: true, resource };
	}

	/** Validate before session metadata is committed. No mission means there is no task link to bind. */
	validatePullRequestBinding(
		sessionId: string,
		url: string,
		taskId?: string,
	): { missionId: string; taskId?: string } | undefined {
		const parsed = normalizeResourceWrite({ url });
		if (parsed.kind !== "github.pr") throw new Error("Expected a GitHub pull request URL");
		const missionId = this.missionOf(sessionId);
		if (!missionId) {
			if (taskId !== undefined) throw new Error("A task binding requires a mission chat");
			return undefined;
		}
		if (taskId !== undefined) {
			const task = this.resolveTask(missionId, taskId);
			if (task.status === "done" || task.status === "dropped")
				throw new Conflict(`Task #${task.number} is already ${task.status}`);
			return { missionId, taskId: task.id };
		}
		const tasks = this.all(
			"SELECT id FROM tasks WHERE mission_id = ? AND session_id = ? AND status NOT IN ('done', 'dropped') LIMIT 2",
			missionId,
			sessionId,
		);
		if (tasks.length > 1) throw new Conflict("Ambiguous task binding: specify a taskId");
		return { missionId, ...(tasks[0] ? { taskId: str(tasks[0].id!) } : {}) };
	}

	/** Explicit handoffs move task links and both sides' activity in one durable, replay-safe transaction. */
	applyPullRequestBinding(operation: PullRequestBinding): { changed: boolean; taskLinkRemoved: boolean } {
		let changed = false;
		let taskLinkRemoved = false;
		const affected = new Set<string>();
		this.transaction(() => {
			if (this.one("SELECT 1 FROM pull_request_binding_operations WHERE id = ?", operation.id)) return;
			const parsed = normalizeResourceWrite({ url: operation.url });
			if (parsed.kind !== "github.pr") throw new Error("Expected a GitHub pull request URL");
			// Validation already resolved the task before the journal commit. Do not resolve an omitted
			// task again: claims can change while metadata is saved or before crash recovery runs.
			const targetMissionId = operation.missionId ?? this.missionOf(operation.sessionId);
			const pinnedTask =
				operation.bound && targetMissionId && operation.taskId
					? this.one("SELECT * FROM tasks WHERE mission_id = ? AND id = ?", targetMissionId, operation.taskId)
					: undefined;
			const targetTaskId =
				pinnedTask && pinnedTask.status !== "done" && pinnedTask.status !== "dropped"
					? str(pinnedTask.id!)
					: undefined;
			const missionIds = new Set<string>();
			if (targetMissionId && this.get(targetMissionId)) missionIds.add(targetMissionId);
			for (const sessionId of [operation.sessionId, ...operation.previousSessionIds]) {
				const missionId = this.missionOf(sessionId);
				if (missionId) missionIds.add(missionId);
			}
			const cached = this.one(
				"SELECT pull_request FROM resources WHERE url = ? COLLATE NOCASE AND pull_request IS NOT NULL LIMIT 1",
				parsed.url,
			)?.pull_request;
			const tasks = new Map<string, string>();
			const linkChanges = new Set<string>();
			const currentBinding = this.one(
				"SELECT task_id FROM pull_request_bindings WHERE session_id = ? AND url = ? AND bound = 1",
				operation.sessionId,
				parsed.url,
			);
			for (const missionId of missionIds) {
				const links = this.all(
					`SELECT r.id, r.task_id FROM resources r JOIN tasks t ON t.id = r.task_id
					WHERE r.mission_id = ? AND r.kind = 'github.pr' AND r.relationship = 'ownership' AND r.url = ? COLLATE NOCASE
					AND t.status NOT IN ('done', 'dropped')
					AND (? = 1 OR ((t.session_id = ? OR r.added_by_session_id = ? OR t.id = ?)
						AND NOT EXISTS (SELECT 1 FROM pull_request_bindings b WHERE b.url = r.url
							AND b.bound = 1 AND b.session_id <> ? AND b.mission_id = r.mission_id AND b.task_id = r.task_id)))`,
					missionId,
					parsed.url,
					operation.bound ? 1 : 0,
					operation.sessionId,
					operation.sessionId,
					currentBinding?.task_id ?? null,
					operation.sessionId,
				);
				for (const link of links) {
					if (!operation.bound && operation.changed === false) continue;
					const taskId = str(link.task_id!);
					if (operation.bound && targetMissionId === missionId && targetTaskId === taskId) continue;
					this.run("DELETE FROM resources WHERE id = ?", link.id!);
					changed = true;
					taskLinkRemoved = true;
					tasks.set(taskId, missionId);
					linkChanges.add(missionId);
					affected.add(missionId);
				}
			}
			if (operation.bound && targetMissionId && targetTaskId) {
				if (
					!this.one(
						"SELECT 1 FROM resources WHERE mission_id = ? AND task_id = ? AND url = ? COLLATE NOCASE AND relationship = 'ownership'",
						targetMissionId,
						targetTaskId,
						parsed.url,
					)
				) {
					this.run(
						`INSERT INTO resources (id, mission_id, task_id, url, kind, external_id,
						added_by_session_id, created_at, pull_request, relationship) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ownership')`,
						randomUUID(),
						targetMissionId,
						targetTaskId,
						parsed.url,
						parsed.kind,
						parsed.externalId ?? null,
						operation.actor.sessionId ?? null,
						Date.now(),
						cached ?? null,
					);
					changed = true;
					linkChanges.add(targetMissionId);
					affected.add(targetMissionId);
				}
				tasks.set(targetTaskId, targetMissionId);
			}
			const record = (sessionId: string, bound: boolean, missionId: string | undefined, taskId?: string) => {
				const before = this.one(
					"SELECT * FROM pull_request_bindings WHERE session_id = ? AND url = ?",
					sessionId,
					parsed.url,
				);
				const same =
					before &&
					Boolean(before.bound) === bound &&
					before.mission_id === (missionId ?? null) &&
					before.task_id === (taskId ?? null);
				const metadataChanged = sessionId === operation.sessionId ? operation.changed : undefined;
				if (
					missionId &&
					this.get(missionId) &&
					(linkChanges.has(missionId) || metadataChanged === true || (!same && metadataChanged !== false))
				) {
					this.event(
						missionId,
						"resource",
						`Pull request ${bound ? "bound to" : "unbound from"} chat ${sessionId}: ${parsed.url}`,
						operation.actor,
						{
							taskId:
								taskId ??
								[...tasks].find(
									([id, mission]) => mission === missionId && this.task(mission, id).sessionId === sessionId,
								)?.[0],
						},
					);
					affected.add(missionId);
				}
				this.run(
					`INSERT INTO pull_request_bindings (session_id, url, bound, mission_id, task_id) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (session_id, url) DO UPDATE SET bound = excluded.bound,
					mission_id = excluded.mission_id, task_id = excluded.task_id`,
					sessionId,
					parsed.url,
					bound ? 1 : 0,
					missionId ?? null,
					taskId ?? null,
				);
			};
			for (const sessionId of new Set(operation.previousSessionIds)) {
				if (sessionId !== operation.sessionId) record(sessionId, false, this.missionOf(sessionId));
			}
			record(operation.sessionId, operation.bound, targetMissionId, operation.bound ? operation.taskId : undefined);
			for (const [taskId, missionId] of tasks) {
				if (this.reconcileTaskPullRequests(missionId, taskId, operation.actor)) affected.add(missionId);
			}
			this.run(
				"INSERT INTO pull_request_binding_operations (id, applied_at) VALUES (?, ?)",
				operation.id,
				Date.now(),
			);
		});
		for (const missionId of affected) this.changed(missionId);
		return { changed, taskLinkRemoved };
	}

	/** Persist a fresh result for all copies of this URL and reconcile affected tasks together. */
	newlyMergedCoordinators(pr: SessionPullRequest): string[] {
		if (pr.state !== "merged") return [];
		return this.all(
			`SELECT DISTINCT m.coordinator_session_id FROM resources r JOIN missions m ON m.id = r.mission_id
			WHERE r.kind = 'github.pr' AND r.relationship = 'ownership' AND r.url = ? COLLATE NOCASE AND m.status = 'active'
			AND m.coordinator_session_id IS NOT NULL AND json_extract(r.pull_request, '$.state') IS NOT 'merged'`,
			pr.url,
		).map((row) => str(row.coordinator_session_id!));
	}

	updatePullRequest(
		pr: SessionPullRequest,
		members: SessionSummary[] = [],
		contextPrs?: (missionId: string) => SessionPullRequest[],
	): void {
		const rows = this.all(
			"SELECT DISTINCT mission_id FROM resources WHERE kind = 'github.pr' AND url = ? COLLATE NOCASE",
			pr.url,
		);
		const affected = new Set(rows.map((row) => str(row.mission_id!)));
		this.transaction(() => {
			for (const id of affected) {
				this.run(
					"UPDATE resources SET pull_request = ? WHERE mission_id = ? AND url = ? COLLATE NOCASE",
					JSON.stringify(pr),
					id,
					pr.url,
				);
				for (const task of this.all(
					"SELECT DISTINCT task_id FROM resources WHERE mission_id = ? AND url = ? COLLATE NOCASE AND task_id IS NOT NULL",
					id,
					pr.url,
				))
					this.reconcileTaskPullRequests(id, str(task.task_id!));
			}
			for (const member of members) {
				const id = this.missionOf(member.id);
				if (id && this.recordMemberPullRequests(member, [pr], false, contextPrs?.(id))) affected.add(id);
			}
		});
		for (const id of affected) this.changed(id);
	}

	private reconcileTaskPullRequests(id: string, taskId: string, handoffActor?: MissionActor): boolean {
		if (!handoffActor && this.require(id).status !== "active") return false;
		const task = this.task(id, taskId);
		if (
			task.status === "done" ||
			task.status === "dropped" ||
			(!handoffActor && this.one("SELECT pr_sync_disabled FROM tasks WHERE id = ?", taskId)?.pr_sync_disabled)
		)
			return false;
		const prs = this.all(
			"SELECT * FROM resources WHERE mission_id = ? AND task_id = ? AND kind = 'github.pr' AND relationship = 'ownership'",
			id,
			taskId,
		).map((row) => resourceFrom(row).pullRequest);
		const open = prs.some((pr) => pr?.state === "open" || pr?.state === "draft");
		// Unknown links block completion. Closed-unmerged links contribute nothing.
		const done =
			prs.length > 0 &&
			prs.every((pr) => pr && pr.state !== "open" && pr.state !== "draft") &&
			prs.some((pr) => pr?.state === "merged");
		const status = done
			? "done"
			: open
				? "in_review"
				: handoffActor && prs.every((pr) => pr?.state === "closed") && task.status === "in_review"
					? task.sessionId
						? "in_progress"
						: "todo"
					: undefined;
		if (!status || task.status === status) return false;
		const now = Date.now();
		this.run(
			"UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?",
			status,
			now,
			done ? now : null,
			taskId,
		);
		this.event(
			id,
			"task",
			`Task #${task.number} ${statusLabel(status)} after linked pull request ${done ? "merge" : open ? "opened" : "unbound"}: ${task.title}`,
			handoffActor ?? {},
			{ taskId, at: now },
		);
		return true;
	}

	linkArtifact(
		id: string,
		link: {
			sessionId: string;
			artifactId: string;
			title: string;
			kind: ArtifactKind;
			revision?: number;
			taskId?: string;
		},
		actor: MissionActor = USER,
	): MissionArtifactLink {
		this.require(id);
		if (
			!this.one(
				"SELECT 1 FROM artifact_links WHERE mission_id = ? AND artifact_id = ? AND session_id = ?",
				id,
				link.artifactId,
				link.sessionId,
			)
		)
			this.assertMember(id, link.sessionId);
		const taskId = link.taskId === undefined ? undefined : this.resolveTask(id, link.taskId).id;
		const now = Date.now();
		const value: MissionArtifactLink = {
			...(taskId ? { taskId } : {}),
			artifactId: link.artifactId,
			sessionId: link.sessionId,
			title: link.title,
			kind: link.kind,
			...(link.revision !== undefined ? { revision: link.revision } : {}),
			...(actor.sessionId ? { linkedBySessionId: actor.sessionId } : {}),
			linkedAt: now,
		};
		this.transaction(() => {
			this.run(
				"INSERT INTO artifact_links (mission_id, artifact_id, session_id, title, kind, revision, linked_by_session_id, linked_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET title = excluded.title, kind = excluded.kind, revision = excluded.revision, linked_by_session_id = excluded.linked_by_session_id, linked_at = excluded.linked_at",
				id,
				value.artifactId,
				value.sessionId,
				value.title,
				value.kind,
				value.revision ?? null,
				actor.sessionId ?? null,
				now,
				taskId ?? null,
			);
			this.event(id, "artifact", `Artifact linked: ${value.title}`, actor, { at: now, taskId });
		});
		this.changed(id);
		return value;
	}

	unlinkArtifact(id: string, artifactId: string, actor: MissionActor = USER, taskRef?: string): void {
		const taskId = taskRef === undefined ? null : this.resolveTask(id, taskRef).id;
		const row = this.one(
			"SELECT * FROM artifact_links WHERE mission_id = ? AND artifact_id = ? AND task_id IS ?",
			id,
			artifactId,
			taskId,
		);
		if (!row) throw new NotFound(`Unknown artifact link: ${artifactId}`);
		this.transaction(() => {
			this.run(
				"DELETE FROM artifact_links WHERE mission_id = ? AND artifact_id = ? AND task_id IS ?",
				id,
				artifactId,
				taskId,
			);
			this.event(id, "artifact", `Artifact unlinked: ${str(row.title!)}`, actor);
		});
		this.changed(id);
	}

	// Activity

	/** Replay-safe attribution. Only the execution-time mission receives the event. */
	recordGitHubAction(sessionId: string, action: GitHubAction, chat: string): void {
		const id = action.missionId;
		if (!id || !this.one("SELECT id FROM missions WHERE id = ?", id)) return;
		const retention = this.one("SELECT pruned_at FROM github_action_retention WHERE mission_id = ?", id);
		if (retention && action.at <= num(retention.pruned_at!)) return;
		if (
			this.one(
				"SELECT event_id FROM github_action_events WHERE session_id = ? AND action_id = ?",
				sessionId,
				action.id,
			)
		)
			return;
		const status =
			action.exitCode === 0
				? ""
				: action.exitCode === null
					? " (exit status unknown)"
					: ` (failed, exit ${action.exitCode})`;
		const description = action.exitCode === 0 ? action.description : `attempted: ${action.description}`;
		this.transaction(() => {
			const event = this.event(
				id,
				"github",
				`${chat} ${description}${status} · ${action.summary}`,
				{ sessionId },
				{ at: action.at },
			);
			this.run(
				"INSERT INTO github_action_events (session_id, action_id, event_id) VALUES (?, ?, ?)",
				sessionId,
				action.id,
				event.id,
			);
			const pruned = this.one(
				`SELECT MAX(at) AS at FROM events WHERE mission_id = ? AND kind = 'github' AND id NOT IN
				(SELECT id FROM events WHERE mission_id = ? AND kind = 'github' ORDER BY id DESC LIMIT 1000)`,
				id,
				id,
			);
			if (pruned?.at !== null && pruned?.at !== undefined)
				this.run(
					`INSERT INTO github_action_retention (mission_id, pruned_at) VALUES (?, ?)
					ON CONFLICT(mission_id) DO UPDATE SET pruned_at = MAX(pruned_at, excluded.pruned_at)`,
					id,
					num(pruned.at),
				);
			// Delete only automatic GitHub records, never authored notes or unrelated history.
			this.run(
				`DELETE FROM events WHERE mission_id = ? AND kind = 'github' AND id NOT IN
				(SELECT id FROM events WHERE mission_id = ? AND kind = 'github' ORDER BY id DESC LIMIT 1000)`,
				id,
				id,
			);
		});
		this.changed(id);
	}

	/** User-authored notes have their own bounded window, independent of automatic and agent activity. */
	userNotes(id: string, limit: number): MissionEvent[] {
		this.require(id);
		return this.all(
			`SELECT * FROM events WHERE mission_id = ? AND is_user_note = 1
			 ORDER BY id DESC LIMIT ?`,
			id,
			limit,
		).map(eventFrom);
	}

	events(id: string, before?: number, limit = DETAIL_EVENTS): MissionEvent[] {
		this.require(id);
		const rows =
			before === undefined
				? this.all("SELECT * FROM events WHERE mission_id = ? ORDER BY id DESC LIMIT ?", id, limit)
				: this.all(
						"SELECT * FROM events WHERE mission_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
						id,
						before,
						limit,
					);
		return rows.map(eventFrom);
	}

	log(id: string, write: MissionEventWrite, actor: MissionActor = USER): MissionEvent {
		this.require(id);
		if (!write || typeof write !== "object") throw new Error("Expected an event object");
		const eventText = text(write.text, "text", MAX_TEXT)!;
		const kind = write.kind ?? "update";
		if (kind !== "update" && kind !== "handoff") throw new Error("kind must be update or handoff");
		if (write.health !== undefined && !HEALTH.includes(write.health))
			throw new Error("health must be on_track, at_risk or off_track");
		const event = this.transaction(() =>
			this.event(id, kind, eventText, actor, {
				userNote: actor.sessionId === undefined,
				...(write.health ? { health: write.health } : {}),
			}),
		);
		this.changed(id);
		return event;
	}

	/** Automatic start activity is task activity, not an authored user note. */
	recordTaskStart(id: string, taskId: string, model: string, thinking: string): MissionEvent {
		const task = this.task(id, taskId);
		const event = this.transaction(() =>
			this.event(id, "task", `Started #${task.number} on ${model}, thinking ${thinking}`, USER, { taskId }),
		);
		this.changed(id);
		return event;
	}

	// Membership

	missionOf(sessionId: string): string | undefined {
		const row = this.one("SELECT mission_id FROM members WHERE session_id = ?", sessionId);
		return row ? str(row.mission_id!) : undefined;
	}

	members(id: string): string[] {
		return this.all("SELECT session_id FROM members WHERE mission_id = ? ORDER BY joined_at", id).map((row) =>
			str(row.session_id!),
		);
	}

	private assertMember(id: string, sessionId: unknown): void {
		if (typeof sessionId !== "string" || this.missionOf(sessionId) !== id)
			throw new Conflict("That chat is not in this mission");
	}

	/** Moving a chat from another mission releases its tasks there. */
	join(sessionId: string, id: string, actor: MissionActor = USER): void {
		this.require(id);
		const previous = this.missionOf(sessionId);
		if (previous === id) return;
		this.transaction(() => {
			if (previous) this.detach(sessionId, previous, actor);
			this.run(
				"INSERT INTO members (session_id, mission_id, joined_at) VALUES (?, ?, ?)",
				sessionId,
				id,
				Date.now(),
			);
			this.event(id, "member", "A chat joined the mission", { sessionId });
		});
		if (previous) this.changed(previous, []);
		this.changed(id, [sessionId]);
	}

	leave(sessionId: string, actor: MissionActor = USER): void {
		const id = this.missionOf(sessionId);
		if (!id) return;
		this.transaction(() => this.detach(sessionId, id, actor));
		this.changed(id, [sessionId]);
	}

	private detach(sessionId: string, id: string, actor: MissionActor): void {
		this.run("DELETE FROM members WHERE session_id = ?", sessionId);
		this.run("DELETE FROM member_runs WHERE session_id = ?", sessionId);
		this.run(
			"UPDATE tasks SET session_id = NULL, status = CASE status WHEN 'in_progress' THEN 'todo' ELSE status END WHERE mission_id = ? AND session_id = ?",
			id,
			sessionId,
		);
		this.run(
			"UPDATE missions SET coordinator_session_id = NULL WHERE id = ? AND coordinator_session_id = ?",
			id,
			sessionId,
		);
		this.event(id, "member", "A chat left the mission", actor.sessionId ? actor : { sessionId });
	}
}

function optionalAuthor(value: SQLInputValue | string | undefined): { authorSessionId?: string } {
	return value === null || value === undefined ? {} : { authorSessionId: String(value) };
}

function statusLabel(status: MissionTaskStatus): string {
	return status === "in_progress" ? "in progress" : status === "in_review" ? "in review" : status;
}

function missionFrom(row: Row): Mission {
	return {
		id: str(row.id!),
		projectId: str(row.project_id!),
		title: str(row.title!),
		goal: str(row.goal!),
		status: str(row.status!) as MissionStatus,
		...(row.coordinator_session_id ? { coordinatorSessionId: str(row.coordinator_session_id) } : {}),
		...(row.autopilot ? { autopilot: true } : {}),
		briefRevision: num(row.brief_revision!),
		needsYouCount: num(row.needs_you_count!),
		createdAt: num(row.created_at!),
		updatedAt: num(row.updated_at!),
		...(row.completed_at !== null && row.completed_at !== undefined ? { completedAt: num(row.completed_at) } : {}),
		...(row.archived_at !== null && row.archived_at !== undefined ? { archivedAt: num(row.archived_at) } : {}),
	};
}

function briefFrom(row: Row): MissionBrief {
	return {
		missionId: str(row.mission_id!),
		revision: num(row.revision!),
		markdown: str(row.markdown!),
		...optionalAuthor(row.author_session_id),
		createdAt: num(row.created_at!),
	};
}

function decisionAudience(value: unknown): MissionDecision["audience"] {
	if (value !== "all" && value !== "coordinator" && value !== "reference")
		throw new Error("audience must be all, coordinator or reference");
	return value;
}

function decisionFrom(row: Row): MissionDecision {
	return {
		id: str(row.id!),
		text: str(row.text!),
		audience: decisionAudience(row.audience),
		...optionalAuthor(row.author_session_id),
		createdAt: num(row.created_at!),
		updatedAt: num(row.updated_at!),
	};
}

function commentFrom(row: Row): MissionComment {
	return {
		id: str(row.id!),
		text: str(row.text!),
		...(row.anchor ? { anchor: str(row.anchor) } : {}),
		...(optional(row.revision, num) !== undefined ? { revision: num(row.revision!) } : {}),
		...optionalAuthor(row.author_session_id),
		...(row.target_session_id ? { targetSessionId: str(row.target_session_id) } : {}),
		createdAt: num(row.created_at!),
		...(optional(row.resolved_at, num) !== undefined ? { resolvedAt: num(row.resolved_at!) } : {}),
		...(row.resolved_by_session_id ? { resolvedBySessionId: str(row.resolved_by_session_id) } : {}),
	};
}

function taskFrom(row: Row): MissionTask {
	const dependsOn = row.depends_on ? (JSON.parse(str(row.depends_on)) as string[]) : undefined;
	return {
		id: str(row.id!),
		number: num(row.number!),
		title: str(row.title!),
		...(row.body ? { body: str(row.body) } : {}),
		status: str(row.status!) as MissionTaskStatus,
		order: num(row.sort!),
		...(row.milestone ? { milestone: str(row.milestone) } : {}),
		...(dependsOn?.length ? { dependsOn } : {}),
		...(row.decision_ids ? { decisionIds: JSON.parse(str(row.decision_ids)) as string[] } : {}),
		...(row.session_id ? { sessionId: str(row.session_id) } : {}),
		createdAt: num(row.created_at!),
		updatedAt: num(row.updated_at!),
		...(optional(row.completed_at, num) !== undefined ? { completedAt: num(row.completed_at!) } : {}),
	};
}

function artifactFrom(row: Row): MissionArtifactLink {
	return {
		...(row.task_id ? { taskId: str(row.task_id) } : {}),
		artifactId: str(row.artifact_id!),
		sessionId: str(row.session_id!),
		title: str(row.title!),
		kind: str(row.kind!) as ArtifactKind,
		...(optional(row.revision, num) !== undefined ? { revision: num(row.revision!) } : {}),
		...(row.linked_by_session_id ? { linkedBySessionId: str(row.linked_by_session_id) } : {}),
		linkedAt: num(row.linked_at!),
	};
}

function resourceFrom(row: Row): MissionResource {
	return {
		id: str(row.id!),
		relationship: str(row.relationship!) as MissionResource["relationship"],
		...(row.pull_request ? { pullRequest: JSON.parse(str(row.pull_request)) as SessionPullRequest } : {}),
		...(row.task_id ? { taskId: str(row.task_id) } : {}),
		url: str(row.url!),
		...(row.title ? { title: str(row.title) } : {}),
		kind: str(row.kind!) as MissionResourceKind,
		...(row.external_id ? { externalId: str(row.external_id) } : {}),
		...(row.added_by_session_id ? { addedBySessionId: str(row.added_by_session_id) } : {}),
		createdAt: num(row.created_at!),
	};
}

function eventFrom(row: Row): MissionEvent {
	return {
		id: num(row.id!),
		kind: str(row.kind!) as MissionEventKind,
		text: str(row.text!),
		...(row.session_id ? { sessionId: str(row.session_id) } : {}),
		...(row.task_id ? { taskId: str(row.task_id) } : {}),
		...(row.health ? { health: str(row.health) as MissionHealth } : {}),
		at: num(row.at!),
	};
}
