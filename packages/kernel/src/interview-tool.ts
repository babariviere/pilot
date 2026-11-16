import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { InterviewQuestion, InterviewVersion, MissionInterview } from "@pilot/protocol";
import { Type } from "typebox";
import { validateQuestions } from "./interview-round.ts";
import type { NativePlanningPort } from "./mission-plan-tool.ts";

/** Bound by the host. The model can write questions, never human answers. */
export interface NativeInterviewPort {
	read(signal?: AbortSignal): Promise<unknown>;
	questions(
		callId: string,
		request: { expected: string | null; questions: InterviewQuestion[]; kind?: "revisit" },
		signal?: AbortSignal,
	): Promise<unknown>;
	receipt(operationId: string, signal?: AbortSignal): Promise<unknown>;
}

const key = Type.String({ minLength: 1, maxLength: 128 });
/** Shared by standalone interviews and the mission compatibility surface. */
export const interviewQuestionSchema = Type.Object(
	{
		id: key,
		section: Type.Union(
			["outcome", "non-goals", "constraints", "acceptance", "authority"].map((section) => Type.Literal(section)),
		),
		prompt: Type.String(),
		options: Type.Array(Type.Object({ id: key, meaning: Type.String() }, { additionalProperties: false })),
		recommendedOptionId: Type.Union([key, Type.Null()]),
		context: Type.Optional(
			Type.String({ maxLength: 1500, description: "Background in plain words, shown on request." }),
		),
	},
	{ additionalProperties: false },
);

export function createInterviewTool(port: NativeInterviewPort): ToolDefinition {
	return defineTool({
		name: "interview",
		label: "Interview",
		executionMode: "sequential",
		description:
			"Read saved questions, answers and submission. Save the entire question list using the exact opaque expected token from read (null for a new standalone round). Returns immediately; end the turn while the host holds dependent work. Humans answer and submit in the native UI. Unknown writes require check with the exact operationId, never a new attempt.",
		parameters: Type.Union([
			Type.Object({ action: Type.Literal("read") }, { additionalProperties: false }),
			Type.Object(
				{
					action: Type.Literal("questions"),
					request: Type.Object(
						{
							expected: Type.Union([Type.String(), Type.Null()]),
							questions: Type.Array(interviewQuestionSchema),
							kind: Type.Optional(Type.Literal("revisit")),
						},
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
			Type.Object({ action: Type.Literal("check"), operationId: key }, { additionalProperties: false }),
		]),
		async execute(callId, args, signal) {
			let result: unknown;
			if (args.action === "read") result = await port.read(signal);
			else if (args.action === "questions") {
				validateQuestions(args.request.questions);
				result = await port.questions(callId, args.request, signal);
			} else if (args.action === "check") result = await port.receipt(args.operationId, signal);
			else throw new Error("Unsupported interview action");
			return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: undefined };
		},
	});
}

function missionExpected(token: string | null): InterviewVersion {
	if (token === null) throw new Error("Read the current mission interview before saving questions");
	let value: InterviewVersion;
	try {
		value = JSON.parse(token);
	} catch {
		throw new Error("Invalid mission interview expected token");
	}
	const fence = value?.fence;
	if (
		!fence ||
		!Number.isInteger(value.revision) ||
		![fence.missionId, fence.ownerSessionId, fence.enrollmentId].every(
			(id) => typeof id === "string" && id.length > 0,
		) ||
		![fence.questionSetRevision, fence.answerRevision].every(Number.isInteger)
	)
		throw new Error("Invalid mission interview expected token");
	return value;
}

export function createMissionInterviewPort(planning: NativePlanningPort): NativeInterviewPort {
	return {
		async read(signal) {
			// PlanningWorker.call returns MissionPlans.view directly, not the HTTP view envelope.
			const view = (await planning.read(undefined, signal)) as { interview?: MissionInterview } | null;
			const interview = view?.interview;
			if (!interview) throw new Error("Current mission interview unavailable");
			return {
				expected: JSON.stringify({ fence: interview.fence, revision: interview.revision }),
				questions: interview.questions,
				answers: interview.answers,
				submission: interview.submission,
				...(interview.kind ? { kind: interview.kind } : {}),
			};
		},
		questions(callId, request, signal) {
			if (!planning.questions) throw new Error("Trusted interview worker binding unavailable");
			return planning.questions(
				callId,
				{ ...request, purpose: "interview-questions", expected: missionExpected(request.expected) },
				signal,
			);
		},
		receipt: (operationId, signal) => planning.receipt(operationId, signal),
	};
}
