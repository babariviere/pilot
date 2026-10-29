import type { MissionAssignment } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { classificationWrite } from "./mission-classification.ts";

/** Write validation only. Stored/legacy reads never pass through these limits. */
export function assignmentWrite(
	value: unknown,
	current?: MissionAssignment,
	definitionRevision = 0,
): MissionAssignment {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("assignment must be an object");
	const input = value as Record<string, unknown>;
	const allowed = [
		"version",
		"expectedRevision",
		"intent",
		"scope",
		"criteria",
		"classification",
		"expectedDefinitionRevision",
	];
	if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("Unknown assignment write field");
	if (input.version !== 1 || (current && current.version !== 1)) throw new Conflict("Unsupported assignment version");
	if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0)
		throw new Error("assignment expectedRevision must be a non-negative integer");
	if (input.expectedRevision !== (current?.revision ?? 0))
		throw new Conflict("Assignment revision conflict; read the task and reapply your change");
	if ("classification" in input && !("expectedDefinitionRevision" in input))
		throw new Error("classification requires expectedDefinitionRevision");
	if ("expectedDefinitionRevision" in input) {
		if (!Number.isSafeInteger(input.expectedDefinitionRevision) || (input.expectedDefinitionRevision as number) < 0)
			throw new Error("assignment expectedDefinitionRevision must be a non-negative integer");
		if (input.expectedDefinitionRevision !== definitionRevision)
			throw new Conflict("Task definition revision conflict; read the task and reapply your change");
	}
	const text = (value: unknown, field: string, limit: number) => {
		if (typeof value !== "string" || !value.trim() || Array.from(value).length > limit)
			throw new Error(`assignment ${field} must be nonempty text, at most ${limit} Unicode code points`);
		return value;
	};
	if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 20)
		throw new Error("assignment criteria must contain 1 to 20 items");
	const next: MissionAssignment = {
		version: 1,
		revision: (current?.revision ?? 0) + 1,
		intent: text(input.intent, "intent", 1000),
		scope: text(input.scope, "scope", 4000),
		criteria: input.criteria.map((value) => text(value, "criterion", 1000)),
	};
	if ("classification" in input) {
		if (input.classification !== null) next.classification = classificationWrite(input.classification);
	} else if (
		current &&
		current.intent === next.intent &&
		current.scope === next.scope &&
		JSON.stringify(current.criteria) === JSON.stringify(next.criteria)
	) {
		if (current.classification) next.classification = structuredClone(current.classification);
	}
	return next;
}

export function strictPlanningFields(value: object, allowed: readonly string[]): void {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw new Error(`Unknown planning write field: ${key}`);
}

export const TASK_WRITE_FIELDS = [
	"title",
	"body",
	"status",
	"order",
	"milestone",
	"phaseId",
	"overridePhaseGating",
	"overrideRetirement",
	"dependsOn",
	"decisionIds",
	"sessionId",
	"preferredModel",
	"preferredThinking",
	"assignment",
] as const;
