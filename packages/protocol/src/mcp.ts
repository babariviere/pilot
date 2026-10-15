/**
 * The user's global pi MCP servers (~/.pi/agent/mcp.json), as pilotd last found them. pilotd connects to each
 * enabled server off its event loop at startup, when mcp.json or mcp-auth.json changes, and on request. Chats
 * keep their own connections; this is the shared view of whether a server works or needs the user.
 * Never carries server output, configuration values or credentials.
 */
/** unknown: pilotd cannot check it (a server signing in with a model provider login); see `problem`. */
export type McpServerState = "connected" | "needs_sign_in" | "failed" | "unknown" | "disabled";

export interface McpSignInState {
	/** waiting: the browser was opened (or is about to be) and pilotd waits for approval. */
	state: "waiting" | "done" | "failed" | "cancelled";
	/** Sign in again while signed in (another account or new scope). */
	again?: boolean;
	startedAt: number;
	/** When a waiting sign-in gives up. */
	expiresAt: number;
	finishedAt?: number;
	/** Short, sanitized reason for a failed sign-in. */
	error?: string;
}

export interface McpServerStatus {
	/** Name in mcp.json. Chats reach it as the `mcp__<name>` namespace. */
	name: string;
	transport: "stdio" | "http";
	state: McpServerState;
	/** Connected servers: tools offered. */
	tools?: number;
	/** Failed or unknown servers: one short, fixed sentence, never the server's own error text. */
	problem?: string;
	/** pilotd can run pi's browser sign-in for this server (HTTP with OAuth, no fixed headers). */
	canSignIn?: boolean;
	/** Epoch ms of the last finished check of this server. */
	checkedAt?: number;
	/** Latest browser sign-in started from Pilot, kept until the next one. */
	signIn?: McpSignInState;
}

/** GET /api/mcp, and the `mcp` message on /api/ws. Servers needing the user come first. */
export interface McpStatus {
	servers: McpServerStatus[];
	/** A check is running. Servers keep their last state until it finishes. */
	checking: boolean;
	/** Entries in mcp.json that pi rejects. Run `pi mcp list` for details. */
	configProblems?: number;
}

/**
 * POST /api/mcp/check rechecks every server (or `server`) and returns the current status at once.
 * POST /api/mcp/servers/:name/sign-in starts (or returns the running) sign-in; DELETE cancels it.
 */
export interface McpCheckRequest {
	server?: string;
}
export interface McpSignInRequest {
	again?: boolean;
}
