/** INACTIVE supplied-claim contracts. No admission, execution, journal, accounting or authority. */
import type { MissionAssignment } from "@pilot/protocol";
import { deliveryAssignment, deliveryDigest } from "./mission-delivery-evidence.ts";

export const RETAINED_REVIEW_LINKAGE_LIMITS = Object.freeze({
	jsonBytes: 64 * 1024,
	nodes: 4096,
	depth: 16,
	keys: 256,
	array: 128,
	calls: 32,
	usage: 32,
	authorLineages: 20,
	id: 128,
	source: 256,
	reason: 2000,
	rawBytes: 50 * 1024,
});
type ReadonlyData<T> = T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
type Stop = { kind: "observed"; source: string; exactReason: string } | { kind: "unknown" };
type Billing = "api" | "subscription";
export type RetainedReviewTargetClaim = ReadonlyData<{
	version: 1;
	kind: "retained-non-code";
	targetId: string;
	hostId: string;
	daemonLineageId: string;
	projectId: string;
	missionId: string;
	taskId: string;
	ownerSessionId: string;
	coordinatorSessionId: string;
	policyId: string;
	submissionId: string;
	allocationId: string;
	definitionRevision: number;
	assignment: MissionAssignment;
	contextFence: {
		briefRevision: number;
		decisionEventId: number;
		artifactEventId: number;
		memberEventId: number;
		coordinatorEventId: number;
	};
	inputSha256: string;
	manifestId: string;
	manifestSha256: string;
	profileId: string;
	profileRevision: number;
	profileSha256: string;
	contextSha256: string;
	runtimeSha256: string;
	contextPackageSha256: string;
}>;
export type RetainedReviewRunBindingClaim = ReadonlyData<{
	version: 1;
	kind: "retained-run-binding";
	runId: string;
	targetId: string;
	targetSha256: string;
	admissionId: string;
	lineageId: string;
	evidenceId: string;
	contextId: string;
	configObservationId: string;
	channelGeneration: string;
	inputSha256: string;
	profileSha256: string;
	contextSha256: string;
	runtimeSha256: string;
	provider: string;
	model: string;
	account: { kind: "claimed"; bindingId: string; billing: Billing; configSha256: string } | { kind: "unknown" };
	authorLineage: { kind: "claimed"; lineageIds: string[]; basis: string } | { kind: "unknown" };
}>;
export type RetainedReviewCallClaim = ReadonlyData<{
	version: 1;
	kind: "retained-call";
	observationId: string;
	runId: string;
	callId: string;
	bindingSha256: string;
	stop: Stop;
}>;
export type RetainedReviewUsageClaim = ReadonlyData<{
	version: 1;
	kind: "retained-usage";
	observationId: string;
	runId: string;
	callId: string;
	bindingSha256: string;
	receiptSource: string;
	receiptIdentity: string;
	rateSha256: string;
	billing: Billing;
	input: number;
	generated: number;
	durationMs: number;
}>;
export type RetainedReviewCompletionClaim = ReadonlyData<{
	version: 1;
	kind: "retained-completion";
	completionId: string;
	runId: string;
	bindingSha256: string;
	terminalCallId: string | null;
	hostTermination: Stop;
	raw:
		| { kind: "bytes"; sha256: string; bytesRef: string; length: number }
		| { kind: "no-output"; reason: string }
		| { kind: "unknown" };
	usageAtCompletion: { kind: "observed"; usageObservationIds: string[] } | { kind: "unknown" };
}>;
export type RetainedReviewProducerClaim = ReadonlyData<{
	version: 1;
	kind: "host-retained-run";
	runId: string;
	admissionId: string;
	completionId: string;
	bindingSha256: string;
	completionSha256: string;
	rawSha256: string | null;
}>;
interface Claims {
	target: RetainedReviewTargetClaim;
	binding: RetainedReviewRunBindingClaim;
	call: RetainedReviewCallClaim;
	usage: RetainedReviewUsageClaim;
	completion: RetainedReviewCompletionClaim;
	producer: RetainedReviewProducerClaim;
}
type ClaimKind = keyof Claims;
export type RetainedReviewClaimComparison = "replay" | "conflict" | "distinct" | "corroboration";

function invalid(): never {
	throw new Error("Invalid retained-review linkage claim");
}
function fields(v: unknown, names: readonly string[]): asserts v is Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) invalid();
	const keys = Object.keys(v);
	if (keys.length !== names.length || keys.some((key) => !names.includes(key))) invalid();
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) invalid();
	return v as number;
}
function id(v: unknown): string {
	if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) invalid();
	return v;
}
function sha(v: unknown): string {
	if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) invalid();
	return v;
}
function exactText(v: unknown, max: number): string {
	if (typeof v !== "string" || v.length === 0 || v.length > max) invalid();
	return v; // No trimming, case folding, categorization or Unicode normalization.
}
function billing(v: unknown): Billing {
	if (v !== "api" && v !== "subscription") invalid();
	return v;
}
function list<T>(v: unknown, parse: (item: unknown) => T, max: number, min = 0): T[] {
	if (!Array.isArray(v) || v.length < min || v.length > max) invalid();
	return v.map(parse);
}
function unique(values: readonly unknown[]): void {
	if (new Set(values).size !== values.length) invalid();
}
function freeze<T>(v: T): ReadonlyData<T> {
	if (!v || typeof v !== "object") return v as ReadonlyData<T>;
	const result = Array.isArray(v)
		? v.map((child) => freeze(child))
		: Object.fromEntries(Object.entries(v).map(([key, child]) => [key, freeze(child)]));
	return Object.freeze(result) as ReadonlyData<T>;
}

/** Aggregate preflight BEFORE parsing, normalization or hashing. Never invoke accessors/toJSON.
 * Proxies are not an isolation boundary; reflective traps cannot be made inert by a JSON parser. */
function snapshot(value: unknown): unknown {
	const limits = RETAINED_REVIEW_LINKAGE_LIMITS;
	let bytes = 0;
	let nodes = 0;
	const ancestors = new Set<object>();
	const visit = (v: unknown, depth: number): unknown => {
		if (++nodes > limits.nodes || depth > limits.depth) invalid();
		if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
			bytes += String(v).length;
		} else if (typeof v === "string") {
			if (v.length > limits.jsonBytes) invalid();
			bytes += Buffer.byteLength(JSON.stringify(v));
		} else if (v && typeof v === "object") {
			if (ancestors.has(v)) invalid();
			const array = Array.isArray(v);
			const prototype = Object.getPrototypeOf(v);
			if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
			const keys = Reflect.ownKeys(v);
			if (keys.length > limits.keys || (array && (v.length > limits.array || keys.length !== v.length + 1)))
				invalid();
			ancestors.add(v);
			const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
			bytes += 2 + Math.max(0, keys.length - (array ? 2 : 1));
			for (const key of keys) {
				if (array && key === "length") continue;
				if (typeof key !== "string" || key.length > limits.id) invalid();
				if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) invalid();
				const property = Object.getOwnPropertyDescriptor(v, key)!;
				if (!property.enumerable || !("value" in property)) invalid();
				bytes += array ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1;
				if (bytes > limits.jsonBytes) invalid();
				(result as Record<string, unknown>)[key] = visit(property.value, depth + 1);
			}
			ancestors.delete(v);
			if (bytes > limits.jsonBytes) invalid();
			return result;
		} else invalid();
		if (bytes > limits.jsonBytes) invalid();
		return v;
	};
	return visit(value, 0);
}
// Snapshot a named aggregate, so each public operation has ONE byte/node/depth budget.
function args(value: Record<string, unknown>): Record<string, unknown> {
	return snapshot(value) as Record<string, unknown>;
}
function header(v: unknown, kind: string, names: readonly string[]): asserts v is Record<string, unknown> {
	fields(v, ["version", "kind", ...names]);
	if (v.version !== 1 || v.kind !== kind) invalid();
}
function kindOf(v: unknown): unknown {
	return v && typeof v === "object" ? (v as Record<string, unknown>).kind : undefined;
}
const inputHashes = ["inputSha256", "profileSha256", "contextSha256", "runtimeSha256"] as const;
const targetIds = [
	"hostId",
	"daemonLineageId",
	"projectId",
	"missionId",
	"taskId",
	"ownerSessionId",
	"coordinatorSessionId",
	"policyId",
	"submissionId",
	"allocationId",
] as const;
const fenceKeys = [
	"briefRevision",
	"decisionEventId",
	"artifactEventId",
	"memberEventId",
	"coordinatorEventId",
] as const;
function target(v: unknown): RetainedReviewTargetClaim {
	header(v, "retained-non-code", [
		"targetId",
		...targetIds,
		"definitionRevision",
		"assignment",
		"contextFence",
		...inputHashes,
		"manifestId",
		"manifestSha256",
		"profileId",
		"profileRevision",
		"contextPackageSha256",
	]);
	id(v.targetId);
	for (const key of targetIds) id(v[key]);
	for (const key of [...inputHashes, "manifestSha256", "contextPackageSha256"]) sha(v[key]);
	id(v.manifestId);
	id(v.profileId);
	integer(v.definitionRevision, 1);
	integer(v.profileRevision, 1);
	const assignment = deliveryAssignment(v.assignment);
	if (assignment.classification?.deliveryKind !== "research") invalid();
	fields(v.contextFence, fenceKeys);
	for (const key of fenceKeys) integer(v.contextFence[key]);
	v.assignment = assignment;
	return v as RetainedReviewTargetClaim;
}
function binding(v: unknown): RetainedReviewRunBindingClaim {
	header(v, "retained-run-binding", [
		"runId",
		"targetId",
		"targetSha256",
		"admissionId",
		"lineageId",
		"evidenceId",
		"contextId",
		"configObservationId",
		"channelGeneration",
		...inputHashes,
		"provider",
		"model",
		"account",
		"authorLineage",
	]);
	for (const key of [
		"runId",
		"targetId",
		"admissionId",
		"lineageId",
		"evidenceId",
		"contextId",
		"configObservationId",
		"channelGeneration",
	])
		id(v[key]);
	for (const key of [...inputHashes, "targetSha256"]) sha(v[key]);
	exactText(v.provider, RETAINED_REVIEW_LINKAGE_LIMITS.source);
	exactText(v.model, RETAINED_REVIEW_LINKAGE_LIMITS.source);
	const a = v.account;
	if (kindOf(a) === "claimed") {
		fields(a, ["kind", "bindingId", "billing", "configSha256"]);
		id(a.bindingId);
		billing(a.billing);
		sha(a.configSha256);
	} else {
		fields(a, ["kind"]);
		if (a.kind !== "unknown") invalid();
	}
	const lineage = v.authorLineage;
	if (kindOf(lineage) === "claimed") {
		fields(lineage, ["kind", "lineageIds", "basis"]);
		unique(list(lineage.lineageIds, id, RETAINED_REVIEW_LINKAGE_LIMITS.authorLineages, 1));
		exactText(lineage.basis, RETAINED_REVIEW_LINKAGE_LIMITS.reason);
	} else {
		fields(lineage, ["kind"]);
		if (lineage.kind !== "unknown") invalid();
	}
	return v as RetainedReviewRunBindingClaim;
}
function stop(v: unknown): void {
	if (kindOf(v) === "observed") {
		fields(v, ["kind", "source", "exactReason"]);
		exactText(v.source, RETAINED_REVIEW_LINKAGE_LIMITS.source);
		exactText(v.exactReason, RETAINED_REVIEW_LINKAGE_LIMITS.reason);
	} else {
		fields(v, ["kind"]);
		if (v.kind !== "unknown") invalid();
	}
}
function bound(v: Record<string, unknown>): void {
	id(v.runId);
	sha(v.bindingSha256);
}
function call(v: unknown): RetainedReviewCallClaim {
	header(v, "retained-call", ["observationId", "runId", "callId", "bindingSha256", "stop"]);
	bound(v);
	id(v.observationId);
	id(v.callId);
	stop(v.stop);
	return v as RetainedReviewCallClaim;
}
function usage(v: unknown): RetainedReviewUsageClaim {
	header(v, "retained-usage", [
		"observationId",
		"runId",
		"callId",
		"bindingSha256",
		"receiptSource",
		"receiptIdentity",
		"rateSha256",
		"billing",
		"input",
		"generated",
		"durationMs",
	]);
	bound(v);
	for (const key of ["observationId", "callId", "receiptSource", "receiptIdentity"]) id(v[key]);
	sha(v.rateSha256);
	billing(v.billing);
	for (const key of ["input", "generated", "durationMs"]) integer(v[key]);
	return v as RetainedReviewUsageClaim;
}
function completion(v: unknown): RetainedReviewCompletionClaim {
	header(v, "retained-completion", [
		"completionId",
		"runId",
		"bindingSha256",
		"terminalCallId",
		"hostTermination",
		"raw",
		"usageAtCompletion",
	]);
	bound(v);
	id(v.completionId);
	if (v.terminalCallId !== null) id(v.terminalCallId);
	stop(v.hostTermination);
	const raw = v.raw;
	if (kindOf(raw) === "bytes") {
		fields(raw, ["kind", "sha256", "bytesRef", "length"]);
		sha(raw.sha256);
		id(raw.bytesRef);
		integer(raw.length, 0, RETAINED_REVIEW_LINKAGE_LIMITS.rawBytes);
	} else if (kindOf(raw) === "no-output") {
		fields(raw, ["kind", "reason"]);
		exactText(raw.reason, RETAINED_REVIEW_LINKAGE_LIMITS.reason);
	} else {
		fields(raw, ["kind"]);
		if (raw.kind !== "unknown") invalid();
	}
	const u = v.usageAtCompletion;
	if (kindOf(u) === "observed") {
		fields(u, ["kind", "usageObservationIds"]);
		unique(list(u.usageObservationIds, id, RETAINED_REVIEW_LINKAGE_LIMITS.usage, 1));
	} else {
		fields(u, ["kind"]);
		if (u.kind !== "unknown") invalid();
	}
	return v as RetainedReviewCompletionClaim;
}
function producer(v: unknown): RetainedReviewProducerClaim {
	header(v, "host-retained-run", [
		"runId",
		"admissionId",
		"completionId",
		"bindingSha256",
		"completionSha256",
		"rawSha256",
	]);
	bound(v);
	id(v.admissionId);
	id(v.completionId);
	sha(v.completionSha256);
	if (v.rawSha256 !== null) sha(v.rawSha256);
	return v as RetainedReviewProducerClaim;
}
const shapes = { target, binding, call, usage, completion, producer };
function shape<K extends ClaimKind>(kind: K, v: unknown): Claims[K] {
	if (typeof kind !== "string" || !Object.hasOwn(shapes, kind)) invalid();
	return shapes[kind](v) as Claims[K];
}
function digest(kind: ClaimKind, v: Claims[ClaimKind]): string {
	return deliveryDigest(["retained-review-linkage", 1, kind, v]);
}
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b))
		return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every(
			(key) =>
				Object.hasOwn(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
		)
	);
}
function checkBinding(t: RetainedReviewTargetClaim, b: RetainedReviewRunBindingClaim): boolean {
	return (
		b.targetId === t.targetId &&
		b.targetSha256 === digest("target", t) &&
		b.evidenceId === t.manifestId &&
		inputHashes.every((key) => t[key] === b[key])
	);
}
function checkBound(b: RetainedReviewRunBindingClaim, v: { runId: string; bindingSha256: string }): void {
	if (v.runId !== b.runId || v.bindingSha256 !== digest("binding", b)) invalid();
}
function checkUsage(b: RetainedReviewRunBindingClaim, c: RetainedReviewCallClaim, u: RetainedReviewUsageClaim): void {
	checkBound(b, c);
	checkBound(b, u);
	if (u.callId !== c.callId || (b.account.kind === "claimed" && b.account.billing !== u.billing)) invalid();
}

/** Shape only. Every ID, digest, seal and historical context pin remains a supplied claim. */
export function parseRetainedReviewTargetClaim(value: unknown): RetainedReviewTargetClaim {
	return freeze(target(snapshot(value)));
}
/** Contextual target linkage, not a host admission. */
export function parseRetainedReviewRunBindingClaim(
	targetValue: unknown,
	value: unknown,
): RetainedReviewRunBindingClaim {
	const a = args({ targetValue, value });
	const t = target(a.targetValue),
		b = binding(a.value);
	if (!checkBinding(t, b)) invalid();
	return freeze(b);
}
export function parseRetainedReviewCallClaim(bindingValue: unknown, value: unknown): RetainedReviewCallClaim {
	const a = args({ bindingValue, value });
	const b = binding(a.bindingValue),
		c = call(a.value);
	checkBound(b, c);
	return freeze(c);
}
export function parseRetainedReviewUsageClaim(
	bindingValue: unknown,
	callValue: unknown,
	value: unknown,
): RetainedReviewUsageClaim {
	const a = args({ bindingValue, callValue, value });
	const b = binding(a.bindingValue),
		c = call(a.callValue),
		u = usage(a.value);
	checkUsage(b, c, u);
	return freeze(u);
}
export function parseRetainedReviewCompletionClaim(
	bindingValue: unknown,
	calls: unknown,
	observations: unknown,
	value: unknown,
): RetainedReviewCompletionClaim {
	const a = args({ bindingValue, calls, observations, value });
	const b = binding(a.bindingValue),
		v = completion(a.value);
	checkBound(b, v);
	const cs = list(a.calls, call, RETAINED_REVIEW_LINKAGE_LIMITS.calls);
	const us = list(a.observations, usage, RETAINED_REVIEW_LINKAGE_LIMITS.usage);
	unique(cs.map((c) => c.observationId));
	unique(us.map((u) => u.observationId));
	for (const c of cs) checkBound(b, c);
	for (const u of us) {
		const c = cs.find((c) => c.callId === u.callId);
		if (!c) invalid();
		checkUsage(b, c, u);
	}
	for (let i = 0; i < us.length; i++)
		for (const other of us.slice(i + 1)) {
			if (compare("usage", us[i]!, other) === "conflict") invalid();
		}
	if (v.terminalCallId !== null && !cs.some((c) => c.callId === v.terminalCallId)) invalid();
	if (
		v.usageAtCompletion.kind === "observed" &&
		v.usageAtCompletion.usageObservationIds.some((id) => !us.some((u) => u.observationId === id))
	)
		invalid();
	// Later supplied usage is checked, but NEVER appended to this captured completion.
	return freeze(v);
}
export function parseRetainedReviewProducerClaim(
	bindingValue: unknown,
	completionValue: unknown,
	value: unknown,
): RetainedReviewProducerClaim {
	const a = args({ bindingValue, completionValue, value });
	const b = binding(a.bindingValue),
		c = completion(a.completionValue),
		p = producer(a.value);
	checkBound(b, c);
	checkBound(b, p);
	if (
		p.admissionId !== b.admissionId ||
		p.completionId !== c.completionId ||
		p.completionSha256 !== digest("completion", c) ||
		p.rawSha256 !== (c.raw.kind === "bytes" ? c.raw.sha256 : null)
	)
		invalid();
	return freeze(p);
}

/** Shape-only digest. Does NOT establish parent consistency, original bytes or provenance. */
export function retainedReviewLinkageDigest(kind: ClaimKind, value: unknown): string {
	return digest(kind, shape(kind, snapshot(value)));
}

function compare<K extends ClaimKind>(kind: K, left: Claims[K], right: Claims[K]): RetainedReviewClaimComparison {
	if (same(left, right)) return "replay";
	switch (kind) {
		case "target": {
			const a = left as Claims["target"],
				b = right as Claims["target"];
			return a.targetId === b.targetId ? "conflict" : "distinct";
		}
		case "binding":
			return (left as Claims["binding"]).runId === (right as Claims["binding"]).runId ? "conflict" : "distinct";
		case "call": {
			const a = left as Claims["call"],
				b = right as Claims["call"];
			if (
				a.observationId === b.observationId ||
				(a.callId === b.callId && (a.runId !== b.runId || a.bindingSha256 !== b.bindingSha256))
			)
				return "conflict";
			return "distinct"; // Separate observations may report different transport/provider reasons.
		}
		case "usage": {
			const a = left as Claims["usage"],
				b = right as Claims["usage"];
			if (
				a.observationId === b.observationId ||
				(a.receiptSource === b.receiptSource && a.receiptIdentity === b.receiptIdentity)
			)
				return "conflict";
			if (a.callId !== b.callId) return "distinct";
			if (
				a.runId !== b.runId ||
				a.bindingSha256 !== b.bindingSha256 ||
				a.rateSha256 !== b.rateSha256 ||
				a.billing !== b.billing ||
				a.input !== b.input ||
				a.generated !== b.generated ||
				a.durationMs !== b.durationMs
			)
				return "conflict";
			return "corroboration";
		}
		case "completion": {
			const a = left as Claims["completion"],
				b = right as Claims["completion"];
			return a.runId === b.runId || a.completionId === b.completionId ? "conflict" : "distinct";
		}
		case "producer": {
			const a = left as Claims["producer"],
				b = right as Claims["producer"];
			return a.runId === b.runId || a.completionId === b.completionId ? "conflict" : "distinct";
		}
		default:
			return invalid();
	}
}
/** Pure pairwise structural comparison, NOT a journal, settlement or one-time effect guarantee. */
export function compareRetainedReviewClaims(
	kind: ClaimKind,
	left: unknown,
	right: unknown,
): RetainedReviewClaimComparison {
	const a = args({ left, right });
	return compare(kind, shape(kind, a.left), shape(kind, a.right));
}

/** Compare supplied D38 PUBLIC structure, NOT its WeakMap/preparation origin, original bytes,
 * semantic profile validity or vault sealing. Malformed shape throws; a pin mismatch returns false.
 * Recompute the exact D38 public domains before trusting any embedded hash labels. */
export function compareRetainedReviewTargetInput(targetValue: unknown, bindingValue: unknown, input: unknown): boolean {
	const a = args({ targetValue, bindingValue, input });
	const t = target(a.targetValue),
		b = binding(a.bindingValue),
		p = a.input;
	fields(p, ["descriptor", ...inputHashes]);
	const d = p.descriptor;
	fields(d, [
		"version",
		...targetIds,
		"runId",
		"definitionRevision",
		"assignment",
		"contextFence",
		"contextPackageSha256",
		"profile",
		"runtime",
		"manifest",
		"content",
	]);
	if (d.version !== 1) invalid();
	fields(d.profile, ["profileId", "revision", "definition"]);
	fields(d.runtime, [
		"buildSha256",
		"configSha256",
		"provider",
		"model",
		"promptVersion",
		"toolSchemaVersion",
		"outputSchemaVersion",
	]);
	fields(d.manifest, [
		"schemaVersion",
		"kind",
		"id",
		"projectId",
		"hostId",
		"sourceIds",
		"createdAt",
		"sealed",
		"sha256",
		"entries",
		"omissions",
		"complete",
	]);
	for (const key of inputHashes) sha(p[key]);
	const hashes = {
		inputSha256: deliveryDigest(["retained-review", 1, "input", d]),
		profileSha256: deliveryDigest([
			"retained-review",
			1,
			"profile",
			d.profile.profileId,
			d.profile.revision,
			d.profile.definition,
		]),
		contextSha256: deliveryDigest(["retained-review", 1, "context", d.contextFence, d.contextPackageSha256]),
		runtimeSha256: deliveryDigest(["retained-review", 1, "runtime", d.runtime]),
	};
	return (
		checkBinding(t, b) &&
		inputHashes.every((key) => p[key] === hashes[key] && t[key] === hashes[key] && b[key] === hashes[key]) &&
		targetIds.every((key) => t[key] === d[key]) &&
		t.definitionRevision === d.definitionRevision &&
		same(t.assignment, d.assignment) &&
		same(t.contextFence, d.contextFence) &&
		t.contextPackageSha256 === d.contextPackageSha256 &&
		t.manifestId === d.manifest.id &&
		b.evidenceId === d.manifest.id &&
		t.manifestSha256 === d.manifest.sha256 &&
		t.profileId === d.profile.profileId &&
		t.profileRevision === d.profile.revision &&
		b.runId === d.runId &&
		b.provider === d.runtime.provider &&
		b.model === d.runtime.model
	);
}

const disabled = Object.freeze({ enabled: false as const, reason: "retained-dispatch-disabled" as const });
/** No retained effort or budget key is selected. Existing session/PR accounting is untouched. */
export function retainedReviewDispatchStatus(): typeof disabled {
	return disabled;
}
