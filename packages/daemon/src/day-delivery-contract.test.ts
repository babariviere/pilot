import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveredWork, UserVerificationLookup, VerificationSubject } from "@pilot/protocol";
import type {
	UserVerificationLookup as NativeLookup,
	VerificationSubject as NativeSubject,
	DeliveredWork as NativeView,
} from "../../../apps/day/deliveryContract.ts";

// These assignments are checked by tsgo without loading NSH or its platform VM.
// Core identity/receipt shapes must stay exact; the output view can be narrower.
const subject: (v: VerificationSubject) => NativeSubject = (v) => v;
const canonicalSubject: (v: NativeSubject) => VerificationSubject = (v) => v;
const lookup: (v: UserVerificationLookup) => NativeLookup = (v) => v;
const canonicalLookup: (v: NativeLookup) => UserVerificationLookup = (v) => v;
const view: (v: DeliveredWork) => NativeView = (v) => v;
type Fields = Exclude<keyof DeliveredWork, "pullRequests" | "artifacts">;
const canonicalFields: (v: NativeView) => Pick<DeliveredWork, Fields> = (v) => v;

test("Day wire view keeps canonical identities, assessments and receipt pairs", () => {
	const v: VerificationSubject = { kind: "chat", projectId: "project", sessionId: "session" };
	assert.equal(canonicalSubject(subject(v)), v);
	const unknown: UserVerificationLookup = { receipt: { state: "unknown" }, verificationReceipt: null };
	assert.equal(canonicalLookup(lookup(unknown)), unknown);
	// Keep the projection signatures referenced without inventing domain fixtures.
	assert.equal(typeof view, "function");
	assert.equal(typeof canonicalFields, "function");
});
