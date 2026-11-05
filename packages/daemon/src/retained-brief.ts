/** Host-only acquisition of one persisted local brief. No executor, endpoint or approval. */
import { createHash, randomUUID } from "node:crypto";
import type { CriticalReviewEvidence } from "@pilot/protocol";
import type { CriticalReviewVault } from "./critical-review-vault.ts";
import { Conflict } from "./errors.ts";
import { deliveryDigest } from "./mission-delivery-evidence.ts";
import type { MissionStore } from "./missions.ts";
import {
	type InputDescriptor,
	type PreparedRetainedReviewInput,
	prepareRetainedReviewInput,
	RETAINED_REVIEW_LIMITS,
	retainedReviewDescriptor,
} from "./retained-review-contract.ts";

export type RetainedBriefHeader = Omit<InputDescriptor, "manifest" | "content">;
export interface RetainedBriefHost {
	vault: CriticalReviewVault;
	knownSecrets: string[];
	/** Must reauthorize current coordinator/project and observe current bindings on EVERY call.
	 * This is a trusted host function, never a request DTO/digest or model callback. */
	observe(): RetainedBriefHeader;
}
export type RetainedBriefCapture =
	| { state: "captured"; input: PreparedRetainedReviewInput }
	| { state: "partial"; manifest: CriticalReviewEvidence };

function observe(store: MissionStore, host: RetainedBriefHost, revision: number) {
	const header = structuredClone(host.observe());
	if (header.contextFence.briefRevision !== revision) throw new Conflict("Retained brief revision changed");
	const { bytes, ...metadata } = store.briefExact(header.missionId, revision, RETAINED_REVIEW_LIMITS.blobBytes);
	const originalSha256 = createHash("sha256").update(bytes).digest("hex");
	// Only the existing reference observation uses decoded fields. Original bytes never round-trip text.
	const referenceSha256 = deliveryDigest({
		...metadata,
		markdown: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
	});
	return { header, bytes, originalSha256, referenceSha256 };
}
function fence(value: ReturnType<typeof observe>): string {
	return deliveryDigest([value.header, value.originalSha256, value.referenceSha256]);
}
function recheck(
	store: MissionStore,
	host: RetainedBriefHost,
	revision: number,
	expected: string,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	if (fence(observe(store, host, revision)) !== expected)
		throw new Conflict("Retained brief context or bytes changed");
}

export async function captureRetainedBrief(
	store: MissionStore,
	host: RetainedBriefHost,
	revision: number,
	signal?: AbortSignal,
): Promise<RetainedBriefCapture> {
	signal?.throwIfAborted();
	const initial = observe(store, host, revision);
	const expected = fence(initial);
	await store.durable();
	recheck(store, host, revision, expected, signal);
	const manifest = await host.vault.capture(
		{
			id: randomUUID(),
			projectId: initial.header.projectId,
			hostId: initial.header.hostId,
			sourceIds: [initial.header.missionId],
			createdAt: Date.now(),
			knownSecrets: [...host.knownSecrets],
			selections: [
				{
					selectionId: "brief",
					sourceId: initial.header.missionId,
					label: "brief.md",
					category: "source",
					selected: true,
					bytes: initial.bytes,
				},
			],
		},
		signal,
	);
	recheck(store, host, revision, expected, signal);
	if (!manifest.complete || manifest.entries.length !== 1) return { state: "partial", manifest };
	const entry = manifest.entries[0]!;
	const descriptor: InputDescriptor = {
		...initial.header,
		manifest,
		content: [
			{
				reference: { kind: "brief", revision },
				part: "brief",
				artifactKind: null,
				referenceSha256: initial.referenceSha256,
				sourceOwnerSessionId: null,
				blobId: entry.blobId,
				originalSha256: initial.originalSha256,
				originalBytes: initial.bytes.byteLength,
			},
		],
	};
	return { state: "captured", input: await reopenRetainedBrief(store, host, descriptor, signal) };
}

/** A host may persist the descriptor and reopen after restart. It conveys NO authorization.
 * Reobserve current bindings and raw revision; read only the actual sealed selection through #42. */
export async function reopenRetainedBrief(
	store: MissionStore,
	host: RetainedBriefHost,
	descriptor: unknown,
	signal?: AbortSignal,
): Promise<PreparedRetainedReviewInput> {
	signal?.throwIfAborted();
	const pinned = retainedReviewDescriptor(descriptor);
	const { manifest, content, ...claimedHeader } = pinned;
	if (content.length !== 1 || content[0]!.reference.kind !== "brief")
		throw new Conflict("Only one exact local brief is supported");
	const revision = content[0]!.reference.revision;
	const initial = observe(store, host, revision);
	const expected = fence(initial);
	if (deliveryDigest(claimedHeader) !== deliveryDigest(initial.header))
		throw new Conflict("Retained brief configuration or binding changed");
	if (
		!manifest.complete ||
		manifest.omissions.length ||
		manifest.entries.length !== 1 ||
		manifest.projectId !== initial.header.projectId ||
		manifest.hostId !== initial.header.hostId ||
		deliveryDigest(manifest.sourceIds) !== deliveryDigest([initial.header.missionId]) ||
		content[0]!.referenceSha256 !== initial.referenceSha256 ||
		content[0]!.originalSha256 !== initial.originalSha256 ||
		content[0]!.originalBytes !== initial.bytes.byteLength
	)
		throw new Conflict("Retained brief selection changed or partial");
	await store.durable();
	recheck(store, host, revision, expected, signal);
	const exact = await host.vault.readExact(
		{
			manifestId: manifest.id,
			manifestSha256: manifest.sha256,
			blobs: [{ blobId: content[0]!.blobId, sha256: initial.originalSha256, length: initial.bytes.byteLength }],
		},
		signal,
	);
	recheck(store, host, revision, expected, signal);
	if (deliveryDigest(exact.manifest) !== deliveryDigest(manifest))
		throw new Conflict("Retained brief manifest changed");
	return prepareRetainedReviewInput(
		pinned,
		exact.blobs.map(({ blobId, bytes }) => ({ blobId, bytes })),
	);
}
