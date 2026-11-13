import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { InterviewWrite, PlanWrite } from "@pilot/protocol";
import { Type } from "typebox";
import type { MissionRevisionDelta } from "../../protocol/src/mission-revision.ts";

export interface NativePlanningPort {
	/** Bound to the current admitted mission/project/coordinator, never model-supplied IDs. */
	read(revision: number | undefined, signal?: AbortSignal): Promise<unknown>;
	knowledge(id: string, revision: number, signal?: AbortSignal): Promise<unknown>;
	/** Host resolves the retained full envelope in this mission. Status only, no handler re-entry. */
	receipt(operationId: string, signal?: AbortSignal): Promise<unknown>;
	/** Host owns durable envelope identity, retains it by callId, and never replays Unknown effects.
	 * Only MissionPlans operations, never interview-save/submit or worker admission. */
	write(callId: string, request: PlanWrite, signal?: AbortSignal): Promise<unknown>;
	revision?(
		callId: string,
		request: { purpose: "revision-propose"; source: string; summary: string; delta: MissionRevisionDelta },
		signal?: AbortSignal,
	): Promise<unknown>;
	questions?(
		callId: string,
		request: Extract<InterviewWrite, { purpose: "interview-questions" }>,
		signal?: AbortSignal,
	): Promise<unknown>;
}

/** Inject only from a trusted opted-in host. No production route or auto-enrollment. */
export function createMissionPlanTool(port: NativePlanningPort): ToolDefinition {
	const key = Type.String({ minLength: 1, maxLength: 128 });
	const sources = Type.Array(
		Type.Union([
			Type.Object({ kind: Type.Literal("decision"), id: key, digest: key }, { additionalProperties: false }),
			Type.Object(
				{
					kind: Type.Literal("knowledge"),
					id: key,
					revision: Type.Integer({ minimum: 1 }),
					linkRevision: Type.Integer({ minimum: 1 }),
				},
				{ additionalProperties: false },
			),
		]),
		{ maxItems: 40 },
	);
	const option = Type.Object({ id: key, meaning: Type.String() }, { additionalProperties: false });
	const prototype = Type.Object(
		{
			context: Type.String(),
			experimentType: Type.Union([Type.Literal("logic-state"), Type.Literal("ui")]),
			smallestExperiment: Type.String(),
			maxMinutes: Type.Integer({ minimum: 1, maximum: 480 }),
			maxCostUsd: Type.Number({ minimum: 0, maximum: 10 }),
		},
		{ additionalProperties: false },
	);
	const question = Type.Object(
		{
			id: key,
			title: Type.String(),
			question: Type.String(),
			kind: Type.Union([Type.Literal("human"), Type.Literal("research"), Type.Literal("prototype")]),
			prototype: Type.Optional(prototype),
			options: Type.Array(option),
			recommendedOptionId: Type.Union([key, Type.Null()]),
			dependsOn: Type.Array(key),
			sources,
		},
		{ additionalProperties: false },
	);
	const fog = Type.Object(
		{
			id: key,
			area: Type.String(),
			why: Type.String(),
			readyWhen: Type.String(),
			dependsOn: Type.Array(key),
			sources,
		},
		{ additionalProperties: false },
	);
	const spec = Type.Object(
		{
			problem: Type.String(),
			solution: Type.String(),
			stories: Type.Array(Type.Object({ id: key, text: Type.String() }, { additionalProperties: false })),
			implementation: Type.Array(Type.String()),
			testing: Type.Array(Type.String()),
			exclusions: Type.Array(Type.String()),
		},
		{ additionalProperties: false },
	);
	const slice = Type.Object(
		{
			id: key,
			title: Type.String(),
			outcome: Type.String(),
			acceptance: Type.Array(Type.String()),
			storyIds: Type.Array(key),
			dependsOn: Type.Array(key),
			owners: Type.Array(Type.Union([Type.Literal("opus-ui"), Type.Literal("sol-backend")])),
		},
		{ additionalProperties: false },
	);
	const expectedRevision = Type.Integer({ minimum: 0 });
	const request = Type.Union([
		Type.Object(
			{
				purpose: Type.Literal("plan-prototype-result"),
				expectedRevision,
				questionId: key,
				result: Type.Object(
					{
						planRevision: Type.Integer({ minimum: 1 }),
						questionDigest: key,
						contextDigest: key,
						artifact: Type.Object(
							{ sessionId: key, artifactId: key, revision: Type.Integer({ minimum: 1 }) },
							{ additionalProperties: false },
						),
						observations: Type.Array(Type.String(), { minItems: 1, maxItems: 12 }),
						verdict: Type.Union([
							Type.Literal("supported"),
							Type.Literal("not-supported"),
							Type.Literal("inconclusive"),
						]),
						unresolvedQuestions: Type.Array(Type.String(), { maxItems: 12 }),
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				purpose: Type.Literal("plan-map"),
				expectedRevision,
				destination: Type.String(),
				sources,
				questions: Type.Array(question),
				fog: Type.Array(fog),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{ purpose: Type.Literal("plan-promote"), expectedRevision, fogId: key, questions: Type.Array(question) },
			{ additionalProperties: false },
		),
		Type.Object(
			{
				purpose: Type.Literal("plan-claim"),
				expectedRevision,
				questionId: key,
				claimedBy: Type.Union([key, Type.Null()]),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				purpose: Type.Literal("plan-resolve"),
				expectedRevision,
				questionId: key,
				resolution: Type.Object(
					{
						kind: Type.Union([Type.Literal("decision"), Type.Literal("knowledge"), Type.Literal("interview")]),
						id: key,
						digest: key,
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{ purpose: Type.Literal("plan-propose"), expectedRevision, spec, slices: Type.Array(slice) },
			{ additionalProperties: false },
		),
		Type.Object(
			{
				purpose: Type.Literal("plan-ask"),
				expectedRevision,
				topicId: key,
				questions: Type.Array(
					Type.Object(
						{
							id: key,
							section: Type.Union([
								Type.Literal("outcome"),
								Type.Literal("non-goals"),
								Type.Literal("constraints"),
								Type.Literal("acceptance"),
								Type.Literal("authority"),
							]),
							prompt: Type.String(),
							options: Type.Array(option),
							recommendedOptionId: Type.Union([key, Type.Null()]),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		...(["plan-review", "plan-publish"] as const).map((purpose) =>
			Type.Object({ purpose: Type.Literal(purpose), expectedRevision }, { additionalProperties: false }),
		),
	]);
	return defineTool({
		name: "mission_plan",
		label: "Mission planning",
		description:
			"Read native planning or save a revision-bound map, questions, spec or slices. After publication, read returns current agreement/tasks/active decisions and settled answers; only explicitly requested Revisit questions or an inert revision delta are allowed. Use read revisionSource for action revision; only separate exact human confirmation applies it. Prototype findings need exact digests and a pinned artifact; they never accept a preference. Human answers use native UI. Publication starts nothing. Unknown writes require exact receipt lookup, never a new attempt.",
		parameters: Type.Union([
			Type.Object(
				{
					action: Type.Literal("revision"),
					request: Type.Object(
						{
							purpose: Type.Literal("revision-propose"),
							source: key,
							summary: Type.String({ minLength: 1, maxLength: 1000 }),
							delta: Type.Unsafe<MissionRevisionDelta>({
								type: "object",
								description:
									"Inert MissionRevisionDelta: optional goal/markdown, tasks [{id,title?,body?,drop?,assignment?,dependsOn?,decisionIds?}], decisions [{id,reason,action:replace|withdraw,text?,audience?}], corrections [{kind:instruction|permission,text}]. Existing IDs only; no completed task edits. Corrections never apply permissions.",
							}),
						},
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					action: Type.Literal("questions"),
					request: Type.Object({
						purpose: Type.Literal("interview-questions"),
						kind: Type.Optional(Type.Literal("revisit")),
						expected: Type.Object({
							fence: Type.Object({
								missionId: key,
								ownerSessionId: key,
								enrollmentId: key,
								questionSetRevision: Type.Integer(),
								answerRevision: Type.Integer(),
							}),
							revision: Type.Integer(),
						}),
						questions: Type.Array(
							Type.Object({
								id: key,
								section: Type.Union(
									["outcome", "non-goals", "constraints", "acceptance", "authority"].map((s) =>
										Type.Literal(s),
									),
								),
								prompt: Type.String(),
								options: Type.Array(option),
								recommendedOptionId: Type.Union([key, Type.Null()]),
							}),
						),
					}),
				},
				{ additionalProperties: false },
			),
			Type.Object({ action: Type.Literal("check"), operationId: key }, { additionalProperties: false }),
			Type.Object(
				{ action: Type.Literal("read"), revision: Type.Optional(Type.Integer({ minimum: 1 })) },
				{ additionalProperties: false },
			),
			Type.Object(
				{ action: Type.Literal("knowledge"), id: key, revision: Type.Integer({ minimum: 1 }) },
				{ additionalProperties: false },
			),
			Type.Object({ action: Type.Literal("write"), request }, { additionalProperties: false }),
		]),
		async execute(callId, args, signal) {
			let result: unknown;
			if (args.action === "revision") {
				if (!port.revision) throw new Error("Trusted Revisit binding unavailable");
				result = await port.revision(callId, args.request, signal);
			} else if (args.action === "questions") {
				if (!port.questions) throw new Error("Trusted interview worker binding unavailable");
				result = await port.questions(
					callId,
					args.request as Extract<InterviewWrite, { purpose: "interview-questions" }>,
					signal,
				);
			} else if (args.action === "read") result = await port.read(args.revision, signal);
			else if (args.action === "check") result = await port.receipt(args.operationId, signal);
			else if (args.action === "knowledge") result = await port.knowledge(args.id, args.revision, signal);
			else {
				const r = args.request as PlanWrite;
				if (
					!r ||
					![
						"plan-map",
						"plan-promote",
						"plan-claim",
						"plan-resolve",
						"plan-prototype-result",
						"plan-propose",
						"plan-ask",
						"plan-review",
						"plan-publish",
					].includes(r.purpose)
				)
					throw new Error("Unsupported native planning purpose");
				result = await port.write(callId, r, signal);
			}
			return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: undefined };
		},
	});
}
