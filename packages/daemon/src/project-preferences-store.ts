/** Small project choices share MissionStore's transaction, disk replica and durability boundary. */
import { createHash } from "node:crypto";
import type {
	ProjectPreferenceAuthor,
	ProjectPreferenceSource,
	ProjectPreferences,
	ProjectPreferencesHistory,
	ProjectPreferencesOperation,
	ProjectPreferencesWrite,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON } from "./operation-journal.ts";
import type { KnowledgeDb } from "./project-knowledge-store.ts";

type PreferencesDb = Pick<KnowledgeDb, "all" | "one" | "run" | "transaction">;

export const PROJECT_PREFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS project_preferences_revisions (
 project_id TEXT NOT NULL, revision INTEGER NOT NULL,
 operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, snapshot TEXT NOT NULL,
 PRIMARY KEY(project_id, revision), UNIQUE(project_id, operation_id)
);
`;

export const PROJECT_PREFERENCES_LIMITS = { entries: 16, textBytes: 512, revisionBytes: 8192, history: 20 } as const;
export class InvalidProjectPreferences extends Error {}

export class ProjectPreferencesStore {
	private readonly db: PreferencesDb;
	constructor(db: PreferencesDb) {
		this.db = db;
	}

	get(projectId: string): ProjectPreferences {
		const row = this.db.one(
			"SELECT snapshot FROM project_preferences_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1",
			projectId,
		);
		return row ? JSON.parse(String(row.snapshot)) : { projectId, revision: 0, entries: [] };
	}

	lookup(projectId: string, operationId: string): ProjectPreferencesOperation {
		const row = this.db.one(
			"SELECT request_hash,snapshot FROM project_preferences_revisions WHERE project_id=? AND operation_id=?",
			projectId,
			operationId,
		);
		return row
			? {
					state: "committed",
					operationId,
					requestHash: String(row.request_hash),
					snapshot: JSON.parse(String(row.snapshot)),
				}
			: { state: "unknown", operationId };
	}

	history(projectId: string, before: number, limit: number): ProjectPreferencesHistory {
		const rows = this.db.all(
			"SELECT snapshot FROM project_preferences_revisions WHERE project_id=? AND revision<? ORDER BY revision DESC LIMIT ?",
			projectId,
			before,
			limit + 1,
		);
		const revisions: ProjectPreferences[] = rows.slice(0, limit).map((row) => JSON.parse(String(row.snapshot)));
		return { revisions, more: rows.length > limit, before: rows.length > limit ? revisions.at(-1)!.revision : null };
	}

	/** A locator to human-authored evidence, not a permission/consent projection from decision authorship. */
	humanNote(missionId: string, eventId: number): string | undefined {
		const row = this.db.one(
			"SELECT text FROM events WHERE mission_id=? AND id=? AND is_user_note=1 AND session_id IS NULL",
			missionId,
			eventId,
		);
		return row ? String(row.text) : undefined;
	}

	write(
		projectId: string,
		write: ProjectPreferencesWrite,
		author: ProjectPreferenceAuthor,
		source: ProjectPreferenceSource,
	): Extract<ProjectPreferencesOperation, { state: "committed" }> {
		return this.db.transaction(() => {
			if (this.lookup(projectId, write.operationId).state === "committed")
				throw new Conflict("Preference operation already exists. Look up its exact receipt; do not resend.");
			const current = this.get(projectId);
			if (current.revision !== write.expectedRevision)
				throw new Conflict("Project preferences changed. Read the current revision.");
			const now = Date.now();
			const entries = write.entries.map(({ id, text }) => {
				const previous = current.entries.find((entry) => entry.id === id);
				return previous?.text === text ? previous : { id, text, author, source, recordedAt: now };
			});
			const snapshot: ProjectPreferences = {
				projectId,
				revision: current.revision + 1,
				entries,
				updatedAt: now,
				author,
				source,
				reason: write.reason,
			};
			if (Buffer.byteLength(JSON.stringify(snapshot)) > PROJECT_PREFERENCES_LIMITS.revisionBytes)
				throw new InvalidProjectPreferences("Project preference revision exceeds 8 KiB, including provenance");
			const requestHash = createHash("sha256")
				.update(canonicalJSON({ projectId, ...write, author, source }))
				.digest("hex");
			this.db.run(
				"INSERT INTO project_preferences_revisions(project_id,revision,operation_id,request_hash,snapshot) VALUES(?,?,?,?,?)",
				projectId,
				snapshot.revision,
				write.operationId,
				requestHash,
				JSON.stringify(snapshot),
			);
			return { state: "committed", operationId: write.operationId, requestHash, snapshot };
		});
	}
}
