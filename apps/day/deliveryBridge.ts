// The native host owns exact operations and receipt pairs across window lifetimes.
// These methods never infer success from an agent report, a PR, or a passive read.
import { call, type Refusal } from "./bridge";
import type { DeliveredWork, DeliveryList, UserVerificationLookup, VerificationSubject } from "./deliveryContract";

export type { DeliveredWork, VerificationSubject };

/** Native selects the project; a page cursor never retargets the window. */
export function listDeliveries(window: string, after?: number) {
	return call<DeliveryList>(window, "day.delivery.list", after === undefined ? {} : { after });
}

/** Availability comes from the native owner, never from an output's URL. */
export interface OutputCapabilities {
	web: boolean;
	artifacts: false;
	documents: false;
	paths: false;
}

/** Immutable native command summary. Unknown permits only Check of operationId. */
export interface DeliveryOperation {
	operationId: string;
	subject: VerificationSubject;
	targetId: string;
	deliveryId: string;
	expectedRevision: number;
	ownerSessionId: string | null;
	action: "done" | "send_back" | "reopen";
	note: string;
	state: "unknown" | "accepted" | "rejected" | "not-sent";
	lookup: (UserVerificationLookup & { state: "accepted" | "rejected" }) | null;
	receiptSaved?: false;
}

/** Canonical evidence stays in snapshot. Operation acknowledgements stay separate. */
export type DeliveryReply =
	| {
			ok: true;
			snapshot: DeliveredWork | null;
			operations: DeliveryOperation[];
			outcome: DeliveryOperation | null;
			outputCapabilities?: OutputCapabilities;
	  }
	| { ok: false; refusal: Refusal };

async function invoke(window: string, name: string, args: unknown): Promise<DeliveryReply> {
	const r = await call<DeliveredWork | null>(window, name, args);
	if (!r.ok) return r;
	return {
		ok: true,
		snapshot: r.snapshot,
		operations: r.value.operations as DeliveryOperation[],
		outcome: (r.value.outcome ?? null) as DeliveryOperation | null,
		outputCapabilities: r.value.outputCapabilities as OutputCapabilities | undefined,
	};
}

/** Authenticated passive read. No model start, subscription or verification effect. */
export function readDelivery(window: string, subject: VerificationSubject): Promise<DeliveryReply> {
	return invoke(window, "day.delivery.read", subject);
}

/** The saved command summaries only. No service read, Check or effect. */
export function readSavedDeliveries(window: string): Promise<DeliveryReply> {
	return invoke(window, "day.delivery.saved", {});
}

/** Explicit user assessment of precisely this displayed delivery and revision. */
export function assessDelivery(
	window: string,
	shown: DeliveredWork,
	action: "done" | "send_back" | "reopen",
	note = "",
): Promise<DeliveryReply> {
	const method = action === "send_back" ? "sendBack" : action;
	return invoke(window, `day.delivery.${method}`, {
		subject: shown.subject,
		targetId: shown.targetId,
		deliveryId: shown.deliveryId,
		expectedRevision: shown.verificationRevision,
		ownerSessionId: shown.ownerSessionId,
		note,
	});
}

/** Lookup only. No new envelope, delivery read, reset, retarget or resend. */
export function checkDelivery(window: string, operationId: string): Promise<DeliveryReply> {
	return invoke(window, "day.delivery.check", { operationId });
}

/** A local selection saved before a push ran. Never proof that it reached GitHub. */
export type LocalSelection =
	| { status: "unknown" }
	| {
			status: "owned";
			revisions: { changeId: string; commitId: string; startCommitId: string; baselineCommitId: string | null }[];
	  };

/** One saved push or PR-creation record of the chat that did the work. */
export interface PublicationRecord {
	id: string;
	kind: "push" | "pr_opened";
	branch: string | null;
	prNumber: number | null;
	url: string | null;
	summary: string;
	description: string;
	at: number;
	exitCode: number | null;
	/** Absent on records saved before attempts and results were kept apart. */
	publication: {
		attemptId: string;
		stage: "attempted" | "confirmed" | "unknown";
		evidence: "command-dispatch" | "command-result";
		local: LocalSelection;
	} | null;
}

/** One retained comparison's owned change and how it changed, at one pinned repository operation. */
export type OwnedChange =
	| { snapshotId: string; state: "unavailable" }
	| {
			snapshotId: string;
			state: "shown";
			changeId: string;
			creationCommitId: string;
			baselineCommitId: string | null;
			current: "present" | "absent";
			seed: "current" | "retained-observation" | "creation-only";
			revisions: { changeId: string; commitId: string; parents: string[]; ownedChange: boolean }[];
			more: boolean;
			operationId: string;
	  };

/** What Pilot recorded about the agent's work on one exact result. Not its report or the user's check. */
export interface AgentWork {
	version: 1;
	reference: { subject: VerificationSubject; targetId: string; deliveryId: string; ownerSessionId: string };
	changes: OwnedChange[];
	moreChanges: boolean;
	publication:
		| { state: "unavailable" }
		| { state: "shown"; scope: "mission" | "chat"; actions: PublicationRecord[]; more: boolean };
}

/** Passive read of the shown result's Agent work. Native checks the result again after it. */
export function readAgentWork(window: string, shown: DeliveredWork) {
	return call<AgentWork>(window, "day.delivery.work", {
		subject: shown.subject,
		targetId: shown.targetId,
		deliveryId: shown.deliveryId,
		ownerSessionId: shown.ownerSessionId,
	});
}

/** One user press on an exact displayed PR resource. Never retry after a lost
 * answer. Native rechecks canonical scope and target before its URL-only callback.
 * Opening is not acceptance; artifacts, documents and paths are unsupported. */
export async function openDeliveryOutput(
	window: string,
	shown: DeliveredWork,
	resource: DeliveredWork["pullRequests"][number],
): Promise<{ ok: true; opened: true; url: string } | { ok: false; refusal: Refusal }> {
	const url = resource.pullRequest?.url || resource.url;
	const r = await call<null>(window, "day.delivery.open", {
		subject: shown.subject,
		targetId: shown.targetId,
		deliveryId: shown.deliveryId,
		ownerSessionId: shown.ownerSessionId,
		resourceId: resource.id,
		url,
	});
	if (!r.ok) return r;
	return r.value.opened === true && r.value.url === url && r.value.outcome === null
		? { ok: true, opened: true, url }
		: { ok: false, refusal: "unknown" };
}
