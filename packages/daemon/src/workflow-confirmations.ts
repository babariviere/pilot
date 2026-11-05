/** Purpose-bound native confirmation. No mission admission, reviewer execution or gate activation. */
import type {
	DurableOperation,
	PreparedWorkflowConfirmation,
	ReviewDispositionPayload,
	ReviewerConsentDisclosure,
	WorkflowConfirmationPackage,
	WorkflowConfirmationPayload,
	WorkflowOperationKind,
} from "@pilot/protocol";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import { validateFeedback } from "./human-review-anchors.ts";
import { changeIdPattern } from "./jj-ownership-contract.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash } from "./operation-journal.ts";
import type { WorkflowConfirmationRecord } from "./workflow-confirmation-store.ts";

const KINDS: readonly string[] = [
	"workflow-approve",
	"workflow-revoke",
	"review-consent",
	"review-consent-revoke",
	"review-disposition",
];
export const isWorkflowOperation = (kind: string): kind is WorkflowOperationKind => KINDS.includes(kind);
const digest = (value: unknown) => payloadHash(canonicalJSON(value));
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new OperationRejected("Expected exact confirmation fields");
}

/** #60 owns durable feedback, request/authority fences and annotation history. No second store here.
 * Production leaves this port absent until that real producer is qualified and wired. */
export interface QualifiedReviewDispositionSource {
	prepare(request: ReviewDispositionPayload): Promise<ReviewDispositionPayload>;
	/** Must bind tested revisions/configuration and fresh independent agent review to all selected targets. */
	prerequisites?(request: ReviewDispositionPayload): Promise<"passed" | "unavailable" | "blocked">;
	/** Atomic expected-prior CAS + revalidation, durable before returning. Dedupes the complete operation. */
	record(op: DurableOperation, request: ReviewDispositionPayload): Promise<{ recordId: string }>;
	/** Exact operation lookup only. Absence is Unknown, never permission to record again. */
	lookup(op: DurableOperation): Promise<{ recordId: string } | undefined>;
}
export interface WorkflowConfirmationDependencies {
	store: MissionStore;
	journal: OperationJournal;
	/** Synchronous current project and coordinator metadata admission. Returns immutable config identity. */
	authorize(projectId: string, coordinatorSessionId: string): string;
	/** Trusted host configuration only; absent terms/account/configuration refuses consent. No provider calls. */
	consentConfiguration?(missionId: string): ReviewerConsentDisclosure;
	dispositions?: QualifiedReviewDispositionSource;
}

export class WorkflowConfirmations {
	private readonly deps: WorkflowConfirmationDependencies;
	constructor(deps: WorkflowConfirmationDependencies) {
		this.deps = deps;
	}
	private async uncertainRevocation(
		missionId: string,
		consent: boolean,
		excludeOperationId?: string,
	): Promise<boolean> {
		for (const kind of ["workflow-revoke", ...(consent ? ["review-consent-revoke"] : [])]) {
			const receipts = await this.deps.journal.targetReceipts(kind, missionId);
			if (receipts.some((r) => r.state === "pending" && r.operationId !== excludeOperationId)) return true;
		}
		return false;
	}
	private build(missionId: string, purpose: WorkflowConfirmationPackage["purpose"]): WorkflowConfirmationPackage {
		const { store } = this.deps;
		const state = store.workflowConfirmationState(missionId);
		const { mission } = state;
		const coordinator = mission.coordinatorSessionId;
		const member = coordinator ? store.membership(coordinator) : undefined;
		if (
			mission.planningVersion !== 1 ||
			!coordinator ||
			!member?.coordinator ||
			member.missionId !== missionId ||
			(!purpose.endsWith("revoke") && !member.active)
		)
			throw new Conflict("A current coordinator in an active opted-in mission is required");
		const configurationDigest = this.deps.authorize(mission.projectId, coordinator);
		const consent = purpose.startsWith("review-consent");
		let disclosure: ReviewerConsentDisclosure | null = null;
		let workflowApprovalOperationId: string | null = null;
		if (consent && !purpose.endsWith("revoke")) {
			const approval = store.workflowConfirmations.latest(missionId, false);
			if (
				approval?.kind !== "workflow-approve" ||
				approval.confirmed.package.digest !== this.build(missionId, "workflow-approve").digest
			)
				throw new Conflict("A current exact workflow approval is required");
			workflowApprovalOperationId = approval.operationId;
			if (!this.deps.consentConfiguration)
				throw new ServiceUnavailable("Reviewer disclosure configuration is unavailable");
			disclosure = structuredClone(this.deps.consentConfiguration(missionId));
			validateDisclosure(disclosure);
		} else if (consent) {
			const previous = store.workflowConfirmations.latest(missionId, true);
			disclosure = previous?.confirmed.package.disclosure ?? null;
			workflowApprovalOperationId = previous?.confirmed.package.workflowApprovalOperationId ?? null;
		}
		const value: Omit<WorkflowConfirmationPackage, "digest"> = {
			version: 1,
			purpose,
			missionId,
			projectId: mission.projectId,
			coordinatorSessionId: coordinator,
			brief: state.brief,
			decisions: state.decisions,
			eventId: state.eventId,
			contextFence: state.contextFence,
			configurationDigest,
			policy: {
				scrutiny: "Balanced",
				requiredChecks: "must-pass",
				review: { T1: "targeted-independent", T2: "full-independent", T3: "specialist-and-human" },
				excludedPowers: ["review-spend", "human-review", "integrate", "cleanup", "subdelegate"],
				expiry: "mission-end-or-revocation",
			},
			delegation: {
				coordinatorSessionId: coordinator,
				actions: ["plan", "classify", "assign", "assess", "accept-outcome"],
				expansion: "fresh-user-confirmation",
				protectedDecisions: "user-only",
				force: false,
			},
			workflowApprovalOperationId,
			disclosure,
		};
		return { ...value, digest: digest(value) };
	}
	/** No row, capability or permission is created by preparation. Re-read after the durability await. */
	async prepare(
		missionId: string,
		purpose: WorkflowConfirmationPackage["purpose"],
	): Promise<PreparedWorkflowConfirmation> {
		if (!isWorkflowOperation(purpose)) throw new OperationRejected("Unsupported confirmation purpose");
		this.build(missionId, purpose);
		await this.deps.store.durable();
		if (
			!purpose.endsWith("revoke") &&
			(await this.uncertainRevocation(missionId, purpose.startsWith("review-consent")))
		)
			throw new ServiceUnavailable("A prior revocation is uncertain; check its exact operation");
		return {
			package: this.build(missionId, purpose),
			expectedPriorOperationId:
				this.deps.store.workflowConfirmations.latest(missionId, purpose.startsWith("review-consent"))
					?.operationId ?? null,
		};
	}
	/** Historical receipt != current authority. Positive projections always cross the store durability barrier. */
	async current(
		missionId: string,
		consent = false,
	): Promise<{
		state: "missing" | "applicable" | "stale" | "revoked" | "expired" | "unknown";
		record?: WorkflowConfirmationRecord;
	}> {
		const rows = this.deps.store.workflowConfirmations;
		const record = rows.latest(missionId, consent);
		// Revocation blocks immediately, even while its disk acknowledgement is uncertain.
		if (record?.kind.endsWith("revoke")) return { state: "revoked", record };
		const approvalOperationId = consent ? rows.latest(missionId, false)?.operationId : undefined;
		await rows.durable();
		// A crash may keep the entered revocation intent but lose its store row.
		// Never resurrect the preceding grant from matching current state.
		if (await this.uncertainRevocation(missionId, consent)) return { state: "unknown" };
		const latest = rows.latest(missionId, consent);
		if (latest?.kind.endsWith("revoke")) return { state: "revoked", record: latest };
		// durable() covers only writes present at invocation, not rows appended during journal I/O.
		// Keep both the observed row and its workflow authority pinned to that completed barrier.
		if (
			latest?.operationId !== record?.operationId ||
			(consent && rows.latest(missionId, false)?.operationId !== approvalOperationId)
		)
			return { state: "unknown" };
		if (!record) return { state: "missing" };
		const mission = this.deps.store.require(missionId);
		if (mission.status !== "active" || (consent && record.confirmed.package.disclosure!.expiresAt <= Date.now()))
			return { state: "expired", record };
		try {
			return {
				state:
					record.confirmed.package.digest === this.build(missionId, record.kind).digest ? "applicable" : "stale",
				record,
			};
		} catch {
			return { state: "stale", record };
		}
	}
	async admit(op: DurableOperation, firstEntry = false): Promise<unknown> {
		if (!isWorkflowOperation(op.kind)) throw new OperationRejected("Unsupported workflow purpose");
		// Recovery and duplicate POSTs never create authority, even without an entered marker.
		// Generic journal.recover calls this with firstEntry=false.
		if (!firstEntry) return this.recoverExact(op);
		let record: WorkflowConfirmationRecord;
		try {
			const value: unknown = JSON.parse(op.payload);
			if (op.kind === "review-disposition") return await this.disposition(op, value);
			exact(value, ["purpose", "package", "expectedPriorOperationId"]);
			if (
				value.purpose !== op.kind ||
				!(value.expectedPriorOperationId === null || id(value.expectedPriorOperationId))
			)
				throw new OperationRejected("Confirmation purpose or prior record is invalid");
			const payload = value as unknown as WorkflowConfirmationPayload;
			if (
				!op.kind.endsWith("revoke") &&
				(await this.uncertainRevocation(op.targetId, op.kind === "review-consent", op.operationId))
			)
				throw new ServiceUnavailable("A prior revocation is uncertain; no new authority");
			const check = () => {
				if (canonicalJSON(payload.package) !== canonicalJSON(this.build(op.targetId, payload.purpose)))
					throw new Conflict("Confirmation package changed; prepare and confirm again");
			};
			check();
			await this.deps.journal.checkpoint(op, {
				stage: "workflow-effect-entered",
				purpose: op.kind,
				payloadHash: op.payloadHash,
			});
			// Synchronous check inside the append transaction closes held-package races.
			record = this.deps.store.workflowConfirmations.append(op, payload, check);
		} catch (error) {
			if (
				error instanceof Conflict ||
				error instanceof NotFound ||
				error instanceof ServiceUnavailable ||
				error instanceof SyntaxError
			)
				throw new OperationRejected(error.message);
			throw error;
		}
		// A durability error of any class is uncertain, never an authoritative rejection.
		await this.deps.store.durable();
		return { operationId: record.operationId, missionId: record.missionId, kind: record.kind };
	}
	private async recoverExact(op: DurableOperation): Promise<unknown> {
		const marker = (await this.deps.journal.lookup(op))?.result;
		if (
			canonicalJSON(marker) !==
			canonicalJSON({ stage: "workflow-effect-entered", purpose: op.kind, payloadHash: op.payloadHash })
		)
			throw new Error("Unknown confirmation entry checkpoint; no replay");
		if (op.kind === "review-disposition") {
			const record = await this.deps.dispositions?.lookup(op);
			if (!record) throw new Error("Unknown entered review disposition; no replay");
			return record;
		}
		const record = this.deps.store.workflowConfirmations.lookup(op);
		if (!record) throw new Error("Unknown entered confirmation; no authority can be recreated");
		await this.deps.store.durable();
		return { operationId: record.operationId, missionId: record.missionId, kind: record.kind };
	}
	private async disposition(op: DurableOperation, value: unknown): Promise<unknown> {
		const request = dispositionPayload(value);
		if (op.targetId !== request.packageDigest)
			throw new OperationRejected("Disposition target must be the exact package digest");
		const source = this.deps.dispositions;
		if (!source) throw new OperationRejected("Durable review feedback source is unavailable");
		const check = async () => {
			if (canonicalJSON(await source.prepare(structuredClone(request))) !== canonicalJSON(request))
				throw new OperationRejected("Review package or authority changed");
		};
		await check();
		if (request.disposition === "approve" && (await source.prerequisites?.(structuredClone(request))) !== "passed")
			throw new OperationRejected("Required checks and agent review have not passed");
		await check();
		await this.deps.journal.checkpoint(op, {
			stage: "workflow-effect-entered",
			purpose: op.kind,
			payloadHash: op.payloadHash,
		});
		// The qualified producer must repeat current target/authority/prerequisite checks in its CAS.
		try {
			return await source.record(op, structuredClone(request));
		} catch (cause) {
			throw new Error("Unknown entered review disposition; check the exact operation", { cause });
		}
	}
}

function validateDisclosure(value: ReviewerConsentDisclosure): void {
	exact(value, [
		"configurationRevision",
		"provider",
		"model",
		"account",
		"terms",
		"dataScope",
		"retention",
		"expiresAt",
		"missionLimitMicros",
		"logicalTaskLimitMicros",
		"cumulativeAcrossRechecks",
		"refillOnReplacement",
		"paidFallback",
	]);
	if (
		![value.configurationRevision, value.provider, value.model, value.account, value.terms].every(
			(s) => typeof s === "string" && s.trim().length > 0 && s.length <= 2000,
		) ||
		value.dataScope !== "exact-local-research-plan-revisions" ||
		value.retention !== "raw-30-days-records-90-days-active-pins-excepted" ||
		!Number.isSafeInteger(value.expiresAt) ||
		value.expiresAt <= Date.now() ||
		value.missionLimitMicros !== 20_000_000 ||
		value.logicalTaskLimitMicros !== 4_000_000 ||
		value.cumulativeAcrossRechecks !== true ||
		value.refillOnReplacement !== false ||
		value.paidFallback !== false
	)
		throw new Conflict("Reviewer disclosure or cumulative allowance is invalid");
}

export function dispositionPayload(value: unknown, draft = false): ReviewDispositionPayload {
	if (
		value &&
		typeof value === "object" &&
		Object.hasOwn(value, "feedback") &&
		Buffer.byteLength(JSON.stringify(value)) > 48 * 1024
	)
		throw new OperationRejected("Review payload exceeds 48 KiB");
	exact(value, [
		"purpose",
		"targets",
		"disposition",
		"body",
		"expectedPriorRecordId",
		"packageDigest",
		...(value && typeof value === "object" && Object.hasOwn(value, "feedback") ? ["feedback"] : []),
	]);
	if (Object.hasOwn(value, "feedback")) {
		try {
			validateFeedback(value.feedback);
		} catch {
			throw new OperationRejected("Invalid human review feedback");
		}
	}
	if (
		value.purpose !== "review-disposition" ||
		!["comment", "request_changes", "approve"].includes(value.disposition as string) ||
		typeof value.body !== "string" ||
		Buffer.byteLength(value.body) > 16 * 1024 ||
		(!draft &&
			value.disposition !== "approve" &&
			!value.body.trim() &&
			!(value.feedback as ReviewDispositionPayload["feedback"])?.annotations.length &&
			!(value.feedback as ReviewDispositionPayload["feedback"])?.findings.length &&
			!(value.feedback as ReviewDispositionPayload["feedback"])?.resolveAnnotationIds.length &&
			!(value.feedback as ReviewDispositionPayload["feedback"])?.supersedes) ||
		!(value.expectedPriorRecordId === null || id(value.expectedPriorRecordId)) ||
		!hash(value.packageDigest) ||
		!Array.isArray(value.targets) ||
		!value.targets.length ||
		value.targets.length > 20
	)
		throw new OperationRejected("Invalid exact review disposition");
	const seen = new Set<string>();
	for (const target of value.targets) {
		exact(target, [
			"projectId",
			"sessionId",
			"snapshotId",
			"repositoryId",
			"changeId",
			"baseCommitId",
			"headCommitId",
			"layer",
			"diffSha256",
			"comparisonDigest",
		]);
		if (
			![target.projectId, target.sessionId].every(id) ||
			typeof target.changeId !== "string" ||
			!changeIdPattern.test(target.changeId) ||
			![target.snapshotId, target.repositoryId, target.diffSha256, target.comparisonDigest].every(hash) ||
			![target.baseCommitId, target.headCommitId].every((s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)) ||
			!["layer", "stack"].includes(target.layer as string) ||
			seen.has(target.snapshotId as string)
		)
			throw new OperationRejected("Invalid or duplicate selected comparison");
		seen.add(target.snapshotId as string);
	}
	return structuredClone(value) as unknown as ReviewDispositionPayload;
}
