/** External text is untrusted. Tracking never starts agents or writes to external services. */
export type TrackedKind = "linear" | "slack";
export type TrackingJson = null | boolean | number | string | TrackingJson[] | { [key: string]: TrackingJson };

/** Logical tool names are adapter-defined (issues, history, thread). Use raw MCP tool names. */
export interface SourceMcpConfig {
	server: string;
	tools: Record<string, string>;
	/** Optional dispatcher, e.g. CALL_TOOL on a unified server. */
	dispatchTool?: string;
}
export interface ProjectTrackingConfig {
	slackChannels: string[];
	/** Empty string in a settings request clears the team. */
	linearTeam?: string;
	mcp?: Partial<Record<TrackedKind, SourceMcpConfig>>;
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
	mcp: SourceMcpConfig;
	lastPolledAt?: number;
	error?: string;
	signInCommand?: string;
}
