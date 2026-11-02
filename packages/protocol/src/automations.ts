/** Personal project hooks, stored by the daemon, never in a repository. */
export type AutomationTrigger = "workspace.created" | "workspace.restored" | "run.finished";

export interface ProjectAutomations {
	revision: number;
	/** Ordered, at most 32. Empty when a saved definition is invalid. */
	items: Automation[];
	/** Invalid saved definitions are retained on disk but never executable. */
	error?: string;
}

export interface Automation {
	id: string;
	name: string;
	enabled: boolean;
	on: AutomationTrigger[];
	when?: AutomationConditions;
	action: AutomationAction;
}

export interface AutomationConditions {
	filesChanged?: true | { paths: string[] };
	openTodos?: true;
}

export type AutomationAction = ShellAction | FollowUpAction;

export interface ShellAction {
	type: "shell";
	run: { argv: string[] } | { shell: string };
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	onFailure?: "report" | "followUp";
	/** Reserved for environment setup; not accepted until requirement evaluation ships. */
	requires?: string[];
}

export interface FollowUpAction {
	type: "followUp";
	message?: string;
}

export interface ProjectAutomationsUpdateRequest {
	/** 0 when no definitions have been saved. */
	expectedRevision: number;
	items: Automation[];
}
