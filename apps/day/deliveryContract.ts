// NSH-safe view of the canonical DeliveredWork contract. No Node SDK imports.
// The daemon's compile-time contract test checks every field this view exposes.
// This describes wire data only, not a second verification/domain store.
import type { DurableOperation, OperationReceipt } from "../../packages/protocol/src/operations.ts";

export type VerificationSubject =
	| { kind: "task"; projectId: string; missionId: string; taskId: string }
	| { kind: "chat"; projectId: string; sessionId: string };

export interface UserVerification {
	version: 1;
	subject: VerificationSubject;
	deliveryId: string;
	revision: number;
	operationId: string;
	state: "done" | "sent_back" | "open";
	note: string;
	createdAt: number;
	messageReceipt?: { sessionId: string; requestId: string; state: "admitted" };
}

export interface UserVerificationLookup {
	receipt: OperationReceipt | { state: "unknown" };
	verificationReceipt: {
		operation: DurableOperation;
		operationId: string;
		payloadHash: string;
		intent: {
			purpose: "user-verification";
			subject: VerificationSubject;
			deliveryId: string;
			expectedRevision: number;
			action: "done" | "send_back" | "reopen";
			note: string;
		};
		verification: UserVerification;
		state: "pending" | "accepted";
	} | null;
}

type Evidence = { kind: "brief"; revision: number } | { kind: "artifact"; artifactId: string; revision: number };

/** Canonical fields used by Day. Unlisted output metadata is passed through unchanged. */
export interface DeliveredWork {
	version: 1;
	subject: VerificationSubject;
	deliveryId: string | null;
	targetId: string;
	ownerSessionId: string | null;
	completion?: { commit: string; checks: string; issues: string };
	nonCodeDelivery?: { kind: "non-code"; references: Evidence[]; checks: string; limitations: string };
	submissionId?: string;
	submission?: {
		id: string;
		kind: "code" | "native-ui" | "research";
		claim: string;
		limitations: string;
		evidence: Array<Evidence | { kind: "snapshot"; snapshotId: string }>;
	};
	outcome?: { outcomeAt: number; reason?: string };
	pullRequests: Array<{
		id: string;
		url: string;
		title?: string;
		kind: string;
		taskId?: string;
		relationship: "ownership" | "reference";
		owner?: { id: string; title: string } | null;
		pullRequest?: {
			number: number;
			url: string;
			title: string;
			state: "draft" | "open" | "merged" | "closed";
			branch?: string;
			mergedAt?: number;
			checkedAt: number;
			readiness?: {
				state: "ready" | "pending" | "blocked";
				checkedAt: number;
				reasons: Array<{ code: string; names?: string[] }>;
			};
		};
	}>;
	artifacts: Array<{
		artifactId: string;
		sessionId: string;
		title: string;
		kind: string;
		taskId?: string;
		revision?: number;
		linkedAt: number;
	}>;
	production: "not_tracked";
	verification: UserVerification | null;
	verificationCurrent: boolean;
	verificationReceiptState: "accepted" | "unknown";
	verificationRevision: number;
	pendingOperationId: string | null;
}

/** One bounded post-cutoff page. A list never settles an operation. */
export type DeliveryList = {
	version: 1;
	projectId: string;
	baseline: { mode: "start_fresh"; sourceSequence: number };
	sourceCursor: number;
	nextCursor: number | null;
	complete: boolean;
	more: boolean;
	currentness: "live" | "stale";
	items: { subject: VerificationSubject; title: string; snapshot: DeliveredWork; sourceSequence: number }[];
};
