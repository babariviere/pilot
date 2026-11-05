/** Host-only visual acquisition, not reviewer input, execution, admission or a check result. */
import { createHash, randomUUID } from "node:crypto";
import { parseStoredVisualRevision, type StoredVisualRevision, validateVisualWrite } from "@pilot/artifacts";
import type { CriticalReviewEvidence } from "@pilot/protocol";
import type { CriticalReviewVault } from "./critical-review-vault.ts";
import { Conflict } from "./errors.ts";
import { type DeliveryObservation, deliveryDigest } from "./mission-delivery-evidence.ts";
import type { MissionStore } from "./missions.ts";
import type { RetainedBriefHeader } from "./retained-brief.ts";
import { RETAINED_REVIEW_LIMITS, retainedReviewSnapshot } from "./retained-review-contract.ts";

export interface RetainedArtifactReference {
	artifactId: string;
	revision: number;
	kind: "visual";
	sourceOwnerSessionId: string;
}
/** Host-provided intended validation pins. `now` is explicit, never inferred from stored timestamps.
 * Acquisition cannot prove these pins describe an installed validator. The executor must do that. */
export interface RetainedVisualValidator {
	buildSha256: string;
	runtimeSha256: string;
	configSha256: string;
	api: number;
	engine: string;
	options: { now: number; timeoutMs: number };
}
export interface RetainedArtifactHost {
	vault: CriticalReviewVault;
	knownSecrets: string[];
	/** Current coordinator, source/member/project, pinned link and allocation/policy/profile fences. */
	observe(): { header: RetainedBriefHeader; observation: DeliveryObservation; validator: RetainedVisualValidator };
	read(signal?: AbortSignal): Promise<StoredVisualRevision>;
}
export interface RetainedArtifactDescriptor {
	version: 1;
	kind: "stored-visual-container";
	header: RetainedBriefHeader;
	reference: RetainedArtifactReference;
	manifest: CriticalReviewEvidence;
	container: { blobId: string; sha256: string; bytes: number };
	derived: {
		source: { sha256: string; bytes: number };
		dataJSON: { sha256: string; bytes: number };
		id: string;
		storedVisual: { api: number; engine: string };
	};
	validator: RetainedVisualValidator;
}
export interface AcquiredRetainedArtifact {
	descriptor: RetainedArtifactDescriptor;
	descriptorSha256: string;
	/** Original stored numbered JSON, not pre-publication submission bytes. */
	containerBytes: Uint8Array;
	/** Derived arguments ONLY, never InputDescriptor source/data or evidence of execution. */
	validationInput: Readonly<{ source: string; dataJSON: string; id: string }>;
}
const rawHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function textPin(text: string) {
	return { sha256: rawHash(Buffer.from(text)), bytes: Buffer.byteLength(text) };
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function reference(value: RetainedArtifactReference): RetainedArtifactReference {
	const v = retainedReviewSnapshot(value, 1024) as RetainedArtifactReference;
	if (
		Object.keys(v).length !== 4 ||
		v.kind !== "visual" ||
		!Number.isSafeInteger(v.revision) ||
		v.revision < 1 ||
		typeof v.artifactId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.artifactId) ||
		typeof v.sourceOwnerSessionId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(v.sourceOwnerSessionId)
	)
		throw new Conflict("Unsupported exact artifact reference");
	return v;
}
function validator(value: RetainedVisualValidator) {
	const v = retainedReviewSnapshot(value, 2048) as RetainedVisualValidator;
	if (
		Object.keys(v).length !== 6 ||
		Object.keys(v.options).length !== 2 ||
		![v.buildSha256, v.runtimeSha256, v.configSha256].every(
			(h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h),
		) ||
		v.api !== 1 ||
		typeof v.engine !== "string" ||
		!v.engine ||
		v.engine.length > 256 ||
		!Number.isSafeInteger(v.options.now) ||
		v.options.now < 0 ||
		!Number.isSafeInteger(v.options.timeoutMs) ||
		v.options.timeoutMs < 1 ||
		v.options.timeoutMs > 30_000
	)
		throw new Conflict("Unsupported visual validator configuration");
	return v;
}
function derive(stored: StoredVisualRevision) {
	const { source, html: _html, ...metadata } = stored.artifact;
	if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.from(source)) !== source)
		throw new Conflict("Unsupported visual source encoding");
	const dataJSON = validateVisualWrite(source, stored.artifact.data);
	return {
		container: { sha256: rawHash(stored.bytes), bytes: stored.bytes.byteLength },
		derived: {
			source: textPin(source),
			dataJSON: textPin(dataJSON),
			id: stored.artifact.id,
			storedVisual: { api: stored.artifact.visual!.api, engine: stored.artifact.visual!.engine },
		},
		observation: {
			reference: { kind: "artifact" as const, artifactId: stored.artifact.id, revision: stored.artifact.revision },
			sourceOwnerSessionId: stored.artifact.sessionId,
			sha256: deliveryDigest({ metadata, sourceSha256: textPin(source).sha256 }),
			availability: "retained" as const,
		},
		validationInput: Object.freeze({ source, dataJSON, id: stored.artifact.id }),
	};
}
function current(host: RetainedArtifactHost) {
	const value = retainedReviewSnapshot(host.observe(), RETAINED_REVIEW_LIMITS.descriptorBytes) as ReturnType<
		RetainedArtifactHost["observe"]
	>;
	return { ...value, validator: validator(value.validator) };
}
async function observe(host: RetainedArtifactHost, ref: RetainedArtifactReference, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const before = current(host);
	const loaded = await host.read(signal);
	signal?.throwIfAborted();
	if (deliveryDigest(current(host)) !== deliveryDigest(before)) throw new Conflict("Retained artifact access changed");
	// Revalidate even a host adapter's returned fields against its ORIGINAL container.
	const stored = parseStoredVisualRevision(loaded.bytes, {
		id: ref.artifactId,
		revision: ref.revision,
		sessionId: ref.sourceOwnerSessionId,
		projectId: before.header.projectId,
	});
	const data = derive(stored);
	if (deliveryDigest(data.observation) !== deliveryDigest(before.observation))
		throw new Conflict("Retained artifact allocation source changed");
	return { ...before, ...data, bytes: stored.bytes };
}
function fence(value: Awaited<ReturnType<typeof observe>>) {
	const { bytes: _bytes, validationInput: _input, ...pins } = value;
	return deliveryDigest(pins);
}
function descriptor(
	value: Awaited<ReturnType<typeof observe>>,
	ref: RetainedArtifactReference,
	manifest: CriticalReviewEvidence,
): RetainedArtifactDescriptor {
	if (
		!manifest.complete ||
		manifest.omissions.length ||
		manifest.entries.length !== 1 ||
		manifest.projectId !== value.header.projectId ||
		manifest.hostId !== value.header.hostId ||
		deliveryDigest(manifest.sourceIds) !==
			deliveryDigest([value.header.missionId, ref.sourceOwnerSessionId, ref.artifactId]) ||
		manifest.entries[0]!.sourceId !== ref.artifactId ||
		manifest.entries[0]!.category !== "source" ||
		manifest.entries[0]!.label !== "artifact.json" ||
		manifest.entries[0]!.sha256 !== value.container.sha256 ||
		manifest.entries[0]!.bytes !== value.container.bytes
	)
		throw new Conflict("Retained artifact selection is partial or changed");
	return {
		version: 1,
		kind: "stored-visual-container",
		header: value.header,
		reference: ref,
		manifest,
		container: { blobId: manifest.entries[0]!.blobId, ...value.container },
		derived: value.derived,
		validator: value.validator,
	};
}
async function recheck(
	host: RetainedArtifactHost,
	ref: RetainedArtifactReference,
	expected: string,
	signal?: AbortSignal,
) {
	if (fence(await observe(host, ref, signal)) !== expected)
		throw new Conflict("Retained artifact context or bytes changed");
}
export async function captureRetainedArtifact(
	store: MissionStore,
	host: RetainedArtifactHost,
	requested: RetainedArtifactReference,
	signal?: AbortSignal,
): Promise<
	{ state: "captured"; input: AcquiredRetainedArtifact } | { state: "partial"; manifest: CriticalReviewEvidence }
> {
	const ref = reference(requested);
	const initial = await observe(host, ref, signal);
	const expected = fence(initial);
	await store.durable();
	await recheck(host, ref, expected, signal);
	const manifest = await host.vault.capture(
		{
			id: randomUUID(),
			projectId: initial.header.projectId,
			hostId: initial.header.hostId,
			sourceIds: [initial.header.missionId, ref.sourceOwnerSessionId, ref.artifactId],
			createdAt: Date.now(),
			knownSecrets: [...host.knownSecrets],
			selections: [
				{
					selectionId: "artifact",
					sourceId: ref.artifactId,
					label: "artifact.json",
					category: "source",
					selected: true,
					bytes: initial.bytes,
				},
			],
		},
		signal,
	);
	await recheck(host, ref, expected, signal);
	if (!manifest.complete || manifest.entries.length !== 1) return { state: "partial", manifest };
	return {
		state: "captured",
		input: await reopenRetainedArtifact(store, host, descriptor(initial, ref, manifest), signal),
	};
}

/** A serialized host descriptor conveys no access. Reopen reobserves all current fences and exact bytes. */
export async function reopenRetainedArtifact(
	store: MissionStore,
	host: RetainedArtifactHost,
	supplied: unknown,
	signal?: AbortSignal,
): Promise<AcquiredRetainedArtifact> {
	signal?.throwIfAborted();
	const pinned = retainedReviewSnapshot(
		supplied,
		RETAINED_REVIEW_LIMITS.descriptorBytes,
	) as RetainedArtifactDescriptor;
	const ref = reference(pinned.reference);
	const initial = await observe(host, ref, signal);
	const expected = fence(initial);
	// The actual stored manifest, not descriptor claims, supplies the one allowed blob identity.
	const manifest = await host.vault.manifest(pinned.manifest.id);
	await recheck(host, ref, expected, signal);
	const actual = descriptor(initial, ref, manifest);
	if (deliveryDigest(actual) !== deliveryDigest(pinned)) throw new Conflict("Retained artifact descriptor changed");
	await store.durable();
	await recheck(host, ref, expected, signal);
	const exact = await host.vault.readExact(
		{
			manifestId: manifest.id,
			manifestSha256: manifest.sha256,
			blobs: [
				{ blobId: actual.container.blobId, sha256: initial.container.sha256, length: initial.container.bytes },
			],
		},
		signal,
	);
	// No async source reread after readExact: that would permit an acknowledged erasure during I/O.
	// Current access/config is synchronous; the exact vault read is the final async disclosure barrier.
	signal?.throwIfAborted();
	if (
		deliveryDigest(current(host)) !==
		deliveryDigest({ header: initial.header, observation: initial.observation, validator: initial.validator })
	)
		throw new Conflict("Retained artifact access changed");
	if (deliveryDigest(exact.manifest) !== deliveryDigest(manifest))
		throw new Conflict("Retained artifact manifest changed");
	const sealed = parseStoredVisualRevision(exact.blobs[0]!.bytes, {
		id: ref.artifactId,
		revision: ref.revision,
		sessionId: ref.sourceOwnerSessionId,
		projectId: initial.header.projectId,
	});
	const derived = derive(sealed);
	if (deliveryDigest(derived.derived) !== deliveryDigest(actual.derived))
		throw new Conflict("Retained visual derivation changed");
	return {
		descriptor: freeze(actual),
		descriptorSha256: deliveryDigest(actual),
		containerBytes: new Uint8Array(sealed.bytes),
		validationInput: derived.validationInput,
	};
}
