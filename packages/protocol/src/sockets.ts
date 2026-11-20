import type { ArtifactSummary } from "./artifacts.ts";
import type { AgentEvent } from "./chat-stream.ts";
import type { ProjectDashboard, ProjectDashboardCounts } from "./dashboard.ts";
import type { Mission, MissionDetail } from "./missions.ts";
import type { Project } from "./projects.ts";
import type { SessionSummary } from "./session.ts";
import type { TrackingSource } from "./tracking.ts";

/** Client to daemon, over /api/ws. */
export type ClientMessage =
	/** Receive `mission` details for one mission: the current detail first, then after every change. */
	| { type: "mission.subscribe"; missionId: string }
	| { type: "mission.unsubscribe"; missionId: string }
	/** Receive `dashboard` for one project: the current dashboard first, then whenever it changes. */
	| { type: "dashboard.subscribe"; projectId: string }
	| { type: "dashboard.unsubscribe"; projectId: string }
	/**
	 * The client is in the foreground showing these sessions (at most 50). The daemon rechecks their
	 * pull requests soon unless they were checked recently. Opening a chat socket implies the same.
	 */
	| { type: "focus"; sessionIds: string[] };

/** Daemon to client, over /api/ws and the dedicated sockets below (see their message types). */
export type ServerMessage =
	| { type: "diagnostics.next-control"; control: import("./telemetry.ts").NextDiagnosticsControl }
	| { type: "mission-catalog.changed" }
	/** Notice only: a screen agent request waits for this Day window. Read it with GET /api/screen/requests. */
	| { type: "screen.requested"; windowId: string }
	/** Invalidation only: a planning coordinator's tool steps changed. Read the planning page again. */
	| { type: "planning.activity"; missionId: string }
	/** Invalidation only. Read the current checkpoint through authenticated GET /api/runtime-update. */
	| { type: "runtime-update.changed" }
	| { type: "power"; power: import("./power.ts").PowerStatus }
	| { type: "mcp"; mcp: import("./mcp.ts").McpStatus }
	| { type: "pi.reload"; reload: import("./pi-reload.ts").PiReloadStatus }
	| import("./schedules.ts").SchedulesMessage
	/** Includes both active and archived sessions, so clients can switch views locally. */
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "session"; session: SessionSummary }
	| { type: "projects"; projects: Project[] }
	| { type: "sources"; sources: TrackingSource[] }
	/** Invalidation only; clients fetch a bounded list. Dashboards use their existing subscription. */
	| { type: "tracked.changed"; projectId: string }
	| { type: "artifacts"; sessionId: string; artifacts: ArtifactSummary[] }
	/** All missions, including done and archived ones, so clients can filter locally. */
	| { type: "missions"; missions: Mission[] }
	/** Full detail for a subscribed mission, on subscription and after every change. */
	| { type: "mission"; mission: MissionDetail }
	/** A subscribed project's dashboard, on subscription and after every change that alters it. */
	| { type: "dashboard"; dashboard: ProjectDashboard }
	/** Sidebar counts for every project, on connection and whenever they change. */
	| { type: "dashboard.counts"; counts: ProjectDashboardCounts }
	/** A chat stream's batches, numbered from 1 for resuming. A new stream's first batch holds a snapshot. */
	| { type: "events"; sessionId: string; events: AgentEvent[]; seq: number }
	/**
	 * First frame on every chat socket connection. `resumed`: the frames after the requested `after` follow. Otherwise
	 * this is a new stream and its first batch holds a snapshot. Reconnect with `?stream=<streamId>&after=<last seq>`.
	 */
	| { type: "chat.stream"; sessionId: string; streamId: string; resumed: boolean }
	| { type: "terminal.data"; sessionId: string; data: string }
	| { type: "terminal.exit"; sessionId: string; code: number }
	| { type: "terminal.hello"; sessionId: string; bootId: string; terminalId?: string }
	| { type: "terminal.ready"; sessionId: string; terminalId: string }
	/** Replaces the transcript when it contains a snapshot (or is empty); otherwise appends entries. */
	| { type: "subagent.events"; sessionId: string; name: string; events: AgentEvent[] }
	| { type: "error"; sessionId?: string; name?: string; message: string };

/**
 * Dedicated sockets. Each has its own send queue, so one stream never delays another. Close codes in 4400–4499
 * are final (4404: unknown session or subagent, 4409: refused, for example a read-only session's terminal), so
 * clients do not reconnect. 1013 asks the client to reconnect (overload, or a temporary refusal such as a pending
 * update).
 *
 * Chat socket, /api/sessions/:id/ws[?stream=<id>&after=<seq>], one per open chat. Opening it subscribes and closing
 * it unsubscribes; clients send nothing. The first frame is `chat.stream`, then numbered `events` batches starting
 * with a snapshot, unless the stream resumed. Artifact index updates for the session are repeated here so they
 * stay ordered with the initial index.
 */
export type ChatServerMessage = Extract<ServerMessage, { type: "chat.stream" | "events" | "artifacts" | "error" }>;

/**
 * Terminal socket, /api/sessions/:id/terminal/ws?protocol=2&cols=<n>&rows=<n>.
 * Requires hello.capabilities.workspaceTerminalProtocol === 2. Receive terminal.hello, then send terminal.open
 * with its boot identity and a stable requestId (reuse after a lost reply). Existing terminalId fences reattach;
 * restart is an explicit open mutation. terminal.ready precedes bounded scrollback and live output.
 * Socket closure only detaches. terminal.close signals the matched shell; terminal.exit proves actual exit.
 */
export type TerminalServerMessage = Extract<
	ServerMessage,
	{ type: "terminal.data" | "terminal.exit" | "terminal.hello" | "terminal.ready" | "error" }
>;
export type TerminalSocketMessage =
	| { type: "terminal.open"; bootId: string; requestId: string; terminalId?: string; restart?: boolean }
	| { type: "terminal.input"; terminalId: string; data: string }
	| { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
	| { type: "terminal.close"; terminalId: string };

/**
 * Subagent socket, /api/sessions/:id/subagents/:name/ws. Streams one subagent's transcript: a snapshot first (also
 * after reconnects), then appended entries. Clients send nothing.
 */
export type SubagentServerMessage = Extract<ServerMessage, { type: "subagent.events" | "error" }>;
