/** Inactive host integration seam. No installed caller, executor, provider adapter, route or gate. */
import type { ReviewCallRequest, ReviewProviderGates } from "./critical-review-accounting.ts";
import { ReviewAccounting } from "./critical-review-accounting.ts";
import type { CriticalReviewStore } from "./critical-review-store.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON } from "./operation-journal.ts";
import type { InputDescriptor, PreparedRetainedReviewInput } from "./retained-review-contract.ts";
import {
	compareRetainedReviewTargetInput,
	retainedReviewLinkageDigest as digest,
	type RetainedReviewCallClaim,
	type RetainedReviewCompletionClaim,
	type RetainedReviewProducerClaim,
	type RetainedReviewTargetClaim,
	type RetainedReviewUsageClaim,
} from "./retained-review-linkage-contract.ts";
import type { RetainedRunAdmission, RetainedRunCompletion } from "./retained-review-run-disk.ts";
import type { WorkflowConfirmations } from "./workflow-confirmations.ts";

export interface RetainedRunHost {
	/** Actual local host identity, not a target-supplied budget namespace. */
	hostId: string;
	/** Authorize known run metadata before looking up its stored binding. */
	authorizeRun(runId: string): void;
	/** Current coordinator, task/owner/assignment/allocation/profile/config + all ABA fences.
	 * Synchronous, repeated after every await. Does NOT grant dispatch authority. */
	authorize(target: RetainedReviewTargetClaim): void;
	/** Host-owned replacement/transfer history. No default if history is unresolved. */
	logicalTask(target: RetainedReviewTargetClaim): string;
	/** Actual existing acquisition path, including current source and exact sealed-vault checks. */
	reopen(descriptor: InputDescriptor): Promise<PreparedRetainedReviewInput>;
}
export class RetainedReviewRuns {
	private readonly store: CriticalReviewStore;
	private readonly missions: MissionStore;
	private readonly confirmations: WorkflowConfirmations;
	private readonly host: RetainedRunHost;
	private readonly accounting: ReviewAccounting;
	constructor(
		store: CriticalReviewStore,
		missions: MissionStore,
		confirmations: WorkflowConfirmations,
		host: RetainedRunHost,
	) {
		this.store = store;
		this.missions = missions;
		this.confirmations = confirmations;
		this.host = host;
		this.accounting = new ReviewAccounting(store);
	}
	private authorize(a: RetainedRunAdmission): void {
		if (a.target.hostId !== this.host.hostId) throw new Error("Retained cross-host transfer is unsupported");
		this.host.authorize(a.target);
		if (this.host.logicalTask(a.target) !== a.logicalTaskId)
			throw new Error("Retained accounting lineage changed or unresolved");
	}
	private async current(a: RetainedRunAdmission): Promise<void> {
		this.authorize(a);
		const consent = await this.confirmations.current(a.target.missionId, true);
		this.authorize(a);
		if (consent.state !== "applicable" || canonicalJSON(consent.record) !== canonicalJSON(a.consent))
			throw new Error("Exact current retained reviewer consent unavailable");
	}
	async admit(admission: RetainedRunAdmission, gates: ReviewProviderGates): Promise<void> {
		const a = structuredClone(admission);
		await this.current(a);
		const input = await this.host.reopen(a.input.descriptor as InputDescriptor);
		this.authorize(a);
		if (
			!compareRetainedReviewTargetInput(a.target, a.binding, input) ||
			canonicalJSON(input) !== canonicalJSON(a.input)
		)
			throw new Error("Actual retained input changed");
		await this.current(a);
		await this.store.rpc("retainedAdmit", { admission: a, gates });
		await this.current(a);
	}
	private async admission(runId: string): Promise<RetainedRunAdmission> {
		// Trusted metadata only. Authorization happens before any raw completion lookup.
		this.host.authorizeRun(runId);
		const a = await this.store.rpc<RetainedRunAdmission>("retainedAdmission", { runId });
		this.host.authorizeRun(runId);
		this.authorize(a);
		return a;
	}
	async reserve(request: ReviewCallRequest) {
		const a = await this.admission(request.runId);
		await this.current(a);
		if (request.approvalId !== a.binding.admissionId) throw new Error("Wrong retained admission");
		const result = await this.accounting.reserve(request);
		await this.current(a);
		return result;
	}
	/** Consumes the existing one-time claim. A lost ACK MUST NOT be retried as a provider send.
	 * This is accounting, not authority to install/call a provider. */
	async claimSend(runId: string, callId: string, gates: ReviewProviderGates): Promise<void> {
		const a = await this.admission(runId);
		const reservation = await this.store.get("reservation", callId);
		this.authorize(a);
		if (reservation?.runId !== runId) throw new Error("Call belongs to another run");
		await this.current(a);
		await this.accounting.send(callId, gates);
		await this.current(a);
	}
	/** Private host channel only. These methods are deliberately absent from tools/REST. */
	async observeCall(value: RetainedReviewCallClaim, channelGeneration: string): Promise<void> {
		const result = await this.store.rpc<{ conflict: boolean }>("retainedObserve", {
			kind: "call",
			value,
			channelGeneration,
		});
		if (result.conflict) throw new Error("Retained call conflict; quarantined");
	}
	usage(value: RetainedReviewUsageClaim, channelGeneration: string): Promise<void> {
		return this.store.rpc("retainedUsage", { value, channelGeneration });
	}
	async complete(
		value: RetainedReviewCompletionClaim,
		raw: Uint8Array | null,
		channelGeneration: string,
	): Promise<void> {
		if (raw !== null && raw.byteLength > 50 * 1024) throw new Error("Retained report exceeds byte limit");
		const a = await this.admission(value.runId);
		await this.current(a);
		const result = await this.store.rpc<{ conflict: boolean }>("retainedObserve", {
			kind: "completion",
			value,
			channelGeneration,
			rawBase64: raw === null ? null : Buffer.from(raw).toString("base64"),
		});
		if (result.conflict) throw new Error("Retained completion conflict; quarantined");
		await this.current(a);
	}
	revoke(runId: string): Promise<void> {
		return this.store.rpc("retainedRevoke", { runId });
	}
	/** Only an actual host join/drain acknowledgement may supply this. Ledger finish is insufficient. */
	exited(runId: string, observation: string, channelGeneration: string): Promise<void> {
		return this.store.rpc("retainedExited", { runId, observation, channelGeneration });
	}
	async project(runId: string, operationId: string) {
		const a = await this.admission(runId);
		await this.current(a);
		const completion = await this.store.rpc<RetainedRunCompletion | undefined>("retainedCompletion", { runId });
		await this.current(a);
		if (!completion) throw new Error("Retained completion unavailable or quarantined");
		const c = completion.claim;
		const producer: RetainedReviewProducerClaim = {
			version: 1,
			kind: "host-retained-run",
			runId,
			admissionId: a.binding.admissionId,
			completionId: c.completionId,
			bindingSha256: digest("binding", a.binding),
			completionSha256: digest("completion", c),
			rawSha256: c.raw.kind === "bytes" ? c.raw.sha256 : null,
		};
		const result = await this.missions.retainedReviewProjections.record(
			{
				version: 1,
				kind: "retained-run-reference",
				operationId,
				target: a.target,
				producer,
				consentOperationId: a.consent.operationId,
			},
			() => this.authorize(a),
		);
		await this.current(a);
		// A conflict/revocation arriving during the other store's durability wait invalidates the return.
		const after = await this.store.rpc<RetainedRunCompletion | undefined>("retainedCompletion", { runId });
		await this.current(a);
		if (canonicalJSON(after) !== canonicalJSON(completion))
			throw new Error("Retained completion changed availability");
		return result;
	}
}
