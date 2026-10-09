/** The `mission` tool: shared mission state, owned by pilotd and reached over the worker's IPC channel. */
import type { JsonValue } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export const MISSION_TOOL = "mission";

const MEMBER_ACTIONS = [
	"get",
	"brief",
	"update",
	"tasks",
	"task",
	"claim",
	"decide",
	"comment",
	"resolve",
	"attach",
	"link",
	"log",
] as const;
export const MISSION_ACTIONS = [...MEMBER_ACTIONS, "start", "send", "status"] as const;
export type MissionAction = (typeof MISSION_ACTIONS)[number];

/** Sends one call to pilotd and resolves with its JSON result. */
export type MissionCall = (action: MissionAction, args: Record<string, JsonValue>) => Promise<JsonValue>;

const taskStatus = StringEnum(["todo", "in_progress", "blocked", "in_review", "done", "dropped"] as const);

export function createMissionTool(call: MissionCall, coordinator = false): ToolDefinition {
	return defineTool({
		name: MISSION_TOOL,
		label: "Mission",
		description: `Read and update the mission this chat belongs to. Mission state is shared with the user and the other chats of the mission.
Actions:
- get: goal, decisions, your tasks, open tasks, open comments, links, artifacts, recent activity and the brief's revision and outline. Call it before starting work and before handing off.
- brief: read the brief (optionally an older revision). With markdown and expectedRevision, replace the whole brief; a stale expectedRevision fails, so re-read and reapply your change.
- update: change the mission title or goal.
- tasks: list every task. task: create one (title, optional body, status, milestone, dependsOn) or, with id, update one. Tasks are referenced by ID or number (#3).
- claim: take a task for this chat. Tasks claimed by another chat cannot be taken.
- decide: record a decision. Decisions override the brief; only the user changes them later.
- comment: comment on the brief (text, optional anchor quote and targetSessionId). resolve: resolve a comment by id.
- attach: link one of this chat's artifacts (artifactId, optional artifactRevision to pin).
- link: link an external resource by url (Linear, GitHub, Slack or any URL), with an optional title and taskId (task ID or number).
- log: post a short status update or, with kind "handoff", a handoff note for whoever continues the work (optional health).${
			coordinator
				? `
- start (coordinator only): start a new chat for an unclaimed task (id or number, optional message). Start chats only when the user asks.
- send (coordinator only): send message to targetSessionId, a member of this mission, as a follow-up (queued if busy).
- status (coordinator only): summarize every member chat's state, latest outcome, archive status and assigned tasks without starting workers.`
				: ""
		}`,
		promptSnippet: "Read and update the shared mission: brief, tasks, decisions, comments, links and activity",
		executionMode: "sequential",
		annotations: { openWorldHint: false, destructiveHint: false },
		parameters: Type.Object({
			action: StringEnum(coordinator ? MISSION_ACTIONS : MEMBER_ACTIONS),
			id: Type.Optional(
				Type.String({
					maxLength: 128,
					description: coordinator
						? "Task ID or number (task, claim, start), or comment ID (resolve)."
						: "Task ID or number (task, claim), or comment ID (resolve).",
				}),
			),
			markdown: Type.Optional(Type.String({ maxLength: 262144, description: "Complete replacement brief." })),
			expectedRevision: Type.Optional(Type.Integer({ minimum: 0, description: "Brief revision you edited." })),
			revision: Type.Optional(Type.Integer({ minimum: 1, description: "Brief revision to read." })),
			title: Type.Optional(Type.String({ maxLength: 200 })),
			goal: Type.Optional(Type.String({ maxLength: 4000 })),
			body: Type.Optional(Type.String({ maxLength: 8000, description: "Task details." })),
			status: Type.Optional(taskStatus),
			milestone: Type.Optional(Type.String({ maxLength: 200 })),
			dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { description: "Task IDs or numbers." })),
			text: Type.Optional(Type.String({ maxLength: 8000, description: "Decision, comment or log text." })),
			anchor: Type.Optional(
				Type.String({ maxLength: 8000, description: "Quoted brief excerpt a comment refers to." }),
			),
			targetSessionId: Type.Optional(
				Type.String({
					maxLength: 128,
					description: coordinator ? "Member chat for comment or send." : "Member chat for comment.",
				}),
			),
			...(coordinator
				? {
						message: Type.Optional(
							Type.String({
								maxLength: 8000,
								description: "Opening instructions (start) or message to send (send).",
							}),
						),
					}
				: {}),
			artifactId: Type.Optional(Type.String({ maxLength: 128 })),
			artifactRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			url: Type.Optional(Type.String({ maxLength: 2048 })),
			taskId: Type.Optional(Type.String({ maxLength: 128, description: "Task ID or number for link." })),
			kind: Type.Optional(StringEnum(["update", "handoff"] as const)),
			health: Type.Optional(StringEnum(["on_track", "at_risk", "off_track"] as const)),
		}),
		async execute(_callId, params, signal): Promise<AgentToolResult<JsonValue>> {
			signal?.throwIfAborted();
			const { action, ...rest } = params;
			const args = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Record<
				string,
				JsonValue
			>;
			const data = await call(action, args);
			return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
		},
	});
}
