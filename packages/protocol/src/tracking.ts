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
}
