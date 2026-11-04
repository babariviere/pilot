import type { Automation, AutomationTrigger } from "@pilot/protocol";

export type WorkspaceSetupTrigger = Extract<AutomationTrigger, "workspace.created" | "workspace.restored"> | "manual";

/** One workspace setup boundary. Manual requests cannot overlap active work. */
export interface WorkspaceSetupState {
	trigger: WorkspaceSetupTrigger;
	triggerId: string;
	holdUntil: number;
	state: "pending" | "ok" | "failed" | "cancelled";
	detail?: string;
	/** Bounded definition snapshot and completion cursor, independent of the 20 retained results. */
	hooks: Automation[];
	definitionRevision: number;
	finished: Record<string, boolean>;
	participantDone?: boolean;
}

/** Generic pre-command participant, used by project environment setup when it ships. */
export interface WorkspaceSetupContext {
	sessionId: string;
	projectId: string;
	cwd: string;
	trigger: WorkspaceSetupTrigger;
	triggerId: string;
	signal: AbortSignal;
}

export const WORKSPACE_SETUP_HOLD_MS = 10 * 60_000;
