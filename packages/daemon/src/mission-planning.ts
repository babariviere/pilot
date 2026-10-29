import type { MissionAssignment } from "@pilot/protocol";
import { Conflict } from "./errors.ts";

/** Write validation only. Stored/legacy reads never pass through these limits. */
export function assignmentWrite(value: unknown, current?: MissionAssignment): MissionAssignment {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("assignment must be an object");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).sort().join(",") !== "criteria,expectedRevision,intent,scope,version")
		throw new Error("assignment requires version, expectedRevision, intent, scope and criteria only");
	if (input.version !== 1 || (current && current.version !== 1)) throw new Conflict("Unsupported assignment version");
	if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0)
		throw new Error("assignment expectedRevision must be a non-negative integer");
	if (input.expectedRevision !== (current?.revision ?? 0))
		throw new Conflict("Assignment revision conflict; read the task and reapply your change");
	const text = (value: unknown, field: string, limit: number) => {
		if (typeof value !== "string" || !value.trim() || Array.from(value).length > limit)
			throw new Error(`assignment ${field} must be nonempty text, at most ${limit} Unicode code points`);
		return value;
	};
	if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 20)
		throw new Error("assignment criteria must contain 1 to 20 items");
	return {
		version: 1,
		revision: (current?.revision ?? 0) + 1,
		intent: text(input.intent, "intent", 1000),
		scope: text(input.scope, "scope", 4000),
		criteria: input.criteria.map((value) => text(value, "criterion", 1000)),
	};
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
