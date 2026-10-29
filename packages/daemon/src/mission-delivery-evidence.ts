/** Internal record contract. Nothing here verifies checks, grants authority or completes work. */
import { createHash } from "node:crypto";
import type { MissionAssignment, MissionNonCodeDeliveryReference, MissionTask } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON } from "./operation-journal.ts";

export type DeliveryReference = MissionNonCodeDeliveryReference | { kind: "snapshot"; snapshotId: string };
export interface DeliverySubmissionWrite {
	version: 1;
	operationId: string;
	expectedSubmissionId: string | null;
	/** Existing task-definition fence, including owner release/reclaim ABA. Not contribution proof. */
	definitionRevision: number;
	assignment: MissionAssignment;
	kind: "code" | "native-ui" | "research";
	claim: string;
	limitations: string;
	evidence: DeliveryReference[];
	/** One entry per ordered assignment criterion; entries are evidence indexes, not verified coverage. */
	coverage: number[][];
}
export interface DeliveryJudgementWrite {
	version: 1;
	operationId: string;
	submissionId: string;
	expectedJudgementId: string | null;
	decision: "approve" | "reject" | "request-changes";
	reason: string;
}

/** Host observation of retained identity only, never test/review/CI success. */
export interface DeliveryObservation {
	reference: DeliveryReference;
	/** Custodian from the retained host record, not a caller-supplied actor. Briefs have no session custodian. */
	sourceOwnerSessionId: string | null;
	sha256: string;
	availability: "retained" | "partial" | "unavailable";
}
interface DeliveryRecordBase {
	version: 1;
	id: string;
	missionId: string;
	taskId: string;
	actorSessionId: string;
	createdAt: number;
}
export interface DeliverySubmission extends DeliveryRecordBase {
	type: "submission";
	ownerSessionId: string;
	request: DeliverySubmissionWrite;
	observations: DeliveryObservation[];
}
export interface DeliveryJudgement extends DeliveryRecordBase {
	type: "judgement";
	request: DeliveryJudgementWrite;
}
export type DeliveryRecord = DeliverySubmission | DeliveryJudgement;
export type DeliveryResolver = (reference: DeliveryReference) => Promise<DeliveryObservation>;

function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== names.sort().join()
	)
		throw new Error("Invalid delivery fields");
}
function text(value: unknown, max: number, empty = false): string {
	if (typeof value !== "string" || (!empty && !value.trim()) || Array.from(value).length > max)
		throw new Error("Invalid delivery text");
	return value;
}
function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
		throw new Error("Invalid delivery identifier");
	return value;
}
function previous(value: unknown): string | null {
	return value === null ? null : identifier(value);
}
function revision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Invalid delivery revision");
	return value as number;
}
export function deliveryDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}
export function deliveryAssignment(value: unknown): MissionAssignment {
	fields(value, ["version", "revision", "intent", "scope", "criteria"]);
	if (value.version !== 1) throw new Error("Unsupported delivery assignment version");
	if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 20)
		throw new Error("Invalid delivery criteria");
	return {
		version: 1,
		revision: revision(value.revision),
		intent: text(value.intent, 1000),
		scope: text(value.scope, 4000),
		criteria: Array.from(value.criteria, (c) => text(c, 1000)),
	};
}
export function deliveryReference(value: unknown): DeliveryReference {
	const ref = value as Record<string, unknown> | null;
	if (ref?.kind === "brief") {
		fields(value, ["kind", "revision"]);
		return { kind: "brief", revision: revision(value.revision) };
	}
	if (ref?.kind === "artifact") {
		fields(value, ["kind", "artifactId", "revision"]);
		return { kind: "artifact", artifactId: identifier(value.artifactId), revision: revision(value.revision) };
	}
	fields(value, ["kind", "snapshotId"]);
	if (value.kind !== "snapshot" || typeof value.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotId))
		throw new Error("Invalid immutable delivery reference");
	return { kind: "snapshot", snapshotId: value.snapshotId };
}
export function deliverySubmissionWrite(value: unknown): DeliverySubmissionWrite {
	fields(value, [
		"version",
		"operationId",
		"expectedSubmissionId",
		"definitionRevision",
		"assignment",
		"kind",
		"claim",
		"limitations",
		"evidence",
		"coverage",
	]);
	if (value.version !== 1) throw new Error("Unsupported delivery version");
	if (value.kind !== "code" && value.kind !== "native-ui" && value.kind !== "research")
		throw new Error("Invalid delivery kind");
	const assignment = deliveryAssignment(value.assignment);
	if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 20)
		throw new Error("Delivery evidence requires 1 to 20 immutable references");
	const evidence = Array.from(value.evidence, deliveryReference);
	if (new Set(evidence.map(deliveryDigest)).size !== evidence.length) throw new Error("Duplicate delivery evidence");
	if (!Array.isArray(value.coverage) || value.coverage.length !== assignment.criteria.length)
		throw new Error("Delivery coverage must enumerate every criterion");
	const coverage = Array.from(value.coverage, (indexes: unknown) => {
		if (
			!Array.isArray(indexes) ||
			indexes.length > evidence.length ||
			new Set(indexes).size !== indexes.length ||
			Array.from(indexes).some((i) => !Number.isSafeInteger(i) || i < 0 || i >= evidence.length)
		)
			throw new Error("Invalid criterion evidence indexes");
		return [...indexes] as number[];
	});
	return {
		version: 1,
		operationId: identifier(value.operationId),
		expectedSubmissionId: previous(value.expectedSubmissionId),
		definitionRevision: revision(value.definitionRevision),
		assignment,
		kind: value.kind,
		claim: text(value.claim, 2000),
		limitations: text(value.limitations, 1000, true),
		evidence,
		coverage,
	};
}
export function deliveryJudgementWrite(value: unknown): DeliveryJudgementWrite {
	fields(value, ["version", "operationId", "submissionId", "expectedJudgementId", "decision", "reason"]);
	if (value.version !== 1) throw new Error("Unsupported delivery version");
	if (value.decision !== "approve" && value.decision !== "reject" && value.decision !== "request-changes")
		throw new Error("Invalid coordinator judgement");
	return {
		version: 1,
		operationId: identifier(value.operationId),
		submissionId: identifier(value.submissionId),
		expectedJudgementId: previous(value.expectedJudgementId),
		decision: value.decision,
		reason: text(value.reason, 2000),
	};
}
export function assertDeliveryAssignment(task: MissionTask, assignment: MissionAssignment): void {
	if (!task.assignment || deliveryDigest(deliveryAssignment(task.assignment)) !== deliveryDigest(assignment))
		throw new Conflict("Delivery assignment is stale or altered");
}
export function latestSubmission(records: DeliveryRecord[]): DeliverySubmission | undefined {
	return records.findLast((r): r is DeliverySubmission => r.type === "submission");
}
export function latestJudgement(records: DeliveryRecord[]): DeliveryJudgement | undefined {
	return records.findLast((r): r is DeliveryJudgement => r.type === "judgement");
}

/** Freshness is about these records, not a proof of current live source or accepted delivery. */
export function evaluateDelivery(
	task: MissionTask,
	coordinator: string | undefined,
	records: DeliveryRecord[],
	observations: DeliveryObservation[] | undefined,
	definitionRevision: number,
) {
	const submission = latestSubmission(records),
		judgement = latestJudgement(records);
	let assignment: "current" | "stale" | "unavailable" = "unavailable";
	if (submission) {
		try {
			assertDeliveryAssignment(task, submission.request.assignment);
			assignment =
				task.sessionId === submission.ownerSessionId &&
				Number.isSafeInteger(definitionRevision) &&
				definitionRevision > 0 &&
				definitionRevision === submission.request.definitionRevision
					? "current"
					: "stale";
		} catch {
			assignment = "stale";
		}
	}
	const evidence =
		!submission || !observations
			? "unavailable"
			: deliveryDigest(observations) !== deliveryDigest(submission.observations)
				? "stale"
				: observations.some((o) => o.availability !== "retained")
					? "unavailable"
					: "current";
	const judgementFreshness = !judgement
		? "unavailable"
		: assignment !== "current" ||
				evidence !== "current" ||
				judgement.request.submissionId !== submission?.id ||
				judgement.actorSessionId !== coordinator
			? "stale"
			: "current";
	return {
		submission,
		judgement,
		freshness: { assignment, evidence, judgement: judgementFreshness },
		/** Explicitly claimed coverage, never independent verification. */
		coverage: submission?.request.coverage.map((indexes) => (indexes.length ? "claimed" : "missing")) ?? [],
		verification: {
			checks: "unavailable",
			independentReview: "unavailable",
			authority: "unavailable",
			taskAtOperation: "unavailable",
			liveSource: "unavailable",
		},
		integration: "unavailable",
		eligibility: "unavailable",
	} as const;
}
