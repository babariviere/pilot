/** Dormant review records. Interpretation is not acceptance, authority or execution. */
import type { MissionAssignment, MissionTask, ModelList } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import {
	assertDeliveryAssignment,
	type DeliveryObservation,
	type DeliveryReference,
	deliveryAssignment,
	deliveryDigest,
	deliveryReference,
} from "./mission-delivery-evidence.ts";
import { type ModelRecommendationContext, recommendMissionModel } from "./mission-model-recommendation.ts";
import { reviewPath } from "./review-snapshot-contract.ts";

export type ReviewIntent = "code" | "native-ui" | "research";
export type ReviewOutcome = "pass" | "fail" | "low" | "medium" | "high";
export interface ReviewProfileDefinition {
	version: 1;
	purpose: string;
	rubric: string;
	applicableIntents: ReviewIntent[];
	modelSelection: { provider: string; model: string } | { unavailable: string };
	reasoningEffort: string | null;
	timeLimitMs: number | null;
	outputInterpretation:
		| { kind: "pass-fail"; pass: string; fail: string }
		| { kind: "attention"; low: string; medium: string; high: string };
}
export interface ReviewProfileWrite {
	version: 1;
	operationId: string;
	profileId: string;
	expectedRevision: number;
	definition: ReviewProfileDefinition;
}
export type ReviewCitation =
	| { kind: "content"; reference: Exclude<DeliveryReference, { kind: "snapshot" }>; explanation: string }
	| {
			kind: "code";
			snapshotId: string;
			side: "before" | "after";
			path: string;
			sha256: string;
			/** UTF-8 byte range in the retained blob, not a live line anchor. */
			start: number;
			end: number;
	  };
export interface ReviewFinding {
	id: string;
	title: string;
	trigger: string;
	cost: string;
	basis: "introduced" | "worsened" | "existing-baseline";
	severity: "low" | "medium" | "high";
	evidence: ReviewCitation[];
	counterevidence: string;
}
export interface ReviewResolution {
	resultId: string;
	findingId: string;
	/** A reported assessment, never automatic closure or verified behavioral proof. */
	assessment: "resolved" | "remaining" | "not-reverified";
	triggeringPathReason: string;
	evidence: ReviewCitation[];
}
export type ReviewOutput =
	| { state: "completed"; outcome: ReviewOutcome; reason: string }
	| { state: "pending" | "failed-to-run" | "timed-out" | "inconclusive"; reason: string };
export interface ReviewResultWrite {
	version: 1;
	operationId: string;
	profileId: string;
	profileRevision: number;
	expectedResultId: string | null;
	definitionRevision: number;
	expectedContextFence: ReviewContextFence;
	assignment: MissionAssignment;
	intent: ReviewIntent;
	content: DeliveryReference[];
	context: DeliveryReference[];
	/** Retained guidance is an input, not a replacement rubric or proof of human authorship. */
	preferences: { unavailable: string } | { references: DeliveryReference[] };
	output: ReviewOutput;
	findings: ReviewFinding[];
	resolutions: ReviewResolution[];
	limitations: string;
	/** Qualitative self-assessment, not a calibrated probability. */
	confidence: "low" | "medium" | "high" | "unavailable";
}
/** Only a host-installed observer can supply this, never a result payload or role label. */
export type ReviewProducer =
	| { kind: "unavailable"; reason: string }
	| { kind: "observed-agent"; sessionId: string; provider: string; model: string; observationId: string };
export const unavailableReviewProducer = (): ReviewProducer => ({
	kind: "unavailable",
	reason: "No trusted producer/model observation. Recorder identity is not authorship.",
});
export interface ReviewRecordBase {
	version: 1;
	id: string;
	missionId: string;
	recorderSessionId: string;
	createdAt: number;
}
export interface MissionReviewProfile extends ReviewRecordBase {
	type: "profile";
	revision: number;
	request: ReviewProfileWrite;
}
export interface ReviewContextFence {
	briefRevision: number;
	decisionEventId: number;
	artifactEventId: number;
	memberEventId: number;
}
export interface MissionReviewResult extends ReviewRecordBase {
	type: "result";
	taskId: string;
	ownerSessionId: string;
	request: ReviewResultWrite;
	observations: DeliveryObservation[];
	contextFence: ReviewContextFence;
	producer: ReviewProducer;
	independence: "unavailable";
	humanAuthorship: "unavailable";
}
export type MissionReviewRecord = MissionReviewProfile | MissionReviewResult;

function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== names.sort().join()
	)
		throw new Error("Invalid review fields");
}
function text(value: unknown, max = 2000, empty = false): string {
	if (typeof value !== "string" || (!empty && !value.trim()) || Array.from(value).length > max)
		throw new Error("Invalid review text");
	return value;
}
function id(value: unknown): string {
	const result = text(value, 128);
	if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error("Invalid review identifier");
	return result;
}
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
		throw new Error("Invalid review integer");
	return value as number;
}
function list<T>(value: unknown, parse: (item: unknown) => T, max: number, min = 0): T[] {
	if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error("Invalid review list");
	return Array.from(value, parse);
}
function refs(value: unknown, min = 0): DeliveryReference[] {
	const result = list(value, deliveryReference, 20, min);
	if (new Set(result.map(deliveryDigest)).size !== result.length) throw new Error("Duplicate review reference");
	return result;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
	if (!choices.includes(value as T)) throw new Error("Invalid review variant");
	return value as T;
}
export function reviewProfileDefinition(value: unknown): ReviewProfileDefinition {
	fields(value, [
		"version",
		"purpose",
		"rubric",
		"applicableIntents",
		"modelSelection",
		"reasoningEffort",
		"timeLimitMs",
		"outputInterpretation",
	]);
	if (value.version !== 1) throw new Error("Unsupported review profile version");
	const intents = list(value.applicableIntents, (v) => choice(v, ["code", "native-ui", "research"] as const), 3, 1);
	if (new Set(intents).size !== intents.length) throw new Error("Duplicate review intent");
	const selection = value.modelSelection as Record<string, unknown> | null;
	let modelSelection: ReviewProfileDefinition["modelSelection"];
	if (selection && "unavailable" in selection) {
		fields(selection, ["unavailable"]);
		modelSelection = { unavailable: text(selection.unavailable) };
	} else {
		fields(selection, ["provider", "model"]);
		modelSelection = { provider: text(selection.provider, 256), model: text(selection.model, 256) };
	}
	const output = value.outputInterpretation as Record<string, unknown> | null;
	let outputInterpretation: ReviewProfileDefinition["outputInterpretation"];
	if (output?.kind === "pass-fail") {
		fields(output, ["kind", "pass", "fail"]);
		outputInterpretation = { kind: "pass-fail", pass: text(output.pass), fail: text(output.fail) };
	} else {
		fields(output, ["kind", "low", "medium", "high"]);
		choice(output.kind, ["attention"]);
		outputInterpretation = {
			kind: "attention",
			low: text(output.low),
			medium: text(output.medium),
			high: text(output.high),
		};
	}
	return {
		version: 1,
		purpose: text(value.purpose),
		rubric: text(value.rubric, 12000),
		applicableIntents: intents,
		modelSelection,
		reasoningEffort: value.reasoningEffort === null ? null : text(value.reasoningEffort, 128),
		timeLimitMs: value.timeLimitMs === null ? null : integer(value.timeLimitMs, 1, 86400000),
		outputInterpretation,
	};
}
export function reviewProfileWrite(value: unknown): ReviewProfileWrite {
	fields(value, ["version", "operationId", "profileId", "expectedRevision", "definition"]);
	if (value.version !== 1) throw new Error("Unsupported review version");
	return {
		version: 1,
		operationId: id(value.operationId),
		profileId: id(value.profileId),
		expectedRevision: integer(value.expectedRevision, 0),
		definition: reviewProfileDefinition(value.definition),
	};
}
export function reviewCitation(value: unknown): ReviewCitation {
	const v = value as Record<string, unknown> | null;
	if (v?.kind === "content") {
		fields(v, ["kind", "reference", "explanation"]);
		const reference = deliveryReference(v.reference);
		if (reference.kind === "snapshot") throw new Error("Code evidence requires exact code citation");
		return { kind: "content", reference, explanation: text(v.explanation) };
	}
	fields(value, ["kind", "snapshotId", "side", "path", "sha256", "start", "end"]);
	choice(value.kind, ["code"]);
	const reference = deliveryReference({ kind: "snapshot", snapshotId: value.snapshotId });
	reviewPath(value.path);
	if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Invalid code digest");
	const start = integer(value.start, 0),
		end = integer(value.end, start + 1, 2 * 1024 * 1024);
	return {
		kind: "code",
		snapshotId: (reference as { snapshotId: string }).snapshotId,
		side: choice(value.side, ["before", "after"]),
		path: value.path,
		sha256: value.sha256,
		start,
		end,
	};
}
export function reviewResultWrite(value: unknown): ReviewResultWrite {
	fields(value, [
		"version",
		"operationId",
		"profileId",
		"profileRevision",
		"expectedResultId",
		"definitionRevision",
		"expectedContextFence",
		"assignment",
		"intent",
		"content",
		"context",
		"preferences",
		"output",
		"findings",
		"resolutions",
		"limitations",
		"confidence",
	]);
	if (value.version !== 1) throw new Error("Unsupported review version");
	const preferences = value.preferences as Record<string, unknown> | null;
	fields(value.expectedContextFence, ["briefRevision", "decisionEventId", "artifactEventId", "memberEventId"]);
	const expectedContextFence: ReviewContextFence = {
		briefRevision: integer(value.expectedContextFence.briefRevision, 0),
		decisionEventId: integer(value.expectedContextFence.decisionEventId, 0),
		artifactEventId: integer(value.expectedContextFence.artifactEventId, 0),
		memberEventId: integer(value.expectedContextFence.memberEventId, 0),
	};
	let parsedPreferences: ReviewResultWrite["preferences"];
	if (preferences && "unavailable" in preferences) {
		fields(preferences, ["unavailable"]);
		parsedPreferences = { unavailable: text(preferences.unavailable) };
	} else {
		fields(preferences, ["references"]);
		parsedPreferences = { references: refs(preferences.references, 1) };
	}
	const output = value.output as Record<string, unknown> | null;
	let parsedOutput: ReviewOutput;
	if (output?.state === "completed") {
		fields(output, ["state", "outcome", "reason"]);
		parsedOutput = {
			state: "completed",
			outcome: choice(output.outcome, ["pass", "fail", "low", "medium", "high"]),
			reason: text(output.reason),
		};
	} else {
		fields(output, ["state", "reason"]);
		parsedOutput = {
			state: choice(output.state, ["pending", "failed-to-run", "timed-out", "inconclusive"]),
			reason: text(output.reason),
		};
	}
	const findings = list(
		value.findings,
		(v): ReviewFinding => {
			fields(v, ["id", "title", "trigger", "cost", "basis", "severity", "evidence", "counterevidence"]);
			return {
				id: id(v.id),
				title: text(v.title),
				trigger: text(v.trigger),
				cost: text(v.cost),
				basis: choice(v.basis, ["introduced", "worsened", "existing-baseline"]),
				severity: choice(v.severity, ["low", "medium", "high"]),
				evidence: list(v.evidence, reviewCitation, 10, 1),
				counterevidence: text(v.counterevidence),
			};
		},
		30,
	);
	if (new Set(findings.map((f) => f.id)).size !== findings.length) throw new Error("Duplicate finding ID");
	const resolutions = list(
		value.resolutions,
		(v): ReviewResolution => {
			fields(v, ["resultId", "findingId", "assessment", "triggeringPathReason", "evidence"]);
			const assessment = choice(v.assessment, ["resolved", "remaining", "not-reverified"]);
			return {
				resultId: id(v.resultId),
				findingId: id(v.findingId),
				assessment,
				triggeringPathReason: text(v.triggeringPathReason),
				evidence: list(v.evidence, reviewCitation, 10, assessment === "not-reverified" ? 0 : 1),
			};
		},
		30,
	);
	if (parsedOutput.state === "pending" && (findings.length || resolutions.length))
		throw new Error("Pending review has no findings");
	const intent = choice(value.intent, ["code", "native-ui", "research"] as const),
		content = refs(value.content, 1);
	if (intent === "code" && (content.length !== 1 || content.some((r) => r.kind !== "snapshot")))
		throw new Error("Code review requires exact comparisons");
	if (intent !== "code" && content.some((r) => r.kind === "snapshot"))
		throw new Error("Non-code review requires retained brief/artifact content");
	for (const citation of [...findings.flatMap((f) => f.evidence), ...resolutions.flatMap((r) => r.evidence)]) {
		const reference: DeliveryReference =
			citation.kind === "code" ? { kind: "snapshot", snapshotId: citation.snapshotId } : citation.reference;
		if (
			(intent === "code") !== (citation.kind === "code") ||
			!content.some((r) => deliveryDigest(r) === deliveryDigest(reference))
		)
			throw new Error("Finding citation must belong to the reviewed content kind and identity");
	}
	return {
		version: 1,
		operationId: id(value.operationId),
		profileId: id(value.profileId),
		profileRevision: integer(value.profileRevision),
		expectedResultId: value.expectedResultId === null ? null : id(value.expectedResultId),
		definitionRevision: integer(value.definitionRevision),
		expectedContextFence,
		assignment: deliveryAssignment(value.assignment),
		intent,
		content,
		context: refs(value.context),
		preferences: parsedPreferences,
		output: parsedOutput,
		findings,
		resolutions,
		limitations: text(value.limitations, 2000, true),
		confidence: choice(value.confidence, ["low", "medium", "high", "unavailable"]),
	};
}
export function reviewProducer(value: unknown): ReviewProducer {
	const v = value as Record<string, unknown> | null;
	if (v?.kind === "unavailable") {
		fields(v, ["kind", "reason"]);
		return { kind: "unavailable", reason: text(v.reason) };
	}
	fields(value, ["kind", "sessionId", "provider", "model", "observationId"]);
	choice(value.kind, ["observed-agent"]);
	return {
		kind: "observed-agent",
		sessionId: id(value.sessionId),
		provider: text(value.provider, 256),
		model: text(value.model, 256),
		observationId: id(value.observationId),
	};
}
export function reviewReferences(request: ReviewResultWrite): DeliveryReference[] {
	return [
		...request.content,
		...request.context,
		...("references" in request.preferences ? request.preferences.references : []),
	];
}
export function assertReviewOutput(profile: ReviewProfileDefinition, request: ReviewResultWrite): void {
	if (!profile.applicableIntents.includes(request.intent))
		throw new Conflict("Review profile does not apply to this intent");
	if (
		request.output.state === "completed" &&
		!(profile.outputInterpretation.kind === "pass-fail" ? ["pass", "fail"] : ["low", "medium", "high"]).includes(
			request.output.outcome,
		)
	)
		throw new Error("Review outcome does not match profile interpretation");
	if (
		request.output.state === "completed" &&
		request.output.outcome === "pass" &&
		request.findings.some((f) => f.basis !== "existing-baseline")
	)
		throw new Error("Pass cannot hide introduced or worsened findings");
}
/** Pinned record applicability, explicitly NOT a live workspace or delivery gate evaluation. */
export function evaluateMissionReview(
	result: MissionReviewResult,
	current: {
		task: MissionTask;
		definitionRevision: number;
		profileRevision: number;
		latestResultId: string | null;
		contextFence: ReviewContextFence;
		observations?: DeliveryObservation[];
	},
) {
	const reasons: string[] = [];
	try {
		assertDeliveryAssignment(current.task, result.request.assignment);
	} catch {
		reasons.push("Assignment changed");
	}
	if (
		current.task.sessionId !== result.ownerSessionId ||
		current.definitionRevision !== result.request.definitionRevision
	)
		reasons.push("Task definition/ownership changed");
	if (current.profileRevision !== result.request.profileRevision) reasons.push("Profile superseded");
	if (current.latestResultId !== result.id) reasons.push("Result superseded");
	if (deliveryDigest(current.contextFence) !== deliveryDigest(result.contextFence))
		reasons.push("Source/context authorization or relevant context changed");
	if (current.observations && deliveryDigest(current.observations) !== deliveryDigest(result.observations))
		reasons.push("Retained source/context identity changed");
	const outdated = reasons.length > 0;
	const unavailable = !current.observations || current.observations.some((o) => o.availability !== "retained");
	if (unavailable) reasons.push("Retained content unavailable or partial");
	return {
		result,
		applicability: outdated ? "outdated" : unavailable ? "unavailable" : "current",
		reasons,
		liveSourceFreshness: "unavailable",
		checks: "unavailable",
		taskAtOperation: "unavailable",
		integration: "unavailable",
		independence: "unavailable",
		authority: "unavailable",
		acceptance: "unavailable",
		eligibility: "unavailable",
	} as const;
}

/** Optional diagnostics reuse the task catalog and attributed #4 observations, not provider calls. */
export function reviewProfileDiagnostics(
	definition: ReviewProfileDefinition,
	task: MissionTask,
	allowed: ModelList,
	context: ModelRecommendationContext,
) {
	const profile = reviewProfileDefinition(definition);
	if ("unavailable" in profile.modelSelection)
		return { status: "unavailable", reasons: [profile.modelSelection.unavailable], recommendation: null } as const;
	const recommendation = recommendMissionModel(
		{
			...task,
			assignment: task.assignment
				? {
						...task.assignment,
						classification: task.assignment.classification
							? { ...task.assignment.classification, role: "reviewer" }
							: undefined,
					}
				: undefined,
			preferredModel: `${profile.modelSelection.provider}/${profile.modelSelection.model}`,
			preferredThinking: profile.reasoningEffort ?? undefined,
		},
		allowed,
		context,
	);
	return {
		status:
			recommendation.status === "recommended" && profile.reasoningEffort !== null && profile.timeLimitMs !== null
				? "configured"
				: "unavailable",
		reasons: [
			...recommendation.reasons,
			...(profile.reasoningEffort === null ? ["Reasoning effort unconfigured"] : []),
			...(profile.timeLimitMs === null ? ["Time limit unconfigured"] : []),
		],
		recommendation,
	} as const;
}
