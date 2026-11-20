import type { MissionDeliveryScreens } from "../missions/mission-reports.ts";
import type {
	MissionArtifactLink,
	MissionCodeCompletion,
	MissionNonCodeDelivery,
	MissionNonCodeDeliveryReference,
	MissionResource,
} from "../missions/missions.ts";
import type { DurableOperation, OperationReceipt } from "./operations.ts";
import type { VerificationSubject } from "./verification-subject.ts";

export type { VerificationSubject } from "./verification-subject.ts";

/** Explicit native user assessment only. Never task status or execution authority. */
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
	/** Send-back destination shown by the native app. Absent means the delivery's owner (legacy). */
	revisionRecipientSessionId?: string;
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
	/**
	 * Where the owning chat is, while there is no delivered result: so the page can offer the action that moves it.
	 * `queued` waits for a coding slot; `canContinue` as in SessionSummary. `waiting` is SessionSummary.waitsForReply,
	 * shown even with an earlier result, with the chat's last message in `says` (full reads only). Omitted with a
	 * result or without a chat.
	 */
	chat?: {
		state: "working" | "queued" | "question" | "waiting" | "stopped" | "failed" | "done" | "idle";
		reason?: string;
		/** With `queued`: its place in line and what holds the slots. */
		queue?: import("../chats/coding-queue.ts").CodingQueueView;
		canContinue?: true;
		says?: string;
	};
	/** A standalone chat's own title. Tasks are named by their mission's records instead. */
	title?: string;
	scope?: string;
	taskState?: string;
	reviewQueue?: "later" | "selected";
	/** Existing same-mission coordinator for revision routing; otherwise the owner receives it. */
	revisionRecipientSessionId?: string;
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
	/**
	 * A finished standalone chat's last reply, word for word: what it answered, when it saved no report. Its words,
	 * not a saved report or Pilot's check. `shortened` when the reply was longer than Pilot keeps here.
	 */
	finalReply?: { text: string; shortened: boolean };
	/**
	 * In a planned mission with no execution coordinator: the task worker's latest delivery report. The worker's
	 * account, not a coordinator's completion or Pilot's check.
	 */
	workerDelivery?: {
		reportId: string;
		reportedAt: number;
		summary: string;
		nextStep: string;
		evidence: string[];
		/** Omitted when the task changed no code. */
		commit?: string;
		checks: string;
		issues: string;
	};
	/** In the same missions: open comments the task's worker addressed to the coordinator. Newest first, at most 10. */
	coordinatorRequests?: Array<{ id: string; text: string; at: number }>;
	/**
	 * A task's screens from its current worker's latest report that names them: captures of the real app, or why
	 * there are none. The worker's account; each ID matches one of `artifacts` while it stays linked and pinned.
	 */
	screens?: MissionDeliveryScreens & { reportId: string; reportedAt: number };
	/** The report a job chat (started from Slack, Linear or a schedule) saved with `chat_report` in its latest run. */
	chatReport?: ChatReport;
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

/** Task results only. Standalone chats remain discoverable through acknowledged starts/saved checks. */
export interface DeliveredWorkList {
	version: 1;
	projectId: string;
	baseline: { mode: "start_fresh"; sourceSequence: number };
	sourceCursor: number;
	nextCursor: number | null;
	/** No more sources after this page's cursor. Not a claim about history or earlier pages. */
	complete: boolean;
	more: boolean;
	currentness: "live" | "stale";
	items: Array<{ subject: VerificationSubject; title: string; snapshot: DeliveredWork; sourceSequence: number }>;
	selected?: Array<{ subject: VerificationSubject; title: string; snapshot: DeliveredWork }>;
	selectedMore?: boolean;
	selectedUnavailable?: boolean;
}

/** A job chat's own report of its answer. The agent's words, not Pilot's check. */
export interface ChatReport {
	answer: string;
	howItKnows?: string;
	limits?: string;
	nextStep?: string;
	links?: Array<{ url: string; title?: string }>;
	/** When the chat saved it, epoch milliseconds. */
	at: number;
}
