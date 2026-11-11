import type {
	DurableOperation,
	MissionArtifactLink,
	MissionCodeCompletion,
	MissionNonCodeDelivery,
	MissionNonCodeDeliveryReference,
	MissionResource,
	OperationReceipt,
} from "./index.ts";

/** Explicit native user assessment only. Never task status or execution authority. */
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
	/** Present only after ordinary durable message admission acknowledges the exact note. */
	messageReceipt?: { sessionId: string; requestId: string; state: "admitted" };
}

export interface UserVerificationIntent {
	purpose: "user-verification";
	subject: VerificationSubject;
	deliveryId: string;
	expectedRevision: number;
	action: "done" | "send_back" | "reopen";
	note: string;
}

/** Both receipts must match the saved immutable operation before displaying success. */
export interface UserVerificationReceipt {
	operation: DurableOperation;
	operationId: string;
	payloadHash: string;
	intent: UserVerificationIntent;
	verification: UserVerification;
	state: "pending" | "accepted";
}
export interface UserVerificationLookup {
	receipt: OperationReceipt | { state: "unknown" };
	verificationReceipt: UserVerificationReceipt | null;
}

export interface DeliveredWork {
	version: 1;
	subject: VerificationSubject;
	/** Null means no canonical delivered result. Task Done and agent reports are not deliveries. */
	deliveryId: string | null;
	/** Opaque OperationJournal target. Use unchanged; clients need not reproduce canonical hashing. */
	targetId: string;
	ownerSessionId: string | null;
	completion?: MissionCodeCompletion;
	nonCodeDelivery?: MissionNonCodeDelivery;
	/** Identity of the latest canonical evidence submission, not its review judgement. */
	submissionId?: string;
	submission?: {
		id: string;
		kind: "code" | "native-ui" | "research";
		claim: string;
		limitations: string;
		evidence: Array<MissionNonCodeDeliveryReference | { kind: "snapshot"; snapshotId: string }>;
	};
	outcome?: { outcomeAt: number; reason?: string };
	pullRequests: MissionResource[];
	artifacts: MissionArtifactLink[];
	production: "not_tracked";
	/** Latest historical assessment may be stale for the current delivery. */
	verification: UserVerification | null;
	verificationCurrent: boolean;
	/** A saved domain row without its matching accepted outer receipt is still Unknown. */
	verificationReceiptState: "accepted" | "unknown";
	verificationRevision: number;
	/** An entered Send back without its final receipt blocks new assessments. Check only. */
	pendingOperationId: string | null;
}
