/** Dormant later allocation of retained contributions, never original task-purpose proof. */
import type { MissionAssignment, MissionTask } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { exact, identifier } from "./jj-ownership-contract.ts";
import {
	assertDeliveryAssignment,
	type DeliveryObservation,
	type DeliverySubmission,
	deliveryAssignment,
	deliveryDigest,
	deliveryReference,
} from "./mission-delivery-evidence.ts";
import type { ReviewContextFence } from "./mission-review-contract.ts";

/** Extends, without changing, the historical review fence. */
export interface AllocationContextFence extends ReviewContextFence {
	coordinatorEventId: number;
}
interface AllocationWriteBase {
	version: 1;
	operationId: string;
	expectedAllocationId: string | null;
	reason: string;
}
export interface ContributionAllocationWrite extends AllocationWriteBase {
	action: "allocate";
	submissionId: string;
	assignment: MissionAssignment;
	ownerSessionId: string;
	definitionRevision: number;
	expectedContextFence: AllocationContextFence;
	/** Exact selected subset of submitted evidence, not exhaustive task coverage. */
	sources: DeliveryObservation[];
}
export interface ContributionWithdrawalWrite extends AllocationWriteBase {
	action: "withdraw";
	expectedAllocationId: string;
}
export type AllocationWrite = ContributionAllocationWrite | ContributionWithdrawalWrite;
export interface ContributionAllocation {
	version: 1;
	id: string;
	missionId: string;
	taskId: string;
	recorderSessionId: string;
	createdAt: number;
	request: AllocationWrite;
	/** Creation/custody provenance remains in the exact retained source, not inferred here. */
	historicalTaskAttribution: "unknown";
	scopeCoverage: "selected-only";
}
function id(value: unknown): string {
	identifier(value, /^[a-zA-Z0-9_-]{1,128}$/);
	return value;
}
function integer(value: unknown, min: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error("Invalid allocation revision");
	return value as number;
}
export function allocationWrite(value: unknown): AllocationWrite {
	const allocating = (value as { action?: unknown } | null)?.action === "allocate";
	exact(value, [
		"version",
		"operationId",
		"expectedAllocationId",
		"action",
		"reason",
		...(allocating
			? ["submissionId", "assignment", "ownerSessionId", "definitionRevision", "expectedContextFence", "sources"]
			: []),
	]);
	if (value.version !== 1) throw new Error("Unsupported allocation version");
	if (typeof value.reason !== "string" || !value.reason.trim() || Array.from(value.reason).length > 2000)
		throw new Error("Invalid allocation reason");
	const base: AllocationWriteBase = {
		version: 1,
		operationId: id(value.operationId),
		expectedAllocationId: value.expectedAllocationId === null ? null : id(value.expectedAllocationId),
		reason: value.reason,
	};
	if (!allocating) {
		if (value.action !== "withdraw" || base.expectedAllocationId === null) throw new Error("Invalid withdrawal");
		return { ...base, action: "withdraw", expectedAllocationId: base.expectedAllocationId };
	}
	exact(value.expectedContextFence, [
		"briefRevision",
		"decisionEventId",
		"artifactEventId",
		"memberEventId",
		"coordinatorEventId",
	]);
	const f = value.expectedContextFence;
	if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 20)
		throw new Error("Allocation requires 1 to 20 selected sources");
	const sources = Array.from(value.sources, (source): DeliveryObservation => {
		exact(source, ["reference", "sourceOwnerSessionId", "sha256", "availability"]);
		identifier(source.sha256, /^[a-f0-9]{64}$/);
		if (source.availability !== "retained") throw new Conflict("Allocation source is partial or unavailable");
		return {
			reference: deliveryReference(source.reference),
			sourceOwnerSessionId: source.sourceOwnerSessionId === null ? null : id(source.sourceOwnerSessionId),
			sha256: source.sha256,
			availability: "retained",
		};
	});
	if (new Set(sources.map((s) => deliveryDigest(s.reference))).size !== sources.length)
		throw new Error("Duplicate allocation source");
	return {
		...base,
		action: "allocate",
		submissionId: id(value.submissionId),
		assignment: deliveryAssignment(value.assignment),
		ownerSessionId: id(value.ownerSessionId),
		definitionRevision: integer(value.definitionRevision, 1),
		expectedContextFence: {
			briefRevision: integer(f.briefRevision, 0),
			decisionEventId: integer(f.decisionEventId, 0),
			artifactEventId: integer(f.artifactEventId, 0),
			memberEventId: integer(f.memberEventId, 0),
			coordinatorEventId: integer(f.coordinatorEventId, 0),
		},
		sources,
	};
}

export function assertAllocationSubmission(
	request: ContributionAllocationWrite,
	submission: DeliverySubmission | undefined,
): void {
	if (!submission || submission.id !== request.submissionId)
		throw new Conflict("Allocation submission is stale or missing");
	if (
		submission.ownerSessionId !== request.ownerSessionId ||
		submission.request.definitionRevision !== request.definitionRevision ||
		deliveryDigest(submission.request.assignment) !== deliveryDigest(request.assignment)
	)
		throw new Conflict("Allocation submission assignment or owner mismatch");
	for (const source of request.sources) {
		if (!submission.observations.some((o) => deliveryDigest(o) === deliveryDigest(source)))
			throw new Conflict("Allocation source does not match submitted evidence");
		if (source.reference.kind === "snapshot" && source.sourceOwnerSessionId !== request.ownerSessionId)
			throw new Conflict("Allocation source worker custody mismatch");
	}
	if (submission.request.kind === "code" && !request.sources.some((s) => s.reference.kind === "snapshot"))
		throw new Conflict("Code allocation must select its own exact retained comparison");
}

export function evaluateContributionAllocation(
	record: ContributionAllocation,
	current: {
		task: MissionTask;
		definitionRevision: number;
		coordinatorSessionId: string | undefined;
		contextFence: AllocationContextFence;
		latestAllocationId: string | null;
		submission: DeliverySubmission | undefined;
		observations: DeliveryObservation[] | undefined;
	},
) {
	const reasons: string[] = [];
	let unavailable = false;
	if (record.id !== current.latestAllocationId) reasons.push("superseded");
	if (record.request.action === "withdraw") reasons.push("withdrawn");
	else {
		const request = record.request;
		try {
			assertDeliveryAssignment(current.task, request.assignment);
		} catch {
			reasons.push("assignment changed");
		}
		if (
			current.task.sessionId !== request.ownerSessionId ||
			current.definitionRevision !== request.definitionRevision
		)
			reasons.push("owner or definition changed");
		if (current.task.status === "done" || current.task.status === "dropped") reasons.push("task closed");
		if (current.coordinatorSessionId !== record.recorderSessionId) reasons.push("coordinator changed");
		if (deliveryDigest(current.contextFence) !== deliveryDigest(request.expectedContextFence))
			reasons.push("context changed");
		try {
			assertAllocationSubmission(request, current.submission);
		} catch {
			reasons.push("submission changed or unavailable");
		}
		if (!current.observations || current.observations.some((o) => o.availability !== "retained")) {
			unavailable = true;
			reasons.push("retained sources unavailable");
		} else if (deliveryDigest(current.observations) !== deliveryDigest(request.sources))
			reasons.push("source identity changed");
	}
	return {
		record,
		applicability: reasons.length ? (unavailable ? "unavailable" : "outdated") : "current",
		reasons,
		scopeCoverage: "selected-only",
		historicalTaskAttribution: "unknown",
		checks: "unavailable",
		independentReview: "unavailable",
		authority: "unavailable",
		liveSourceFreshness: "unavailable",
		contributionCompleteness: "unavailable",
		acceptance: "unavailable",
		integration: "unavailable",
		eligibility: "unavailable",
	} as const;
}
