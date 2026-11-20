/** Personal project hooks, stored by the daemon, never in a repository. */
export type AutomationTrigger = "workspace.created" | "workspace.restored" | "run.finished";

export interface ProjectAutomations {
	revision: number;
	/** Ordered, at most 32. Empty when a saved definition is invalid. */
	items: Automation[];
	/** Optional for compatibility with hook-only clients. */
	flows?: AgentFlow[];
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
	/** Omission preserves saved flows. */
	flows?: AgentFlow[];
}

export type FlowOutcome = "done" | "approved" | "changes_requested" | "failed";

export interface FlowNode {
	id: string;
	mode: "build" | "ask";
	prompt: string;
	model?: string;
	thinking?: string;
	edges: Partial<Record<Exclude<FlowOutcome, "failed">, string>>;
}

export interface AgentFlow {
	id: string;
	name: string;
	enabled: boolean;
	nodes: FlowNode[];
	loop?: { from: string; to: string; maxRounds: number };
}

export interface FlowStartRequest {
	requestId: string;
	expectedRevision: number;
	flowId: string;
	message: string;
}

export interface FlowProgress {
	rootSessionId: string;
	flowId: string;
	name: string;
	nodeId: string;
	sessionId: string;
	round: number;
	maxRounds: number;
	state: "running" | "waiting" | "completed" | "failed" | "cancelled";
	reason?: string;
}

export interface AutomationRunRecord {
	id: string;
	automationId: string;
	name: string;
	definitionRevision: number;
	trigger: AutomationTrigger | "manual";
	state: "waiting" | "running" | "ok" | "failed" | "timed_out" | "cancelled" | "interrupted" | "skipped";
	attempt: number;
	exitCode?: number;
	reason?: string;
	startedAt?: number;
	endedAt?: number;
	excerpt: string;
}
