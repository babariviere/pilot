// The native host owns exact operations and receipt pairs across window lifetimes.
// These methods never infer success from an agent report, a PR, or a passive read.
import { call, type Refusal } from "./bridge";
import type { DeliveredWork, UserVerificationLookup, VerificationSubject } from "./deliveryContract";

export type { DeliveredWork, VerificationSubject };

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
	| { ok: true; snapshot: DeliveredWork | null; operations: DeliveryOperation[]; outcome: DeliveryOperation | null }
	| { ok: false; refusal: Refusal };

async function invoke(window: string, name: string, args: unknown): Promise<DeliveryReply> {
	const r = await call<DeliveredWork | null>(window, name, args);
	if (!r.ok) return r;
	return {
		ok: true,
		snapshot: r.snapshot,
		operations: r.value.operations as DeliveryOperation[],
		outcome: (r.value.outcome ?? null) as DeliveryOperation | null,
	};
}

/** Authenticated passive read. No model start, subscription or verification effect. */
export function readDelivery(window: string, subject: VerificationSubject): Promise<DeliveryReply> {
	return invoke(window, "day.delivery.read", subject);
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
