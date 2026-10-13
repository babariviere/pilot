/** External text is untrusted. Tracking never starts agents or writes to external services. */
export type TrackedKind = "linear" | "slack";
export type TrackingJson = null | boolean | number | string | TrackingJson[] | { [key: string]: TrackingJson };

export interface ProjectTrackingConfig {
	slackChannels: string[];
	/** Empty string in a settings request clears the team. */
	linearTeam?: string;
}
export interface TrackedItem {
	id: string;
	projectId: string;
	kind: TrackedKind;
	externalId: string;
	title: string;
	url: string;
	status: string;
	metadata: Record<string, TrackingJson>;
	dismissed: boolean;
	sessionId?: string;
	missionId?: string;
	createdAt: number;
	updatedAt: number;
}
/** Local actions only; null clears a link. Source refreshes never overwrite these fields. */
export interface TrackedItemPatch {
	dismissed?: boolean;
	sessionId?: string | null;
	missionId?: string | null;
}
/** GET /api/tracked-items?projectId=...&kind=...&dismissed=true&limit=...&offset=... */
export interface TrackedItemList {
	items: TrackedItem[];
	total: number;
}
export type SourceStatus = "not_configured" | "idle" | "ok" | "syncing" | "sign_in_required" | "error";
/** Progress covers only my issues, never the team's overall workload. */
export interface LinearCycleSummary {
	id: string;
	name?: string;
	number: number;
	startsAt: string;
	endsAt: string;
	progress: number;
	total: number;
	done: number;
	inProgress: number;
	todo: number;
}
export interface LinearSourceSummary {
	cycleStatus: "current" | "no_active_cycle";
	currentCycle?: LinearCycleSummary;
	statusMessage?: string;
}
/** GET /api/tracked-items/:id/prefill. Transient, never bulk-stored or broadcast. */
export interface TrackedItemPrefill {
	itemId: string;
	identifier: string;
	title: string;
	url: string;
	description: string;
	gitBranchName?: string;
	/** Explicitly quoted external content. User confirmation is required before starting work. */
	prompt: string;
}
export interface TrackingSource {
	/** Stable project-scoped identifier, <projectId>:<kind>. */
	id: string;
	projectId: string;
	kind: TrackedKind;
	label: string;
	configured: boolean;
	status: SourceStatus;
	lastPolledAt?: number;
	error?: string;
	signInCommand?: string;
	nextPollAt?: number;
	linear?: LinearSourceSummary;
}
