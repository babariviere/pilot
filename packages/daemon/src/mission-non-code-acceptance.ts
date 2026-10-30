/** Inert host-only configuration and explanation. Never an acceptance or authority grant. */
import type { MissionAssignment, MissionTask } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { classificationAdvice } from "./mission-classification.ts";
import type { AllocationContextFence, ContributionAllocation } from "./mission-contribution-allocation.ts";
import {
	assertDeliveryAssignment,
	type DeliveryJudgement,
	type DeliveryObservation,
	type DeliveryReference,
	type DeliverySubmission,
	deliveryAssignment,
	deliveryDigest,
	deliveryReference,
} from "./mission-delivery-evidence.ts";
import type { MissionReviewProfile, MissionReviewResult } from "./mission-review-contract.ts";

type NonCodeReference = Exclude<DeliveryReference, { kind: "snapshot" }>;
export type NonCodeReviewRequirement =
	| {
			kind: "independent-agent";
			profileId: string;
			profileRevision: number;
			scrutiny: "targeted" | "full" | "specialist";
			provenance: "host-proven-producer-and-independence";
	  }
	| { kind: "human"; profileId: string; profileRevision: number; provenance: "trusted-human-origin" };
export interface NonCodePolicyWrite {
	version: 1;
	operationId: string;
	expectedPolicyId: string | null;
	kind: "non-code";
	assignment: MissionAssignment;
	ownerSessionId: string;
	definitionRevision: number;
	expectedContextFence: AllocationContextFence;
	destinations: NonCodeReference[];
	checks: { checkId: string; configVersion: string }[];
	reviews: NonCodeReviewRequirement[];
	authorityClaim: { source: "mission-decision"; decisionId: string; decisionEventId: number; sha256: string } | null;
}
export interface NonCodeAuthorityGap {
	state: "unavailable";
	claimedReference: NonCodePolicyWrite["authorityClaim"];
	code:
		| "authority-not-configured"
		| "authority-reference-unavailable"
		| "authority-reference-changed"
		| "trusted-approval-source-unavailable";
	remedy: string;
}
export interface NonCodeAcceptancePolicy {
	version: 1;
	id: string;
	missionId: string;
	taskId: string;
	recorderSessionId: string;
	createdAt: number;
	request: NonCodePolicyWrite;
	destinations: DeliveryObservation[];
	authority: NonCodeAuthorityGap;
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("Invalid non-code policy fields");
}
function id(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
		throw new Error("Invalid non-code policy identifier");
	return value;
}
function integer(value: unknown, min = 1): number {
	if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error("Invalid non-code policy revision");
	return value as number;
}
function list<T>(value: unknown, parse: (v: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 20 || Object.keys(value).length !== value.length)
		throw new Error("Non-code policy requires 1 to 20 dense requirements");
	const result = Array.from(value, parse);
	if (new Set(result.map(deliveryDigest)).size !== result.length)
		throw new Error("Duplicate non-code policy requirement");
	return result;
}
export function nonCodePolicyWrite(value: unknown): NonCodePolicyWrite {
	fields(value, [
		"version",
		"operationId",
		"expectedPolicyId",
		"kind",
		"assignment",
		"ownerSessionId",
		"definitionRevision",
		"expectedContextFence",
		"destinations",
		"checks",
		"reviews",
		"authorityClaim",
	]);
	if (value.version !== 1 || value.kind !== "non-code") throw new Error("Unsupported non-code policy version or kind");
	const assignment = deliveryAssignment(value.assignment);
	if (assignment.classification?.deliveryKind !== "research")
		throw new Conflict("Non-code policy requires explicit research classification, not code-free proof");
	const f = value.expectedContextFence;
	fields(f, ["briefRevision", "decisionEventId", "artifactEventId", "memberEventId", "coordinatorEventId"]);
	const reviews = list(value.reviews, (r): NonCodeReviewRequirement => {
		const human = (r as { kind?: unknown } | null)?.kind === "human";
		fields(r, ["kind", "profileId", "profileRevision", "provenance", ...(human ? [] : ["scrutiny"])]);
		const base = { profileId: id(r.profileId), profileRevision: integer(r.profileRevision) };
		if (human && r.provenance === "trusted-human-origin")
			return { ...base, kind: "human", provenance: "trusted-human-origin" };
		if (
			r.kind !== "independent-agent" ||
			r.provenance !== "host-proven-producer-and-independence" ||
			!["targeted", "full", "specialist"].includes(r.scrutiny as string)
		)
			throw new Error("Invalid non-code review requirement");
		return {
			...base,
			kind: "independent-agent",
			scrutiny: r.scrutiny as "targeted" | "full" | "specialist",
			provenance: "host-proven-producer-and-independence",
		};
	});
	const baseline = classificationAdvice(assignment.classification).tier;
	const rank = { targeted: 1, full: 2, specialist: 3 };
	if (
		!reviews.some(
			(r) =>
				r.kind === "independent-agent" && rank[r.scrutiny] >= (baseline === "T3" ? 3 : baseline === "T2" ? 2 : 1),
		) ||
		(baseline === "T3" && !reviews.some((r) => r.kind === "human"))
	)
		throw new Conflict("Non-code policy cannot weaken Balanced review minimums");
	const checks = list(value.checks, (c) => {
		fields(c, ["checkId", "configVersion"]);
		return { checkId: id(c.checkId), configVersion: id(c.configVersion) };
	});
	if (
		new Set(checks.map((c) => c.checkId)).size !== checks.length ||
		new Set(reviews.map((r) => `${r.kind}:${r.profileId}`)).size !== reviews.length
	)
		throw new Error("Duplicate non-code check or review identity");
	let authorityClaim: NonCodePolicyWrite["authorityClaim"] = null;
	if (value.authorityClaim !== null) {
		const a = value.authorityClaim;
		fields(a, ["source", "decisionId", "decisionEventId", "sha256"]);
		if (a.source !== "mission-decision" || typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256))
			throw new Error("Invalid non-code authority claim");
		authorityClaim = {
			source: "mission-decision",
			decisionId: id(a.decisionId),
			decisionEventId: integer(a.decisionEventId, 0),
			sha256: a.sha256,
		};
	}
	return {
		version: 1,
		operationId: id(value.operationId),
		expectedPolicyId: value.expectedPolicyId === null ? null : id(value.expectedPolicyId),
		kind: "non-code",
		assignment,
		ownerSessionId: id(value.ownerSessionId),
		definitionRevision: integer(value.definitionRevision),
		expectedContextFence: {
			briefRevision: integer(f.briefRevision, 0),
			decisionEventId: integer(f.decisionEventId, 0),
			artifactEventId: integer(f.artifactEventId, 0),
			memberEventId: integer(f.memberEventId, 0),
			coordinatorEventId: integer(f.coordinatorEventId, 0),
		},
		destinations: list(value.destinations, (d) => {
			const ref = deliveryReference(d);
			if (ref.kind === "snapshot") throw new Error("Non-code destination cannot be code");
			return ref;
		}),
		checks,
		reviews,
		authorityClaim,
	};
}

/** Bounded metadata only; immutable journal IDs fence their content. Not source stability. */
export interface NonCodeAcceptanceState {
	missionId: string;
	projectId: string;
	task: MissionTask;
	actorSessionId: string;
	coordinatorSessionId: string | null;
	definitionRevision: number;
	contextFence: AllocationContextFence;
	policy: NonCodeAcceptancePolicy | undefined;
	submission: DeliverySubmission | undefined;
	judgement: DeliveryJudgement | undefined;
	allocation: ContributionAllocation | undefined;
	reviews: {
		requirement: NonCodeReviewRequirement;
		profile: MissionReviewProfile | undefined;
		result: MissionReviewResult | undefined;
	}[];
}
export function nonCodeInputIds(s: NonCodeAcceptanceState) {
	return {
		missionId: s.missionId,
		projectId: s.projectId,
		taskId: s.task.id,
		actorSessionId: s.actorSessionId,
		coordinatorSessionId: s.coordinatorSessionId,
		ownerSessionId: s.task.sessionId ?? null,
		definitionRevision: s.definitionRevision,
		assignmentRevision: s.task.assignment?.revision ?? null,
		classification: s.task.assignment?.classification ?? null,
		assignmentDigest: deliveryDigest(s.task.assignment ?? null),
		status: s.task.status,
		contextFence: s.contextFence,
		policyId: s.policy?.id ?? null,
		submissionId: s.submission?.id ?? null,
		judgementId: s.judgement?.id ?? null,
		allocationId: s.allocation?.id ?? null,
		reviews: s.reviews.map(({ requirement: r, profile, result }) => ({
			kind: r.kind,
			profileId: r.profileId,
			profileRevision: r.profileRevision,
			currentProfileRevision: profile?.revision ?? null,
			profileRecordId: profile?.id ?? null,
			resultId: result?.id ?? null,
		})),
		destinations: s.policy?.destinations ?? [],
	};
}

/** Always false. Current metadata and reported Pass/judgement/allocation never become gates. */
export function explainNonCodeAcceptance(
	s: NonCodeAcceptanceState,
	authority: NonCodeAuthorityGap,
	observations: DeliveryObservation[] | undefined,
) {
	const requirements: {
		key: string;
		state: "missing" | "outdated" | "unavailable" | "configured";
		inputIds: string[];
		code: string;
		remedy: string;
	}[] = [];
	const add = (
		key: string,
		state: (typeof requirements)[number]["state"],
		code: string,
		remedy: string,
		inputIds: string[] = [],
	) => requirements.push({ key, state, inputIds, code, remedy });
	const p = s.policy;
	let applicability: "current" | "outdated" | "unavailable" = p ? "current" : "unavailable";
	if (!p) add("policy", "missing", "policy-missing", "Configure an exact current non-code policy.");
	else {
		try {
			assertDeliveryAssignment(s.task, p.request.assignment);
			if (
				s.task.sessionId !== p.request.ownerSessionId ||
				s.definitionRevision !== p.request.definitionRevision ||
				s.coordinatorSessionId !== p.recorderSessionId ||
				deliveryDigest(s.contextFence) !== deliveryDigest(p.request.expectedContextFence) ||
				["done", "dropped"].includes(s.task.status)
			)
				throw new Conflict("Policy outdated");
		} catch {
			applicability = "outdated";
			add("policy", "outdated", "policy-fences-changed", "Read current fences and append a new policy.", [p.id]);
		}
		if (!observations) {
			if (applicability === "current") applicability = "unavailable";
			add(
				"retained-destinations",
				"unavailable",
				"retained-destinations-unavailable",
				"Restore admitted exact retained references.",
				[p.id],
			);
		} else if (deliveryDigest(observations) !== deliveryDigest(p.destinations)) {
			applicability = "outdated";
			add(
				"retained-destinations",
				"outdated",
				"retained-destinations-changed",
				"Reconfigure exact retained identities.",
				[p.id],
			);
		}
		for (const c of p.request.checks)
			add(
				`check:${c.checkId}`,
				"unavailable",
				"check-execution-and-config-unavailable",
				"Qualify the named host validator and exact config version.",
				[c.checkId, c.configVersion],
			);
		for (const { requirement: r, profile, result } of s.reviews) {
			const ids = [r.profileId, ...(profile ? [profile.id] : []), ...(result ? [result.id] : [])];
			if (!profile || profile.revision !== r.profileRevision) {
				applicability = "outdated";
				add(
					`profile:${r.profileId}`,
					profile ? "outdated" : "missing",
					"review-profile-unavailable-or-changed",
					"Configure the exact current research profile.",
					ids,
				);
			}
			if (!result)
				add(
					`review:${r.profileId}`,
					"missing",
					"review-result-missing",
					"Obtain an attributable review of these exact inputs.",
					ids,
				);
			else {
				const { coordinatorEventId: _coordinator, ...reviewFence } = s.contextFence;
				if (
					result.request.intent !== "research" ||
					result.ownerSessionId !== p.request.ownerSessionId ||
					result.request.definitionRevision !== p.request.definitionRevision ||
					result.request.profileRevision !== r.profileRevision ||
					deliveryDigest(result.request.assignment) !== deliveryDigest(p.request.assignment) ||
					deliveryDigest(result.request.content) !== deliveryDigest(p.request.destinations) ||
					deliveryDigest(result.contextFence) !== deliveryDigest(reviewFence) ||
					deliveryDigest(result.observations.slice(0, result.request.content.length)) !==
						deliveryDigest(p.destinations)
				)
					add(
						`review:${r.profileId}`,
						"outdated",
						"review-inputs-differ",
						"Obtain a review of the exact current policy inputs and profile.",
						ids,
					);
				if (result.request.output.state !== "completed" || result.request.output.outcome !== "pass")
					add(
						`review-outcome:${r.profileId}`,
						"unavailable",
						"reported-review-not-pass",
						"Resolve pending, failed, inconclusive or non-passing review; a reported Pass still needs provenance.",
						ids,
					);
			}
			add(
				`review-provenance:${r.profileId}`,
				"unavailable",
				r.kind === "human" ? "trusted-human-origin-unavailable" : "review-producer-and-independence-unavailable",
				"Qualify independently admitted review provenance; recorder/model labels are insufficient.",
				ids,
			);
		}
	}
	add(
		"authority",
		"unavailable",
		authority.code,
		authority.remedy,
		authority.claimedReference ? [authority.claimedReference.decisionId] : [],
	);
	if (!p?.request.checks.length)
		add(
			"checks",
			"missing",
			"check-requirements-missing",
			"Name required validators and exact config versions; empty is not successful applicability.",
		);
	if (!p?.request.reviews.length)
		add("reviews", "missing", "review-requirements-missing", "Configure at least the Balanced review minimum.");
	if (!s.submission)
		add("submission", "missing", "submission-missing", "Submit exact retained outcome and criterion coverage.");
	else {
		if (
			s.submission.request.kind !== "research" ||
			!p ||
			s.submission.ownerSessionId !== p.request.ownerSessionId ||
			s.submission.request.definitionRevision !== p.request.definitionRevision ||
			deliveryDigest(s.submission.request.assignment) !== deliveryDigest(p.request.assignment) ||
			deliveryDigest(s.submission.request.evidence) !== deliveryDigest(p.request.destinations) ||
			deliveryDigest(s.submission.observations) !== deliveryDigest(p.destinations)
		)
			add("submission", "outdated", "submission-inputs-differ", "Submit the exact policy-bound outcome.", [
				s.submission.id,
			]);
		for (const [i, coverage] of s.submission.request.coverage.entries())
			if (!coverage.length)
				add(
					`criterion:${i}`,
					"missing",
					"criterion-coverage-missing",
					"Provide exact evidence for this criterion.",
					[s.submission.id],
				);
	}
	if (
		!s.judgement ||
		s.judgement.actorSessionId !== s.coordinatorSessionId ||
		s.judgement.request.submissionId !== s.submission?.id ||
		s.judgement.request.decision !== "approve"
	)
		add(
			"judgement",
			s.judgement ? "outdated" : "missing",
			"coordinator-judgement-missing-or-not-approved",
			"Assess the exact current submission; judgement is not execution proof.",
			s.judgement ? [s.judgement.id] : [],
		);
	if (
		s.allocation?.request.action !== "allocate" ||
		s.allocation.request.submissionId !== s.submission?.id ||
		!p ||
		s.allocation.request.ownerSessionId !== p.request.ownerSessionId ||
		s.allocation.request.definitionRevision !== p.request.definitionRevision ||
		deliveryDigest(s.allocation.request.assignment) !== deliveryDigest(p.request.assignment) ||
		deliveryDigest(s.allocation.request.expectedContextFence) !== deliveryDigest(s.contextFence)
	)
		add(
			"allocation",
			s.allocation ? "outdated" : "missing",
			"selected-allocation-missing-or-changed",
			"Allocate exact retained sources; selected-only is not exhaustive.",
			s.allocation ? [s.allocation.id] : [],
		);
	const missingCapabilities = [
		"approved-authority-source",
		"check-execution",
		"review-provenance",
		"finding-resolution",
		"code-free-inventory",
		"contribution-reconciliation",
		"live-source-freshness",
		"source-stability",
		"destination-observer",
		"executable-acceptance-seam",
	];
	for (const code of missingCapabilities)
		add(
			code,
			"unavailable",
			code,
			"Implement and qualify the separately admitted host capability; reported records cannot replace it.",
		);
	return {
		version: 1,
		mode: "explain-only",
		eligible: false,
		force: "off",
		preset: "balanced",
		inputs: nonCodeInputIds(s),
		policyApplicability: applicability,
		authority,
		requirements,
		missingCapabilities,
	} as const;
}
