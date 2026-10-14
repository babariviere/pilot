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
	"release",
	"decide",
	"decisions",
	"links",
	"artifacts",
	"comments",
	"activity",
	"comment",
	"resolve",
	"attach",
	"link",
	"unlink",
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
- get: compact goal/status/brief revision, your open tasks and references, other open tasks as [number,title,status,dependsOn?], and counts. Coordinator also gets member states, needs-you and PRs in review. No history. Read before work and handoff.
- links, artifacts: references, filtered by taskId and filter open (default), done or all.
- decisions: decisions not already in your prompt. Changes arrive as short notices; re-read, as current decisions supersede old prompt text.
- comments, activity: open comments or recent activity and user notes on demand.
- brief: read a revision, or replace with markdown and expectedRevision (stale writes fail).
- update: change the mission title or goal.
- tasks: list tasks, filter open (default), done or all, mine and milestone. task: id alone reads one full task; title creates one, other fields update it (body, status, milestone, dependsOn, decisionIds to pin decisions). Tasks are referenced by ID or number (#3). Use status "dropped" to retire work while keeping its history.
- claim: take id or ids (IDs, numbers or ranges such as ["1-5","#8"]). Returns claimed tasks and skipped tasks with reasons; never takes another chat's task.
- release: clear claims using the same selectors. Members release their own, coordinator any. Resets active/blocked to todo, preserves other states and links.
- decide: record a decision, audience all, coordinator or reference (default). Decisions override the brief; only the user changes them later.
- comment: comment on the brief (text, optional anchor quote and targetSessionId). resolve: resolve a comment by id.
- attach: link one of this chat's artifacts (artifactId, optional artifactRevision to pin, optional taskId).
- link: add url, optional title/taskId. Task PRs default to relationship "ownership" (drives status); "reference" is related work. Neither binds a chat.
- unlink: remove url at taskId (omitted: mission-level), own links only unless coordinator; prefers reference. Absent returns removed:false.
- log: post a short status update or, with kind "handoff", a handoff note for whoever continues the work (optional health).${
			coordinator
				? `
- delete (coordinator only): permanently remove a task by id or number. Removes dependency references and keeps its links at mission level. Prefer status "dropped" when history should remain.
- group (coordinator only): set milestone on every task selected by ids (IDs, numbers or ranges such as ["1-5", "#8"]). Use milestone "" to clear the group. All references must exist; the batch is atomic.
- task order (coordinator only): set order when creating or updating a task to reorder it. Read tasks for current sort keys. Lower numbers sort first; fractional keys are allowed; ties sort by task number. Numbers and dependencies do not change.
- start (coordinator only): start an unclaimed task (id, optional message/model/thinking/artifacts/links). References attach to the task; artifacts must be linked or member-owned. Opening text, task body and reference list must fit 4000 characters. Durable context belongs in the brief, decisions or task links. Model defaults to project; validation errors list allowed model IDs, prices and supported thinking levels. Pick cheaper models for small tasks, strongest allowed model for hard ones. Start only when asked.
- send (coordinator only): send message to member targetSessionId; wakes idle/paused chats, optional mode steer for corrections that change current work, followUp (default) for anything that can wait. Steer joins a running turn at its next step; either mode starts an idle chat. Returns delivery delivered/queued/rejected, mode and reason; restore archived chats first.
- status (coordinator only): summarize members: state, outcome, branch, compact PR states, tasks and finishedWithoutPR (idle claimed work lacking open/draft/merged PR). targetSessionId returns one member plus lastAssistantReply (1500 chars). Never starts workers. Status/start include cached read-only subscriptionUsage per provider (window percent/reset; stale or unknown labelled).
- bindPr (coordinator only): bind url to targetSessionId, optional taskId to disambiguate. Transfers sole PR-head ownership and unfinished ownership links. Returns {changed, previousOwner, taskLinkRemoved}; references never grant ownership.
- unbindPr (coordinator only): detach url from targetSessionId, stopping tracking/pushes/follow-ups and removing unfinished ownership links. References/branches stay. Returns {changed, previousOwner, taskLinkRemoved}.`
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
						? "Task ID or number (task, claim, release, delete, start), or comment ID (resolve). For claim or release, also accepts ranges or comma-separated numbers. Use id or ids, not both."
						: "Task ID or number (task, claim, release), or comment ID (resolve). For claim or release, also accepts ranges or comma-separated numbers. Use id or ids, not both.",
				}),
			),
			ids: Type.Optional(
				Type.Array(Type.Union([Type.String({ maxLength: 128 }), Type.Integer({ minimum: 1 })]), {
					minItems: 1,
					maxItems: 1000,
					description: coordinator
						? "For claim, release or group: task IDs, numbers or inclusive ascending ranges such as 1-5 (at most 1000 expanded references). Claim/release return claimed/released and skipped; group requires every task to exist. Use instead of id."
						: "For claim or release: task IDs, numbers or inclusive ascending ranges such as 1-5 (at most 1000 expanded references). Returns claimed/released and skipped. Use instead of id.",
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
			decisionIds: Type.Optional(
				Type.Array(Type.String({ maxLength: 128 }), {
					maxItems: 1000,
					description: "Task decision pins; [] clears.",
				}),
			),
			audience: Type.Optional(StringEnum(["all", "coordinator", "reference"] as const)),
			filter: Type.Optional(StringEnum(["open", "done", "all"] as const)),
			mine: Type.Optional(Type.Boolean({ description: "tasks: only your tasks." })),
			text: Type.Optional(Type.String({ maxLength: 8000, description: "Decision, comment or log text." })),
			anchor: Type.Optional(
				Type.String({ maxLength: 8000, description: "Quoted brief excerpt a comment refers to." }),
			),
			targetSessionId: Type.Optional(
				Type.String({
					maxLength: 128,
					description: coordinator
						? "Member chat for comment, send, status, bindPr or unbindPr."
						: "Member chat for comment.",
				}),
			),
			...(coordinator
				? {
						mode: Type.Optional(
							StringEnum(["steer", "followUp"] as const, {
								description: "For send: steer changes current work; followUp can wait (default).",
							}),
						),
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
			relationship: Type.Optional(
				StringEnum(["ownership", "reference"] as const, {
					description: "Link role: task PR ownership or related-work reference. Never binds a chat.",
				}),
			),
			url: Type.Optional(Type.String({ maxLength: 2048 })),
			taskId: Type.Optional(
				Type.String({
					maxLength: 128,
					description: coordinator
						? "Task ID or number for link, unlink, attach or bindPr (owning task disambiguation)."
						: "Task ID or number for link, unlink or attach.",
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
