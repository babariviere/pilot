/** Inactive structural contracts only. No acquisition, admission, execution, persistence or gates. */
import { createHash } from "node:crypto";
import type { ArtifactKind, CriticalReviewEvidence, MissionAssignment } from "@pilot/protocol";
import type { AllocationContextFence } from "./mission-contribution-allocation.ts";
import {
	type DeliveryReference,
	deliveryAssignment,
	deliveryDigest,
	deliveryReference,
} from "./mission-delivery-evidence.ts";
import { type ReviewProfileDefinition, reviewProfileDefinition } from "./mission-review-contract.ts";

export const RETAINED_REVIEW_LIMITS = Object.freeze({
	parts: 20,
	omissions: 20,
	blobBytes: 1024 * 1024,
	totalBytes: 8 * 1024 * 1024,
	descriptorBytes: 64 * 1024,
	reportBytes: 50 * 1024,
	findings: 40,
	citations: 20,
});

interface ContentPart {
	reference: Exclude<DeliveryReference, { kind: "snapshot" }>;
	part: "brief" | "source" | "data";
	artifactKind: ArtifactKind | null;
	/** Retained-reference observation, NOT the digest of original bytes. */
	referenceSha256: string;
	/** Custody is not authorship. Null stays unknown. */
	sourceOwnerSessionId: string | null;
	blobId: string;
	originalSha256: string;
	originalBytes: number;
}
interface InputDescriptor {
	version: 1;
	hostId: string;
	daemonLineageId: string;
	projectId: string;
	missionId: string;
	taskId: string;
	runId: string;
	coordinatorSessionId: string;
	ownerSessionId: string;
	definitionRevision: number;
	assignment: MissionAssignment;
	contextFence: AllocationContextFence;
	policyId: string;
	submissionId: string;
	allocationId: string;
	contextPackageSha256: string;
	profile: { profileId: string; revision: number; definition: ReviewProfileDefinition };
	runtime: {
		buildSha256: string;
		configSha256: string;
		provider: string;
		model: string;
		promptVersion: string;
		toolSchemaVersion: string;
		outputSchemaVersion: 1;
	};
	manifest: CriticalReviewEvidence;
	content: ContentPart[];
}
type ReadonlyData<T> = T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
export type PreparedRetainedReviewInput = ReadonlyData<{
	descriptor: InputDescriptor;
	inputSha256: string;
	profileSha256: string;
	contextSha256: string;
	runtimeSha256: string;
}>;
interface Citation {
	manifestId: string;
	blobId: string;
	sha256: string;
	/** Nonempty half-open range of ORIGINAL UTF-8 bytes, including a BOM if present. */
	start: number;
	end: number;
}
export type ParsedRetainedReviewReport = ReadonlyData<{
	version: 1;
	runId: string;
	inputSha256: string;
	profileSha256: string;
	contextSha256: string;
	runtimeSha256: string;
	state: "completed" | "failed" | "partial" | "length" | "timed-out" | "cancelled" | "unavailable";
	reportedOutcome: "pass" | "fail" | "low" | "medium" | "high" | null;
	reason: string;
	findings: {
		id: string;
		severity: "low" | "medium" | "high";
		title: string;
		detail: string;
		citations: Citation[];
	}[];
	coverage: {
		criterionIndex: number;
		state: "assessed" | "omitted" | "unavailable";
		reason: string;
		citations: Citation[];
	}[];
	omissions: string[];
	limitations: string[];
}>;

// This association proves only preparation by THIS module instance, never host admission or trust.
const ownedBytes = new WeakMap<PreparedRetainedReviewInput, Map<string, Uint8Array>>();
function invalid(): never {
	// Never interpolate untrusted source, labels, findings or config into errors/logs.
	throw new Error("Invalid retained-review contract");
}
function fields(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) invalid();
	const actual = Object.keys(v);
	if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) invalid();
	return v as number;
}
function text(v: unknown, max = 2000): string {
	if (typeof v !== "string" || !v.trim() || v.length > max) invalid();
	return v;
}
function id(v: unknown): string {
	if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) invalid();
	return v;
}
function digest(v: unknown): string {
	if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) invalid();
	return v;
}
function choice<T extends string>(v: unknown, values: readonly T[]): T {
	if (!values.includes(v as T)) invalid();
	return v as T;
}
function list<T>(v: unknown, parse: (item: unknown) => T, max: number, min = 0): T[] {
	if (!Array.isArray(v) || v.length < min || v.length > max) invalid();
	return v.map(parse);
}
function unique<T>(values: T[], key: (v: T) => unknown = (v) => v): void {
	if (new Set(values.map(key)).size !== values.length) invalid();
}
function freeze<T>(v: T): ReadonlyData<T> {
	if (v && typeof v === "object") {
		for (const child of Object.values(v)) freeze(child);
		Object.freeze(v);
	}
	return v as ReadonlyData<T>;
}

/** Bounded JSON-data snapshot BEFORE shared parsers/hashes. Reject accessors, cycles, sparse arrays,
 * symbols, exotic objects and excessive nesting; do not invoke caller toJSON/getters. */
function snapshot(value: unknown, maxBytes: number): unknown {
	let bytes = 0,
		nodes = 0;
	const visit = (v: unknown, depth: number): unknown => {
		if (++nodes > 4096 || depth > 16) invalid();
		if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
			bytes += String(v).length;
		} else if (typeof v === "string") {
			if (v.length > maxBytes) invalid();
			bytes += Buffer.byteLength(JSON.stringify(v));
		} else if (v && typeof v === "object") {
			const array = Array.isArray(v);
			const prototype = Object.getPrototypeOf(v);
			if (!array && prototype !== Object.prototype && prototype !== null) invalid();
			const keys = Reflect.ownKeys(v);
			if (keys.length > 256 || (array && (v.length > 128 || keys.length !== v.length + 1))) invalid();
			const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
			bytes += 2 + Math.max(0, keys.length - (array ? 2 : 1));
			for (const key of keys) {
				if (array && key === "length") continue;
				if (typeof key !== "string" || key.length > 128) invalid();
				if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) invalid();
				const property = Object.getOwnPropertyDescriptor(v, key)!;
				if (!property.enumerable || !("value" in property)) invalid();
				bytes += array ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1;
				if (bytes > maxBytes) invalid();
				(result as Record<string, unknown>)[key] = visit(property.value, depth + 1);
			}
			if (bytes > maxBytes) invalid();
			return result;
		} else invalid();
		if (bytes > maxBytes) invalid();
		return v;
	};
	return visit(value, 0);
}
function rawDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function hash(domain: string, values: unknown[]): string {
	return deliveryDigest(["retained-review", 1, domain, ...values]);
}

// JSON.parse would silently overwrite duplicate keys, including escaped spellings of the same key.
// Scan only already bounded, syntactically valid JSON; strings are decoded only when they are keys.
function rejectDuplicateKeys(json: string): void {
	const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
	for (let i = 0; i < json.length; i++) {
		const ch = json[i];
		if (ch === '"') {
			const start = i++;
			while (json[i] !== '"') {
				if (json[i] === "\\") i++;
				i++;
			}
			const frame = stack.at(-1);
			if (frame?.key) {
				const key: string = JSON.parse(json.slice(start, i + 1));
				if (frame.keys.has(key)) invalid();
				frame.keys.add(key);
				frame.key = false;
			}
		} else if (ch === "{") stack.push({ keys: new Set(), key: true });
		else if (ch === "[") stack.push(null);
		else if (ch === "}" || ch === "]") stack.pop();
		else if (ch === ",") {
			const frame = stack.at(-1);
			if (frame) frame.key = true;
		}
	}
}

function manifest(value: unknown): CriticalReviewEvidence {
	fields(value, [
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
	if (value.schemaVersion !== 1 || value.kind !== "evidence" || value.sealed !== true) invalid();
	const sourceIds = list(value.sourceIds, id, 20, 1);
	unique(sourceIds);
	const entries = list(
		value.entries,
		(e) => {
			fields(e, ["blobId", "sha256", "bytes", "label", "sourceId", "category"]);
			return {
				blobId: id(e.blobId),
				sha256: digest(e.sha256),
				bytes: integer(e.bytes, 0, RETAINED_REVIEW_LIMITS.blobBytes),
				label: text(e.label, 256),
				sourceId: id(e.sourceId),
				category: choice(e.category, ["source", "transcript", "discussion", "guidance"] as const),
			};
		},
		RETAINED_REVIEW_LIMITS.parts,
		1,
	);
	unique(entries, (e) => e.blobId);
	if (entries.some((e) => !sourceIds.includes(e.sourceId))) invalid();
	const omissions = list(
		value.omissions,
		(o) => {
			fields(o, ["selectionId", "reason"]);
			return {
				selectionId: id(o.selectionId),
				reason: choice(o.reason, [
					"unselected",
					"secret",
					"binary",
					"unsafe",
					"missing",
					"quota",
					"redacted",
				] as const),
			};
		},
		RETAINED_REVIEW_LIMITS.omissions,
	);
	unique(omissions, (o) => o.selectionId);
	if (value.complete !== (omissions.length === 0)) invalid();
	// EXACT existing vault semantics. A self-consistent supplied manifest is NOT actual sealing proof.
	if (digest(value.sha256) !== deliveryDigest({ entries, omissions })) invalid();
	return {
		schemaVersion: 1,
		kind: "evidence",
		id: id(value.id),
		projectId: id(value.projectId),
		hostId: id(value.hostId),
		sourceIds,
		createdAt: integer(value.createdAt),
		sealed: true,
		sha256: digest(value.sha256),
		entries,
		omissions,
		complete: value.complete as boolean,
	};
}

/** Supplied descriptors/bytes only. No live reads or independently observed reference/vault facts.
 * All pins are structural claims; this function grants no authorization, authorship or independence. */
export function prepareRetainedReviewInput(
	descriptor: unknown,
	blobs: readonly { blobId: string; bytes: Uint8Array }[],
): PreparedRetainedReviewInput {
	const v = snapshot(descriptor, RETAINED_REVIEW_LIMITS.descriptorBytes);
	fields(v, [
		"version",
		"hostId",
		"daemonLineageId",
		"projectId",
		"missionId",
		"taskId",
		"runId",
		"coordinatorSessionId",
		"ownerSessionId",
		"definitionRevision",
		"assignment",
		"contextFence",
		"policyId",
		"submissionId",
		"allocationId",
		"contextPackageSha256",
		"profile",
		"runtime",
		"manifest",
		"content",
	]);
	if (v.version !== 1) invalid();
	const assignment = deliveryAssignment(v.assignment);
	// Only an intent restriction. Never reclassify code/mixed/unknown work or assert code-free inventory.
	if (assignment.classification?.deliveryKind !== "research") invalid();
	const f = v.contextFence;
	fields(f, ["briefRevision", "decisionEventId", "artifactEventId", "memberEventId", "coordinatorEventId"]);
	const contextFence = {
		briefRevision: integer(f.briefRevision),
		decisionEventId: integer(f.decisionEventId),
		artifactEventId: integer(f.artifactEventId),
		memberEventId: integer(f.memberEventId),
		coordinatorEventId: integer(f.coordinatorEventId),
	};
	const p = v.profile;
	fields(p, ["profileId", "revision", "definition"]);
	const profile = {
		profileId: id(p.profileId),
		revision: integer(p.revision, 1),
		definition: reviewProfileDefinition(p.definition),
	};
	const r = v.runtime;
	fields(r, [
		"buildSha256",
		"configSha256",
		"provider",
		"model",
		"promptVersion",
		"toolSchemaVersion",
		"outputSchemaVersion",
	]);
	if (r.outputSchemaVersion !== 1) invalid();
	const runtime: InputDescriptor["runtime"] = {
		buildSha256: digest(r.buildSha256),
		configSha256: digest(r.configSha256),
		provider: text(r.provider, 256),
		model: text(r.model, 256),
		promptVersion: id(r.promptVersion),
		toolSchemaVersion: id(r.toolSchemaVersion),
		outputSchemaVersion: 1,
	};
	const selection = profile.definition.modelSelection;
	if (
		!profile.definition.applicableIntents.includes("research") ||
		"unavailable" in selection ||
		selection.provider !== runtime.provider ||
		selection.model !== runtime.model
	)
		invalid();
	const m = manifest(v.manifest);
	if (m.hostId !== v.hostId || m.projectId !== v.projectId) invalid();
	const content = list(
		v.content,
		(c): ContentPart => {
			fields(c, [
				"reference",
				"part",
				"artifactKind",
				"referenceSha256",
				"sourceOwnerSessionId",
				"blobId",
				"originalSha256",
				"originalBytes",
			]);
			const reference = deliveryReference(c.reference);
			if (reference.kind === "snapshot") invalid();
			const part = choice(c.part, ["brief", "source", "data"] as const);
			const artifactKind =
				c.artifactKind === null
					? null
					: choice(c.artifactKind, ["html", "react", "image", "swiftui", "shader", "visual"] as const);
			if (
				reference.kind === "brief"
					? part !== "brief" || artifactKind !== null || c.sourceOwnerSessionId !== null
					: artifactKind === null || part === "brief" || (part === "data" && artifactKind !== "visual")
			)
				invalid();
			return {
				reference,
				part,
				artifactKind,
				referenceSha256: digest(c.referenceSha256),
				sourceOwnerSessionId: c.sourceOwnerSessionId === null ? null : id(c.sourceOwnerSessionId),
				blobId: id(c.blobId),
				originalSha256: digest(c.originalSha256),
				originalBytes: integer(c.originalBytes, 0, RETAINED_REVIEW_LIMITS.blobBytes),
			};
		},
		RETAINED_REVIEW_LIMITS.parts,
		1,
	);
	unique(content, (c) => deliveryDigest([c.reference, c.part]));
	unique(content, (c) => c.blobId);
	for (const c of content) {
		const same = content.filter((other) => deliveryDigest(other.reference) === deliveryDigest(c.reference));
		if (
			same.some(
				(o) =>
					o.referenceSha256 !== c.referenceSha256 ||
					o.artifactKind !== c.artifactKind ||
					o.sourceOwnerSessionId !== c.sourceOwnerSessionId,
			)
		)
			invalid();
		if (
			c.artifactKind === "visual" &&
			(same.length !== 2 || !same.some((o) => o.part === "source") || !same.some((o) => o.part === "data"))
		)
			invalid();
		const entry = m.entries.find((e) => e.blobId === c.blobId);
		if (!entry || entry.sha256 !== c.originalSha256 || entry.bytes !== c.originalBytes) invalid();
	}
	if (m.entries.length !== content.length) invalid();
	const d: InputDescriptor = {
		version: 1,
		hostId: id(v.hostId),
		daemonLineageId: id(v.daemonLineageId),
		projectId: id(v.projectId),
		missionId: id(v.missionId),
		taskId: id(v.taskId),
		runId: id(v.runId),
		coordinatorSessionId: id(v.coordinatorSessionId),
		ownerSessionId: id(v.ownerSessionId),
		definitionRevision: integer(v.definitionRevision, 1),
		assignment,
		contextFence,
		policyId: id(v.policyId),
		submissionId: id(v.submissionId),
		allocationId: id(v.allocationId),
		contextPackageSha256: digest(v.contextPackageSha256),
		profile,
		runtime,
		manifest: m,
		content,
	};
	// Bound ALL supplied byte lengths/counts before copying, decoding or hashing ANY original byte.
	if (!Array.isArray(blobs) || blobs.length !== content.length || Reflect.ownKeys(blobs).length !== blobs.length + 1)
		invalid();
	let total = 0;
	const supplied = new Map<string, Uint8Array>();
	for (let i = 0; i < blobs.length; i++) {
		const property = Object.getOwnPropertyDescriptor(blobs, String(i));
		if (!property || !("value" in property)) invalid();
		const blob = property.value;
		fields(blob, ["blobId", "bytes"]);
		const properties = Object.getOwnPropertyDescriptors(blob);
		if (Reflect.ownKeys(blob).length !== 2 || !("value" in properties.blobId!) || !("value" in properties.bytes!))
			invalid();
		const blobId = id(properties.blobId!.value),
			bytes = properties.bytes!.value;
		if (
			!(bytes instanceof Uint8Array) ||
			(Object.getPrototypeOf(bytes) !== Uint8Array.prototype && Object.getPrototypeOf(bytes) !== Buffer.prototype) ||
			supplied.has(blobId)
		)
			invalid();
		// Use typed-array intrinsics, not caller-shadowable byteLength/buffer getters.
		const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
		const length = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!.call(bytes) as number;
		const buffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!.call(bytes) as ArrayBufferLike;
		if (buffer instanceof SharedArrayBuffer || length > RETAINED_REVIEW_LIMITS.blobBytes) invalid();
		total += length;
		if (total > RETAINED_REVIEW_LIMITS.totalBytes) invalid();
		const entry = m.entries.find((e) => e.blobId === blobId);
		if (!entry || entry.bytes !== length) invalid();
		supplied.set(blobId, bytes);
	}
	const bytesById = new Map<string, Uint8Array>();
	for (const [blobId, bytes] of supplied) {
		const copy = new Uint8Array(bytes);
		if (rawDigest(copy) !== m.entries.find((e) => e.blobId === blobId)!.sha256) invalid();
		// Validation only. NEVER hash/re-encode the decoded display string (BOM included in copy).
		try {
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy);
		} catch {
			invalid();
		}
		bytesById.set(blobId, copy);
	}
	const profileSha256 = hash("profile", [profile.profileId, profile.revision, profile.definition]);
	const contextSha256 = hash("context", [contextFence, d.contextPackageSha256]);
	const runtimeSha256 = hash("runtime", [runtime]);
	// Full header association in addition to the vault's entries/omissions-only digest. Order is material.
	const inputSha256 = hash("input", [d]);
	const prepared = freeze({ descriptor: d, inputSha256, profileSha256, contextSha256, runtimeSha256 });
	ownedBytes.set(prepared, bytesById);
	return prepared;
}

/** Parse a MODEL CLAIM, not a host completion, review result or trustworthy coverage decision.
 * Future execution must retain original terminal bytes before calling this interpretation helper. */
export function parseRetainedReviewReport(
	input: PreparedRetainedReviewInput,
	json: string,
): ParsedRetainedReviewReport {
	const bytes = ownedBytes.get(input);
	if (
		!bytes ||
		typeof json !== "string" ||
		json.length > RETAINED_REVIEW_LIMITS.reportBytes ||
		Buffer.byteLength(json) > RETAINED_REVIEW_LIMITS.reportBytes
	)
		invalid();
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		invalid();
	}
	rejectDuplicateKeys(json);
	const v = snapshot(parsed, RETAINED_REVIEW_LIMITS.reportBytes);
	fields(v, [
		"version",
		"runId",
		"inputSha256",
		"profileSha256",
		"contextSha256",
		"runtimeSha256",
		"state",
		"reportedOutcome",
		"reason",
		"findings",
		"coverage",
		"omissions",
		"limitations",
	]);
	if (
		v.version !== 1 ||
		v.runId !== input.descriptor.runId ||
		v.inputSha256 !== input.inputSha256 ||
		v.profileSha256 !== input.profileSha256 ||
		v.contextSha256 !== input.contextSha256 ||
		v.runtimeSha256 !== input.runtimeSha256
	)
		invalid();
	const state = choice(v.state, [
		"completed",
		"failed",
		"partial",
		"length",
		"timed-out",
		"cancelled",
		"unavailable",
	] as const);
	const outcomes =
		input.descriptor.profile.definition.outputInterpretation.kind === "pass-fail"
			? (["pass", "fail"] as const)
			: (["low", "medium", "high"] as const);
	const reportedOutcome = v.reportedOutcome === null ? null : choice(v.reportedOutcome, outcomes);
	if ((state === "completed") !== (reportedOutcome !== null)) invalid();
	const citations = (value: unknown): Citation[] => {
		const result = list(
			value,
			(c): Citation => {
				fields(c, ["manifestId", "blobId", "sha256", "start", "end"]);
				const blobId = id(c.blobId),
					original = bytes.get(blobId);
				const entry = input.descriptor.manifest.entries.find((e) => e.blobId === blobId);
				if (!original || !entry || c.manifestId !== input.descriptor.manifest.id || c.sha256 !== entry.sha256)
					invalid();
				const start = integer(c.start, 0, original.length),
					end = integer(c.end, 1, original.length);
				if (
					start >= end ||
					(original[start]! & 0xc0) === 0x80 ||
					(end < original.length && (original[end]! & 0xc0) === 0x80)
				)
					invalid();
				return { manifestId: c.manifestId as string, blobId, sha256: c.sha256 as string, start, end };
			},
			RETAINED_REVIEW_LIMITS.citations,
		);
		unique(result, deliveryDigest);
		return result;
	};
	const findings = list(
		v.findings,
		(f) => {
			fields(f, ["id", "severity", "title", "detail", "citations"]);
			return {
				id: id(f.id),
				severity: choice(f.severity, ["low", "medium", "high"] as const),
				title: text(f.title, 256),
				detail: text(f.detail, 4000),
				citations: citations(f.citations),
			};
		},
		RETAINED_REVIEW_LIMITS.findings,
	);
	unique(findings, (f) => f.id);
	const coverage = list(
		v.coverage,
		(c) => {
			fields(c, ["criterionIndex", "state", "reason", "citations"]);
			return {
				criterionIndex: integer(c.criterionIndex, 0, input.descriptor.assignment.criteria.length - 1),
				state: choice(c.state, ["assessed", "omitted", "unavailable"] as const),
				reason: text(c.reason),
				citations: citations(c.citations),
			};
		},
		20,
	);
	unique(coverage, (c) => c.criterionIndex);
	// Never fill coverage gaps, drop findings/limitations, or interpret Pass as a green review.
	return freeze({
		version: 1,
		runId: input.descriptor.runId,
		inputSha256: input.inputSha256,
		profileSha256: input.profileSha256,
		contextSha256: input.contextSha256,
		runtimeSha256: input.runtimeSha256,
		state,
		reportedOutcome,
		reason: text(v.reason),
		findings,
		coverage,
		omissions: list(v.omissions, (s) => text(s), 20),
		limitations: list(v.limitations, (s) => text(s), 20),
	});
}
