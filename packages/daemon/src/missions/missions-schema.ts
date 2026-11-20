/** missions.sqlite schema and its upgrades. They protect saved user data: keep every step and its order. */
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { ATTENTION_SCHEMA } from "../day/attention/attention-store.ts";
import { CHANGE_LANDING_SCHEMA } from "../changes/change-landing-store.ts";
import { DAY_INSIGHTS_ALLOWANCE_SCHEMA } from "../day/insights/day-insights-allowance.ts";
import { DAY_INSIGHTS_SCHEMA } from "../day/insights/day-insights-store.ts";
import { HUMAN_REVIEW_SCHEMA } from "../reviews/human/human-review-store.ts";
import { INSIGHTS_SCHEMA } from "../insights/insights-backlog.ts";
import { INSIGHTS_OWNER_SCHEMA } from "../insights/ownership/insights-owner-store.ts";
import { INSIGHTS_TRANSITION_SCHEMA } from "../insights/migration/insights-transition-store.ts";
import { INSIGHTS_WORKSPACE_SCHEMA } from "../insights/ownership/insights-workspace-store.ts";
import { LINEAR_PUBLISHER_SCHEMA } from "../sources/linear/linear-publisher-store.ts";
import { MISSION_CONTROL_SCHEMA } from "./lifecycle/mission-control-store.ts";
import { type MissionDatabase, sqlIdentifier } from "./mission-database.ts";
import { MISSION_INTERVIEW_SCHEMA } from "./interviews/mission-interview-store.ts";
import { MISSION_PLAN_SCHEMA } from "./planning/mission-plan-store.ts";
import { MISSION_REVISION_SCHEMA } from "./lifecycle/mission-revisions.ts";
import { MISSION_THREAD_SCHEMA } from "./threads/mission-thread-store.ts";
import { PLANNING_WORKER_SCHEMA } from "./planning/workers/planning-worker-store.ts";
import { assertLocalMissionDb, dropEmptyRemoteTables } from "../runtime/updates/profile-cutover.ts";
import { KNOWLEDGE_SCHEMA } from "../projects/knowledge/project-knowledge-store.ts";
import { PROJECT_PREFERENCES_SCHEMA } from "../projects/project-preferences-store.ts";
import { linearKey } from "./resource-url.ts";
import { RETAINED_PROJECTION_SCHEMA } from "../reviews/retained/retained-review-projections.ts";
import { REVIEW_REQUEST_SCHEMA } from "../reviews/requests/review-request-store.ts";
import { USER_FEEDBACK_SCHEMA } from "../day/feedback/user-feedback-store.ts";
import { DELIVERY_SOURCE_SCHEMA, USER_VERIFICATION_SCHEMA } from "../user-verification-store.ts";
import { WORKFLOW_CONFIRMATION_SCHEMA } from "./planning/confirmations/workflow-confirmation-store.ts";

/** Mission store steps that migration runs at fixed points. */
export interface MigrationHooks {
	/** On disk, before the in-memory copy opens. Never replays a saved placement. */
	recoverInsightsReviews(): void;
	/** The mission's task phases need reconciling at the next reconciling commit. */
	phaseChanged(missionId: string): void;
	reconcileLinearSync(): void;
}

const str = (value: SQLInputValue) => String(value);

/** Re-planning links: an old mission (no planningVersion) and the new mission that re-plans it. */
const MISSION_SUCCESSOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_successors (
	old_mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
	new_mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	operation_id TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('planning', 'finished', 'abandoned')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mission_successors_by_new ON mission_successors(new_mission_id);
CREATE TABLE IF NOT EXISTS mission_successor_finishes (operation_id TEXT PRIMARY KEY, record TEXT NOT NULL);
`;

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
CREATE TABLE IF NOT EXISTS mission_review_records (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
	profile_id TEXT NOT NULL,
	record_type TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	record_id TEXT NOT NULL UNIQUE,
	record TEXT NOT NULL,
	UNIQUE(mission_id, operation_id)
);
CREATE INDEX IF NOT EXISTS mission_review_stream ON mission_review_records(mission_id, record_type, profile_id, task_id, sequence);
CREATE TABLE IF NOT EXISTS task_contribution_allocations (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	operation_id TEXT NOT NULL,
	record_id TEXT NOT NULL UNIQUE,
	record TEXT NOT NULL,
	UNIQUE(mission_id, operation_id)
);
CREATE INDEX IF NOT EXISTS contribution_allocation_task ON task_contribution_allocations(mission_id, task_id, sequence);
CREATE TABLE IF NOT EXISTS task_non_code_acceptance_policies (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	operation_id TEXT NOT NULL,
	record_id TEXT NOT NULL UNIQUE,
	record TEXT NOT NULL,
	UNIQUE(mission_id, operation_id)
);
CREATE INDEX IF NOT EXISTS non_code_policy_task ON task_non_code_acceptance_policies(mission_id, task_id, sequence);
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
CREATE INDEX IF NOT EXISTS tasks_by_session ON tasks (session_id) WHERE session_id IS NOT NULL;
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

/** Schema creation and upgrades, on the disk file at startup. Keep the order: later steps read earlier columns. */
export function migrateMissionDb(db: MissionDatabase, hooks: MigrationHooks): void {
	assertLocalMissionDb(db.connection);
	// The previous store's replica thread may still be closing its connection.
	db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	retireRemoteSchema(db);
	const migratePrTransitions = !db.one("SELECT 1 FROM sqlite_master WHERE name = 'pull_request_transitions'");
	db.exec(SCHEMA);
	db.exec(KNOWLEDGE_SCHEMA);
	db.exec(PROJECT_PREFERENCES_SCHEMA);
	db.exec(USER_FEEDBACK_SCHEMA);
	db.exec(INSIGHTS_SCHEMA);
	db.exec(INSIGHTS_WORKSPACE_SCHEMA);
	db.exec(INSIGHTS_OWNER_SCHEMA);
	db.exec(DAY_INSIGHTS_SCHEMA);
	db.exec(DAY_INSIGHTS_ALLOWANCE_SCHEMA);
	db.exec(INSIGHTS_TRANSITION_SCHEMA);
	db.exec(WORKFLOW_CONFIRMATION_SCHEMA);
	db.exec(MISSION_INTERVIEW_SCHEMA);
	db.exec(PLANNING_WORKER_SCHEMA);
	db.exec(MISSION_PLAN_SCHEMA);
	db.exec(LINEAR_PUBLISHER_SCHEMA);
	db.exec(ATTENTION_SCHEMA);
	db.exec(USER_VERIFICATION_SCHEMA);
	if (!db.one("SELECT 1 FROM sqlite_master WHERE name='delivery_sources'")) {
		db.exec(`BEGIN; ${DELIVERY_SOURCE_SCHEMA} COMMIT;`);
	}
	db.exec(MISSION_CONTROL_SCHEMA);
	db.exec(MISSION_REVISION_SCHEMA);
	db.exec(MISSION_THREAD_SCHEMA);
	db.exec(HUMAN_REVIEW_SCHEMA);
	db.exec(CHANGE_LANDING_SCHEMA);
	db.exec(RETAINED_PROJECTION_SCHEMA);
	db.exec(REVIEW_REQUEST_SCHEMA);
	db.exec(MISSION_SUCCESSOR_SCHEMA);
	hooks.recoverInsightsReviews();
	if (!db.all("PRAGMA table_info(tasks)").some((row) => row.name === "created_by_session_id"))
		db.exec("ALTER TABLE tasks ADD COLUMN created_by_session_id TEXT");
	// Existing assignments are grandfathered, not retroactively charged.
	db.exec(`INSERT OR IGNORE INTO member_task_claims (session_id, task_id, additional)
		SELECT session_id, id, 0 FROM tasks WHERE session_id IS NOT NULL`);
	db.exec(`CREATE TABLE IF NOT EXISTS linear_pr_safety_reports (
		resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
		mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
		comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
		text TEXT NOT NULL
	);`);
	db.exec(`CREATE TABLE IF NOT EXISTS phases (
		id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
		name TEXT NOT NULL, goal TEXT, sort REAL NOT NULL, completed_at INTEGER,
		UNIQUE(mission_id, name)
	);
	CREATE INDEX IF NOT EXISTS phases_by_mission ON phases(mission_id, sort, id);`);
	db.transaction(() => {
		if (!db.all("PRAGMA table_info(missions)").some((row) => row.name === "phase_gating"))
			db.exec("ALTER TABLE missions ADD COLUMN phase_gating INTEGER NOT NULL DEFAULT 0");
		if (!db.all("PRAGMA table_info(tasks)").some((row) => row.name === "phase_id")) {
			db.exec("ALTER TABLE tasks ADD COLUMN phase_id TEXT REFERENCES phases(id) ON DELETE SET NULL");
			// Display order defines first appearance. Names are scoped to their mission.
			for (const row of db.all(
				"SELECT * FROM tasks WHERE milestone IS NOT NULL AND trim(milestone) <> '' ORDER BY mission_id, sort, number",
			)) {
				const missionId = str(row.mission_id!);
				const name = str(row.milestone!).trim();
				let phase = db.one("SELECT id FROM phases WHERE mission_id = ? AND name = ?", missionId, name);
				if (!phase) {
					const phaseId = randomUUID();
					db.run(
						"INSERT INTO phases (id, mission_id, name, sort) VALUES (?, ?, ?, (SELECT COUNT(*) FROM phases WHERE mission_id = ?))",
						phaseId,
						missionId,
						name,
						missionId,
					);
					phase = { id: phaseId };
				}
				db.run("UPDATE tasks SET phase_id = ?, milestone = ? WHERE id = ?", phase.id!, name, row.id!);
				hooks.phaseChanged(missionId);
			}
		}
		db.exec("CREATE INDEX IF NOT EXISTS tasks_by_phase ON tasks(phase_id, status)");
		db.exec(
			"CREATE INDEX IF NOT EXISTS unfinished_tasks_by_phase ON tasks(phase_id) WHERE status NOT IN ('done', 'dropped')",
		);
	});
	db.exec(
		"CREATE TABLE IF NOT EXISTS system_message_events (session_id TEXT NOT NULL, event_id TEXT NOT NULL, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, PRIMARY KEY (session_id, event_id))",
	);
	if (!db.all("PRAGMA table_info(decisions)").some((row) => row.name === "audience"))
		db.exec("ALTER TABLE decisions ADD COLUMN audience TEXT NOT NULL DEFAULT 'reference'");
	if (!db.all("PRAGMA table_info(decisions)").some((row) => row.name === "replacement"))
		db.exec("ALTER TABLE decisions ADD COLUMN replacement TEXT");
	if (!db.all("PRAGMA table_info(decisions)").some((row) => row.name === "withdrawn"))
		db.exec("ALTER TABLE decisions ADD COLUMN withdrawn TEXT");
	if (!db.all("PRAGMA table_info(decision_proposals)").some((row) => row.name === "operation_id"))
		db.exec("ALTER TABLE decision_proposals ADD COLUMN operation_id TEXT");
	db.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS decision_proposal_operations ON decision_proposals(mission_id, operation_id) WHERE operation_id IS NOT NULL",
	);
	db.transaction(() => {
		const migrateNumbers = !db.all("PRAGMA table_info(decisions)").some((row) => row.name === "number");
		const migrateSequence = !db.all("PRAGMA table_info(missions)").some((row) => row.name === "decision_sequence");
		if (migrateNumbers) {
			db.exec("ALTER TABLE decisions ADD COLUMN number INTEGER NOT NULL DEFAULT 0");
			db.exec(`UPDATE decisions SET number = (SELECT n FROM
				(SELECT id, ROW_NUMBER() OVER (PARTITION BY mission_id ORDER BY created_at, id) n FROM decisions) ranked
				WHERE ranked.id = decisions.id)`);
		}
		if (migrateSequence) db.exec("ALTER TABLE missions ADD COLUMN decision_sequence INTEGER NOT NULL DEFAULT 0");
		if (migrateNumbers || migrateSequence)
			db.exec(`UPDATE missions SET decision_sequence = MAX(decision_sequence,
				COALESCE((SELECT MAX(number) FROM decisions WHERE mission_id = missions.id), 0))`);
		db.exec("CREATE UNIQUE INDEX IF NOT EXISTS decision_numbers ON decisions(mission_id, number)");
	});
	if (!db.all("PRAGMA table_info(missions)").some((row) => row.name === "planning_version"))
		db.exec("ALTER TABLE missions ADD COLUMN planning_version INTEGER");
	if (!db.all("PRAGMA table_info(members)").some((row) => row.name === "role"))
		db.exec("ALTER TABLE members ADD COLUMN role TEXT");
	if (!db.all("PRAGMA table_info(tasks)").some((row) => row.name === "assignment"))
		db.exec("ALTER TABLE tasks ADD COLUMN assignment TEXT");
	if (!db.all("PRAGMA table_info(tasks)").some((row) => row.name === "decision_ids"))
		db.exec("ALTER TABLE tasks ADD COLUMN decision_ids TEXT");
	for (const column of ["delegated_to", "delegated_from_status", "delegated_resource_id"])
		if (!db.all("PRAGMA table_info(tasks)").some((row) => row.name === column))
			db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
	for (const column of ["preferred_model", "preferred_thinking", "preferred_model_by"])
		if (!db.all("PRAGMA table_info(tasks)").some((row) => row.name === column))
			db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
	db.exec(`CREATE TABLE IF NOT EXISTS linear_task_assignees (
		resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
		assignee_id TEXT,
		held INTEGER NOT NULL DEFAULT 0
	)`);
	if (!db.all("PRAGMA table_info(linear_task_assignees)").some((row) => row.name === "held")) {
		db.exec(`ALTER TABLE linear_task_assignees ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
			UPDATE linear_task_assignees SET held=1 WHERE resource_id IN
			(SELECT delegated_resource_id FROM tasks WHERE delegated_from_status IS NOT NULL);`);
	}
	db.exec(`CREATE TABLE IF NOT EXISTS linear_chat_links (
		id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
		url TEXT NOT NULL, external_id TEXT NOT NULL, linear_key TEXT NOT NULL,
		linear_sync TEXT NOT NULL, created_at INTEGER NOT NULL, enabled INTEGER NOT NULL,
		operation_id TEXT
	);
	CREATE UNIQUE INDEX IF NOT EXISTS linear_chat_manager ON linear_chat_links(linear_key) WHERE enabled=1;
	CREATE INDEX IF NOT EXISTS linear_chat_poll ON linear_chat_links(id) WHERE enabled=1;`);
	// Upgrade already queued events without losing their stable event IDs.
	db.exec(`INSERT OR IGNORE INTO pending_notice_summaries (event_id, group_key, text, state)
		SELECT p.event_id, COALESCE('task:' || e.task_id, 'task:' || t.id,
			CASE WHEN p.text LIKE '%: chat %' THEN 'chat:' || e.session_id ELSE 'note:' || COALESCE(e.session_id, 'user') END), p.text,
			CASE WHEN p.text LIKE '%chat failed%' THEN 'failed'
				WHEN p.text LIKE '%chat finished%' THEN 'done' END
		FROM pending_notices p JOIN events e ON e.id = p.event_id
		LEFT JOIN tasks t ON t.mission_id = p.mission_id AND t.session_id = e.session_id
			AND e.kind = 'update' AND p.text LIKE '%: chat %'
		WHERE NOT EXISTS (SELECT 1 FROM pending_notice_summaries s WHERE s.event_id = p.event_id)`);
	if (!db.all("PRAGMA table_info(member_completions)").some((row) => row.name === "signature"))
		db.exec("ALTER TABLE member_completions ADD COLUMN signature TEXT");
	if (migratePrTransitions)
		db.exec(`INSERT OR IGNORE INTO pull_request_transitions (mission_id, url, state)
			SELECT c.mission_id, json_extract(p.value, '$[0]'), json_extract(p.value, '$[1]')
			FROM member_completions c, json_each(c.signature, '$[3]') p
			WHERE json_extract(p.value, '$[1]') IN ('merged', 'closed')`);
	if (!db.all("PRAGMA table_info(artifact_links)").some((row) => row.name === "task_id")) {
		db.exec(`BEGIN;
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
	if (!db.all("PRAGMA table_info(artifact_links)").some((row) => row.name === "id")) {
		const columns =
			"mission_id, artifact_id, session_id, title, kind, revision, linked_by_session_id, linked_at, task_id";
		db.exec(`BEGIN;
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
	if (!db.all("PRAGMA table_info(notices)").some((row) => row.name === "chat_event"))
		db.exec("ALTER TABLE notices ADD COLUMN chat_event TEXT");
	db.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS artifact_link_scope ON artifact_links(mission_id, artifact_id, COALESCE(task_id, ''))",
	);
	if (!db.all("PRAGMA table_info(resources)").some((row) => row.name === "task_id"))
		db.exec("ALTER TABLE resources ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL");
	db.exec(
		"CREATE INDEX IF NOT EXISTS resources_by_linear_task ON resources(mission_id, task_id) WHERE kind = 'linear.issue'",
	);
	if (!db.all("PRAGMA table_info(resources)").some((row) => row.name === "pull_request"))
		db.exec("ALTER TABLE resources ADD COLUMN pull_request TEXT");
	if (!db.all("PRAGMA table_info(resources)").some((row) => row.name === "relationship"))
		db.transaction(() => {
			db.exec("ALTER TABLE resources ADD COLUMN relationship TEXT NOT NULL DEFAULT 'reference'");
			db.exec("UPDATE resources SET relationship = 'ownership' WHERE kind = 'github.pr' AND task_id IS NOT NULL");
		});
	db.transaction(() => {
		if (!db.all("PRAGMA table_info(resources)").some((row) => row.name === "linear_role")) {
			db.exec("ALTER TABLE resources ADD COLUMN linear_role TEXT; ALTER TABLE resources ADD COLUMN linear_key TEXT");
			// No existing link acquires lifecycle authority. Delegated task state is deliberately untouched.
			for (const row of db.all("SELECT id, url FROM resources WHERE kind = 'linear.issue'"))
				db.run(
					"UPDATE resources SET linear_role = 'reference', linear_key = ? WHERE id = ?",
					linearKey(str(row.url!)) ?? null,
					row.id!,
				);
		}
		db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS linear_ticket_manager ON resources(linear_key)
			WHERE linear_role = 'managed';
			CREATE UNIQUE INDEX IF NOT EXISTS linear_task_contribution ON resources(mission_id, task_id, linear_key)
			WHERE linear_role = 'contribution';`);
		db.exec("CREATE INDEX IF NOT EXISTS resources_by_linear_key ON resources(mission_id, linear_key, task_id)");
	});
	if (!db.all("PRAGMA table_info(missions)").some((row) => row.name === "passive_lifecycle"))
		db.exec("ALTER TABLE missions ADD COLUMN passive_lifecycle INTEGER NOT NULL DEFAULT 0");
	if (!db.all("PRAGMA table_info(tasks)").some((row) => row.name === "pr_sync_disabled"))
		db.exec("ALTER TABLE tasks ADD COLUMN pr_sync_disabled INTEGER NOT NULL DEFAULT 0");
	if (!db.all("PRAGMA table_info(resources)").some((row) => row.name === "linear_sync"))
		db.exec("ALTER TABLE resources ADD COLUMN linear_sync TEXT");
	db.exec(`CREATE TABLE IF NOT EXISTS linear_sync_dirty (
		resource_id TEXT PRIMARY KEY, structural INTEGER NOT NULL DEFAULT 0, reopened INTEGER NOT NULL DEFAULT 0);
		CREATE INDEX IF NOT EXISTS resources_by_managed_linear ON resources(id) WHERE linear_role = 'managed';
		CREATE INDEX IF NOT EXISTS managed_linear_by_mission ON resources(mission_id,created_at,id) WHERE linear_role='managed';
		CREATE UNIQUE INDEX IF NOT EXISTS resources_by_linear_uuid ON resources(json_extract(linear_sync,'$.status.issueId')) WHERE linear_role='managed';
		CREATE INDEX IF NOT EXISTS resources_by_contributing_task ON resources(task_id,linear_key,mission_id) WHERE linear_role='contribution';
		CREATE INDEX IF NOT EXISTS linear_sync_attention_order ON resources(mission_id,created_at,id)
			WHERE linear_role='managed' AND json_extract(linear_sync, '$.status.state') IN ('paused', 'error');
		CREATE TRIGGER IF NOT EXISTS linear_sync_task AFTER UPDATE OF status ON tasks
		WHEN OLD.status <> NEW.status BEGIN
			INSERT OR IGNORE INTO linear_sync_dirty(resource_id) SELECT m.id FROM resources c JOIN resources m
			ON m.mission_id=c.mission_id AND m.linear_key=c.linear_key AND m.linear_role='managed'
			WHERE c.task_id=NEW.id AND c.linear_role='contribution';
			UPDATE linear_sync_dirty SET reopened=1 WHERE OLD.status IN ('done','dropped')
			AND NEW.status NOT IN ('done','dropped') AND resource_id IN (SELECT m.id FROM resources c JOIN resources m
			ON m.mission_id=c.mission_id AND m.linear_key=c.linear_key AND m.linear_role='managed'
			WHERE c.task_id=NEW.id AND c.linear_role='contribution'); END;
		CREATE TRIGGER IF NOT EXISTS linear_sync_task_delete BEFORE DELETE ON tasks BEGIN
			INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) SELECT m.id,1 FROM resources c JOIN resources m
			ON m.mission_id=c.mission_id AND m.linear_key=c.linear_key AND m.linear_role='managed'
			WHERE c.task_id=OLD.id AND c.linear_role='contribution'; END;
		CREATE TRIGGER IF NOT EXISTS linear_sync_insert AFTER INSERT ON resources
		WHEN NEW.linear_role IN ('managed','contribution') BEGIN
			INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) SELECT id,1 FROM resources
			WHERE mission_id=NEW.mission_id AND linear_key=NEW.linear_key AND linear_role='managed'; END;
		CREATE TRIGGER IF NOT EXISTS linear_sync_delete AFTER DELETE ON resources
		WHEN OLD.linear_role IN ('managed','contribution') BEGIN
			INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) SELECT id,1 FROM resources
			WHERE mission_id=OLD.mission_id AND linear_key=OLD.linear_key AND linear_role='managed'; END;
		CREATE TRIGGER IF NOT EXISTS linear_sync_role AFTER UPDATE OF linear_role,task_id,linear_key ON resources BEGIN
			INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) VALUES(NEW.id,1);
			INSERT OR REPLACE INTO linear_sync_dirty(resource_id,structural) SELECT id,1 FROM resources WHERE mission_id=NEW.mission_id
			AND linear_key IN (OLD.linear_key,NEW.linear_key) AND linear_role='managed'; END;`);
	// Existing managed links start with a baseline, never an inferred completion.
	db.transaction(() => {
		db.run(
			"INSERT OR IGNORE INTO linear_sync_dirty(resource_id) SELECT id FROM resources WHERE linear_role='managed' AND linear_sync IS NULL",
		);
		hooks.reconcileLinearSync();
	});
	db.exec(`CREATE INDEX IF NOT EXISTS resources_by_owned_pr ON resources(mission_id, created_at, id)
		WHERE kind = 'github.pr' AND relationship = 'ownership'`);
	if (!db.all("PRAGMA table_info(events)").some((row) => row.name === "is_user_note"))
		db.transaction(() => {
			db.exec("ALTER TABLE events ADD COLUMN is_user_note INTEGER NOT NULL DEFAULT 0");
			// Legacy updates mix authored notes with automatic goal/title edits. Exclude that known
			// automatic text; new writes use the marker so even identically worded notes are distinct.
			db.exec(`UPDATE events SET is_user_note = 1 WHERE session_id IS NULL AND
				(kind = 'handoff' OR (kind = 'update' AND (text <> 'Mission title or goal changed' OR health IS NOT NULL)))`);
		});
	db.exec(`CREATE INDEX IF NOT EXISTS user_notes_by_mission ON events (mission_id, id)
		WHERE is_user_note = 1`);
	installTaskDefinitionRevisions(db);
}

/** Safe after the profile preflight: the legacy tables must have no records. */
function retireRemoteSchema(db: MissionDatabase): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		assertLocalMissionDb(db.connection);
		for (const row of db.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'shared_*'"))
			db.exec(`DROP TRIGGER ${sqlIdentifier(str(row.name!))}`);
		dropEmptyRemoteTables(db.connection);
		if (db.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shared_task_definitions'"))
			db.exec("ALTER TABLE shared_task_definitions RENAME TO task_definition_revisions");
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function installTaskDefinitionRevisions(db: MissionDatabase): void {
	db.exec(`CREATE TABLE IF NOT EXISTS task_definition_revisions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
		INSERT OR IGNORE INTO task_definition_revisions SELECT id,1 FROM tasks;
		CREATE TRIGGER IF NOT EXISTS task_definition_insert BEFORE INSERT ON tasks BEGIN
			INSERT INTO task_definition_revisions VALUES(NEW.id,1); END;
		CREATE TRIGGER IF NOT EXISTS task_definition_update BEFORE UPDATE OF title,body,depends_on,decision_ids,preferred_model,preferred_thinking,status,phase_id,session_id,milestone,assignment ON tasks
		WHEN (OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body OR OLD.depends_on IS NOT NEW.depends_on
		OR OLD.decision_ids IS NOT NEW.decision_ids OR OLD.preferred_model IS NOT NEW.preferred_model OR OLD.preferred_thinking IS NOT NEW.preferred_thinking
		OR OLD.status IS NOT NEW.status OR OLD.phase_id IS NOT NEW.phase_id OR OLD.session_id IS NOT NEW.session_id OR OLD.milestone IS NOT NEW.milestone OR OLD.assignment IS NOT NEW.assignment)
		BEGIN UPDATE task_definition_revisions SET revision=revision+1 WHERE id=NEW.id; END;`);
}
