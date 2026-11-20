import type { ProjectTrackingConfig } from "./tracking.ts";

/** A named working directory. Sessions and triggers belong to projects. */
export interface Project {
	/** Native local registration receipt. Host-owned, not an editable setting. */
	registration?: { operationId: string; payloadHash: string };
	/** Native local setup policy. Host-owned; absent on legacy projects. */
	sourceCopy?: "jj" | "folder";
	id: string;
	name: string;
	/** Absolute, existing directory. */
	path: string;
	/** Default model for new sessions, "provider/modelId". */
	model?: string;
	/**
	 * Set once the user ticks or unticks a work profile here. From then on `allowedProfiles` is exactly the allowed
	 * list, so a profile added later is off. Until then every profile that is not opt-in only is allowed.
	 * A project never forces one profile on its chats.
	 */
	profilesEdited?: true;
	/** With `profilesEdited`: the IDs of the work profiles allowed in this project. */
	allowedProfiles?: string[];
	/** Host-owned: turns a provider blocked as cyber work in this project's chats. */
	cyberBlocks?: number;
	/** Host-owned: the user answered Not now to "Allow Cyber work in this project?". */
	cyberSuggestionDismissed?: boolean;
	/** "clone" (default): each session works in a private clone. "direct": in `path` itself. */
	workspace?: WorkspaceMode;
	/** Require branch/PR delivery. Defaults to true; false permits direct default-branch pushes. */
	requirePullRequest?: boolean;
	tracking?: ProjectTrackingConfig;
	/** Host-owned generation for diagnostic configuration fencing. Never an editable project setting. */
	trackingGeneration?: string;
	/** Host-owned workflow configuration ABA fence. Never accepted from project requests. */
	workflowGeneration?: string;
	/** Environment profile. Edited through PUT /api/projects/:id/environment, never through project updates. */
	environment?: import("./environment.ts").ProjectEnvironment;
	/** Personal hooks. Writes require the native automations endpoint. */
	automations?: import("./automations.ts").ProjectAutomations;
	/** This host's own environment layer, never synced. Edited through PUT /api/projects/:id/environment/override. */
	environmentOverride?: import("./environment.ts").ProjectEnvironmentOverride;
	/** Other projects whose read-only main view this project's chats may read. Project IDs, in the user's order. */
	linkedProjects?: string[];
	createdAt: number;
}

export type WorkspaceMode = "clone" | "direct";

/** GET /api/projects/:id/github. Resolved on demand by GitHub CLI on the project's host. */
export interface ProjectGitHubRepository {
	url: string;
}

/** GET /api/projects/:id/origin. Sanitized local-config identity only; null requires manual matching. */
export interface ProjectOrigin {
	identity: string | null;
}

/** GET /api/projects/:id/branches. Live origin heads only; mode=ask or workspace=clone also allows direct projects. */
export interface RemoteBranchList {
	/** Exact origin head names, sorted lexically. No remote-tracking prefix is added; HEAD is excluded. */
	branches: string[];
	/** Origin's symbolic HEAD, when it names an advertised branch. */
	defaultBranch?: string;
}

/** POST /api/projects, PATCH /api/projects/:id (partial). An empty model clears it. */
export interface ProjectRequest {
	path: string;
	name?: string;
	model?: string;
	workspace?: WorkspaceMode;
	requirePullRequest?: boolean;
	tracking?: ProjectTrackingConfig;
	/** Replaces the linked project list. An empty list removes every link. */
	linkedProjects?: string[];
}
