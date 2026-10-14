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
export const MISSION_ACTIONS = [
	...MEMBER_ACTIONS,
	"delete",
	"group",
	"start",
	"send",
	"status",
	"bindPr",
	"unbindPr",
] as const;
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
- get: goal, decisions, your tasks, open tasks, open comments, links, artifacts, recent user updates and handoffs (separate from recent activity), and the brief's revision and outline. Call it before starting work and before handing off.
- brief: read the brief (optionally an older revision). With markdown and expectedRevision, replace the whole brief; a stale expectedRevision fails, so re-read and reapply your change.
- update: change the mission title or goal.
- tasks: list every task. task: create one (title, optional body, status, milestone, dependsOn) or, with id, update one. Tasks are referenced by ID or number (#3). Use status "dropped" to retire work while keeping its history.
- claim: take tasks for this chat. Use id for one task or ids for several IDs, numbers or ranges (for example ["1-5", "#8"]). A range or comma-separated list also works in id. Batch results contain claimed tasks and skipped tasks with reasons (owned by another chat or not found); other chats' tasks are never taken.
- decide: record a decision. Decisions override the brief; only the user changes them later.
- comment: comment on the brief (text, optional anchor quote and targetSessionId). resolve: resolve a comment by id.
- attach: link one of this chat's artifacts (artifactId, optional artifactRevision to pin, optional taskId).
- link: link an external resource by url (Linear, GitHub, Slack or any URL), with an optional title and taskId (task ID or number). A resource link does not bind a PR to a chat.
- log: post a short status update or, with kind "handoff", a handoff note for whoever continues the work (optional health).${
			coordinator
				? `
- delete (coordinator only): permanently remove a task by id or number. Removes dependency references and keeps its links at mission level. Prefer status "dropped" when history should remain.
- group (coordinator only): set milestone on every task selected by ids (IDs, numbers or ranges such as ["1-5", "#8"]). Use milestone "" to clear the group. All references must exist; the batch is atomic.
- task order (coordinator only): set order when creating or updating a task to reorder it. Read tasks for current sort keys. Lower numbers sort first; fractional keys are allowed; ties sort by task number. Numbers and dependencies do not change.
- start (coordinator only): start a new chat for an unclaimed task (id or number, optional message, model, thinking, artifacts [{artifactId, revision?}], links [{url, title?}]). Model defaults to the project's default. Allowed models are the project's scoped models within the price cap; start validation errors list allowed model IDs, prices and supported thinking levels. Choose cheaper models for small tasks and the strongest allowed model for hard ones. Thinking must be supported by the chosen model. Artifacts must already be linked to the mission or owned by a member chat. References are attached to the task before starting, so later chats see them too. The opening message lists references without pasting content and must fit 4000 characters including the task body. Durable context belongs in the brief, decisions or task links. Start chats only when the user asks.
- send (coordinator only): send message to targetSessionId, a member of this mission, as a follow-up (queued if busy).
- status (coordinator only): summarize every member chat's state, latest outcome, archive status and assigned tasks without starting workers.
- bindPr (coordinator only): bind an existing GitHub PR by url to targetSessionId, a member chat of this mission, without changing its branches. The bound chat owns the PR head for follow-ups and pushes. One owner per PR: binding transfers ownership from the previous chat and moves unfinished task links to the selected task. Use taskId (task ID or number) when the owning task is ambiguous. Use resource links for dependencies or references, not ownership.
- unbindPr (coordinator only): detach a PR from targetSessionId by url to stop its tracking, follow-ups and pushes for that chat. Suppresses rediscovery and clears unfinished task links. Repository branches and mission-level references stay unchanged.`
				: ""
		}`,
		promptSnippet: "Read and update the shared mission: brief, tasks, decisions, comments, links and activity",
		executionMode: "sequential",
		annotations: { openWorldHint: false, destructiveHint: coordinator },
		parameters: Type.Object({
			action: StringEnum(coordinator ? MISSION_ACTIONS : MEMBER_ACTIONS),
			id: Type.Optional(
				Type.String({
					maxLength: 128,
					description: coordinator
						? "Task ID or number (task, claim, delete, start), or comment ID (resolve). For claim, also accepts ranges or comma-separated numbers. Use id or ids, not both."
						: "Task ID or number (task, claim), or comment ID (resolve). For claim, also accepts ranges or comma-separated numbers. Use id or ids, not both.",
				}),
			),
			ids: Type.Optional(
				Type.Array(Type.Union([Type.String({ maxLength: 128 }), Type.Integer({ minimum: 1 })]), {
					minItems: 1,
					maxItems: 1000,
					description: coordinator
						? "For claim or group: task IDs, numbers or inclusive ascending ranges such as 1-5 (at most 1000 expanded references). Claim returns claimed and skipped; group requires every task to exist. Use instead of id."
						: "For claim only: task IDs, numbers or inclusive ascending ranges such as 1-5 (at most 1000 expanded references). Returns claimed and skipped. Use instead of id.",
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
					description: coordinator
						? "Member chat for comment, send, bindPr or unbindPr."
						: "Member chat for comment.",
				}),
			),
			...(coordinator
				? {
						order: Type.Optional(
							Type.Number({
								description: "Task sort key (task): lower first, ties by task number. Fractions allowed.",
							}),
						),
						model: Type.Optional(
							Type.String({
								maxLength: 256,
								description:
									"For start: scoped provider/modelId within the price cap. Omit for the project's default. Errors list allowed models.",
							}),
						),
						thinking: Type.Optional(
							Type.String({
								maxLength: 32,
								description:
									"For start: a thinking level supported by the chosen model. Omit for its configured default.",
							}),
						),
						artifacts: Type.Optional(
							Type.Array(
								Type.Object({
									artifactId: Type.String({ maxLength: 128 }),
									revision: Type.Optional(Type.Integer({ minimum: 1 })),
								}),
								{ maxItems: 40, description: "Artifact references for start, saved on the task." },
							),
						),
						links: Type.Optional(
							Type.Array(
								Type.Object({
									url: Type.String({ maxLength: 2048 }),
									title: Type.Optional(Type.String({ maxLength: 200 })),
								}),
								{ maxItems: 40, description: "Link references for start, saved on the task." },
							),
						),
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
			taskId: Type.Optional(
				Type.String({
					maxLength: 128,
					description: coordinator
						? "Task ID or number for link, attach or bindPr (owning task disambiguation)."
						: "Task ID or number for link or attach.",
				}),
			),
			kind: Type.Optional(StringEnum(["update", "handoff"] as const)),
			health: Type.Optional(StringEnum(["on_track", "at_risk", "off_track"] as const)),
		}),
		// The daemon owns the action-specific result shapes; every action returns a JSON object.
		outputSchema: Type.Record(Type.String(), Type.Unknown()),
		async execute(_callId, params, signal): Promise<AgentToolResult<JsonValue>> {
			signal?.throwIfAborted();
			const { action, ...rest } = params;
			const args = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Record<
				string,
				JsonValue
			>;
			const data = await call(action, args);
			return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, structuredContent: data };
		},
	});
}
