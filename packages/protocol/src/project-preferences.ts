/** Small explicit project choices. These records never grant permissions or override runtime controls. */
export type ProjectPreferenceSource =
	| { type: "user" }
	| { type: "mission_note"; missionId: string; eventId: number; quote: string };

export type ProjectPreferenceAuthor = { type: "user" } | { type: "coordinator"; sessionId: string; missionId: string };

export interface ProjectPreference {
	id: string;
	text: string;
	source: ProjectPreferenceSource;
	author: ProjectPreferenceAuthor;
	recordedAt: number;
}

/** Revision zero is the empty state, not a stored default or inherited global setting. */
export interface ProjectPreferences {
	projectId: string;
	revision: number;
	entries: ProjectPreference[];
	updatedAt?: number;
	author?: ProjectPreferenceAuthor;
	source?: ProjectPreferenceSource;
	reason?: string;
}

/** PUT /api/projects/:id/preferences. Full list CAS; unchanged items keep their provenance.
 * 16 entries, 512 UTF-8 bytes per text, 8 KiB serialized revision. Native-authenticated HTTP derives user source/author.
 * Agent writes require a current coordinator and an exact existing human mission note citation.
 * Never resend after losing the ACK. Use the operation lookup, including after process restart.
 */
export interface ProjectPreferencesWrite {
	operationId: string;
	expectedRevision: number;
	entries: Array<Pick<ProjectPreference, "id" | "text">>;
	reason: string;
	source?: Extract<ProjectPreferenceSource, { type: "mission_note" }>;
}

export type ProjectPreferencesOperation =
	| { state: "committed"; operationId: string; requestHash: string; snapshot: ProjectPreferences }
	| { state: "unknown"; operationId: string };

/** GET .../preferences/history?before=<revision>&limit=20. Immutable, newest first, max 20. */
export interface ProjectPreferencesHistory {
	revisions: ProjectPreferences[];
	more: boolean;
	before: number | null;
}

/** Native generic operation kind project-preferences-update; targetId = projectId.
 * Native capability authentication is required. Accepted receipt.result is ProjectPreferences.
 * The outer exact receipt is required; a domain snapshot alone never proves native delivery.
 */
export interface ProjectPreferencesIntent {
	purpose: "project-preferences-update";
	projectId: string;
	expectedRevision: number;
	entries: Array<Pick<ProjectPreference, "id" | "text">>;
	reason: string;
}
