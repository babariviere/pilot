/** Missions: daemon-owned state shared by the chats of one goal. pilotd is the sole writer. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type Session, type SQLInputValue } from "node:sqlite";
import type {
	ArtifactKind,
	CatalogSharedTask,
	DelegationGrant,
	GitHubAction,
	Mission,
	MissionArtifactLink,
	MissionBrief,
	MissionBriefRevision,
	MissionCodeCompletion,
	MissionComment,
	MissionCommentWrite,
	MissionDecision,
	MissionDecisionProposal,
	MissionDetail,
	MissionEvent,
	MissionEventKind,
	MissionEventWrite,
	MissionHealth,
	MissionLinearRole,
	MissionLinearSync,
	MissionNonCodeDelivery,
	MissionPhase,
	MissionPhaseWrite,
	MissionResource,
	MissionResourceKind,
	MissionResourceUpdate,
	MissionResourceWrite,
	MissionRole,
	MissionStatus,
	MissionTask,
	MissionTaskStatus,
	MissionTaskWrite,
	MissionWorkerRole,
	OperationHost,
	SessionPullRequest,
	SessionSummary,
	SharedContextBinding,
	SharedEntity,
	SharedMissionChange,
	SharedMissionSnapshot,
	UpdateMissionRequest,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { operations } from "./event-loop-watchdog.ts";
import type { SharedMissionGroup } from "./mission-catalog.ts";
import {
	assertDeliveryAssignment,
	type DeliveryObservation,
	type DeliveryRecord,
	type DeliveryResolver,
	type DeliverySubmission,
	deliveryDigest,
	deliveryJudgementWrite,
	deliverySubmissionWrite,
	latestJudgement,
	latestSubmission,
} from "./mission-delivery-evidence.ts";
import {
	type LinearContributor,
	type LinearSyncRecord,
	linearTarget,
	reconcileLinearRecord,
} from "./mission-linear-state.ts";
import { parseNonCodeDelivery } from "./mission-non-code-delivery.ts";
import { assignmentWrite, strictPlanningFields, TASK_WRITE_FIELDS } from "./mission-planning.ts";
import { MissionReplica } from "./mission-replica.ts";
import { reasonLine } from "./needs-you-reason.ts";
import { NOTICE_HOURLY_CAP, NOTICE_WINDOW_MS, noticeDeadline, noticeInvolvesSession } from "./notice-dispatcher.ts";
import type { PullRequestBinding } from "./sessions.ts";

/** Who changed mission state. Omitted sessionId means the user (or pilotd itself). */
export interface MissionActor {
	sessionId?: string;
	/** Internal attribution when the user accepts a proposal. */
	proposedBySessionId?: string;
}

/** Activity selectors are applied in SQLite before limiting or paging. */
export interface MissionActivityQuery {
	taskId?: string;
	kind?: MissionEventKind;
	sinceEventId?: number;
	sinceAt?: number;
	before?: number;
	limit: number;
}

const USER: MissionActor = {};
const STATUSES: MissionStatus[] = ["active", "done", "archived"];
const TASK_STATUSES: MissionTaskStatus[] = [
	"todo",
	"in_progress",
	"blocked",
	"in_review",
	"delegated",
	"done",
	"dropped",
];
const HEALTH: MissionHealth[] = ["on_track", "at_risk", "off_track"];
const MAX_TITLE = 200;
const MAX_TEXT = 8_000;
const MAX_GOAL = 4_000;
const MAX_BRIEF = 256 * 1024;
const MAX_URL = 2_048;
const MAX_LINEAR_KEY = 256;
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
CREATE TABLE IF NOT EXISTS decision_proposals (
	id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	decision_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	text TEXT,
	reason TEXT NOT NULL,
	author_session_id TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_proposal_per_decision
	ON decision_proposals(mission_id, decision_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS proposals_by_mission ON decision_proposals(mission_id, status, resolved_at);
CREATE INDEX IF NOT EXISTS proposals_attention_order ON decision_proposals(mission_id, created_at, id) WHERE status = 'pending';
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
	id INTEGER PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS events_by_mission_task ON events (mission_id, task_id, id);
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
-- Lifetime admission history deliberately survives task deletion and mission changes.
CREATE TABLE IF NOT EXISTS member_task_claims (
	session_id TEXT NOT NULL,
	task_id TEXT NOT NULL,
	additional INTEGER NOT NULL,
	PRIMARY KEY (session_id, task_id)
);
CREATE TABLE IF NOT EXISTS session_continuations (
	from_session_id TEXT PRIMARY KEY,
	to_session_id TEXT NOT NULL
);
-- A first automatic observation is consumed even when task attribution is ambiguous.
-- Keep it after unlinking so creation/discovery replay cannot recreate deleted links.
CREATE TABLE IF NOT EXISTS automatic_pull_request_observations (
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	url TEXT NOT NULL COLLATE NOCASE,
	PRIMARY KEY (mission_id, url)
);
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
CREATE TABLE IF NOT EXISTS watch_activity (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	task_id TEXT,
	task_number INTEGER,
	title TEXT NOT NULL,
	at INTEGER NOT NULL,
	origin_session_id TEXT,
	annotated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS watch_activity_unannotated ON watch_activity(mission_id) WHERE annotated=0;
CREATE TRIGGER IF NOT EXISTS watch_task_done AFTER UPDATE OF status ON tasks
WHEN NEW.status='done' AND OLD.status<>'done' BEGIN
	INSERT INTO watch_activity(mission_id,task_id,task_number,title,at)
	VALUES(NEW.mission_id,NEW.id,NEW.number,NEW.title,NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS watch_mission_done AFTER UPDATE OF status ON missions
WHEN NEW.status='done' AND OLD.status<>'done' BEGIN
	INSERT INTO watch_activity(mission_id,title,at) VALUES(NEW.id,NEW.title,NEW.updated_at);
END;
CREATE TABLE IF NOT EXISTS pending_notices (
	event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	at INTEGER NOT NULL,
	text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_notices_by_mission ON pending_notices (mission_id, event_id);
CREATE TABLE IF NOT EXISTS task_completions (
	task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
	record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_non_code_deliveries (
	task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
	record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_delivery_evidence (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	operation_id TEXT NOT NULL,
	record_id TEXT NOT NULL UNIQUE,
	record_type TEXT NOT NULL,
	record TEXT NOT NULL,
	UNIQUE (mission_id, operation_id)
);
CREATE INDEX IF NOT EXISTS delivery_evidence_by_task ON task_delivery_evidence(task_id, sequence);
CREATE INDEX IF NOT EXISTS delivery_evidence_current ON task_delivery_evidence(task_id, record_type, sequence);
CREATE TABLE IF NOT EXISTS retired_members (
	session_id TEXT PRIMARY KEY,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	retired_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS urgent_notices (
	event_id INTEGER PRIMARY KEY REFERENCES pending_notices(event_id) ON DELETE CASCADE,
	immediate INTEGER NOT NULL
);
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
CREATE INDEX IF NOT EXISTS blocked_tasks_attention_order ON tasks (mission_id, sort, number) WHERE status = 'blocked';
CREATE INDEX IF NOT EXISTS tasks_by_member ON tasks (mission_id, session_id, status);
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
CREATE INDEX IF NOT EXISTS needs_you_comments_attention_order ON comments (mission_id, created_at, id)
	WHERE resolved_at IS NULL AND target_session_id IS NULL AND author_session_id IS NOT NULL;
`;

/** Task counts of one mission by status, dropped tasks excluded. To do and delegated are the rest of `total`. */
export interface MissionTaskProgress {
	done: number;
	inReview: number;
	inProgress: number;
	blocked: number;
	total: number;
}

export interface MissionNotice {
	requestId: string;
	missionId: string;
	lastEventId: number;
	sessionId: string;
	content: string;
	event: import("@pilot/protocol").ChatEventSummary;
}

export { NOTICE_DEBOUNCE_MS, NOTICE_HOURLY_CAP, NOTICE_MAX_DELAY_MS, NOTICE_WINDOW_MS } from "./notice-dispatcher.ts";

/** Summary-only attention and progress counts plus one bounded reason, without loading full task/comment bodies. */
const MISSION_SELECT = `SELECT missions.*,
	(SELECT COUNT(*) FROM tasks WHERE mission_id = missions.id AND status = 'blocked') +
	CASE WHEN coordinator_session_id IS NULL THEN
		(SELECT COUNT(*) FROM comments WHERE mission_id = missions.id AND resolved_at IS NULL
			AND target_session_id IS NULL AND author_session_id IS NOT NULL)
	ELSE 0 END +
	(SELECT COUNT(*) FROM decision_proposals WHERE mission_id = missions.id AND status = 'pending') +
	(SELECT COUNT(*) FROM resources WHERE mission_id = missions.id AND linear_role = 'managed'
		AND json_extract(linear_sync, '$.status.state') IN ('paused', 'error')) AS needs_you_count,
	(SELECT COUNT(*) FROM tasks WHERE mission_id = missions.id AND status = 'done') AS tasks_done,
	(SELECT COUNT(*) FROM tasks WHERE mission_id = missions.id AND status != 'dropped') AS tasks_total,
	(SELECT json_object('id', p.id, 'name', p.name,
		'done', (SELECT COUNT(*) FROM tasks t WHERE t.phase_id = p.id AND t.status = 'done'),
		'total', (SELECT COUNT(*) FROM tasks t WHERE t.phase_id = p.id AND t.status != 'dropped'))
		FROM phases p WHERE p.mission_id = missions.id AND p.completed_at IS NULL ORDER BY p.sort, p.id LIMIT 1
	) AS current_phase,
	COALESCE(
		(SELECT substr('Blocked: ' || title, 1, 201) FROM tasks
			WHERE mission_id = missions.id AND status = 'blocked' ORDER BY sort, number LIMIT 1),
		CASE WHEN coordinator_session_id IS NULL THEN
			(SELECT substr(text, 1, 201) FROM comments WHERE mission_id = missions.id AND resolved_at IS NULL
				AND target_session_id IS NULL AND author_session_id IS NOT NULL ORDER BY created_at, id LIMIT 1)
		END,
		(SELECT substr('Decision proposal: ' || reason, 1, 201) FROM decision_proposals
			WHERE mission_id = missions.id AND status = 'pending' ORDER BY created_at, id LIMIT 1),
		(SELECT substr('Linear ' || COALESCE(external_id, 'ticket') || ': ' ||
			COALESCE(json_extract(linear_sync, '$.status.error'), json_extract(linear_sync, '$.status.reason'),
				'Review synchronization'), 1, 201) FROM resources
			WHERE mission_id = missions.id AND linear_role = 'managed'
			AND json_extract(linear_sync, '$.status.state') IN ('paused', 'error') ORDER BY created_at, id LIMIT 1)
	) AS needs_you_reason
	FROM missions`;

type Row = Record<string, SQLInputValue>;

function noticeFrom(row: Row): MissionNotice {
	return {
		requestId: String(row.request_id),
		missionId: String(row.mission_id),
		lastEventId: Number(row.last_event_id),
		sessionId: String(row.session_id),
		content: String(row.content),
		event:
			typeof row.chat_event === "string"
				? JSON.parse(row.chat_event)
				: { kind: "mission_updated", text: "Mission updated" },
	};
}

function text(
	value: unknown,
	name: string,
	max: number,
	options: { optional?: boolean; empty?: boolean; codePoints?: boolean } = {},
) {
	if (value === undefined && options.optional) return undefined;
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	const trimmed = value.trim();
	if (!trimmed && !options.empty) throw new Error(`${name} is required`);
	if ((options.codePoints ? Array.from(value).length : value.length) > max)
		throw new Error(`${name} is too long (max ${max} characters)`);
	return trimmed;
}

function optional<T>(value: SQLInputValue | undefined, map: (value: SQLInputValue) => T): T | undefined {
	return value === null || value === undefined ? undefined : map(value);
}

/** Shape-only checks; scope and price-cap validation is asynchronous and belongs to the caller. */
function preference(write: MissionTaskWrite): { model?: string | null; thinking?: string | null } | undefined {
	if (write.preferredModel === undefined && write.preferredThinking === undefined) return undefined;
	const value = (input: unknown, name: string, max: number) =>
		input === undefined || input === null ? input : text(input, name, max) || null;
	return {
		...(write.preferredModel !== undefined ? { model: value(write.preferredModel, "preferredModel", 256) } : {}),
		...(write.preferredThinking !== undefined
			? { thinking: value(write.preferredThinking, "preferredThinking", 32) }
			: {}),
	};
}

const str = (value: SQLInputValue) => String(value);
const num = (value: SQLInputValue) => Number(value);

/** Shared validation for saved resources and start references, before any side effects. */
export function normalizeResourceWrite(write: MissionResourceWrite) {
	if (!write || typeof write !== "object") throw new Error("Expected a resource object");
	const parsed = parseResourceUrl(text(write.url, "url", MAX_URL)!);
	if (write.linearRole !== undefined) {
		if (!["reference", "managed", "contribution"].includes(write.linearRole)) throw new Error("Invalid Linear role");
		if (parsed.kind !== "linear.issue") throw new Error("Linear roles require a Linear issue");
	}
	const title = text(write.title, "title", MAX_TITLE, { optional: true, empty: true }) || undefined;
	return { ...parsed, ...(title ? { title } : {}) };
}

/** Workspace-scoped identifiers avoid collisions between Linear organizations. */
export function linearKey(url: string): string | undefined {
	const parts = new URL(url).pathname.split("/").filter(Boolean);
	if (
		!/^[a-z0-9][a-z0-9-]*$/i.test(parts[0] ?? "") ||
		parts[1] !== "issue" ||
		!/^[a-z0-9]+-[1-9]\d*$/i.test(parts[2] ?? "")
	)
		return undefined;
	const key = `${parts[0]!.toLowerCase()}/${parts[2]!.toUpperCase()}`;
	return key.length <= MAX_LINEAR_KEY ? key : undefined;
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
	/** Replica projections are reused across unrelated mission/memory invalidations. At most one per binding. */
	private readonly catalogReplicaCache = new Map<string, SharedMissionGroup[]>();
	private db: DatabaseSync;
	private readonly listeners = new Set<(missionId: string, passive?: boolean, preferenceOnly?: boolean) => void>();
	private readonly linearSyncListeners = new Set<() => void>();
	private readonly linearSyncChanged = new Set<string>();
	private readonly completionListeners = new Set<(projectId: string, missionId: string, at: number) => void>();
	private readonly memberListeners = new Set<(sessionId: string) => void>();
	private writing = false;
	private referenceBatch?: string;
	private batchedChanges?: Map<string, Set<string>>;
	/** Saves each commit to missions.sqlite off the event loop. Absent for ":memory:" stores. */
	private replica?: MissionReplica;
	/** Records the changes of the current commit, for the replica. */
	private session?: Session;
	private readonly phaseReconciliations = new Set<string>();
	private initializing = true;

	/** ":memory:" keeps state in memory, for tests. */
	constructor(file: string) {
		if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(file);
		this.migrate();
		if (file !== ":memory:") {
			// SQLite is synchronous and pilotd has one event loop, so a disk-backed connection made every read and
			// commit wait for a busy disk. The store now runs in memory; a worker thread saves each commit to disk,
			// and callers acknowledge writes to clients and chats only after durable().
			this.db.close();
			this.db = loadInMemory(file);
			this.replica = new MissionReplica(file, (error) => console.warn(`pilotd: ${error.message}`));
			this.session = this.db.createSession();
		}
	}

	/** Schema creation and upgrades, on the disk file at startup. */
	private migrate(): void {
		// The previous store's replica thread may still be closing its connection.
		this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		const migratePrTransitions = !this.one("SELECT 1 FROM sqlite_master WHERE name = 'pull_request_transitions'");
		this.db.exec(SCHEMA);
		if (!this.all("PRAGMA table_info(tasks)").some((row) => row.name === "created_by_session_id"))
			this.db.exec("ALTER TABLE tasks ADD COLUMN created_by_session_id TEXT");
		// Existing assignments are grandfathered, not retroactively charged.
		this.db.exec(`INSERT OR IGNORE INTO member_task_claims (session_id, task_id, additional)
			SELECT session_id, id, 0 FROM tasks WHERE session_id IS NOT NULL`);
		this.db.exec(`CREATE TABLE IF NOT EXISTS linear_pr_safety_reports (
			resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
			mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
			comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
			text TEXT NOT NULL
		);`);
		this.db.exec(`CREATE TABLE IF NOT EXISTS phases (
			id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
			name TEXT NOT NULL, goal TEXT, sort REAL NOT NULL, completed_at INTEGER,
			UNIQUE(mission_id, name)
		);
		CREATE INDEX IF NOT EXISTS phases_by_mission ON phases(mission_id, sort, id);`);
		this.transaction(() => {
			if (!this.all("PRAGMA table_info(missions)").some((row) => row.name === "phase_gating"))
				this.db.exec("ALTER TABLE missions ADD COLUMN phase_gating INTEGER NOT NULL DEFAULT 0");
			if (!this.all("PRAGMA table_info(tasks)").some((row) => row.name === "phase_id")) {
				this.db.exec("ALTER TABLE tasks ADD COLUMN phase_id TEXT REFERENCES phases(id) ON DELETE SET NULL");
				// Display order defines first appearance. Names are scoped to their mission.
				for (const row of this.all(
					"SELECT * FROM tasks WHERE milestone IS NOT NULL AND trim(milestone) <> '' ORDER BY mission_id, sort, number",
				)) {
					const missionId = str(row.mission_id!);
					const name = str(row.milestone!).trim();
					let phase = this.one("SELECT id FROM phases WHERE mission_id = ? AND name = ?", missionId, name);
					if (!phase) {
						const phaseId = randomUUID();
						this.run(
							"INSERT INTO phases (id, mission_id, name, sort) VALUES (?, ?, ?, (SELECT COUNT(*) FROM phases WHERE mission_id = ?))",
							phaseId,
							missionId,
							name,
							missionId,
						);
						phase = { id: phaseId };
					}
					this.run("UPDATE tasks SET phase_id = ?, milestone = ? WHERE id = ?", phase.id!, name, row.id!);
					this.phaseReconciliations.add(missionId);
				}
			}
			this.db.exec("CREATE INDEX IF NOT EXISTS tasks_by_phase ON tasks(phase_id, status)");
			this.db.exec(
				"CREATE INDEX IF NOT EXISTS unfinished_tasks_by_phase ON tasks(phase_id) WHERE status NOT IN ('done', 'dropped')",
			);
		});
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS system_message_events (session_id TEXT NOT NULL, event_id TEXT NOT NULL, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, PRIMARY KEY (session_id, event_id))",
		);
		if (!this.all("PRAGMA table_info(decisions)").some((row) => row.name === "audience"))
			this.db.exec("ALTER TABLE decisions ADD COLUMN audience TEXT NOT NULL DEFAULT 'reference'");
		this.transaction(() => {
			const migrateNumbers = !this.all("PRAGMA table_info(decisions)").some((row) => row.name === "number");
			const migrateSequence = !this.all("PRAGMA table_info(missions)").some(
				(row) => row.name === "decision_sequence",
			);
			if (migrateNumbers) {
				this.db.exec("ALTER TABLE decisions ADD COLUMN number INTEGER NOT NULL DEFAULT 0");
				this.db.exec(`UPDATE decisions SET number = (SELECT n FROM
					(SELECT id, ROW_NUMBER() OVER (PARTITION BY mission_id ORDER BY created_at, id) n FROM decisions) ranked
					WHERE ranked.id = decisions.id)`);
			}
			if (migrateSequence)
				this.db.exec("ALTER TABLE missions ADD COLUMN decision_sequence INTEGER NOT NULL DEFAULT 0");
			if (migrateNumbers || migrateSequence)
				this.db.exec(`UPDATE missions SET decision_sequence = MAX(decision_sequence,
					COALESCE((SELECT MAX(number) FROM decisions WHERE mission_id = missions.id), 0))`);
			this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS decision_numbers ON decisions(mission_id, number)");
		});
		if (!this.all("PRAGMA table_info(missions)").some((row) => row.name === "planning_version"))
			this.db.exec("ALTER TABLE missions ADD COLUMN planning_version INTEGER");
		if (!this.all("PRAGMA table_info(members)").some((row) => row.name === "role"))
			this.db.exec("ALTER TABLE members ADD COLUMN role TEXT");
		if (!this.all("PRAGMA table_info(tasks)").some((row) => row.name === "assignment"))
			this.db.exec("ALTER TABLE tasks ADD COLUMN assignment TEXT");
		if (!this.all("PRAGMA table_info(tasks)").some((row) => row.name === "decision_ids"))
			this.db.exec("ALTER TABLE tasks ADD COLUMN decision_ids TEXT");
		for (const column of ["delegated_to", "delegated_from_status", "delegated_resource_id"])
			if (!this.all("PRAGMA table_info(tasks)").some((row) => row.name === column))
				this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
		for (const column of ["preferred_model", "preferred_thinking", "preferred_model_by"])
			if (!this.all("PRAGMA table_info(tasks)").some((row) => row.name === column))
				this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
		this.db.exec(`CREATE TABLE IF NOT EXISTS linear_task_assignees (
			resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
			assignee_id TEXT
		)`);
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
		// Replication records changes by primary key, so the old rowid-only table gains an explicit one.
		if (!this.all("PRAGMA table_info(artifact_links)").some((row) => row.name === "id")) {
			const columns =
				"mission_id, artifact_id, session_id, title, kind, revision, linked_by_session_id, linked_at, task_id";
			this.db.exec(`BEGIN;
				ALTER TABLE artifact_links RENAME TO artifact_links_rowid;
				CREATE TABLE artifact_links (
					id INTEGER PRIMARY KEY,
					mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
					artifact_id TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL,
					kind TEXT NOT NULL, revision INTEGER, linked_by_session_id TEXT, linked_at INTEGER NOT NULL,
					task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE
				);
				INSERT INTO artifact_links (id, ${columns}) SELECT rowid, ${columns} FROM artifact_links_rowid;
				DROP TABLE artifact_links_rowid;
				COMMIT;`);
		}
		if (!this.all("PRAGMA table_info(notices)").some((row) => row.name === "chat_event"))
			this.db.exec("ALTER TABLE notices ADD COLUMN chat_event TEXT");
		this.db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS artifact_link_scope ON artifact_links(mission_id, artifact_id, COALESCE(task_id, ''))",
		);
		if (!this.all("PRAGMA table_info(resources)").some((row) => row.name === "task_id"))
			this.db.exec("ALTER TABLE resources ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL");
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS resources_by_linear_task ON resources(mission_id, task_id) WHERE kind = 'linear.issue'",
		);
		if (!this.all("PRAGMA table_info(resources)").some((row) => row.name === "pull_request"))
			this.db.exec("ALTER TABLE resources ADD COLUMN pull_request TEXT");
		if (!this.all("PRAGMA table_info(resources)").some((row) => row.name === "relationship"))
			this.transaction(() => {
				this.db.exec("ALTER TABLE resources ADD COLUMN relationship TEXT NOT NULL DEFAULT 'reference'");
				this.db.exec(
					"UPDATE resources SET relationship = 'ownership' WHERE kind = 'github.pr' AND task_id IS NOT NULL",
				);
			});
		this.transaction(() => {
			if (!this.all("PRAGMA table_info(resources)").some((row) => row.name === "linear_role")) {
				this.db.exec(
					"ALTER TABLE resources ADD COLUMN linear_role TEXT; ALTER TABLE resources ADD COLUMN linear_key TEXT",
				);
				// No existing link acquires lifecycle authority. Delegated task state is deliberately untouched.
				for (const row of this.all("SELECT id, url FROM resources WHERE kind = 'linear.issue'"))
					this.run(
						"UPDATE resources SET linear_role = 'reference', linear_key = ? WHERE id = ?",
						linearKey(str(row.url!)) ?? null,
						row.id!,
					);
			}
			this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS linear_ticket_manager ON resources(linear_key)
				WHERE linear_role = 'managed';
				CREATE UNIQUE INDEX IF NOT EXISTS linear_task_contribution ON resources(mission_id, task_id, linear_key)
				WHERE linear_role = 'contribution';`);
			this.db.exec(
				"CREATE INDEX IF NOT EXISTS resources_by_linear_key ON resources(mission_id, linear_key, task_id)",
			);
		});
		if (!this.all("PRAGMA table_info(missions)").some((row) => row.name === "passive_lifecycle"))
			this.db.exec("ALTER TABLE missions ADD COLUMN passive_lifecycle INTEGER NOT NULL DEFAULT 0");
		if (!this.all("PRAGMA table_info(tasks)").some((row) => row.name === "pr_sync_disabled"))
			this.db.exec("ALTER TABLE tasks ADD COLUMN pr_sync_disabled INTEGER NOT NULL DEFAULT 0");
		if (!this.all("PRAGMA table_info(resources)").some((row) => row.name === "linear_sync"))
			this.db.exec("ALTER TABLE resources ADD COLUMN linear_sync TEXT");
		this.db.exec(`CREATE TABLE IF NOT EXISTS linear_sync_dirty (
			resource_id TEXT PRIMARY KEY, structural INTEGER NOT NULL DEFAULT 0, reopened INTEGER NOT NULL DEFAULT 0);
			CREATE INDEX IF NOT EXISTS resources_by_managed_linear ON resources(id) WHERE linear_role = 'managed';
			CREATE INDEX IF NOT EXISTS managed_linear_by_mission ON resources(mission_id,created_at,id) WHERE linear_role='managed';
			CREATE UNIQUE INDEX IF NOT EXISTS resources_by_linear_uuid ON resources(json_extract(linear_sync,'$.status.issueId')) WHERE linear_role='managed';
			CREATE INDEX IF NOT EXISTS resources_by_contributing_task ON resources(task_id,linear_key,mission_id) WHERE linear_role='contribution';
			CREATE INDEX IF NOT EXISTS linear_sync_attention_order ON resources(mission_id,created_at,id)
				WHERE linear_role='managed' AND json_extract(linear_sync, '$.status.state') IN ('paused', 'error');
			CREATE TRIGGER IF NOT EXISTS shared_linear_sync_task AFTER UPDATE OF status ON tasks
			WHEN OLD.status <> NEW.status BEGIN
				INSERT OR IGNORE INTO linear_sync_dirty(resource_id) SELECT m.id FROM resources c JOIN resources m
				ON m.mission_id=c.mission_id AND m.linear_key=c.linear_key AND m.linear_role='managed'
				WHERE c.task_id=NEW.id AND c.linear_role='contribution';
				UPDATE linear_sync_dirty SET reopened=1 WHERE OLD.status IN ('done','dropped')
				AND NEW.status NOT IN ('done','dropped') AND resource_id IN (SELECT m.id FROM resources c JOIN resources m
				ON m.mission_id=c.mission_id AND m.linear_key=c.linear_key AND m.linear_role='managed'
				WHERE c.task_id=NEW.id AND c.linear_role='contribution'); END;
			CREATE TRIGGER IF NOT EXISTS shared_linear_sync_task_delete BEFORE DELETE ON tasks BEGIN
				INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) SELECT m.id,1 FROM resources c JOIN resources m
				ON m.mission_id=c.mission_id AND m.linear_key=c.linear_key AND m.linear_role='managed'
				WHERE c.task_id=OLD.id AND c.linear_role='contribution'; END;
			CREATE TRIGGER IF NOT EXISTS shared_linear_sync_insert AFTER INSERT ON resources
			WHEN NEW.linear_role IN ('managed','contribution') BEGIN
				INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) SELECT id,1 FROM resources
				WHERE mission_id=NEW.mission_id AND linear_key=NEW.linear_key AND linear_role='managed'; END;
			CREATE TRIGGER IF NOT EXISTS shared_linear_sync_delete AFTER DELETE ON resources
			WHEN OLD.linear_role IN ('managed','contribution') BEGIN
				INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) SELECT id,1 FROM resources
				WHERE mission_id=OLD.mission_id AND linear_key=OLD.linear_key AND linear_role='managed'; END;
			CREATE TRIGGER IF NOT EXISTS shared_linear_sync_role AFTER UPDATE OF linear_role,task_id,linear_key ON resources BEGIN
				INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) VALUES(NEW.id,1);
				INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) SELECT id,1 FROM resources WHERE mission_id=NEW.mission_id
				AND linear_key IN (OLD.linear_key,NEW.linear_key) AND linear_role='managed'; END;`);
		// Existing managed links start with a baseline, never an inferred completion.
		this.transaction(() => {
			this.run(
				"INSERT OR IGNORE INTO linear_sync_dirty(resource_id) SELECT id FROM resources WHERE linear_role='managed' AND linear_sync IS NULL",
			);
			this.reconcileLinearSync();
		});
		this.db.exec(`CREATE INDEX IF NOT EXISTS resources_by_owned_pr ON resources(mission_id, created_at, id)
			WHERE kind = 'github.pr' AND relationship = 'ownership'`);
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
		this.initializing = false;
		this.migrateSharing();
		this.transaction(() => {
			for (const row of this.all("SELECT DISTINCT mission_id FROM phases"))
				this.phaseReconciliations.add(str(row.mission_id!));
		});
	}

	/** Resolves once every committed change so far is on disk. Await before acknowledging a write. */
	private migrateSharing(): void {
		this.db.exec(`CREATE TABLE IF NOT EXISTS shared_records (
			namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,id)
		);
		CREATE TABLE IF NOT EXISTS shared_outbox (
			operation_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,destination TEXT NOT NULL,sequence INTEGER NOT NULL,
			acknowledged INTEGER NOT NULL,value TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS shared_outbox_active ON shared_outbox(binding_id,destination,sequence) WHERE acknowledged=0;
		CREATE INDEX IF NOT EXISTS shared_execution_state ON shared_records(namespace,json_extract(value,'$.state')) WHERE namespace GLOB 'execution:*';
		CREATE INDEX IF NOT EXISTS shared_execution_export ON shared_records(namespace,COALESCE(json_extract(value,'$.needsFactExport'),1)) WHERE namespace GLOB 'execution:*';
		CREATE TABLE IF NOT EXISTS shared_storage_budget(id INTEGER PRIMARY KEY,bytes INTEGER NOT NULL);
		INSERT OR IGNORE INTO shared_storage_budget SELECT 1,COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM shared_records;
		INSERT OR IGNORE INTO shared_storage_budget SELECT 2,COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM shared_outbox;
		CREATE TRIGGER IF NOT EXISTS shared_records_budget_insert AFTER INSERT ON shared_records BEGIN UPDATE shared_storage_budget SET bytes=bytes+length(CAST(NEW.value AS BLOB)) WHERE id=1; END;
		CREATE TRIGGER IF NOT EXISTS shared_records_budget_update AFTER UPDATE OF value ON shared_records BEGIN UPDATE shared_storage_budget SET bytes=bytes+length(CAST(NEW.value AS BLOB))-length(CAST(OLD.value AS BLOB)) WHERE id=1; END;
		CREATE TRIGGER IF NOT EXISTS shared_records_budget_delete AFTER DELETE ON shared_records BEGIN UPDATE shared_storage_budget SET bytes=bytes-length(CAST(OLD.value AS BLOB)) WHERE id=1; END;
		CREATE TRIGGER IF NOT EXISTS shared_outbox_budget_insert AFTER INSERT ON shared_outbox BEGIN UPDATE shared_storage_budget SET bytes=bytes+length(CAST(NEW.value AS BLOB)) WHERE id=2; END;
		CREATE TRIGGER IF NOT EXISTS shared_outbox_budget_update AFTER UPDATE OF value ON shared_outbox BEGIN UPDATE shared_storage_budget SET bytes=bytes+length(CAST(NEW.value AS BLOB))-length(CAST(OLD.value AS BLOB)) WHERE id=2; END;
		CREATE TABLE IF NOT EXISTS shared_entities (
			mission_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
			deleted INTEGER NOT NULL, value TEXT, PRIMARY KEY(mission_id,kind,id)
		);
		CREATE TABLE IF NOT EXISTS shared_changes (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, kind TEXT NOT NULL,
			id TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, value TEXT
		);
		CREATE INDEX IF NOT EXISTS shared_changes_mission ON shared_changes(mission_id,sequence);
		CREATE TABLE IF NOT EXISTS shared_task_definitions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS shared_authority_scopes (mission_id TEXT PRIMARY KEY);
		CREATE TABLE IF NOT EXISTS shared_internal_projection (id INTEGER PRIMARY KEY);
		CREATE TABLE IF NOT EXISTS shared_allocations (
			task_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, delegation_id TEXT NOT NULL,
			epoch INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL
		);`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS shared_allocations_binding ON shared_allocations(json_extract(value,'$.bindingId')); CREATE INDEX IF NOT EXISTS shared_allocations_mission ON shared_allocations(mission_id)",
		);
		const tables: [string, SharedEntity["kind"]][] = [
			["missions", "mission"],
			["brief_revisions", "brief"],
			["tasks", "task"],
			["decisions", "decision"],
			["comments", "comment"],
			["resources", "resource"],
			["artifact_links", "artifact"],
			["phases", "phase"],
		];
		for (const [table, kind] of tables) {
			const columns = this.all(`PRAGMA table_info(${table})`).map((row) => String(row.name));
			for (const [event, prefix, deleted] of [
				["INSERT", "NEW", 0],
				["UPDATE", "NEW", 0],
				["DELETE", "OLD", 1],
			] as const) {
				const mission = `${prefix}.${table === "missions" ? "id" : "mission_id"}`;
				const id = table === "brief_revisions" ? `${mission} || ':brief'` : `CAST(${prefix}.id AS TEXT)`;
				const definition =
					kind === "task" ? `(SELECT revision FROM shared_task_definitions WHERE id=${prefix}.id)` : undefined;
				const value = `json_object(${columns.flatMap((column) => [`'${column}'`, `${prefix}.${column}`]).join(",")}${definition ? `, 'definition_revision', ${definition}` : ""})`;
				this.db.exec(`DROP TRIGGER IF EXISTS shared_${table}_${event};
				CREATE TRIGGER shared_${table}_${event} AFTER ${event} ON ${table}
				WHEN EXISTS(SELECT 1 FROM shared_authority_scopes WHERE mission_id=${mission})
				${
					event === "UPDATE"
						? `AND (${columns
								.filter((column) => column !== "updated_at")
								.map((column) => `OLD.${column} IS NOT NEW.${column}`)
								.join(
									" OR ",
								)}${definition ? ` OR json_extract((SELECT value FROM shared_entities WHERE mission_id=${mission} AND kind='task' AND id=${id}),'$.definition_revision') IS NOT ${definition}` : ""})`
						: ""
				} BEGIN
					SELECT CASE WHEN (SELECT COUNT(*) FROM shared_changes)>=16384 THEN RAISE(ABORT,'Shared change retention full; reconciliation required') END;
					INSERT INTO shared_entities VALUES (${mission}, '${kind}', ${id}, 1, ${deleted}, ${value})
					ON CONFLICT(mission_id,kind,id) DO UPDATE SET revision=revision+1,deleted=${deleted},value=${value};
					INSERT INTO shared_changes(mission_id,kind,id,revision,deleted,value)
					SELECT mission_id,kind,id,revision,deleted,value FROM shared_entities
					WHERE mission_id=${mission} AND kind='${kind}' AND id=${id};
				END;`);
			}
		}
		this.db.exec(`INSERT OR IGNORE INTO shared_task_definitions SELECT id,1 FROM tasks;
			DROP TRIGGER IF EXISTS shared_task_definition_insert;
			CREATE TRIGGER shared_task_definition_insert BEFORE INSERT ON tasks BEGIN
				INSERT INTO shared_task_definitions VALUES(NEW.id,1); END;
			DROP TRIGGER IF EXISTS shared_task_definition_update;
			CREATE TRIGGER shared_task_definition_update BEFORE UPDATE OF title,body,depends_on,decision_ids,preferred_model,preferred_thinking,status,phase_id,session_id,milestone ON tasks
			WHEN NOT EXISTS(SELECT 1 FROM shared_internal_projection) AND (OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body OR OLD.depends_on IS NOT NEW.depends_on
			OR OLD.decision_ids IS NOT NEW.decision_ids OR OLD.preferred_model IS NOT NEW.preferred_model OR OLD.preferred_thinking IS NOT NEW.preferred_thinking
			OR OLD.status IS NOT NEW.status OR OLD.phase_id IS NOT NEW.phase_id OR OLD.session_id IS NOT NEW.session_id OR OLD.milestone IS NOT NEW.milestone)
			BEGIN UPDATE shared_task_definitions SET revision=revision+1 WHERE id=NEW.id; END;
			CREATE TRIGGER IF NOT EXISTS shared_assignment_fence BEFORE UPDATE OF session_id ON tasks
			WHEN NEW.session_id IS NOT NULL AND EXISTS(SELECT 1 FROM shared_allocations WHERE task_id=NEW.id AND sealed=0)
			BEGIN SELECT RAISE(ABORT,'Task has an occupied remote execution grant'); END;`);
		// Only current entities can be upgraded honestly. Historical deltas without a captured
		// definition revision remain unknown; clients must not infer one from activity or timestamps.
		this.db.exec(
			`UPDATE shared_entities SET value=json_set(value,'$.definition_revision',(SELECT revision FROM shared_task_definitions WHERE id=shared_entities.id)) WHERE kind='task' AND json_extract(value,'$.definition_revision') IS NULL`,
		);
	}
	shareMission(id: string): void {
		this.require(id);
		this.transaction(() => {
			if (this.one("SELECT 1 FROM shared_authority_scopes WHERE mission_id=?", id)) return;
			this.run("INSERT INTO shared_authority_scopes VALUES(?)", id);
			for (const [table, kind] of [
				["missions", "mission"],
				["brief_revisions", "brief"],
				["tasks", "task"],
				["decisions", "decision"],
				["comments", "comment"],
				["resources", "resource"],
				["artifact_links", "artifact"],
				["phases", "phase"],
			]) {
				const columns = this.all(`PRAGMA table_info(${table})`).map((row) => String(row.name));
				const mission = table === "missions" ? "id" : "mission_id";
				const entityId = table === "brief_revisions" ? "mission_id || ':brief'" : "CAST(id AS TEXT)";
				const value = `json_object(${columns.flatMap((column) => [`'${column}'`, column]).join(",")}${kind === "task" ? `, 'definition_revision', (SELECT revision FROM shared_task_definitions WHERE id=tasks.id)` : ""})`;
				this.run(
					`INSERT OR IGNORE INTO shared_entities SELECT ${mission},'${kind}',${entityId},1,0,${value} FROM ${table} WHERE ${mission}=? ${table === "brief_revisions" ? "ORDER BY revision DESC" : ""}`,
					id,
				);
			}
		});
	}

	/** Sharing safety records deliberately have no cascading foreign keys. */
	sharingGet<T>(namespace: string, id: string): T | undefined {
		const row = this.one("SELECT value FROM shared_records WHERE namespace=? AND id=?", namespace, id);
		return row ? (JSON.parse(String(row.value)) as T) : undefined;
	}
	sharingList<T>(namespace: string): T[] {
		return this.all("SELECT value FROM shared_records WHERE namespace=? ORDER BY id", namespace).map(
			(row) => JSON.parse(String(row.value)) as T,
		);
	}
	sharingPage<T>(namespace: string, after: string, limit: number): T[] {
		return this.all(
			"SELECT value FROM shared_records WHERE namespace=? AND id>? ORDER BY id LIMIT ?",
			namespace,
			after,
			Math.min(129, limit),
		).map((row) => JSON.parse(String(row.value)) as T);
	}
	sharingExecutions<T>(namespace: string, mode: "active" | "export"): T[] {
		return this.all(
			`SELECT value FROM shared_records WHERE namespace=? AND namespace GLOB 'execution:*' AND ${mode === "active" ? "json_extract(value,'$.state') IN ('accepted','cancel_requested')" : "COALESCE(json_extract(value,'$.needsFactExport'),1)=1"}`,
			namespace,
		).map((row) => JSON.parse(String(row.value)) as T);
	}
	sharingDeleteStaging(namespace: string): void {
		this.run("DELETE FROM shared_records WHERE namespace=?", namespace);
	}
	sharingOutbox<T>(bindingId: string, destination?: string, limit = 4096): T[] {
		const rows =
			destination === undefined
				? this.all(
						"SELECT value FROM shared_outbox WHERE binding_id=? AND acknowledged=0 ORDER BY sequence LIMIT ?",
						bindingId,
						limit,
					)
				: this.all(
						"SELECT value FROM shared_outbox WHERE binding_id=? AND destination=? AND acknowledged=0 ORDER BY sequence LIMIT ?",
						bindingId,
						destination,
						limit,
					);
		return rows.map((row) => JSON.parse(String(row.value)) as T);
	}
	sharingOutboxGet<T>(operationId: string): T | undefined {
		const row = this.one("SELECT value FROM shared_outbox WHERE operation_id=?", operationId);
		return row ? (JSON.parse(String(row.value)) as T) : undefined;
	}
	sharingOutboxCount(bindingId: string): number {
		return Number(
			this.one("SELECT COUNT(*) n FROM shared_outbox WHERE binding_id=? AND acknowledged=0", bindingId)?.n ?? 0,
		);
	}
	sharingOutboxPut(
		operation: import("@pilot/protocol").DurableOperation,
		value: {
			acknowledged: boolean;
			operation: import("@pilot/protocol").DurableOperation;
			transmitted: boolean;
			advance?: { kind: string; cursor: number };
		},
	): void {
		const serialized = JSON.stringify(value),
			previousBytes = Number(
				this.one(
					"SELECT length(CAST(value AS BLOB)) n FROM shared_outbox WHERE operation_id=?",
					operation.operationId,
				)?.n ?? 0,
			);
		if (
			Number(this.one("SELECT bytes FROM shared_storage_budget WHERE id=2")!.bytes) +
				Buffer.byteLength(serialized) -
				previousBytes >
			64 * 1024 * 1024
		)
			throw new Conflict("Sharing outbox byte retention full");
		if (
			!this.one("SELECT 1 FROM shared_outbox WHERE operation_id=?", operation.operationId) &&
			Number(this.one("SELECT COUNT(*) n FROM shared_outbox")!.n) >= 4096
		)
			throw new Conflict("Sharing outbox retention full");
		this.run(
			"INSERT INTO shared_outbox VALUES(?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET acknowledged=excluded.acknowledged,value=excluded.value",
			operation.operationId,
			operation.bindingId!,
			JSON.stringify(["daemon", operation.destination.daemonId, operation.destination.lineageId]),
			operation.sequence,
			value.acknowledged ? 1 : 0,
			serialized,
		);
	}
	sharingPut(namespace: string, id: string, value: unknown): void {
		const serialized = JSON.stringify(value),
			previousBytes = Number(
				this.one(
					"SELECT length(CAST(value AS BLOB)) n FROM shared_records WHERE namespace=? AND id=?",
					namespace,
					id,
				)?.n ?? 0,
			);
		if (
			Number(this.one("SELECT bytes FROM shared_storage_budget WHERE id=1")!.bytes) +
				Buffer.byteLength(serialized) -
				previousBytes >
			64 * 1024 * 1024
		)
			throw new Conflict("Sharing safety-record byte retention full");
		if (
			!this.one("SELECT 1 FROM shared_records WHERE namespace=? AND id=?", namespace, id) &&
			Number(this.one("SELECT COUNT(*) n FROM shared_records")!.n) >= 32768
		)
			throw new Conflict("Sharing safety-record retention full");
		if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Conflict("Sharing record too large");
		this.run(
			"INSERT INTO shared_records VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value",
			namespace,
			id,
			serialized,
		);
		if (namespace === "binding" || namespace === "replica") this.catalogReplicaCache.delete(id);
		else if (namespace.startsWith("proposal:")) this.catalogReplicaCache.delete(namespace.slice("proposal:".length));
	}
	sharingTransaction<T>(work: () => T): T {
		return this.batchChanges(work);
	}

	/** Commit related recovery writes together, then notify each affected mission/member once. */
	batchChanges<T>(work: () => T): T {
		if (this.batchedChanges) return this.transaction(work);
		const changed = new Map<string, Set<string>>();
		this.batchedChanges = changed;
		let committed = false;
		try {
			const value = this.transaction(work);
			committed = true;
			return value;
		} finally {
			this.batchedChanges = undefined;
			if (committed) for (const [missionId, sessions] of changed) this.changed(missionId, [...sessions]);
		}
	}
	sharingAttempt<T>(work: () => T): T {
		this.db.exec("SAVEPOINT shared_validation");
		try {
			const value = work();
			this.db.exec("RELEASE shared_validation");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK TO shared_validation; RELEASE shared_validation");
			throw error;
		}
	}
	sharedHead(): number {
		return Number(this.one("SELECT COALESCE(MAX(sequence),0) n FROM shared_changes")!.n);
	}
	sharedRevision(missionId: string, kind: SharedEntity["kind"], id: string): number {
		return Number(
			this.one("SELECT revision FROM shared_entities WHERE mission_id=? AND kind=? AND id=?", missionId, kind, id)
				?.revision ?? 0,
		);
	}
	sharedDefinitionRevision(taskId: string): number {
		return Number(this.one("SELECT revision FROM shared_task_definitions WHERE id=?", taskId)?.revision ?? 0);
	}
	sharedVersions(missionId: string, after: number, limit: number): import("@pilot/protocol").SharedEntityVersion[] {
		return this.all(
			"SELECT e.id,e.kind,e.revision,e.deleted,d.revision AS definition_revision FROM shared_entities e LEFT JOIN shared_task_definitions d ON e.kind='task' AND e.id=d.id WHERE e.mission_id=? ORDER BY e.kind,e.id LIMIT ? OFFSET ?",
			missionId,
			limit,
			after,
		).map((row) => ({
			id: String(row.id),
			kind: String(row.kind) as SharedEntity["kind"],
			revision: Number(row.revision),
			deleted: Boolean(row.deleted),
			...(row.definition_revision !== null ? { definitionRevision: Number(row.definition_revision) } : {}),
		}));
	}
	sharedSnapshot(id: string): SharedMissionSnapshot {
		if (!this.get(id)) {
			const tombstone = this.one(
				"SELECT value FROM shared_entities WHERE mission_id=? AND kind='mission' AND deleted=1",
				id,
			);
			if (!tombstone) throw new NotFound("No authoritative mission or tombstone");
			const mission = missionFrom({
				...JSON.parse(String(tombstone.value)),
				needs_you_count: 0,
				tasks_done: 0,
				tasks_total: 0,
			});
			mission.status = "archived";
			return {
				missionId: id,
				sequence: this.sharedHead(),
				detail: {
					mission,
					tasks: [],
					decisions: [],
					decisionProposals: [],
					comments: [],
					phases: [],
					artifacts: [],
					resources: [],
					events: [],
				},
				entities: this.all("SELECT * FROM shared_entities WHERE mission_id=?", id).map(sharedEntityFrom),
			};
		}
		return {
			missionId: id,
			sequence: this.sharedHead(),
			detail: this.detail(id),
			entities: this.all("SELECT * FROM shared_entities WHERE mission_id=?", id).map(sharedEntityFrom),
		};
	}
	sharedChanges(after: number, limit = 64): SharedMissionChange[] {
		return this.all(
			"SELECT * FROM shared_changes WHERE sequence>? ORDER BY sequence LIMIT ?",
			after,
			Math.min(64, limit),
		).map((row) => ({
			sequence: Number(row.sequence),
			missionId: String(row.mission_id),
			entity: sharedEntityFrom(row),
		}));
	}
	sharedAllocation(taskId: string): DelegationGrant | undefined {
		const row = this.one("SELECT value FROM shared_allocations WHERE task_id=? AND sealed=0", taskId);
		return row ? JSON.parse(String(row.value)) : undefined;
	}
	sharedGrants(bindingId?: string): DelegationGrant[] {
		return (
			bindingId === undefined
				? this.all("SELECT value FROM shared_allocations")
				: this.all("SELECT value FROM shared_allocations WHERE json_extract(value,'$.bindingId')=?", bindingId)
		).map((row) => JSON.parse(String(row.value)));
	}
	sharedMissionGrants(missionId: string): DelegationGrant[] {
		return this.all("SELECT value FROM shared_allocations WHERE mission_id=?", missionId).map((row) =>
			JSON.parse(String(row.value)),
		);
	}
	sharedGrantHistory(delegationId: string): DelegationGrant | undefined {
		return this.sharingGet<DelegationGrant>("grant-history", delegationId);
	}
	sharedTaskGrant(taskId: string): DelegationGrant | undefined {
		const row = this.one("SELECT value FROM shared_allocations WHERE task_id=?", taskId);
		return row ? JSON.parse(String(row.value)) : undefined;
	}
	reserveSharedGrant(grant: DelegationGrant, expectedPreviousEpoch: number): void {
		this.transaction(() => {
			const previous = this.one("SELECT epoch,sealed FROM shared_allocations WHERE task_id=?", grant.task.taskId);
			if (
				!Number.isSafeInteger(expectedPreviousEpoch) ||
				expectedPreviousEpoch < 0 ||
				expectedPreviousEpoch >= Number.MAX_SAFE_INTEGER ||
				expectedPreviousEpoch !== Number(previous?.epoch ?? 0) ||
				grant.executionEpoch !== expectedPreviousEpoch + 1
			)
				throw new Conflict("Task execution epoch CAS conflict; refresh mission-home inventory");
			if (this.require(grant.task.mission.missionId).status !== "active")
				throw new Conflict("Reopen mission before granting execution");
			if (grant.context.mission !== this.sharedHead())
				throw new Conflict("Mission context changed during grant preparation; reconcile and retry");
			this.prepareTaskStart(grant.task.mission.missionId, [grant.task.taskId]);
			if (this.sharedDefinitionRevision(grant.task.taskId) !== grant.definitionRevision)
				throw new Conflict("Task definition changed");
			if (previous && !previous.sealed) throw new Conflict("Previous target has not sealed this task");
			this.run(
				"INSERT INTO shared_allocations VALUES(?,?,?,?,0,?) ON CONFLICT(task_id) DO UPDATE SET mission_id=excluded.mission_id,delegation_id=excluded.delegation_id,epoch=excluded.epoch,sealed=0,value=excluded.value",
				grant.task.taskId,
				grant.task.mission.missionId,
				grant.delegationId,
				grant.executionEpoch,
				JSON.stringify(grant),
			);
			this.sharingPut("grant-history", grant.delegationId, grant);
		});
	}
	updateSharedGrant(grant: DelegationGrant): void {
		this.run(
			"UPDATE shared_allocations SET value=?,sealed=? WHERE delegation_id=? AND epoch=?",
			JSON.stringify(grant),
			grant.state === "sealed" ? 1 : 0,
			grant.delegationId,
			grant.executionEpoch,
		);
		this.sharingPut("grant-history", grant.delegationId, grant);
	}
	projectSharedProgress(grant: DelegationGrant, status: "in_progress" | "blocked" | "in_review" | "done"): void {
		if (this.sharedDefinitionRevision(grant.task.taskId) !== grant.definitionRevision) return;
		this.transaction(() => {
			this.run("INSERT INTO shared_internal_projection VALUES(1)");
			try {
				this.run(
					"UPDATE tasks SET status=?,updated_at=?,completed_at=? WHERE id=? AND status<>? AND status NOT IN ('done','dropped')",
					status,
					Date.now(),
					status === "done" ? Date.now() : null,
					grant.task.taskId,
					status,
				);
			} finally {
				this.run("DELETE FROM shared_internal_projection");
			}
		});
	}
	recordSharedFact(grant: DelegationGrant, event: import("@pilot/protocol").DelegationEvent, eligible: boolean): void {
		const missionId = grant.task.mission.missionId;
		if (!this.get(missionId)) return;
		const task = this.tasks(missionId).find((task) => task.id === grant.task.taskId);
		const text = `Remote ${event.kind} ${event.eventId}${eligible ? "" : " (late factual evidence; not projected)"}`;
		this.event(
			missionId,
			"update",
			text,
			{ sessionId: `shared:${grant.delegationId}` },
			{
				...(task ? { taskId: task.id } : {}),
				wake: event.kind !== "progress",
				urgent: event.kind === "question" || event.kind === "result",
				noticeText: text,
				noticeSummaries: [
					{
						key: `remote:${event.delegationId}`,
						text,
						state: event.kind === "result" ? String(event.payload.outcome ?? "unknown") : event.kind,
					},
				],
			},
		);
		this.changed(missionId);
	}

	durable(): Promise<void> {
		return this.replica?.durable() ?? Promise.resolve();
	}

	/** Like durable(), but undefined when nothing is waiting for the disk, so callers can stay synchronous. */
	whenDurable(): Promise<void> | undefined {
		return this.replica?.pending ? this.replica.durable() : undefined;
	}

	/** Waits (bounded) for unsaved commits; pilotd only closes the store at shutdown. */
	close(): void {
		this.session?.close();
		this.session = undefined;
		this.replica?.close();
		this.replica = undefined;
		this.db.close();
	}

	/** Ships the changes committed since the last call to the replica. */
	private replicate(): void {
		if (!this.session || !this.replica) return;
		const changes = this.session.changeset();
		if (!changes.length) return;
		this.session.close();
		this.session = this.db.createSession();
		this.replica.push(changes);
	}

	/** Called after every committed change of a mission, including membership and deletion. */
	onChange(listener: (missionId: string, passive?: boolean, preferenceOnly?: boolean) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	/** Only lifecycle intent changes, never chat activity, streaming or remote observation refreshes. */
	onLinearSyncChange(listener: () => void): () => void {
		this.linearSyncListeners.add(listener);
		return () => this.linearSyncListeners.delete(listener);
	}
	/** Only committed transitions to Done, not general activity or startup snapshots. */
	onCompleted(listener: (projectId: string, missionId: string, at: number) => void): () => void {
		this.completionListeners.add(listener);
		return () => this.completionListeners.delete(listener);
	}

	/** Called after a session joins or leaves a mission, or its mission is deleted. */
	onMembershipChange(listener: (sessionId: string) => void): () => void {
		this.memberListeners.add(listener);
		return () => this.memberListeners.delete(listener);
	}

	private changed(missionId: string, sessions: string[] = [], passive = false, preferenceOnly = false): void {
		if (this.batchedChanges) {
			const pending = this.batchedChanges.get(missionId) ?? new Set<string>();
			for (const session of sessions) pending.add(session);
			this.batchedChanges.set(missionId, pending);
			return;
		}
		if (this.referenceBatch === missionId) return;
		if (this.linearSyncChanged.delete(missionId)) for (const listener of this.linearSyncListeners) listener();
		for (const listener of this.listeners) listener(missionId, passive, preferenceOnly);
		for (const sessionId of sessions) for (const listener of this.memberListeners) listener(sessionId);
	}

	/**
	 * SQLite runs synchronously on pilotd's event loop (in memory for disk-backed stores). Attribute slow statements
	 * outside transactions, and whole transactions, in event-loop stall reports.
	 */
	private timed<T>(sql: string, work: () => T): T {
		if (this.writing) return work();
		const result = operations.time(() => `missions.sqlite ${sql.replace(/\s+/g, " ").trim().slice(0, 48)}`, work);
		// An autocommit write. A no-op produces an empty changeset, which is not shipped.
		if (this.session && !/^\s*(SELECT|PRAGMA)\b/i.test(sql)) this.replicate();
		return result;
	}

	private all(sql: string, ...params: SQLInputValue[]): Row[] {
		return this.timed(sql, () => this.db.prepare(sql).all(...params) as Row[]);
	}

	private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
		return this.timed(sql, () => this.db.prepare(sql).get(...params) as Row | undefined);
	}

	private run(sql: string, ...params: SQLInputValue[]): void {
		this.timed(sql, () => this.db.prepare(sql).run(...params));
	}

	private transaction<T>(work: () => T, preferenceOnly = false): T {
		// Reference batches reuse the ordinary validators/writers inside one outer transaction.
		if (this.writing) return work();
		return operations.time("missions.sqlite transaction", () => {
			this.db.exec("BEGIN IMMEDIATE");
			this.writing = true;
			try {
				const result = work();
				if (!this.initializing && !preferenceOnly)
					for (const id of this.phaseReconciliations) this.reconcilePhases(id);
				if (!this.initializing && !preferenceOnly) this.reconcileLinearSync();
				this.run("UPDATE watch_activity SET annotated=1 WHERE annotated=0");
				this.db.exec("COMMIT");
				return result;
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			} finally {
				this.phaseReconciliations.clear();
				this.writing = false;
				// After a rollback the changeset is empty, or a no-op for rows the session saw change back.
				this.replicate();
			}
		});
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
			urgent?: boolean;
			settled?: boolean;
			noticeText?: string;
			noticeSummaries?: { key: string; text: string; state?: string }[];
			userNote?: boolean;
		} = {},
	): MissionEvent {
		const at = extra.at ?? Date.now();
		if (kind === "task" || kind === "claim") this.phaseReconciliations.add(missionId);
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
		if (actor.sessionId)
			this.run(
				"UPDATE watch_activity SET origin_session_id=?,annotated=1 WHERE mission_id=? AND annotated=0",
				actor.sessionId,
				missionId,
			);
		if (extra.wake) {
			const coordinator = this.one(
				"SELECT coordinator_session_id FROM missions WHERE id = ?",
				missionId,
			)?.coordinator_session_id;
			const recipient = typeof coordinator === "string" ? coordinator : undefined;
			const taskSession = extra.taskId
				? this.one("SELECT session_id FROM tasks WHERE id = ?", extra.taskId)?.session_id
				: undefined;
			const taskSubject = typeof taskSession === "string" ? taskSession : undefined;
			const summaries = extra.noticeSummaries ?? [
				{
					key: extra.taskId ? `task:${extra.taskId}` : `note:${actor.sessionId ?? "user"}`,
					text: extra.noticeText ?? eventText,
				},
			];
			const remaining = summaries.filter(
				(summary) => !noticeInvolvesSession(recipient, ...this.noticeSummarySubjects(missionId, summary.key)),
			);
			if (!noticeInvolvesSession(recipient, actor.sessionId, taskSubject) && remaining.length) {
				this.run(
					"INSERT INTO pending_notices (event_id, mission_id, at, text) VALUES (?, ?, ?, ?)",
					eventId,
					missionId,
					at,
					extra.noticeText ?? eventText,
				);
				if (extra.urgent) this.run("INSERT INTO urgent_notices VALUES (?, ?)", eventId, extra.settled ? 0 : 1);
				for (const summary of remaining)
					this.run(
						"INSERT INTO pending_notice_summaries (event_id, group_key, text, state) VALUES (?, ?, ?, ?)",
						eventId,
						summary.key,
						summary.text,
						summary.state ?? null,
					);
			}
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

	/** Resolve chat subjects encoded by durable notice grouping keys. */
	private noticeSummarySubjects(missionId: string, key: string): string[] {
		const separator = key.indexOf(":");
		if (separator < 0) return [];
		const kind = key.slice(0, separator);
		const subject = key.slice(separator + 1);
		if (kind === "chat") return [subject];
		if (kind === "message") return [subject.split(":", 1)[0]!];
		if (kind === "task") {
			const row = this.one("SELECT session_id FROM tasks WHERE mission_id = ? AND id = ?", missionId, subject);
			return typeof row?.session_id === "string" ? [row.session_id] : [];
		}
		if (kind === "pr")
			return this.all(
				`SELECT DISTINCT t.session_id FROM resources r JOIN tasks t ON t.id = r.task_id
				WHERE r.mission_id = ? AND r.url = ? COLLATE NOCASE AND t.session_id IS NOT NULL`,
				missionId,
				subject,
			).flatMap((row) => (typeof row.session_id === "string" ? [row.session_id] : []));
		return [];
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
				const row = this.one(
					"SELECT pull_request FROM member_pull_requests WHERE mission_id = ? AND url = ?",
					id,
					pr.url,
				);
				const cached = row ? (JSON.parse(str(row.pull_request!)) as SessionPullRequest) : undefined;
				if (
					cached &&
					(cached.checkedAt > pr.checkedAt ||
						(cached.checkedAt === pr.checkedAt &&
							(cached.state === "merged" || cached.state === "closed") &&
							(pr.state === "open" || pr.state === "draft")))
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
				// First observations are a durable, silent baseline, not evidence of a transition.
				// Consume terminal states even when their timestamp is missing or later refreshed.
				if (!cached || cached.state === pr.state) continue;
				if (pr.state === "merged" && pr.mergedAt === undefined) continue;
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
		const membership = this.membership(session.id);
		if (!membership || membership.coordinator) return;
		const id = membership.missionId;
		if (this.one("SELECT 1 FROM member_runs WHERE session_id = ?", session.id)) return;
		this.run(
			"INSERT INTO member_runs (session_id, mission_id, done_tasks) VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING",
			session.id,
			id,
			JSON.stringify(
				this.all(
					"SELECT id FROM tasks WHERE mission_id = ? AND session_id = ? AND status = 'done' ORDER BY sort, number",
					id,
					session.id,
				).map((row) => str(row.id!)),
			),
		);
	}

	/** Durable high-water mark prevents ready snapshots/restarts from announcing a completion twice. */
	recordMemberCompletion(session: SessionSummary, recovering = false): void {
		if (session.working || session.runningJobs?.length || !session.outcome || session.outcomeAt === undefined) return;
		const membership = this.membership(session.id);
		if (!membership || membership.coordinator) return;
		const id = membership.missionId;
		const previous = this.one("SELECT * FROM member_completions WHERE session_id = ?", session.id);
		if (previous && num(previous.outcome_at!) > session.outcomeAt) return;
		// Older stores may contain a waiting snapshot at the same outcome version.
		const previousWaiting = previous?.signature && JSON.parse(str(previous.signature))[0] === "waiting";
		if (previous && num(previous.outcome_at!) === session.outcomeAt && !previousWaiting) return;
		const ownedTasks = this.all(
			"SELECT * FROM tasks WHERE mission_id = ? AND session_id = ? ORDER BY sort, number",
			id,
			session.id,
		).map(taskFrom);
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
			session.outcome,
			session.outcomeReason ?? null,
			tasks.map((task) => task.id).sort(),
			prs.map((pr) => [pr.url, pr.state]).sort(),
			[], // Retain the signature shape used by older completion records.
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
			this.run("DELETE FROM member_runs WHERE session_id = ?", session.id);
			if (ownedTasks.length && !tasks.length) return;
			if (session.outcome === "done" && tasks.length && tasks.every((task) => this.completion(id, task.id))) return;
			// Startup is recovery, not a replay of all historical outcomes of newly attached chats.
			if (recovering && !previous && session.outcomeAt! < joinedAt) return;
			// Distinct failures remain useful (and can be counted), but unchanged successful/stopped
			// snapshots must not produce another notice just because their outcome version advanced.
			if ((previous?.signature === signature || unchangedLegacy) && session.outcome !== "failed") return;
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
			const note = `${label}: chat ${session.outcome === "done" ? "finished" : session.outcome === "question" ? "asked a question" : session.outcome}${relevantPrs.length ? `, ${relevantPrs.map((pr) => `PR #${pr.number} ${pr.state}`).join(", ")}` : ""}${session.outcomeReason ? `: ${session.outcomeReason}` : ""}`;
			const suffix = note.slice(label.length);
			this.event(
				id,
				"update",
				note,
				{ sessionId: session.id },
				{
					wake: true,
					urgent: session.outcome === "question" || session.outcome === "failed" || session.outcome === "done",
					settled: session.outcome === "done",
					noticeSummaries: tasks.length
						? tasks.map((task) => ({
								key: `task:${task.id}`,
								text: `#${task.number} ${task.title}${suffix}`,
								state: session.outcome,
							}))
						: [{ key: `chat:${session.id}`, text: note, state: session.outcome }],
				},
			);
		});
		this.changed(id);
	}

	/** Persist only activity transitions, not streaming summary updates. */
	setNoticeActivity(id: string, busy: boolean, now: number): void {
		this.run(
			`INSERT INTO notice_activity (mission_id, busy, idle_at) VALUES (?, ?, ?)
			ON CONFLICT(mission_id) DO UPDATE SET busy = excluded.busy, idle_at = ?
			WHERE notice_activity.busy <> excluded.busy`,
			id,
			busy ? 1 : 0,
			busy ? now : 0,
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
			SELECT p.*, n.request_id, a.busy, a.idle_at, r.delivered_at AS capped_at,
			(SELECT MAX(u.immediate) FROM urgent_notices u
			 JOIN pending_notices pn ON pn.event_id=u.event_id
			 JOIN pending_notice_summaries summary ON summary.event_id=u.event_id
			 WHERE pn.mission_id=p.mission_id AND NOT EXISTS (
			 SELECT 1 FROM pending_notice_summaries newer JOIN pending_notices np ON np.event_id=newer.event_id
			 WHERE np.mission_id=p.mission_id AND newer.group_key=summary.group_key AND newer.event_id>summary.event_id
			 )) AS urgent
			FROM pending p
			LEFT JOIN notice_activity a ON a.mission_id = p.mission_id
			LEFT JOIN notices n ON n.mission_id = p.mission_id AND n.delivered_at IS NULL
			LEFT JOIN recent r ON r.mission_id = p.mission_id AND r.rank = ?`,
			...(id ? [id] : []),
			now - NOTICE_WINDOW_MS,
			NOTICE_HOURLY_CAP,
		);
		return rows.map((row) => {
			const missionId = str(row.mission_id!);
			return {
				missionId,
				at:
					row.urgent !== null && (row.busy !== 1 || row.urgent === 1)
						? now
						: noticeDeadline(
								{
									firstAt: num(row.first_at!),
									lastAt: num(row.last_at!),
									idleAt: num(row.idle_at ?? 0),
									busy: row.busy === 1,
									immediateWhenIdle: false,
									retry: !!row.request_id,
									cappedAt: row.capped_at === null ? undefined : num(row.capped_at!),
								},
								now,
							),
			};
		});
	}

	pendingNotice(id: string): MissionNotice | undefined {
		const row = this.one("SELECT * FROM notices WHERE mission_id = ? AND delivered_at IS NULL", id);
		return row ? noticeFrom(row) : undefined;
	}

	/** Freeze both the cutoff and payload before IPC, so an uncertain acknowledgement has a stable retry. */
	prepareNotice(id: string, sessionId: string, now: number): MissionNotice | undefined {
		const mission = this.require(id);
		if (mission.status !== "active" || this.passiveLifecycle(id) || mission.coordinatorSessionId !== sessionId)
			return undefined;
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
			) SELECT s.*, e.kind AS event_kind, g.failures, COUNT(*) OVER () AS total
				FROM grouped g JOIN pending_notice_summaries s ON s.event_id = g.event_id AND s.group_key = g.group_key
                JOIN events e ON e.id = s.event_id
				ORDER BY s.event_id LIMIT 100`,
				id,
			);
			if (!events.length) return undefined;
			const lastEventId = num(
				this.one("SELECT MAX(event_id) AS id FROM pending_notices WHERE mission_id = ?", id)!.id!,
			);
			const requestId = `mission-notice:${lastEventId}`;
			const first = events[0]!;
			const single = num(first.total!) === 1;
			const kind =
				single && first.event_kind === "update" && first.state === "done"
					? "mission_member_finished"
					: single && first.event_kind === "task" && first.state === "done"
						? "mission_task_done"
						: "mission_updated";
			const event: import("@pilot/protocol").ChatEventSummary = {
				kind,
				text:
					single && !str(first.group_key!).startsWith("note:")
						? str(first.text!).replace(/\s+/g, " ").slice(0, 200)
						: single
							? "Mission updated"
							: `Mission updated · ${num(first.total!)} updates`,
			};
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
				"Read the mission with get for details.",
			].join("\n");
			this.run(
				"INSERT INTO notices (request_id, mission_id, last_event_id, session_id, content, created_at, chat_event) VALUES (?, ?, ?, ?, ?, ?, ?)",
				requestId,
				id,
				lastEventId,
				sessionId,
				content,
				now,
				JSON.stringify(event),
			);
			return { requestId, missionId: id, lastEventId, sessionId, content, event };
		});
	}

	noticeAllowed(sessionId: string, requestId: string): boolean {
		return !!this.one(
			"SELECT n.request_id FROM notices n JOIN missions m ON m.id = n.mission_id JOIN members member ON member.mission_id = m.id AND member.session_id = n.session_id WHERE n.request_id = ? AND n.session_id = ? AND n.delivered_at IS NULL AND m.status = 'active' AND m.passive_lifecycle = 0 AND m.coordinator_session_id = n.session_id",
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

	/** PR synchronization needs neither attention counts nor mission content. */
	pullRequestMissions(): Array<Pick<Mission, "id" | "projectId">> {
		return this.all("SELECT id, project_id FROM missions WHERE status = 'active' ORDER BY updated_at DESC").map(
			(row) => ({ id: str(row.id!), projectId: str(row.project_id!) }),
		);
	}

	ownedPullRequestResources(id: string): Array<Pick<MissionResource, "url" | "pullRequest">> {
		return this.all(
			`SELECT url, pull_request FROM resources
			WHERE mission_id = ? AND kind = 'github.pr' AND relationship = 'ownership' ORDER BY created_at, id`,
			id,
		).map((row) => ({
			url: str(row.url!),
			...(row.pull_request ? { pullRequest: JSON.parse(str(row.pull_request)) as SessionPullRequest } : {}),
		}));
	}

	get(id: string): Mission | undefined {
		const row = this.one(`${MISSION_SELECT} WHERE id = ?`, id);
		return row ? missionFrom(row) : undefined;
	}

	/** Thin, bounded per-scope projection for the change-driven mission catalog, never a tool-time read.
	 * SQL extracts only display fields, not grant requests, replica bodies, events or proposal arguments.
	 * Connectivity is deliberately absent: missing facts cannot fail a task or release a grant.
	 */
	catalogSharedContext(host: OperationHost): SharedMissionGroup[] {
		const groups: SharedMissionGroup[] = [];
		const parseTask = (row: Row): CatalogSharedTask => {
			const value = JSON.parse(str(row.value!));
			for (const key of Object.keys(value)) if (value[key] === null) delete value[key];
			return value;
		};
		for (const mission of this.all(
			`SELECT DISTINCT m.id, m.project_id FROM shared_allocations a JOIN missions m ON m.id=a.mission_id
			WHERE json_extract(a.value,'$.task.mission.home.daemonId')=?
			AND json_extract(a.value,'$.task.mission.home.lineageId')=? ORDER BY m.id`,
			host.daemonId,
			host.lineageId,
		)) {
			const rows = this.all(
				`SELECT COUNT(*) OVER() AS total, json_object(
				'id', 'grant:' || a.delegation_id, 'bindingId', json_extract(a.value,'$.bindingId'),
				'projectId', ?, 'missionId', a.mission_id, 'missionHome', json_extract(a.value,'$.task.mission.home'),
				'source', 'mission-home', 'consistency', 'committed', 'taskId', a.task_id,
				'taskNumber', t.number, 'title', substr(t.title,1,160), 'status', t.status,
				'delegationId', a.delegation_id, 'executionEpoch', a.epoch,
				'executionHost', json_extract(a.value,'$.target.host'), 'grantState', json_extract(a.value,'$.state'),
				'running', CASE WHEN a.sealed=1 THEN json('false')
				WHEN json_extract(p.value,'$.eligible')=1
				AND json_extract(p.value,'$.event.delegationId')=a.delegation_id
				AND json_extract(p.value,'$.event.executionEpoch')=a.epoch
				THEN json(CASE json_extract(p.value,'$.event.payload.working') WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE 'null' END)
				ELSE NULL END) AS value
				FROM shared_allocations a LEFT JOIN tasks t ON t.id=a.task_id
				LEFT JOIN shared_records p ON p.namespace='remote-projection' AND p.id=a.delegation_id
				WHERE a.mission_id=? ORDER BY a.task_id LIMIT 100`,
				mission.project_id!,
				mission.id!,
			);
			groups.push({
				projectId: str(mission.project_id!),
				missionId: str(mission.id!),
				tasks: rows.map(parseTask),
				tasksTotal: Number(rows[0]?.total ?? 0),
			});
		}
		for (const binding of this.sharingList<SharedContextBinding>("binding")) {
			if (
				binding.state !== "active" ||
				(binding.missionHome.daemonId === host.daemonId && binding.missionHome.lineageId === host.lineageId) ||
				binding.executionProject.host.daemonId !== host.daemonId ||
				binding.executionProject.host.lineageId !== host.lineageId
			)
				continue;
			const cached = this.catalogReplicaCache.get(binding.bindingId);
			if (cached) {
				groups.push(...cached);
				continue;
			}
			const bindingGroups: SharedMissionGroup[] = [];
			for (const missionId of binding.missionIds) {
				// json_each avoids loading the full replica object in JavaScript, even for a large brief/history.
				const snapshot = this.one(
					`SELECT json_extract(r.value,'$.complete') AS complete, json_extract(r.value,'$.sequence') AS sequence,
					json_extract(r.value,'$.syncedAt') AS synced_at, substr(json_extract(s.value,'$.detail.mission.title'),1,160) AS title,
					json_extract(s.value,'$.detail.mission.status') AS status
					FROM shared_records r LEFT JOIN json_each(r.value,'$.missions') s ON s.key=?
					WHERE r.namespace='replica' AND r.id=?`,
					missionId,
					binding.bindingId,
				);
				const projectId = binding.executionProject.projectId;
				const syncedAt = snapshot?.synced_at == null ? undefined : Number(snapshot.synced_at);
				const complete = snapshot?.complete === 1 && snapshot?.title != null;
				const base = {
					bindingId: binding.bindingId,
					projectId,
					missionId,
					missionHome: binding.missionHome,
					source: "replica" as const,
					replicaSyncedAt: syncedAt,
					replicaAgeMs: null,
				};
				const rows = complete
					? this.all(
							`WITH display AS (
					SELECT 0 AS kind, json_extract(t.value,'$.id') AS sort, json_object(
					'id', 'replica:' || ? || ':' || ? || ':' || json_extract(t.value,'$.id'),
					'consistency','committed','taskId',json_extract(t.value,'$.id'),'taskNumber',json_extract(t.value,'$.number'),
					'title',substr(json_extract(t.value,'$.title'),1,160),'status',json_extract(t.value,'$.status')) AS value
					FROM shared_records r, json_each(r.value,'$.missions') s, json_each(s.value,'$.detail.tasks') t
					WHERE r.namespace='replica' AND r.id=? AND s.key=?
					UNION ALL SELECT 1, p.id, json_object('id','proposal:' || ? || ':' || p.id,
					'consistency','provisional','proposalId',p.id,'proposalState',json_extract(p.value,'$.state'),
					'taskId',CASE WHEN json_extract(p.value,'$.args.id') IS NOT NULL THEN json_extract(p.value,'$.entityId') END,
					'title',substr(json_extract(p.value,'$.args.title'),1,160),'status',json_extract(p.value,'$.args.status'))
					FROM shared_records p WHERE p.namespace=? AND json_extract(p.value,'$.missionId')=?
					AND json_extract(p.value,'$.action')='task' AND json_extract(p.value,'$.state')!='committed')
					SELECT COUNT(*) OVER() AS total, value FROM display ORDER BY kind, sort LIMIT 100`,
							binding.bindingId,
							missionId,
							binding.bindingId,
							missionId,
							binding.bindingId,
							`proposal:${binding.bindingId}`,
							missionId,
						)
					: [];
				bindingGroups.push({
					projectId,
					missionId,
					replica: {
						id: `replica:${binding.bindingId}:${missionId}`,
						...base,
						consistency: "committed",
						complete,
						sequence: Number(snapshot?.sequence ?? 0),
						...(complete
							? { title: str(snapshot!.title!), status: str(snapshot!.status!) as MissionStatus }
							: {}),
					},
					tasks: rows.map((row) => ({ ...base, ...parseTask(row) })),
					tasksTotal: Number(rows[0]?.total ?? 0),
				});
			}
			this.catalogReplicaCache.set(binding.bindingId, bindingGroups);
			groups.push(...bindingGroups);
		}
		return groups;
	}

	/** Lifecycle listeners need no task counts or attention projection. */
	status(id: string): MissionStatus | undefined {
		return this.one("SELECT status FROM missions WHERE id = ?", id)?.status as MissionStatus | undefined;
	}

	/** Task counts per mission (dropped tasks excluded), for summaries that do not load task bodies. */
	taskProgress(projectId?: string): Map<string, MissionTaskProgress> {
		const rows = this.all(
			`SELECT t.mission_id AS id, SUM(t.status = 'done') AS done, SUM(t.status = 'in_review') AS in_review,
				SUM(t.status = 'in_progress') AS in_progress, SUM(t.status = 'blocked') AS blocked, COUNT(*) AS total
				FROM tasks t JOIN missions m ON m.id = t.mission_id
				WHERE t.status != 'dropped'${projectId ? " AND m.project_id = ?" : ""}
				GROUP BY t.mission_id`,
			...(projectId ? [projectId] : []),
		);
		return new Map(
			rows.map((row) => [
				str(row.id!),
				{
					done: num(row.done!),
					inReview: num(row.in_review!),
					inProgress: num(row.in_progress!),
					blocked: num(row.blocked!),
					total: num(row.total!),
				},
			]),
		);
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
			decisions: this.all("SELECT * FROM decisions WHERE mission_id = ? ORDER BY number", id).map(decisionFrom),
			decisionProposals: this.proposals(id),
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
			phases: this.phases(id),
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
			planningVersion?: 1;
			title: unknown;
			goal?: unknown;
			brief?: unknown;
			tasks?: Array<{ title: unknown; body?: unknown }>;
		},
		actor: MissionActor = USER,
	): Mission {
		if (input.planningVersion !== undefined && input.planningVersion !== 1)
			throw new Error("Unsupported planningVersion; only version 1 can be created");
		if (input.planningVersion !== undefined && actor.sessionId)
			throw new Conflict("Only the user can opt in to coordinator-owned planning");
		const title = text(input.title, "title", MAX_TITLE)!;
		const goal = text(input.goal ?? "", "goal", MAX_GOAL, { empty: true })!;
		const brief = input.brief === undefined ? undefined : text(input.brief, "brief", MAX_BRIEF, { empty: true });
		if (input.tasks !== undefined && !Array.isArray(input.tasks)) throw new Error("tasks must be an array");
		const tasks = (input.tasks ?? []).map((task) => ({
			title: text(task?.title, "task title", MAX_TITLE, { codePoints: true })!,
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
			if (input.planningVersion !== undefined)
				this.run("UPDATE missions SET planning_version = ? WHERE id = ?", input.planningVersion, id);
			this.event(id, "created", `Mission created: ${title}`, actor, { at: now });
			if (brief) this.insertBrief(id, brief, 1, actor, now);
			for (const task of tasks) this.insertTask(id, { title: task.title, body: task.body }, actor);
		});
		this.changed(id);
		return this.require(id);
	}

	update(id: string, patch: UpdateMissionRequest, actor: MissionActor = USER): Mission {
		if ("planningVersion" in patch) throw new Conflict("Planning opt-in is creation-only; adoption is not supported");
		this.assertPlanner(id, actor);
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
		if (patch.phaseGating !== undefined) {
			if (typeof patch.phaseGating !== "boolean") throw new Error("phaseGating must be a boolean");
			next.phaseGating = patch.phaseGating;
			if (next.phaseGating !== mission.phaseGating)
				notes.push(["update", `Phase gating ${next.phaseGating ? "enabled" : "disabled"}`]);
		}
		if (patch.coordinatorSessionId !== undefined) {
			if (patch.coordinatorSessionId !== null) {
				if (typeof patch.coordinatorSessionId !== "string")
					throw new Error("coordinatorSessionId must be a string or null");
				if (this.missionOf(patch.coordinatorSessionId) !== id)
					throw new Conflict("The coordinator must be a chat in this mission");
				if (this.membership(patch.coordinatorSessionId)?.role === "explorer")
					throw new Conflict("An explorer cannot become coordinator; start a separate coordinator chat");
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
			this.run("UPDATE missions SET phase_gating = ? WHERE id = ?", next.phaseGating ? 1 : 0, id);
			if (next.status === "active" && mission.status !== "active")
				for (const task of this.tasks(id)) this.reconcileTaskPullRequests(id, task.id);
		});
		// Status and coordinator changes alter every member's context.
		if (next.status === "done" && mission.status !== "done")
			for (const listener of this.completionListeners) listener(mission.projectId, id, mission.completedAt ?? now);
		this.changed(id, this.members(id));
		return this.require(id);
	}

	/** Explicit lifecycle. No task reconciliation, role transitions or wake; closed coordinators archive when idle. */
	lifecycle(
		id: string,
		projectId: string,
		expected: MissionStatus,
		action: "archive" | "reopen" | "complete",
	): Mission {
		if (this.batchedChanges) throw new Conflict("Lifecycle changes cannot be batched");
		const status = action === "complete" ? "done" : action === "archive" ? "archived" : "active";
		const now = Date.now();
		this.transaction(() => {
			const mission = this.require(id);
			if (mission.projectId !== projectId || mission.status !== expected)
				throw new Conflict("The confirmed mission has changed; review it again");
			if (
				!["archive", "reopen", "complete"].includes(action) ||
				(action === "complete"
					? expected !== "active"
					: action === "archive"
						? expected === "archived"
						: expected === "active")
			)
				throw new Conflict("That lifecycle transition is unavailable");
			// BEGIN IMMEDIATE holds task eligibility through the status write, including external writers.
			if (action === "complete") {
				const counts = this.one(
					"SELECT SUM(status='done') AS done, SUM(status NOT IN ('done','dropped')) AS unfinished FROM tasks WHERE mission_id=?",
					id,
				)!;
				if (!counts.done || counts.unfinished)
					throw new Conflict(
						"Mission completion requires every remaining task to be done and at least one done task",
					);
			}
			this.run(
				"UPDATE missions SET status=?,passive_lifecycle=1,updated_at=?,completed_at=?,archived_at=? WHERE id=?",
				status,
				now,
				status === "done" ? now : null,
				status === "archived" ? now : null,
				id,
			);
			this.event(id, "status", `Mission marked ${status}`, USER, { at: now });
		}, true);
		this.changed(id, [], true);
		return this.require(id);
	}

	/** Durable guard: passive lifecycle never re-enables automatic coordinator notices. */
	passiveLifecycle(id: string): boolean {
		return this.one("SELECT passive_lifecycle FROM missions WHERE id=?", id)?.passive_lifecycle === 1;
	}

	/** Detaches member chats; they keep their history. */
	remove(id: string): void {
		this.require(id);
		const members = this.members(id);
		this.transaction(() => this.run("DELETE FROM missions WHERE id = ?", id));
		this.changed(id, members);
	}

	/** Identity comes from worker IPC or the trusted local API path, never request payload fields. */
	private assertPlanner(id: string, actor: MissionActor): void {
		const mission = this.require(id);
		if (mission.planningVersion === undefined) return;
		if (mission.planningVersion !== 1) throw new Conflict("Unsupported mission planning version");
		if (!actor.sessionId) return; // Trusted daemon/user path.
		this.assertMember(id, actor.sessionId);
		if (mission.coordinatorSessionId !== actor.sessionId)
			throw new Conflict(
				"Coordinator-owned planning: propose changes with comment; report execution with status/log",
			);
	}

	private assertTaskWriter(id: string, ref: string, write: MissionTaskWrite, actor: MissionActor): void {
		const mission = this.require(id);
		if (mission.planningVersion === undefined) return;
		strictPlanningFields(write, TASK_WRITE_FIELDS);
		if (mission.planningVersion !== 1) throw new Conflict("Unsupported mission planning version");
		if (!actor.sessionId || mission.coordinatorSessionId === actor.sessionId) {
			this.assertPlanner(id, actor);
			return;
		}
		this.assertMember(id, actor.sessionId);
		const task = this.resolveTask(id, ref);
		if (
			task.sessionId !== actor.sessionId ||
			task.status === "done" ||
			task.status === "dropped" ||
			Object.keys(write).some((key) => key !== "status") ||
			(write.status !== undefined && !["in_progress", "blocked", "in_review"].includes(write.status))
		)
			throw new Conflict(
				"Coordinator-owned task definition; workers may only report their own execution status or propose changes with comment",
			);
	}

	private validateAssignment(id: string, write: MissionTaskWrite, current?: MissionTask["assignment"]) {
		const version = this.require(id).planningVersion;
		if (version !== undefined) strictPlanningFields(write, TASK_WRITE_FIELDS);
		if (write.assignment === undefined) return;
		if (version !== 1) throw new Conflict("assignment requires planningVersion 1");
		return assignmentWrite(write.assignment, current);
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
		this.assertPlanner(id, actor);
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

	/** Small indexed batches. Network callers must revalidate version after every await. */
	linearSyncBatch(
		after = "",
		limit = 25,
	): Array<{ missionId: string; projectId: string; resource: MissionResource; record: LinearSyncRecord }> {
		return this.all(
			`SELECT r.*, m.project_id FROM resources r JOIN missions m ON m.id=r.mission_id
			WHERE r.linear_role='managed' AND r.id > ? AND m.status <> 'archived' ORDER BY r.id LIMIT ?`,
			after,
			Math.min(25, limit),
		).map((row) => ({
			missionId: str(row.mission_id!),
			projectId: str(row.project_id!),
			resource: resourceFrom(row),
			record: JSON.parse(str(row.linear_sync!)) as LinearSyncRecord,
		}));
	}

	linearSyncRecord(resourceId: string): LinearSyncRecord | undefined {
		const row = this.one("SELECT linear_sync FROM resources WHERE id=? AND linear_role='managed'", resourceId);
		return row?.linear_sync ? (JSON.parse(str(row.linear_sync)) as LinearSyncRecord) : undefined;
	}

	/** Read-only diagnostic projection. Never materialize contributors, task history or unrelated resources. */
	linearSyncDiagnostics(missionId: string, offset = 0, limit = 8) {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
			throw new Error("Invalid Linear diagnostic page");
		const rows = this.all(
			`SELECT id, external_id, json_extract(linear_sync, '$.status') AS status,
			json_extract(linear_sync, '$.intent.target') AS requested_target,
			json_extract(linear_sync, '$.attempts') AS attempts,
			json_extract(linear_sync, '$.paused') AS paused,
			json_extract(linear_sync, '$.lastObservationAt') AS observed_at,
			json_extract(linear_sync, '$.lastFailureAt') AS failed_at
			FROM resources WHERE mission_id=? AND linear_role='managed' ORDER BY created_at,id LIMIT ? OFFSET ?`,
			missionId,
			limit + 1,
			offset,
		);
		const tickets = rows.slice(0, limit).map((row) => ({
			resourceId: str(row.id!),
			externalId: str(row.external_id!),
			status: JSON.parse(str(row.status!)) as MissionLinearSync,
			requestedTarget: row.requested_target === null ? null : str(row.requested_target!),
			attempts: num(row.attempts ?? 0),
			paused: row.paused === null ? null : str(row.paused!),
			// Unknown legacy times stay unknown. status.updatedAt is a record update, not proof of a read.
			lastObservationAt: row.observed_at === null ? null : num(row.observed_at!),
			lastFailureAt: row.failed_at === null ? null : num(row.failed_at!),
		}));
		return { tickets, more: rows.length > limit };
	}

	/** CAS fences task/status edits, detach/re-attach, user pause and concurrent sync work. */
	saveLinearSync(resourceId: string, version: string, record: LinearSyncRecord): boolean {
		const row = this.one(
			"SELECT mission_id FROM resources WHERE id=? AND linear_role='managed' AND json_extract(linear_sync,'$.version')=?",
			resourceId,
			version,
		);
		if (!row) return false;
		// A UUID resolved through another workspace alias must never acquire a second writer.
		if (
			record.status.issueId &&
			this.one(
				`SELECT id FROM resources WHERE linear_role='managed' AND id<>?
			AND json_extract(linear_sync,'$.status.issueId')=?`,
				resourceId,
				record.status.issueId,
			)
		)
			throw new Conflict("This Linear issue already has a verified managing link. Remove the duplicate manager.");
		this.transaction(() =>
			this.run("UPDATE resources SET linear_sync=? WHERE id=?", JSON.stringify(record), resourceId),
		);
		this.changed(str(row.mission_id!));
		return true;
	}

	setLinearSyncPaused(id: string, resourceId: string, action: "pause" | "resume"): MissionResource {
		this.require(id);
		if (action !== "pause" && action !== "resume") throw new Error("action must be pause or resume");
		const row = this.one(
			"SELECT * FROM resources WHERE mission_id=? AND id=? AND linear_role='managed'",
			id,
			resourceId,
		);
		if (!row) throw new NotFound("Unknown managed Linear ticket");
		const record = this.linearSyncRecord(resourceId)!;
		const version = record.version;
		record.version = randomUUID();
		record.attempts = 0;
		delete record.intent;
		delete record.status.error;
		delete record.status.failure;
		delete record.status.retryAt;
		delete record.status.target;
		record.status.updatedAt = Date.now();
		if (action === "pause") {
			record.status.state = "paused";
			record.status.reason = "Synchronization paused by you. Review the ticket, then resume when ready.";
			record.paused = record.status.reason;
			delete record.acceptBaseline;
		} else {
			delete record.paused;
			record.acceptBaseline = true;
			delete record.status.reason;
			const target = linearTarget(record.contributors);
			record.status.state = target ? "pending" : "idle";
			if (target) {
				record.intent = { target };
				record.status.target = target;
			}
		}
		this.saveLinearSync(resourceId, version, record);
		for (const listener of this.linearSyncListeners) listener();
		this.log(id, { text: `Linear synchronization ${action === "pause" ? "paused" : "resumed"}: ${row.external_id}` });
		return resourceFrom(this.one("SELECT * FROM resources WHERE id=?", resourceId)!);
	}

	/** Other managers which could still need any of this ticket's unfinished tasks. Bounded by caller. */
	linearCancellationPeers(resourceId: string): string[] {
		return this.all(
			`SELECT DISTINCT p.id FROM resources m JOIN resources c
			ON c.mission_id=m.mission_id AND c.linear_key=m.linear_key AND c.linear_role='contribution'
			JOIN tasks t ON t.id=c.task_id AND t.status NOT IN ('done','dropped')
			JOIN resources other ON other.task_id=t.id AND other.linear_role='contribution'
			JOIN resources p ON p.mission_id=other.mission_id AND p.linear_key=other.linear_key AND p.linear_role='managed'
			WHERE m.id=? AND p.id<>m.id ORDER BY p.id LIMIT 26`,
			resourceId,
		).map((r) => str(r.id!));
	}

	linearSyncResource(
		resourceId: string,
	): { resource: MissionResource; missionId: string; projectId: string; record: LinearSyncRecord } | undefined {
		const row = this.one(
			`SELECT r.*,m.project_id FROM resources r JOIN missions m ON m.id=r.mission_id
			WHERE r.id=? AND r.linear_role='managed' AND m.status<>'archived'`,
			resourceId,
		);
		return row
			? {
					resource: resourceFrom(row),
					missionId: str(row.mission_id!),
					projectId: str(row.project_id!),
					record: JSON.parse(str(row.linear_sync!)) as LinearSyncRecord,
				}
			: undefined;
	}

	/** Called only with fresh remote terminal observations for every peer. Unknown peers protect work. */
	dropCanceledLinearTasks(
		resourceId: string,
		version: string,
		peers: Map<string, { version: string; inactive: boolean }>,
	): boolean {
		const managed = this.linearSyncResource(resourceId);
		if (managed && this.require(managed.missionId).planningVersion !== undefined) return false;
		if (
			!managed ||
			managed.record.version !== version ||
			managed.record.status.state !== "terminal" ||
			!["canceled", "duplicated"].includes(managed.record.status.reason ?? "")
		)
			return false;
		const currentPeers = this.linearCancellationPeers(resourceId);
		if (currentPeers.some((id) => !peers.has(id) || this.linearSyncRecord(id)?.version !== peers.get(id)!.version))
			return false;
		const protectedTasks = new Set<string>();
		for (const id of currentPeers)
			if (!peers.get(id)!.inactive)
				for (const task of this.linearSyncRecord(id)!.contributors) protectedTasks.add(task.taskId);
		let changed = false;
		this.transaction(() => {
			for (const task of managed.record.contributors) {
				if (task.status === "done" || task.status === "dropped" || protectedTasks.has(task.taskId)) continue;
				this.run(
					"UPDATE tasks SET status='dropped',updated_at=?,delegated_to=NULL,delegated_from_status=NULL,delegated_resource_id=NULL WHERE id=? AND status NOT IN ('done','dropped')",
					Date.now(),
					task.taskId,
				);
				this.event(
					managed.missionId,
					"task",
					`Task dropped because its Linear ticket was ${managed.record.status.reason}`,
					USER,
					{ taskId: task.taskId },
				);
				changed = true;
			}
		});
		if (changed) this.changed(managed.missionId);
		return true;
	}

	private reconcileLinearSync(): void {
		for (const dirty of this.all("SELECT * FROM linear_sync_dirty")) {
			const row = this.one("SELECT * FROM resources WHERE id=?", dirty.resource_id!);
			if (!row) continue;
			if (row.linear_role !== "managed") {
				if (row.linear_sync) this.run("UPDATE resources SET linear_sync=NULL WHERE id=?", row.id!);
				continue;
			}
			const contributors = this.all(
				`SELECT c.id AS linkId,c.task_id AS taskId,t.status FROM resources c
				JOIN tasks t ON t.id=c.task_id WHERE c.mission_id=? AND c.linear_key=? AND c.linear_role='contribution' ORDER BY c.id LIMIT 1001`,
				row.mission_id!,
				row.linear_key!,
			) as unknown as LinearContributor[];
			const previous = row.linear_sync ? (JSON.parse(str(row.linear_sync)) as LinearSyncRecord) : undefined;
			const next = reconcileLinearRecord(previous, contributors, dirty.structural === 1, dirty.reopened === 1);
			if (previous !== next) {
				this.run("UPDATE resources SET linear_sync=? WHERE id=?", JSON.stringify(next), row.id!);
				this.linearSyncChanged.add(str(row.mission_id!));
			}
		}
		this.run("DELETE FROM linear_sync_dirty");
	}

	/** Lightweight, bounded linked-issue reads, including automatic delegations awaiting return. */
	linearTaskLinks(
		projectId?: string,
		after = "",
		limit = 25,
	): { resourceId: string; issueId: string; projectId: string }[] {
		return this.all(
			`
			SELECT r.id, r.external_id, m.project_id FROM missions m
			JOIN resources r ON r.mission_id = m.id AND r.kind = 'linear.issue' AND r.linear_role = 'contribution'
			JOIN tasks t ON t.id = r.task_id
			WHERE (? IS NULL OR m.project_id = ?) AND m.status = 'active' AND r.id > ?
			AND (t.status IN ('todo', 'in_progress', 'blocked', 'in_review')
				OR (t.status = 'delegated' AND t.delegated_from_status IS NOT NULL))
			ORDER BY r.id LIMIT ?`,
			projectId ?? null,
			projectId ?? null,
			after,
			Math.min(25, Math.max(1, limit)),
		).map((row) => ({ resourceId: str(row.id!), issueId: str(row.external_id!), projectId: str(row.project_id!) }));
	}

	/** Only an assignee transition can override a manual status. All state and its notice commit together. */
	observeLinearAssignee(
		projectId: string,
		resourceId: string,
		assignee: { id: string; name: string } | null,
		me: string,
	): void {
		let changed: { missionId: string; sessionId?: string } | undefined;
		this.transaction(() => {
			const row = this.one(
				`SELECT t.*, r.mission_id FROM resources r
				JOIN missions m ON m.id = r.mission_id JOIN tasks t ON t.id = r.task_id
				WHERE r.id = ? AND r.kind = 'linear.issue' AND r.linear_role = 'contribution'
				AND m.project_id = ? AND m.status = 'active'`,
				resourceId,
				projectId,
			);
			if (!row || !["todo", "in_progress", "blocked", "in_review", "delegated"].includes(str(row.status!))) return;
			const prior = this.one("SELECT assignee_id FROM linear_task_assignees WHERE resource_id = ?", resourceId);
			if (prior && prior.assignee_id === (assignee?.id ?? null)) return;
			this.run(
				`INSERT INTO linear_task_assignees (resource_id, assignee_id) VALUES (?, ?)
				ON CONFLICT(resource_id) DO UPDATE SET assignee_id = excluded.assignee_id`,
				resourceId,
				assignee?.id ?? null,
			);
			// Unassignment is not a return to the user.
			if (!assignee) return;
			const before = taskFrom(row);
			const mine = assignee.id === me;
			if (before.status === "delegated" && !row.delegated_from_status) return;
			if (mine && (before.status !== "delegated" || row.delegated_resource_id !== resourceId)) return;
			const status = mine ? str(row.delegated_from_status!) : "delegated";
			const now = Date.now();
			this.run(
				`UPDATE tasks SET status = ?, delegated_to = ?, delegated_from_status = ?,
				delegated_resource_id = ?, updated_at = ?, completed_at = NULL WHERE id = ?`,
				status,
				mine ? null : assignee.name,
				mine ? null : (row.delegated_from_status ?? before.status),
				mine ? null : resourceId,
				now,
				before.id,
			);
			const missionId = str(row.mission_id!);
			this.event(
				missionId,
				"task",
				mine
					? `Returned to you in Linear (restored ${statusLabel(status as MissionTaskStatus)}): #${before.number} ${before.title}`
					: `Delegated to ${assignee.name} in Linear: #${before.number} ${before.title}`,
				{},
				{ taskId: before.id, at: now, wake: true },
			);
			changed = { missionId, sessionId: before.sessionId };
		});
		if (changed) this.changed(changed.missionId, changed.sessionId ? [changed.sessionId] : []);
	}

	// Phases
	phases(id: string): MissionPhase[] {
		return this.all("SELECT * FROM phases WHERE mission_id = ? ORDER BY sort, id", id).map(phaseFrom);
	}

	resolvePhase(id: string, ref: unknown): MissionPhase {
		if (typeof ref !== "string") throw new Error("phase must be a name or ID");
		const phases = this.phases(id);
		const phase = phases.find((item) => item.id === ref) ?? phases.find((item) => item.name === ref.trim());
		if (!phase) throw new NotFound(`Unknown phase: ${ref}`);
		return phase;
	}

	addPhase(id: string, write: MissionPhaseWrite, actor: MissionActor = USER): MissionPhase {
		this.assertPlanner(id, actor);
		this.require(id);
		const phaseId = randomUUID();
		this.transaction(() => {
			this.insertPhase(id, phaseId, write, actor);
		});
		this.changed(id);
		return this.resolvePhase(id, phaseId);
	}

	private insertPhase(id: string, phaseId: string, write: MissionPhaseWrite, actor: MissionActor): void {
		const name = text(write.name, "phase name", MAX_TITLE)!;
		const goal = write.goal === undefined ? null : text(write.goal, "phase goal", MAX_GOAL, { empty: true })!;
		if (write.order !== undefined && (typeof write.order !== "number" || !Number.isFinite(write.order)))
			throw new Error("order must be a number");
		if (this.phases(id).some((phase) => phase.name === name)) throw new Conflict(`Phase already exists: ${name}`);
		this.run(
			"INSERT INTO phases (id, mission_id, name, goal, sort) VALUES (?, ?, ?, ?, ?)",
			phaseId,
			id,
			name,
			goal,
			write.order ??
				num(this.one("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM phases WHERE mission_id = ?", id)!.n!),
		);
		this.phaseReconciliations.add(id);
		this.event(id, "update", `Phase added: ${name}`, actor);
	}

	updatePhase(id: string, ref: string, write: MissionPhaseWrite, actor: MissionActor = USER): MissionPhase {
		this.assertPlanner(id, actor);
		const before = this.resolvePhase(id, ref);
		const name = write.name === undefined ? before.name : text(write.name, "phase name", MAX_TITLE)!;
		const goal = write.goal === undefined ? before.goal : text(write.goal, "phase goal", MAX_GOAL, { empty: true });
		if (write.order !== undefined && (typeof write.order !== "number" || !Number.isFinite(write.order)))
			throw new Error("order must be a number");
		if (this.phases(id).some((phase) => phase.id !== before.id && phase.name === name))
			throw new Conflict(`Phase already exists: ${name}`);
		this.transaction(() => {
			this.run(
				"UPDATE phases SET name = ?, goal = ?, sort = ? WHERE id = ?",
				name,
				goal ?? null,
				write.order ?? before.order,
				before.id,
			);
			// Compatibility alias only. phase_id is authoritative.
			this.run("UPDATE tasks SET milestone = ? WHERE phase_id = ?", name, before.id);
			this.event(id, "update", `Phase updated: ${name}`, actor);
		});
		this.changed(id);
		return this.resolvePhase(id, before.id);
	}

	removePhase(id: string, ref: string, actor: MissionActor = USER): void {
		this.assertPlanner(id, actor);
		const phase = this.resolvePhase(id, ref);
		this.transaction(() => {
			this.run(
				"UPDATE tasks SET phase_id = NULL, milestone = NULL, updated_at = ? WHERE phase_id = ?",
				Date.now(),
				phase.id,
			);
			this.run("DELETE FROM phases WHERE id = ?", phase.id);
			this.event(id, "update", `Phase deleted: ${phase.name}`, actor);
		});
		this.changed(id);
	}

	/** Empty phases are complete too, so an empty stage never deadlocks later work. */
	private reconcilePhases(id: string): void {
		const rows = this.all(
			`SELECT p.*, NOT EXISTS (SELECT 1 FROM tasks t
				WHERE t.phase_id = p.id AND t.status NOT IN ('done', 'dropped')) AS complete
			FROM phases p WHERE p.mission_id = ? ORDER BY p.sort, p.id`,
			id,
		);
		for (const row of rows) {
			const complete = num(row.complete!) === 1;
			if (complete === (row.completed_at !== null)) continue;
			this.run("UPDATE phases SET completed_at = ? WHERE id = ?", complete ? Date.now() : null, row.id!);
			this.event(id, "update", `Phase ${complete ? "completed" : "reopened"}: ${str(row.name!)}`, USER, {
				wake: true,
			});
		}
	}

	private phaseView(id: string, tasks: MissionTask[]): MissionTask[] {
		if (this.one("SELECT phase_gating FROM missions WHERE id = ?", id)?.phase_gating !== 1) return tasks;
		const phases = this.phases(id);
		const blockers = new Map<string, string[]>();
		const earlier: string[] = [];
		for (const phase of phases) {
			blockers.set(phase.id, [...earlier]);
			if (phase.completedAt === undefined) earlier.push(phase.id);
		}
		return tasks.map((task) => {
			if (!task.phaseId || ["done", "dropped", "delegated"].includes(task.status)) return task;
			const blockedByPhases = blockers.get(task.phaseId) ?? [];
			return blockedByPhases.length
				? { ...task, status: "blocked", storedStatus: task.status, blockedByPhases }
				: task;
		});
	}

	private rawTask(task: MissionTask): MissionTask {
		return task.storedStatus ? { ...task, status: task.storedStatus } : task;
	}

	private assertPhaseAdmission(task: MissionTask, override = false): void {
		if (task.blockedByPhases?.length && !override)
			throw new Conflict(`Task #${task.number} is blocked by earlier phases`);
	}

	tasks(id: string): MissionTask[] {
		return this.phaseView(
			id,
			this.all("SELECT * FROM tasks WHERE mission_id = ? ORDER BY sort, number", id).map(taskFrom),
		);
	}

	task(id: string, taskId: string): MissionTask {
		const row = this.one("SELECT * FROM tasks WHERE mission_id = ? AND id = ?", id, taskId);
		if (!row) throw new NotFound(`Unknown task: ${taskId}`);
		return this.phaseView(id, [taskFrom(row)])[0]!;
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
			return this.phaseView(id, [taskFrom(row)])[0]!;
		}
		if (typeof ref !== "string") throw new Error("task id is required");
		return this.task(id, ref);
	}

	addTask(id: string, write: MissionTaskWrite, actor: MissionActor = USER): MissionTask {
		this.assertPlanner(id, actor);
		this.require(id);
		const task = this.transaction(() => this.insertTask(id, write, actor));
		this.changed(id, task.sessionId ? [task.sessionId] : []);
		return task;
	}

	private insertTask(id: string, write: MissionTaskWrite, actor: MissionActor): MissionTask {
		const assignment = this.validateAssignment(id, write);
		// Task authoring uses Unicode code points, matching the agent schema and write boundary.
		const title = text(write.title, "title", MAX_TITLE, { codePoints: true })!;
		const fields = this.taskFields(id, write);
		const now = Date.now();
		const number = num(this.one("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE mission_id = ?", id)!.n!);
		const order =
			fields.order ??
			num(this.one("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM tasks WHERE mission_id = ?", id)!.n!);
		const status = fields.status ?? "todo";
		if (status === "done" && actor.sessionId) throw new Error("Create an unfinished task, then use complete");
		const taskId = randomUUID();
		const owner = write.sessionId ?? null;
		if (owner !== null) {
			this.assertMember(id, owner);
			this.assertFreshMember(owner);
		}
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
		if (assignment) this.run("UPDATE tasks SET assignment = ? WHERE id = ?", JSON.stringify(assignment), taskId);
		this.run("UPDATE tasks SET created_by_session_id = ? WHERE id = ?", actor.sessionId ?? null, taskId);
		if (owner) this.rememberTaskClaim(owner, taskId, false);
		this.event(id, "task", `Task #${number} added: ${title}`, actor, {
			taskId,
			at: now,
			wake: status === "blocked",
			urgent: status === "blocked",
			noticeText: `#${number} ${title} blocked${fields.body ? `: ${fields.body}` : ""}`,
		});
		if (fields.decisionIds !== undefined)
			this.run("UPDATE tasks SET decision_ids = ? WHERE id = ?", JSON.stringify(fields.decisionIds), taskId);
		if (fields.preference) this.writePreference(id, this.task(id, taskId), fields.preference, actor, now);
		const phase = this.taskPhase(id, fields, actor);
		this.run(
			"UPDATE tasks SET phase_id = ?, milestone = ? WHERE id = ?",
			phase?.id ?? null,
			phase?.name ?? null,
			taskId,
		);
		if (owner)
			this.assertPhaseAdmission(this.task(id, taskId), !actor.sessionId && write.overridePhaseGating === true);
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
		if (write.phaseId !== undefined && write.milestone !== undefined)
			throw new Error("Use phaseId or milestone, not both");
		const phaseId =
			write.phaseId === undefined || write.phaseId === null
				? write.phaseId
				: this.resolvePhase(id, write.phaseId).id;
		if (write.overridePhaseGating !== undefined && typeof write.overridePhaseGating !== "boolean")
			throw new Error("overridePhaseGating must be a boolean");
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
		return {
			body,
			status: write.status,
			order: write.order,
			milestone,
			phaseId,
			dependsOn,
			decisionIds,
			preference: preference(write),
		};
	}

	/**
	 * Saves a preference already validated against the model scope by the caller. Setting the model replaces the
	 * thinking level; a thinking-only write keeps the model. Chats never change a user-set preference.
	 */
	private writePreference(
		id: string,
		task: MissionTask,
		write: { model?: string | null; thinking?: string | null },
		actor: MissionActor,
		now: number,
		passive = false,
	): void {
		if (actor.sessionId && task.preferredModelSetBy === "user")
			throw new Conflict(
				`Task #${task.number} has a user-set preferred model (${task.preferredModel}); only the user can change it`,
			);
		const model = write.model === undefined ? (task.preferredModel ?? null) : write.model;
		const thinking = write.thinking ?? null;
		if (!model && thinking) throw new Error("preferredThinking requires a preferred model");
		if (model === (task.preferredModel ?? null) && thinking === (task.preferredThinking ?? null)) return;
		this.run(
			"UPDATE tasks SET preferred_model = ?, preferred_thinking = ?, preferred_model_by = ?, updated_at = ? WHERE id = ?",
			model,
			model ? thinking : null,
			model ? (actor.sessionId ? "coordinator" : "user") : null,
			now,
			task.id,
		);
		this.event(
			id,
			passive ? "update" : "task",
			model
				? `Task #${task.number} preferred model ${model}${thinking ? `, thinking ${thinking}` : ""}: ${task.title}`
				: `Task #${task.number} preferred model cleared: ${task.title}`,
			actor,
			{ taskId: task.id, at: now },
		);
	}

	private taskPhase(
		id: string,
		fields: { phaseId?: string | null; milestone?: string },
		actor: MissionActor,
	): MissionPhase | null | undefined {
		if (fields.phaseId !== undefined) return fields.phaseId === null ? null : this.resolvePhase(id, fields.phaseId);
		if (fields.milestone === undefined) return undefined;
		if (!fields.milestone) return null;
		const existing = this.phases(id).find((phase) => phase.name === fields.milestone);
		if (existing) return existing;
		const phaseId = randomUUID();
		this.insertPhase(id, phaseId, { name: fields.milestone }, actor);
		return this.resolvePhase(id, phaseId);
	}

	/** Dedicated user preference only: no member callbacks, reconciliation or automation. */
	taskModel(id: string, projectId: string, taskId: string, write: MissionTaskWrite): MissionTask {
		this.assertPlanner(id, USER);
		if (this.writing || this.batchedChanges || this.referenceBatch)
			throw new Conflict("Preference changes cannot be batched");
		if (this.require(id).projectId !== projectId) throw new Conflict("The confirmed project changed");
		if (!taskId || /^\d+$/.test(taskId)) throw new Error("An exact task ID is required");
		if (Object.keys(write).some((key) => key !== "preferredModel" && key !== "preferredThinking"))
			throw new Error("Preference fields only");
		const task = this.rawTask(this.task(id, taskId));
		const fields = preference(write);
		if (!fields || fields.model === undefined || fields.thinking === undefined)
			throw new Error("Both preference fields are required");
		this.transaction(() => this.writePreference(id, task, fields, USER, Date.now(), true), true);
		this.changed(id, [], true, true);
		return this.task(id, taskId);
	}

	/** One immutable, task-owned handoff. Retries return it, never add another event. */
	completeTask(id: string, ref: unknown, sessionId: string, value: unknown) {
		if (this.require(id).planningVersion !== undefined)
			throw new Conflict("Report evidence with log; coordinator/user marks done separately");
		this.assertMember(id, sessionId);
		const task = this.resolveTask(id, ref);
		if (task.sessionId !== sessionId) throw new Conflict("Only the task owner can complete it");
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("completion is required");
		const input = value as Record<string, unknown>;
		if (Object.keys(input).sort().join(",") !== "checks,commit,issues")
			throw new Error("completion requires commit, checks and issues only");
		const record = {
			commit: text(input.commit, "commit", 40)!,
			checks: text(input.checks, "checks", 2000)!,
			issues: text(input.issues, "issues", 1000, { empty: true })!,
		};
		if (!/^[a-f0-9]{40}$/.test(record.commit)) throw new Error("commit must be a 40-character lowercase hex hash");
		const encoded = JSON.stringify(record);
		const previous = this.completion(id, task.id);
		if (previous) {
			if (JSON.stringify(previous) !== encoded) throw new Conflict("Task already has a completion record");
			return previous;
		}
		this.batchChanges(() => {
			this.run("INSERT INTO task_completions VALUES (?, ?)", task.id, encoded);
			this.updateTask(id, task.id, { status: "done" }, { sessionId });
			if (task.status === "done")
				this.event(
					id,
					"task",
					`Task #${task.number} completion recorded`,
					{ sessionId },
					{
						taskId: task.id,
						wake: true,
						urgent: true,
						noticeSummaries: [
							{
								key: `task:${task.id}`,
								text: `Task #${task.number} done. Read the task for details.`,
								state: "done",
							},
						],
					},
				);
			if (this.require(id).coordinatorSessionId !== sessionId)
				this.run("INSERT OR IGNORE INTO retired_members VALUES (?, ?, ?)", sessionId, id, Date.now());
			this.changed(id, [sessionId]);
		});
		return record;
	}

	completion(id: string, taskId: string): MissionCodeCompletion | undefined {
		this.task(id, taskId);
		const row = this.one("SELECT record FROM task_completions WHERE task_id = ?", taskId);
		return row ? JSON.parse(str(row.record!)) : undefined;
	}

	/** Unaccepted submission only. Never changes task status or member lifecycle. */
	nonCodeDelivery(id: string, taskId: string): MissionNonCodeDelivery | undefined {
		this.task(id, taskId);
		const row = this.one("SELECT record FROM task_non_code_deliveries WHERE task_id = ?", taskId);
		return row ? JSON.parse(str(row.record!)) : undefined;
	}

	/** Called after the service resolves artifact revisions. Rechecks persisted scope synchronously. */
	saveNonCodeDelivery(
		id: string,
		ref: string,
		sessionId: string,
		value: unknown,
		resolvedArtifacts: ReadonlyMap<string, string> = new Map(),
	) {
		this.assertMember(id, sessionId);
		const task = this.resolveTask(id, ref);
		if (task.sessionId !== sessionId && this.require(id).coordinatorSessionId !== sessionId)
			throw new Conflict("Only the task owner or coordinator may submit delivery");
		const record = parseNonCodeDelivery(value);
		const encoded = JSON.stringify(record);
		const previous = this.nonCodeDelivery(id, task.id);
		if (previous) {
			if (JSON.stringify(previous) !== encoded) throw new Conflict("Task already has a non-code delivery");
			return previous;
		}
		for (const item of record.references) {
			if (item.kind === "brief") {
				if (this.require(id).briefRevision !== item.revision || !this.brief(id, item.revision))
					throw new Conflict("Brief reference is missing or stale");
			} else {
				const links = this.artifactReferences(id, item.artifactId);
				const owner = resolvedArtifacts.get(item.artifactId);
				if (
					!owner ||
					links.some((link) => link.sessionId !== owner) ||
					!links.some(
						(link) => link.sessionId === owner && link.taskId === task.id && link.revision === item.revision,
					)
				)
					throw new Conflict("Artifact reference must be pinned to this task and revision");
			}
		}
		this.transaction(() => this.run("INSERT INTO task_non_code_deliveries VALUES (?, ?)", task.id, encoded), true);
		return record;
	}

	/** Internal history only. No legacy receipt is promoted into verified evidence. */
	deliveryEvidence(id: string, taskId: string, before?: string, limit = 100): DeliveryRecord[] {
		this.task(id, taskId);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid delivery history limit");
		const cursor =
			before === undefined
				? undefined
				: this.one(
						"SELECT sequence FROM task_delivery_evidence WHERE task_id = ? AND record_id = ?",
						taskId,
						before,
					);
		if (before !== undefined && !cursor) throw new Error("Unknown delivery history cursor");
		return this.all(
			"SELECT record FROM task_delivery_evidence WHERE task_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?",
			taskId,
			cursor?.sequence ?? Number.MAX_SAFE_INTEGER,
			limit,
		)
			.reverse()
			.map((row) => JSON.parse(str(row.record!)) as DeliveryRecord);
	}

	/** Two latest records, independent of history page size or the number of review revisions. */
	currentDeliveryEvidence(id: string, taskId: string): DeliveryRecord[] {
		this.task(id, taskId);
		return this.all(
			`SELECT record FROM task_delivery_evidence WHERE sequence IN (
			(SELECT sequence FROM task_delivery_evidence WHERE task_id = ? AND record_type = 'submission' ORDER BY sequence DESC LIMIT 1),
			(SELECT sequence FROM task_delivery_evidence WHERE task_id = ? AND record_type = 'judgement' ORDER BY sequence DESC LIMIT 1)
		) ORDER BY sequence`,
			taskId,
			taskId,
		).map((row) => JSON.parse(str(row.record!)) as DeliveryRecord);
	}

	assertDeliveryEvidencePins(id: string, taskId: string, observations: DeliveryObservation[]): void {
		for (const observation of observations) {
			const item = observation.reference;
			if (
				item.kind === "brief" &&
				(this.require(id).briefRevision !== item.revision || !this.brief(id, item.revision))
			)
				throw new Conflict("Brief delivery evidence is stale");
			if (item.kind === "artifact") {
				const links = this.artifactReferences(id, item.artifactId);
				if (
					!observation.sourceOwnerSessionId ||
					links.some((link) => link.sessionId !== observation.sourceOwnerSessionId) ||
					!links.some((link) => link.taskId === taskId && link.revision === item.revision)
				)
					throw new Conflict("Artifact delivery evidence must be pinned to this task, custodian and revision");
			}
		}
	}

	private assertDeliveryMember(id: string, sessionId: string): void {
		this.assertMember(id, sessionId);
		if (this.require(id).planningVersion !== 1) throw new Conflict("Delivery evidence requires planningVersion 1");
	}

	/** Retry recovery precedes mutable assignment/source checks, but cannot change actor/task/action/payload. */
	private deliveryRetry(
		id: string,
		taskId: string,
		sessionId: string,
		type: DeliveryRecord["type"],
		request: DeliveryRecord["request"],
	): DeliveryRecord | undefined {
		this.assertDeliveryMember(id, sessionId);
		const row = this.one(
			"SELECT record FROM task_delivery_evidence WHERE mission_id = ? AND operation_id = ?",
			id,
			request.operationId,
		);
		if (!row) return;
		const previous = JSON.parse(str(row.record!)) as DeliveryRecord;
		if (
			previous.taskId !== taskId ||
			previous.actorSessionId !== sessionId ||
			previous.type !== type ||
			deliveryDigest(previous.request) !== deliveryDigest(request)
		)
			throw new Conflict("Delivery operation idempotency conflict");
		return previous;
	}

	private insertDelivery(record: DeliveryRecord): void {
		this.run(
			"INSERT INTO task_delivery_evidence (mission_id, task_id, operation_id, record_id, record_type, record) VALUES (?, ?, ?, ?, ?, ?)",
			record.missionId,
			record.taskId,
			record.request.operationId,
			record.id,
			record.type,
			JSON.stringify(record),
		);
	}

	/** Dormant host-only API. Resolver is host code, never request-supplied observations or passing booleans. */
	async submitDeliveryEvidence(id: string, ref: string, sessionId: string, value: unknown, resolve: DeliveryResolver) {
		const request = deliverySubmissionWrite(value);
		const taskId = this.resolveTask(id, ref).id;
		const retry = this.deliveryRetry(id, taskId, sessionId, "submission", request);
		if (retry) {
			await this.durable();
			return retry as DeliverySubmission;
		}
		const admit = () => {
			this.assertDeliveryMember(id, sessionId);
			const task = this.task(id, taskId);
			if (!task.sessionId || (task.sessionId !== sessionId && this.require(id).coordinatorSessionId !== sessionId))
				throw new Conflict("Only the task owner or coordinator may submit delivery");
			if (task.status === "done" || task.status === "dropped") throw new Conflict("Delivery task is closed");
			assertDeliveryAssignment(task, request.assignment);
			if (this.sharedDefinitionRevision(taskId) !== request.definitionRevision)
				throw new Conflict("Delivery task definition revision is stale");
			if ((latestSubmission(this.currentDeliveryEvidence(id, taskId))?.id ?? null) !== request.expectedSubmissionId)
				throw new Conflict("Delivery submission revision conflict");
			return task.sessionId;
		};
		const ownerSessionId = admit();
		const observations: DeliveryObservation[] = [];
		// Sequential, bounded resolution avoids unbounded artifact/source fanout.
		for (const reference of request.evidence) {
			const observation = await resolve(reference);
			if (
				deliveryDigest(reference) !== deliveryDigest(observation.reference) ||
				!/^[a-f0-9]{64}$/.test(observation.sha256) ||
				!["retained", "partial", "unavailable"].includes(observation.availability)
			)
				throw new Conflict("Resolved delivery evidence identity mismatch");
			observations.push(observation);
		}
		const saved = this.transaction(() => {
			const concurrentRetry = this.deliveryRetry(id, taskId, sessionId, "submission", request);
			if (concurrentRetry) return concurrentRetry as DeliverySubmission;
			if (admit() !== ownerSessionId) throw new Conflict("Delivery owner changed while resolving evidence");
			// Recheck persisted pins/current brief after asynchronous host reads.
			this.assertDeliveryEvidencePins(id, taskId, observations);
			const record: DeliverySubmission = {
				version: 1,
				type: "submission",
				id: randomUUID(),
				missionId: id,
				taskId,
				actorSessionId: sessionId,
				ownerSessionId,
				createdAt: Date.now(),
				request,
				observations,
			};
			this.insertDelivery(record);
			return record;
		}, true);
		await this.durable();
		return saved;
	}

	/** Coordinator judgement only. Approval does not imply required checks, authority or integration. */
	async judgeDeliveryEvidence(id: string, ref: string, sessionId: string, value: unknown) {
		const request = deliveryJudgementWrite(value);
		const taskId = this.resolveTask(id, ref).id;
		const saved = this.transaction(() => {
			const retry = this.deliveryRetry(id, taskId, sessionId, "judgement", request);
			if (retry) return retry;
			if (this.require(id).coordinatorSessionId !== sessionId)
				throw new Conflict("Only the coordinator may record delivery judgement");
			const task = this.task(id, taskId),
				records = this.currentDeliveryEvidence(id, taskId);
			const submission = latestSubmission(records);
			if (!submission || submission.id !== request.submissionId)
				throw new Conflict("Delivery judgement targets a stale submission");
			assertDeliveryAssignment(task, submission.request.assignment);
			if (this.sharedDefinitionRevision(taskId) !== submission.request.definitionRevision)
				throw new Conflict("Delivery task definition revision is stale");
			if (task.sessionId !== submission.ownerSessionId) throw new Conflict("Delivery owner is stale");
			if ((latestJudgement(records)?.id ?? null) !== request.expectedJudgementId)
				throw new Conflict("Delivery judgement revision conflict");
			const record: DeliveryRecord = {
				version: 1,
				type: "judgement",
				id: randomUUID(),
				missionId: id,
				taskId,
				actorSessionId: sessionId,
				createdAt: Date.now(),
				request,
			};
			this.insertDelivery(record);
			return record;
		}, true);
		await this.durable();
		return saved;
	}

	retiredMember(sessionId: string): boolean {
		return !!this.one("SELECT 1 FROM retired_members WHERE session_id = ?", sessionId);
	}

	private assertFreshMember(sessionId: string): void {
		if (this.retiredMember(sessionId))
			throw new Conflict(
				"This member has delivered and is retired. Start a new chat, or ask the user to override retirement.",
			);
	}

	updateTask(id: string, taskId: string, write: MissionTaskWrite, actor: MissionActor = USER): MissionTask {
		this.assertTaskWriter(id, taskId, write, actor);
		if (write.sessionId === null && Object.keys(write).length === 1 && !actor.sessionId)
			return this.releaseTask(id, taskId, actor);
		const projected = this.resolveTask(id, taskId);
		const before = this.rawTask(projected);
		const assignment = this.validateAssignment(id, write, before.assignment);
		const fields = this.taskFields(id, write, before.id);
		const title =
			write.title === undefined ? before.title : text(write.title, "title", MAX_TITLE, { codePoints: true })!;
		let owner = before.sessionId ?? null;
		if (write.sessionId !== undefined) {
			if (actor.sessionId && this.require(id).planningVersion === undefined)
				throw new Error("Chats claim tasks with the claim action; only the user assigns them");
			if (write.sessionId !== null) this.assertMember(id, write.sessionId);
			owner = write.sessionId;
			if (owner && owner !== before.sessionId && write.overrideRetirement !== true) this.assertFreshMember(owner);
		}
		const status = fields.status ?? before.status;
		if (
			status === "done" &&
			before.status !== "done" &&
			actor.sessionId &&
			this.require(id).planningVersion === undefined &&
			!this.completion(id, before.id)
		)
			throw new Error("Use complete with commit, checks and issues to finish a task");
		const now = Date.now();
		this.transaction(() => {
			if (assignment) {
				// Revalidate against canonical state inside the transaction, never after model I/O alone.
				const next = this.validateAssignment(id, write, this.task(id, before.id).assignment)!;
				this.run("UPDATE tasks SET assignment = ? WHERE id = ?", JSON.stringify(next), before.id);
				this.event(id, "task", `Task #${before.number} assignment revision ${next.revision}`, actor, {
					taskId: before.id,
				});
			}
			if (owner && owner !== before.sessionId) this.rememberTaskClaim(owner, before.id, false);
			if (owner && owner !== before.sessionId && !actor.sessionId && write.overrideRetirement === true)
				this.run("DELETE FROM retired_members WHERE session_id = ?", owner);
			const phase = this.taskPhase(id, fields, actor);
			if (fields.status !== undefined && fields.status === before.status)
				this.run("UPDATE shared_task_definitions SET revision=revision+1 WHERE id=?", before.id);
			if (fields.decisionIds !== undefined)
				this.run("UPDATE tasks SET decision_ids = ? WHERE id = ?", JSON.stringify(fields.decisionIds), before.id);
			if (fields.preference) this.writePreference(id, { ...before, title }, fields.preference, actor, now);
			// An explicit status, including the same one, opts out until the next assignment change.
			if (fields.status !== undefined)
				this.run(
					"UPDATE tasks SET delegated_to = NULL, delegated_from_status = NULL, delegated_resource_id = NULL WHERE id = ?",
					before.id,
				);
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
				(phase === undefined ? before.milestone : phase?.name) || null,
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
			if (phase !== undefined) {
				this.run("UPDATE tasks SET phase_id = ? WHERE id = ?", phase?.id ?? null, before.id);
				if ((phase?.id ?? undefined) !== before.phaseId)
					this.event(id, "task", `Task #${before.number} phase ${phase?.name ?? "cleared"}: ${title}`, actor, {
						taskId: before.id,
					});
			}
			if (owner && owner !== before.sessionId)
				this.assertPhaseAdmission(this.task(id, before.id), !actor.sessionId && write.overridePhaseGating === true);
			if (status !== before.status)
				this.event(id, "task", `Task #${before.number} ${statusLabel(status)}: ${title}`, actor, {
					taskId: before.id,
					at: now,
					wake: status === "blocked" || (status === "done" && !!this.completion(id, before.id)),
					urgent: status === "blocked" || status === "done",
					settled: false,
					noticeText: `Task #${before.number} ${status}. Read the task for details.`,
					...(status === "done"
						? {
								noticeSummaries: [
									{
										key: `task:${before.id}`,
										text: `Task #${before.number} done. Read the task for details.`,
										state: "done",
									},
								],
							}
						: {}),
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
		this.assertPlanner(id, actor);
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
			const phase = this.taskPhase(id, { milestone: group }, actor);
			const update = this.db.prepare("UPDATE tasks SET milestone = ?, phase_id = ?, updated_at = ? WHERE id = ?");
			for (const task of changed) update.run(group || null, phase?.id ?? null, now, task.id);
			this.event(id, "task", `${changed.length} task milestones ${group ? `set to ${group}` : "cleared"}`, actor, {
				at: now,
			});
		});
		this.changed(id, [...new Set(changed.flatMap((task) => (task.sessionId ? [task.sessionId] : [])))]);
		const updated = new Map(this.tasks(id).map((task) => [task.id, task]));
		return tasks.map((task) => updated.get(task.id)!);
	}

	removeTask(id: string, taskId: string, actor: MissionActor = USER): void {
		this.assertPlanner(id, actor);
		const task = this.resolveTask(id, taskId);
		if (this.one("SELECT 1 FROM resources WHERE task_id = ? AND linear_role = 'contribution'", task.id))
			throw new Conflict("Detach Linear contributions before removing this task");
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

	/** Validate the whole start batch, then stable dependency order (caller order breaks ties). */
	prepareTaskStart(
		id: string,
		refs: string[],
		starting?: ReadonlySet<string>,
		overridePhaseGating = false,
	): MissionTask[] {
		const tasks = [
			...new Map(
				refs.map((ref) => {
					const task = this.resolveTask(id, ref);
					return [task.id, task] as const;
				}),
			).values(),
		];
		if (!tasks.length) throw new Error("start requires at least one task");
		const selected = new Set(tasks.map((task) => task.id));
		const reasons: string[] = [];
		for (const task of tasks) {
			if (this.sharedAllocation(task.id))
				reasons.push(`Task #${task.number} has an occupied remote execution grant`);
			if (starting?.has(`${id}:${task.id}`))
				// Reservations remain authoritative even with a user gating override.
				reasons.push(`Task #${task.number} is already starting in another chat`);
			this.assertPhaseAdmission(task, overridePhaseGating);
			if (task.sessionId) reasons.push(`Task #${task.number} is already claimed by a chat`);
			if (task.status === "done" || task.status === "dropped" || task.status === "delegated")
				reasons.push(`Task #${task.number} is ${task.status}`);
			for (const depId of task.dependsOn ?? []) {
				if (selected.has(depId)) continue;
				const dep = this.resolveTask(id, depId);
				if (dep.status !== "done")
					reasons.push(
						`Task #${task.number} depends on task #${dep.number} outside the start list, which is not done`,
					);
			}
		}
		if (reasons.length) throw new Conflict(reasons.join("; "));
		const ordered: MissionTask[] = [];
		const remaining = new Set(selected);
		while (remaining.size) {
			const next = tasks.find(
				(task) => remaining.has(task.id) && !(task.dependsOn ?? []).some((dep) => remaining.has(dep)),
			);
			if (!next)
				throw new Conflict(
					`Dependency cycle among tasks ${tasks
						.filter((task) => remaining.has(task.id))
						.map((task) => `#${task.number}`)
						.join(", ")}`,
				);
			ordered.push(next);
			remaining.delete(next.id);
		}
		return ordered;
	}

	/** Spawn admission claims every selected task in one transaction, with no partial success. */
	claimStartTasks(id: string, refs: string[], sessionId: string, overridePhaseGating = false): MissionTask[] {
		this.assertMember(id, sessionId);
		const tasks = this.transaction(() =>
			this.prepareTaskStart(id, refs, undefined, overridePhaseGating).map((task) =>
				this.takeTask(id, task, sessionId, {}, overridePhaseGating),
			),
		);
		this.changed(id, [sessionId]);
		return tasks;
	}

	/** Atomic: a task owned by another chat is never taken over. */
	claimTask(id: string, taskId: unknown, sessionId: string, actor: MissionActor = { sessionId }): MissionTask {
		this.assertPlanner(id, actor);
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
		this.assertPlanner(id, actor);
		const mission = this.require(id);
		if (actor.sessionId) this.assertMember(id, actor.sessionId);
		const before = this.rawTask(this.resolveTask(id, taskId));
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
		this.assertPlanner(id, actor);
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
		this.assertPlanner(id, actor);
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
				if (task.blockedByPhases?.length) {
					skipped.push({ ref, reason: `Task #${task.number} is blocked by earlier phases`, task });
					continue;
				}
				const reason = this.additionalClaimRefusal(id, task, sessionId, actor);
				if (reason) {
					skipped.push({ ref, reason, task });
					continue;
				}
				claimed.push(this.takeTask(id, task, sessionId, actor));
			}
			return { claimed, skipped };
		});
		if (result.claimed.length) this.changed(id, [sessionId]);
		return result;
	}

	/** Only member-initiated, previously unseen tasks consume the lifetime allowance. */
	private additionalClaimRefusal(
		id: string,
		task: MissionTask,
		sessionId: string,
		actor: MissionActor,
	): string | undefined {
		if (task.sessionId === sessionId || !actor.sessionId || this.require(id).coordinatorSessionId === sessionId)
			return;
		if (this.one("SELECT 1 FROM member_task_claims WHERE session_id = ? AND task_id = ?", sessionId, task.id)) return;
		const count = num(
			this.one("SELECT COUNT(*) AS n FROM member_task_claims WHERE session_id = ? AND additional = 1", sessionId)!
				.n!,
		);
		if (count >= 2)
			return "This chat has already self-claimed two additional tasks. Ask the coordinator to start a fresh chat.";
	}

	private rememberTaskClaim(sessionId: string, taskId: string, additional: boolean): void {
		this.run(
			"INSERT OR IGNORE INTO member_task_claims (session_id, task_id, additional) VALUES (?, ?, ?)",
			sessionId,
			taskId,
			additional ? 1 : 0,
		);
	}

	private takeTask(
		id: string,
		task: MissionTask,
		sessionId: string,
		actor: MissionActor,
		overridePhaseGating = false,
	): MissionTask {
		if (task.sessionId === sessionId) return task;
		const creator = this.one("SELECT created_by_session_id FROM tasks WHERE id = ?", task.id)?.created_by_session_id;
		// Delivery still fences unrelated work, but not the member's own feedback follow-ups.
		if (actor.sessionId !== sessionId || creator !== sessionId) this.assertFreshMember(sessionId);
		const refusal = this.additionalClaimRefusal(id, task, sessionId, actor);
		if (refusal) throw new Conflict(refusal);
		this.assertPhaseAdmission(task, overridePhaseGating && !actor.sessionId);
		task = this.rawTask(task);
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
		this.rememberTaskClaim(
			sessionId,
			task.id,
			!!actor.sessionId && this.require(id).coordinatorSessionId !== sessionId,
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
		this.assertPlanner(id, actor);
		this.require(id);
		const decisionText = text(value, "text", MAX_TEXT)!;
		const scope = decisionAudience(audience);
		const now = Date.now();
		const decision: MissionDecision = {
			id: randomUUID(),
			number: 0,
			audience: scope,
			text: decisionText,
			...optionalAuthor(actor.sessionId),
			createdAt: now,
			updatedAt: now,
		};
		this.transaction(() => {
			this.run("UPDATE missions SET decision_sequence = decision_sequence + 1 WHERE id = ?", id);
			decision.number = num(this.one("SELECT decision_sequence FROM missions WHERE id = ?", id)!.decision_sequence!);
			this.run(
				"INSERT INTO decisions (id, mission_id, text, author_session_id, created_at, updated_at, audience, number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				decision.id,
				id,
				decision.text,
				actor.sessionId ?? null,
				now,
				now,
				scope,
				decision.number,
			);
			this.event(id, "decision", `Decision D${decision.number}: ${decision.text}`, actor, { at: now });
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
		this.assertPlanner(id, actor);
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
			this.dropProposal(id, before.id);
			this.event(
				id,
				"decision",
				`Decision D${before.number} changed${proposalAttribution(actor)}: ${decisionText}`,
				actor,
				{ at: now, wake: true },
			);
		});
		this.changed(id, this.members(id));
		return this.decision(id, decisionId);
	}

	removeDecision(id: string, decisionId: string, actor: MissionActor = USER): void {
		if (actor.sessionId) throw new Error("Only the user can change recorded decisions");
		this.assertPlanner(id, actor);
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
			this.dropProposal(id, before.id);
			this.run("DELETE FROM decisions WHERE id = ?", before.id);
			this.event(
				id,
				"decision",
				`Decision D${before.number} removed${proposalAttribution(actor)}: ${before.text}`,
				actor,
				{ wake: true },
			);
		});
		this.changed(id, this.members(id));
	}

	private decision(id: string, decisionId: string): MissionDecision {
		const row = /^D[1-9]\d*$/i.test(decisionId)
			? this.one("SELECT * FROM decisions WHERE mission_id = ? AND number = ?", id, Number(decisionId.slice(1)))
			: this.one("SELECT * FROM decisions WHERE mission_id = ? AND id = ?", id, decisionId);
		if (!row) throw new NotFound(`Unknown decision: ${decisionId}`);
		return decisionFrom(row);
	}

	proposals(id: string): MissionDecisionProposal[] {
		return this.all(
			`SELECT * FROM decision_proposals WHERE mission_id = ? AND status = 'pending'
			UNION ALL SELECT * FROM (SELECT * FROM decision_proposals WHERE mission_id = ? AND status != 'pending'
			ORDER BY resolved_at DESC, id LIMIT 20)`,
			id,
			id,
		).map(proposalFrom);
	}

	private dropProposal(id: string, decisionId: string): void {
		this.run(
			"DELETE FROM decision_proposals WHERE mission_id = ? AND decision_id = ? AND status = 'pending'",
			id,
			decisionId,
		);
	}

	proposeDecision(
		id: string,
		decisionId: string,
		value: unknown,
		remove: unknown,
		reason: unknown,
		actor: MissionActor,
	): MissionDecisionProposal {
		const mission = this.require(id);
		if (!actor.sessionId || mission.coordinatorSessionId !== actor.sessionId)
			throw new Conflict("Only the mission coordinator can propose decision changes");
		this.assertMember(id, actor.sessionId);
		const decision = this.decision(id, decisionId);
		if (remove !== undefined && remove !== true) throw new Error("remove must be true");
		if (remove === true && value !== undefined) throw new Error("Use text or remove, not both");
		const proposal: MissionDecisionProposal = {
			id: randomUUID(),
			decisionId: decision.id,
			kind: remove === true ? "remove" : "edit",
			...(remove === true ? {} : { text: text(value, "text", MAX_TEXT)! }),
			reason: text(reason, "reason", MAX_TEXT)!,
			authorSessionId: actor.sessionId,
			status: "pending",
			createdAt: Date.now(),
		};
		this.transaction(() => {
			this.dropProposal(id, decision.id);
			this.run(
				"INSERT INTO decision_proposals (id, mission_id, decision_id, kind, text, reason, author_session_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				proposal.id,
				id,
				decision.id,
				proposal.kind,
				proposal.text ?? null,
				proposal.reason,
				proposal.authorSessionId,
				proposal.status,
				proposal.createdAt,
			);
			this.event(id, "decision", `Change proposed for decision D${decision.number}: ${proposal.reason}`, actor);
		});
		this.changed(id);
		return proposal;
	}

	resolveProposal(
		id: string,
		proposalId: string,
		accept: boolean,
		replacement?: unknown,
		actor: MissionActor = USER,
	): MissionDecisionProposal {
		if (actor.sessionId) throw new Error("Only the user can resolve decision proposals");
		if (!accept && replacement !== undefined) throw new Error("Replacement text requires acceptance");
		const row = this.one(
			"SELECT * FROM decision_proposals WHERE mission_id = ? AND id = ? AND status = 'pending'",
			id,
			proposalId,
		);
		if (!row) throw new NotFound("Unknown pending decision proposal");
		const proposal = proposalFrom(row);
		const decision = this.decision(id, proposal.decisionId);
		if (proposal.kind === "remove" && replacement !== undefined) throw new Error("Removal has no replacement text");
		// Reuse user-only writers, suppressing their broadcasts until the whole transaction commits.
		this.referenceBatch = id;
		try {
			this.transaction(() => {
				this.run(
					"UPDATE decision_proposals SET status = ?, resolved_at = ? WHERE id = ?",
					accept ? "accepted" : "rejected",
					Date.now(),
					proposalId,
				);
				if (accept) {
					const user = { proposedBySessionId: proposal.authorSessionId };
					if (proposal.kind === "remove") this.removeDecision(id, decision.id, user);
					else {
						const applied = this.updateDecision(id, decision.id, replacement ?? proposal.text, user);
						this.run("UPDATE decision_proposals SET text = ? WHERE id = ?", applied.text, proposalId);
					}
				}
				const notice = `Decision D${decision.number} proposal ${proposalId} ${accept ? "accepted" : "rejected"}`;
				this.event(id, "decision", notice, USER, {
					wake: true,
					noticeSummaries: [{ key: `proposal:${proposalId}`, text: notice }],
				});
			});
		} finally {
			this.referenceBatch = undefined;
		}
		this.changed(id, accept ? this.members(id) : []);
		return proposalFrom(this.one("SELECT * FROM decision_proposals WHERE id = ?", proposalId)!);
	}

	/** PR safety needs no task bodies, brief, decisions, events, comments or attention aggregation. */
	linearPrScope(id: string) {
		const mission = this.one("SELECT project_id, status FROM missions WHERE id = ?", id);
		if (!mission) throw new NotFound(`Unknown mission: ${id}`);
		return {
			mission: { projectId: str(mission.project_id!), status: str(mission.status!) },
			tasks: this.all("SELECT id, number, status FROM tasks WHERE mission_id = ? ORDER BY number", id).map(
				(row) => ({ id: str(row.id!), number: num(row.number!), status: str(row.status!) }),
			),
			resources: this.all(
				"SELECT * FROM resources WHERE mission_id = ? AND kind IN ('linear.issue', 'github.pr') ORDER BY created_at, id",
				id,
			).map(resourceFrom),
		};
	}

	/** Daemon-owned correction flags. Persist comment IDs to avoid duplicate notices after restart. */
	reportLinearPrSafety(id: string, resourceId: string, url: string, warnings: string[]): void {
		const previous = this.one(
			"SELECT * FROM linear_pr_safety_reports WHERE resource_id = ? AND mission_id = ?",
			resourceId,
			id,
		);
		const message = warnings.length
			? `Linear PR safety: ${url}\n${[...new Set(warnings)].join("\n").slice(0, 7000)}\nCorrect explicitly and recheck; no PR was edited.`
			: "";
		if ((!previous && !message) || previous?.text === message) return;
		if (!this.one("SELECT 1 FROM resources WHERE id = ? AND mission_id = ?", resourceId, id)) return;
		this.batchChanges(() => {
			if (previous?.comment_id) this.resolveComment(id, str(previous.comment_id));
			const comment = message ? this.addComment(id, { text: message }) : undefined;
			this.run(
				"INSERT INTO linear_pr_safety_reports VALUES (?, ?, ?, ?) ON CONFLICT(resource_id) DO UPDATE SET comment_id = excluded.comment_id, text = excluded.text",
				resourceId,
				id,
				comment?.id ?? null,
				message,
			);
		});
	}

	// Comments

	addComment(
		id: string,
		write: MissionCommentWrite & { notification?: "action" | "informational" | "ack" | "urgent" },
		actor: MissionActor = USER,
	): MissionComment {
		const mission = this.require(id);
		if (!write || typeof write !== "object") throw new Error("Expected a comment object");
		const commentText = text(write.text, "text", MAX_TEXT)!;
		if (
			write.notification !== undefined &&
			!["action", "informational", "ack", "urgent"].includes(write.notification)
		)
			throw new Error("Invalid comment notification");
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
				wake:
					(!write.notification || write.notification === "action" || write.notification === "urgent") &&
					!/^(ack|acknowledged|thanks|thank you|noted|received)[.!]?$/i.test(comment.text.trim()) &&
					(!write.targetSessionId || write.targetSessionId === mission.coordinatorSessionId),
				urgent: write.notification === "urgent",
				noticeSummaries: [{ key: `comment:${comment.id}`, text: `Comment ${comment.id}: ${comment.text}` }],
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
		taskId: string | string[],
		artifacts: Omit<MissionArtifactLink, "linkedAt" | "linkedBySessionId">[],
		links: MissionResourceWrite[],
	): void {
		if (!artifacts.length && !links.length) return;
		if (this.referenceBatch) throw new Error("A reference batch is already active");
		const taskIds = typeof taskId === "string" ? [taskId] : taskId;
		for (const ref of taskIds) this.resolveTask(id, ref);
		this.referenceBatch = id;
		try {
			this.transaction(() => {
				for (const taskId of taskIds) {
					for (const item of artifacts) this.linkArtifact(id, { ...item, taskId });
					for (const item of links) this.addResource(id, { ...item, taskId, relationship: "reference" });
				}
			});
		} finally {
			this.referenceBatch = undefined;
		}
		this.changed(id);
	}

	/** Multi-task chats must use link + taskId, never infer a task from status or claim order. */
	linkAutomaticPullRequests(sessionId: string, urls: string[]): void {
		const id = this.missionOf(sessionId);
		if (!id || !urls.length) return;
		// Include completed tasks: a delayed PR from an earlier task is not the next task's PR.
		const tasks = this.all(
			"SELECT id, status FROM tasks WHERE mission_id = ? AND session_id = ? LIMIT 2",
			id,
			sessionId,
		);
		if (this.referenceBatch) throw new Error("A reference batch is already active");
		let linked = false;
		this.referenceBatch = id;
		try {
			this.transaction(() => {
				for (const url of urls) {
					const parsed = normalizeResourceWrite({ url });
					if (parsed.kind !== "github.pr") continue;
					const observed = this.db
						.prepare("INSERT OR IGNORE INTO automatic_pull_request_observations (mission_id, url) VALUES (?, ?)")
						.run(id, parsed.url);
					if (!observed.changes) continue;
					// Also respect explicit/legacy attribution before the observation ledger existed.
					if (
						this.one(
							"SELECT 1 FROM resources WHERE mission_id = ? AND url = ? COLLATE NOCASE AND relationship = 'ownership' LIMIT 1",
							id,
							parsed.url,
						)
					)
						continue;
					if (tasks.length !== 1 || tasks[0]!.status === "done" || tasks[0]!.status === "dropped") continue;
					this.addResource(id, { url: parsed.url, taskId: str(tasks[0]!.id!) }, { sessionId });
					linked = true;
				}
			});
		} finally {
			this.referenceBatch = undefined;
		}
		if (linked) this.changed(id);
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
		const role = parsed.kind === "linear.issue" ? (write.linearRole ?? "reference") : undefined;
		const key = parsed.kind === "linear.issue" ? linearKey(parsed.url) : undefined;
		const existing = key
			? this.one(
					"SELECT * FROM resources WHERE mission_id = ? AND linear_key = ? AND task_id IS ? ORDER BY created_at, id LIMIT 1",
					id,
					key,
					taskId ?? null,
				)
			: this.one(
					"SELECT * FROM resources WHERE mission_id = ? AND url = ? COLLATE NOCASE AND task_id IS ? AND relationship = ?",
					id,
					parsed.url,
					taskId ?? null,
					relationship,
				);
		if (existing) {
			if (write.linearRole !== undefined && existing.linear_role !== role)
				throw new Conflict("Use PATCH to explicitly change the existing Linear link role");
			return resourceFrom(existing);
		}
		if (role) this.validateLinearRole(id, taskId, key, role, actor);
		const now = Date.now();
		const resource: MissionResource = {
			relationship,
			...(role ? { linearRole: role } : {}),
			...(key ? { linearKey: key } : {}),
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
				"INSERT INTO resources (id, mission_id, url, title, kind, external_id, added_by_session_id, created_at, task_id, relationship, linear_role, linear_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
				role ?? null,
				key ?? null,
			);
			this.event(id, "resource", `Linked ${title ?? parsed.externalId ?? parsed.url}`, actor, {
				at: now,
				taskId,
				...(parsed.kind === "linear.issue" && !taskId
					? {
							wake: true,
							noticeSummaries: [
								{
									key: `ticket:${resource.id}`,
									text: `Linear ticket attached (${role}): ${parsed.externalId}. Read links and ticket context; clarify existing work before associating or splitting.`,
								},
							],
						}
					: {}),
			});
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
		return resourceFrom(this.one("SELECT * FROM resources WHERE id=?", resource.id)!);
	}

	private validateLinearRole(
		id: string,
		taskId: string | undefined,
		key: string | undefined,
		role: MissionLinearRole,
		actor: MissionActor,
		resourceId?: string,
	): void {
		if (role === "reference") return;
		if (actor.sessionId && actor.sessionId !== this.require(id).coordinatorSessionId)
			throw new Conflict("Only the user or coordinator may manage Linear tickets and contributions");
		if (!key) throw new Error("Managed Linear links require a workspace and issue identifier");
		if (role === "managed") {
			if (taskId) throw new Error("Managed Linear tickets require mission scope");
			const manager = this.one("SELECT id FROM resources WHERE linear_key = ? AND linear_role = 'managed'", key);
			if (manager && manager.id !== resourceId)
				throw new Conflict("This Linear ticket already has a managing mission");
		} else {
			if (!taskId) throw new Error("Linear contributions require a task");
			if (
				!this.one(
					"SELECT 1 FROM resources WHERE mission_id = ? AND linear_key = ? AND linear_role = 'managed'",
					id,
					key,
				)
			)
				throw new Conflict("Manage the Linear ticket in this mission before adding contributions");
			const existing = this.one(
				"SELECT id FROM resources WHERE mission_id = ? AND task_id = ? AND linear_key = ? AND linear_role = 'contribution'",
				id,
				taskId,
				key,
			);
			if (existing && existing.id !== resourceId)
				throw new Conflict("This task already contributes to the Linear ticket");
		}
	}

	private assertLinearDetach(id: string, resource: MissionResource): void {
		if (
			resource.linearRole === "managed" &&
			this.one(
				"SELECT 1 FROM resources WHERE mission_id = ? AND linear_key = ? AND linear_role = 'contribution'",
				id,
				resource.linearKey!,
			)
		)
			throw new Conflict("Detach task contributions before detaching the managed Linear ticket");
	}

	updateResource(
		id: string,
		resourceId: string,
		write: MissionResourceUpdate,
		actor: MissionActor = USER,
	): MissionResource {
		this.require(id);
		if (!write || !["reference", "managed", "contribution"].includes(write.linearRole))
			throw new Error("Invalid Linear role");
		const row = this.one("SELECT * FROM resources WHERE mission_id = ? AND id = ?", id, resourceId);
		if (!row) throw new NotFound(`Unknown resource: ${resourceId}`);
		const resource = resourceFrom(row);
		if (resource.kind !== "linear.issue") throw new Error("Linear roles require a Linear issue");
		if (actor.sessionId && actor.sessionId !== this.require(id).coordinatorSessionId)
			throw new Conflict("Only the user or coordinator may change Linear link roles");
		if (resource.linearRole === write.linearRole) return resource;
		this.validateLinearRole(id, resource.taskId, resource.linearKey, write.linearRole, actor, resourceId);
		this.assertLinearDetach(id, resource);
		this.transaction(() => {
			this.run("UPDATE resources SET linear_role = ? WHERE id = ?", write.linearRole, resourceId);
			// A newly explicit contribution starts fresh assignment observation, not a replay of reference reads.
			this.run("DELETE FROM linear_task_assignees WHERE resource_id = ?", resourceId);
			this.event(id, "resource", `Linear link role changed to ${write.linearRole}: ${resource.externalId}`, actor, {
				taskId: resource.taskId,
				wake: true,
			});
		});
		this.changed(id);
		return resourceFrom(this.one("SELECT * FROM resources WHERE id=?", resourceId)!);
	}

	removeResource(id: string, resourceId: string, actor: MissionActor = USER): void {
		const row = this.one("SELECT * FROM resources WHERE mission_id = ? AND id = ?", id, resourceId);
		if (!row) throw new NotFound(`Unknown resource: ${resourceId}`);
		const resource = resourceFrom(row);
		this.assertLinearDetach(id, resource);
		if (
			resource.linearRole &&
			resource.linearRole !== "reference" &&
			actor.sessionId &&
			actor.sessionId !== this.require(id).coordinatorSessionId
		)
			throw new Conflict("Only the user or coordinator may detach Linear contributions or managed tickets");
		if (
			actor.sessionId &&
			actor.sessionId !== this.require(id).coordinatorSessionId &&
			resource.addedBySessionId !== actor.sessionId
		)
			throw new Conflict("Members may only remove links they added");
		this.transaction(() => {
			if (resource.kind === "github.pr" && resource.relationship === "ownership")
				this.run(
					"INSERT OR IGNORE INTO automatic_pull_request_observations (mission_id, url) VALUES (?, ?)",
					id,
					resource.url,
				);
			this.run("DELETE FROM resources WHERE id = ?", resourceId);
			this.event(id, "resource", `Unlinked ${resource.title ?? resource.externalId ?? resource.url}`, actor, {
				taskId: resource.taskId,
			});
			if (resource.taskId && resource.kind !== "linear.issue") this.reconcileTaskPullRequests(id, resource.taskId);
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
		// PR observations are evidence, not coordinator acceptance in the opted-in contract.
		if (this.require(id).planningVersion !== undefined) return false;
		if (!handoffActor && this.require(id).status !== "active") return false;
		const task = this.rawTask(this.task(id, taskId));
		if (
			task.status === "done" ||
			task.status === "dropped" ||
			task.status === "delegated" ||
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

	/** Structured completion activity. Triggers capture all writers, including PR and remote projections. */
	watchActivity(
		after: number,
		limit = 100,
	): {
		id: number;
		missionId: string;
		taskId?: string;
		taskNumber?: number;
		title: string;
		at: number;
		originSessionId?: string;
	}[] {
		return this.all(
			"SELECT * FROM watch_activity WHERE id>? ORDER BY id LIMIT ?",
			after,
			Math.max(1, Math.min(limit, 100)),
		).map((row) => ({
			id: num(row.id!),
			missionId: str(row.mission_id!),
			title: str(row.title!),
			at: num(row.at!),
			...(row.task_id ? { taskId: str(row.task_id!), taskNumber: num(row.task_number!) } : {}),
			...(row.origin_session_id ? { originSessionId: str(row.origin_session_id) } : {}),
		}));
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

	activity(id: string, query: MissionActivityQuery): MissionEvent[] {
		this.require(id);
		const where = ["mission_id = ?"];
		const values: SQLInputValue[] = [id];
		for (const [column, operator, value] of [
			["task_id", "=", query.taskId],
			["kind", "=", query.kind],
			["id", ">", query.sinceEventId],
			["at", ">", query.sinceAt],
			["id", "<", query.before],
		] as const) {
			if (value === undefined) continue;
			where.push(`${column} ${operator} ?`);
			values.push(value);
		}
		return this.all(
			`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
			...values,
			query.limit,
		).map(eventFrom);
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

	/** A durable dedupe key makes kernel outbox replay safe across daemon restarts. */
	recordSystemMessageState(
		sessionId: string,
		event: { id: string; requestId: string; state: "held" | "discarded"; preview: string },
	): void {
		// New sends carry their original mission identity, even if the recipient later leaves or moves.
		const parts = event.requestId.split(":");
		const id =
			parts.length === 6 && parts[2] === "from"
				? parts[4]
				: parts.length === 4
					? parts[2]
					: this.missionOf(sessionId);
		if (!id || !this.get(id)) return;
		const changed = this.transaction(() => {
			if (
				this.one(
					"SELECT event_id FROM system_message_events WHERE session_id = ? AND event_id = ?",
					sessionId,
					event.id,
				)
			)
				return false;
			this.run(
				"INSERT INTO system_message_events (session_id, event_id, mission_id) VALUES (?, ?, ?)",
				sessionId,
				event.id,
				id,
			);
			const text = `Message ${event.requestId} (${JSON.stringify(event.preview)}) to chat ${sessionId} ${event.state === "held" ? "held because the user stopped the chat" : "discarded by the user"}.`;
			this.event(
				id,
				"update",
				text,
				{ sessionId },
				{ wake: true, noticeSummaries: [{ key: `message:${sessionId}:${event.requestId}:${event.state}`, text }] },
			);
			return true;
		});
		if (changed) this.changed(id);
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

	/** Ownership handoff, not leave/join: retain every claim, status, PR link and observation tombstone. */
	continueSession(from: string, to: string): void {
		if (from === to) throw new Conflict("A continuation requires a fresh chat");
		const previous = this.one("SELECT to_session_id FROM session_continuations WHERE from_session_id = ?", from);
		if (previous && previous.to_session_id !== to) throw new Conflict("Chat already continued elsewhere");
		const id = this.missionOf(from);
		if (!id) {
			this.transaction(() => {
				this.run(
					"INSERT OR IGNORE INTO session_continuations (from_session_id, to_session_id) VALUES (?, ?)",
					from,
					to,
				);
				this.run("UPDATE member_task_claims SET session_id = ? WHERE session_id = ?", to, from);
				this.run("UPDATE tasks SET created_by_session_id = ? WHERE created_by_session_id = ?", to, from);
			});
			return; // The same journal may be replayed after the transaction committed.
		}
		if (this.missionOf(to)) throw new Conflict("The continuation chat already belongs to a mission");
		this.transaction(() => {
			this.run(
				"INSERT OR IGNORE INTO session_continuations (from_session_id, to_session_id) VALUES (?, ?)",
				from,
				to,
			);
			this.run("UPDATE member_task_claims SET session_id = ? WHERE session_id = ?", to, from);
			this.run("UPDATE tasks SET created_by_session_id = ? WHERE created_by_session_id = ?", to, from);
			this.run("UPDATE members SET session_id = ? WHERE session_id = ?", to, from);
			this.run("UPDATE tasks SET session_id = ? WHERE session_id = ?", to, from);
			this.run("UPDATE missions SET coordinator_session_id = ? WHERE coordinator_session_id = ?", to, from);
			this.run("UPDATE member_runs SET session_id = ? WHERE session_id = ?", to, from);
			this.run("UPDATE retired_members SET session_id = ? WHERE session_id = ?", to, from);
			this.run("UPDATE notices SET session_id = ? WHERE session_id = ? AND delivered_at IS NULL", to, from);
			this.run(
				"UPDATE comments SET target_session_id = ? WHERE target_session_id = ? AND resolved_at IS NULL",
				to,
				from,
			);
			// Copy both positive bindings and negative tombstones. Never re-infer task attribution.
			this.run(
				`INSERT INTO pull_request_bindings (session_id, url, bound, mission_id, task_id)
				SELECT ?, url, bound, mission_id, task_id FROM pull_request_bindings WHERE session_id = ?`,
				to,
				from,
			);
			this.run("UPDATE pull_request_bindings SET bound = 0 WHERE session_id = ?", from);
			this.run(
				"UPDATE resources SET added_by_session_id = ? WHERE added_by_session_id = ? AND relationship = 'ownership'",
				to,
				from,
			);
			this.event(id, "member", `Chat ${from} continued in ${to}`, { sessionId: to });
		});
		this.changed(id, [from, to]);
	}

	/** Hot session-summary path: no attention counts, task bodies or mission detail. Always read current roles. */
	membership(
		sessionId: string,
	): { missionId: string; active: boolean; coordinator: boolean; role?: MissionRole } | undefined {
		const row = this.one(
			`SELECT m.mission_id, m.role, mission.status, mission.planning_version, mission.coordinator_session_id
			FROM members m JOIN missions mission ON mission.id = m.mission_id WHERE m.session_id = ?`,
			sessionId,
		);
		return row
			? {
					missionId: str(row.mission_id!),
					active: row.status === "active",
					coordinator: row.coordinator_session_id === sessionId,
					...(row.planning_version != null
						? {
								role:
									row.coordinator_session_id === sessionId
										? ("coordinator" as const)
										: workerRole(num(row.planning_version), row.role ?? undefined),
							}
						: {}),
				}
			: undefined;
	}

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
	join(sessionId: string, id: string, actor: MissionActor = USER, role?: MissionWorkerRole): void {
		if (this.one("SELECT 1 FROM session_continuations WHERE from_session_id = ?", sessionId))
			throw new Conflict("This chat continued elsewhere and cannot own mission work");
		this.assertPlanner(id, actor);
		const selected = this.workerRole(id, role);
		const previous = this.missionOf(sessionId);
		if (previous === id) {
			if (role !== undefined && this.membership(sessionId)?.role !== selected)
				throw new Conflict("Mission roles cannot change in place; start a fresh chat");
			return;
		}
		this.transaction(() => {
			if (previous) this.detach(sessionId, previous, actor);
			this.run(
				"INSERT INTO members (session_id, mission_id, joined_at, role) VALUES (?, ?, ?, ?)",
				sessionId,
				id,
				Date.now(),
				selected ?? null,
			);
			this.event(id, "member", "A chat joined the mission", { sessionId });
		});
		if (previous) this.changed(previous, []);
		this.changed(id, [sessionId]);
	}

	/** Missing roles preserve existing opted-in admissions as builders; legacy missions stay unlabelled. */
	workerRole(id: string, value: unknown): MissionWorkerRole | undefined {
		return workerRole(this.require(id).planningVersion, value);
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

function workerRole(version: number | undefined, value: unknown): MissionWorkerRole | undefined {
	if (version === undefined) {
		if (value !== undefined) throw new Conflict("Mission roles require planningVersion 1; adoption is not supported");
		return undefined;
	}
	if (version !== 1) throw new Conflict("Unsupported mission planning version");
	if (value === undefined) return "builder";
	if (value !== "explorer" && value !== "builder" && value !== "reviewer")
		throw new Error("role must be explorer, builder or reviewer");
	return value;
}

function optionalAuthor(value: SQLInputValue | string | undefined): { authorSessionId?: string } {
	return value === null || value === undefined ? {} : { authorSessionId: String(value) };
}

function statusLabel(status: MissionTaskStatus): string {
	return status === "in_progress" ? "in progress" : status === "in_review" ? "in review" : status;
}

function missionFrom(row: Row): Mission {
	return {
		...(row.planning_version != null ? { planningVersion: num(row.planning_version) } : {}),
		id: str(row.id!),
		projectId: str(row.project_id!),
		title: str(row.title!),
		goal: str(row.goal!),
		status: str(row.status!) as MissionStatus,
		...(row.passive_lifecycle === 1 ? { passiveLifecycle: true } : {}),
		...(row.coordinator_session_id ? { coordinatorSessionId: str(row.coordinator_session_id) } : {}),
		...(row.autopilot ? { autopilot: true } : {}),
		phaseGating: row.phase_gating === 1,
		...(typeof row.current_phase === "string" ? { currentPhase: JSON.parse(row.current_phase) } : {}),
		briefRevision: num(row.brief_revision!),
		needsYouCount: num(row.needs_you_count!),
		tasksDone: num(row.tasks_done!),
		tasksTotal: num(row.tasks_total!),
		...(row.needs_you_reason ? { needsYouReason: reasonLine(str(row.needs_you_reason)) } : {}),
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

function sharedEntityFrom(row: Row): SharedEntity {
	const kind = String(row.kind) as SharedEntity["kind"];
	const raw = row.value ? (JSON.parse(String(row.value)) as Row) : {};
	if (kind === "mission") {
		raw.needs_you_count = 0;
		raw.tasks_done = 0;
		raw.tasks_total = 0;
	}
	const map = {
		mission: missionFrom,
		brief: briefFrom,
		task: taskFrom,
		decision: decisionFrom,
		comment: commentFrom,
		resource: resourceFrom,
		artifact: artifactFrom,
		phase: phaseFrom,
	};
	return {
		id: String(row.id),
		kind,
		revision: Number(row.revision),
		...(kind === "task" && Number.isSafeInteger(raw.definition_revision) && Number(raw.definition_revision) > 0
			? { definitionRevision: Number(raw.definition_revision) }
			: {}),
		deleted: Boolean(row.deleted),
		...(!row.deleted ? { value: map[kind](raw) } : {}),
	};
}

function decisionFrom(row: Row): MissionDecision {
	return {
		id: str(row.id!),
		number: num(row.number!),
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

function phaseFrom(row: Row): MissionPhase {
	return {
		id: str(row.id!),
		missionId: str(row.mission_id!),
		name: str(row.name!),
		order: num(row.sort!),
		...(row.goal ? { goal: str(row.goal) } : {}),
		...(row.completed_at !== null ? { completedAt: num(row.completed_at!) } : {}),
	};
}

function taskFrom(row: Row): MissionTask {
	const dependsOn = row.depends_on ? (JSON.parse(str(row.depends_on)) as string[]) : undefined;
	return {
		id: str(row.id!),
		number: num(row.number!),
		title: str(row.title!),
		...(row.body ? { body: str(row.body) } : {}),
		...(row.assignment ? { assignment: JSON.parse(str(row.assignment)) as MissionTask["assignment"] } : {}),
		status: str(row.status!) as MissionTaskStatus,
		...(row.delegated_to ? { delegatedTo: str(row.delegated_to) } : {}),
		order: num(row.sort!),
		...(row.milestone ? { milestone: str(row.milestone) } : {}),
		...(row.phase_id ? { phaseId: str(row.phase_id) } : {}),
		...(dependsOn?.length ? { dependsOn } : {}),
		...(row.decision_ids ? { decisionIds: JSON.parse(str(row.decision_ids)) as string[] } : {}),
		...(row.session_id ? { sessionId: str(row.session_id) } : {}),
		...(row.preferred_model
			? {
					preferredModel: str(row.preferred_model),
					...(row.preferred_thinking ? { preferredThinking: str(row.preferred_thinking) } : {}),
					...(row.preferred_model_by
						? { preferredModelSetBy: str(row.preferred_model_by) as "user" | "coordinator" }
						: {}),
				}
			: {}),
		createdAt: num(row.created_at!),
		updatedAt: num(row.updated_at!),
		...(optional(row.completed_at, num) !== undefined ? { completedAt: num(row.completed_at!) } : {}),
	};
}

/** Quotes an SQLite identifier read from sqlite_master. */
function identifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Copies a migrated missions.sqlite into an in-memory database with the same schema, rows and AUTOINCREMENT
 * counters. Indexes are created after the rows. Foreign keys are enforced from then on.
 */
function loadInMemory(file: string): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = OFF");
	db.prepare("ATTACH DATABASE ? AS disk").run(file);
	try {
		const objects = db
			.prepare(
				`SELECT type, name, sql FROM disk.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
				ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid`,
			)
			.all() as { type: string; name: string; sql: string }[];
		db.exec("BEGIN");
		for (const object of objects) {
			db.exec(object.sql);
			if (object.type === "table")
				db.exec(`INSERT INTO main.${identifier(object.name)} SELECT * FROM disk.${identifier(object.name)}`);
		}
		const sequence = "SELECT 1 FROM %s.sqlite_master WHERE name = 'sqlite_sequence'";
		if (db.prepare(sequence.replace("%s", "disk")).get() && db.prepare(sequence.replace("%s", "main")).get())
			db.exec("INSERT INTO main.sqlite_sequence SELECT * FROM disk.sqlite_sequence");
		db.exec("COMMIT");
	} finally {
		db.exec("DETACH DATABASE disk");
	}
	db.exec("PRAGMA foreign_keys = ON");
	return db;
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
		...(row.linear_role === "managed" && row.linear_sync
			? { linearSync: (JSON.parse(str(row.linear_sync)) as LinearSyncRecord).status }
			: {}),
		...(row.kind === "linear.issue" ? { linearRole: (row.linear_role ?? "reference") as MissionLinearRole } : {}),
		...(row.linear_key ? { linearKey: str(row.linear_key) } : {}),
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

function proposalAttribution(actor: MissionActor): string {
	return actor.proposedBySessionId ? ` (proposed by chat ${actor.proposedBySessionId})` : "";
}

function proposalFrom(row: Row): MissionDecisionProposal {
	return {
		id: str(row.id!),
		decisionId: str(row.decision_id!),
		kind: str(row.kind!) as MissionDecisionProposal["kind"],
		...(row.text !== null ? { text: str(row.text!) } : {}),
		reason: str(row.reason!),
		authorSessionId: str(row.author_session_id!),
		status: str(row.status!) as MissionDecisionProposal["status"],
		createdAt: num(row.created_at!),
		...(row.resolved_at !== null ? { resolvedAt: num(row.resolved_at!) } : {}),
	};
}
