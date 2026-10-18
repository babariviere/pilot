/** Internal capture only. No server, session, branch ownership, network or provider wiring. */
import { createHash, randomUUID } from "node:crypto";
import type { CriticalReviewEvidence } from "@pilot/protocol";
import {
	type ReviewPRDiscussionReader,
	ReviewPRDiscussions,
	type ReviewPRLogSelection,
	reviewPRLogSelections,
} from "./critical-review-pr-discussions.ts";
import {
	canonicalReviewPRIdentity,
	pinReviewPR,
	ReviewPRCaptureError,
	type ReviewPRIdentity,
	type ReviewPRReader,
	type ReviewPRSnapshot,
} from "./critical-review-pr-intake.ts";
import {
	REVIEW_PR_LIMITS,
	type ReviewPRLimits,
	ReviewPRObjects,
	ReviewPRScope,
	type ReviewTreeEntry,
} from "./critical-review-pr-objects.ts";
import {
	type CriticalReviewVault,
	REVIEW_VAULT_LIMITS,
	type ReviewCapture,
	type ReviewSelection,
} from "./critical-review-vault.ts";
import { canonicalJSON } from "./operation-journal.ts";

export interface ReviewPRCaptureRequest {
	id: string;
	projectId: string;
	hostId: string;
	createdAt: number;
	identity: ReviewPRIdentity;
	/** Required host-known credential values for the authorized capture scope. */
	knownSecrets: string[];
	/** Structured host authorization for specific check log byte ranges. Never inferred from PR text. */
	logs?: ReviewPRLogSelection[];
	signal?: AbortSignal;
}
export interface ReviewPRCaptureResult {
	manifest: CriticalReviewEvidence;
	snapshot: ReviewPRSnapshot & { mergeBase: string };
}
export class ReadOnlyPRCapture {
	private busy = false;
	private pendingReads = 0;
	private readonly limits: ReviewPRLimits;
	private readonly vault: CriticalReviewVault;
	private readonly reader: ReviewPRReader;
	private readonly discussions?: ReviewPRDiscussionReader;
	/** Tests may lower ceilings, never raise them. There is deliberately no live reader implementation. */
	constructor(
		vault: CriticalReviewVault,
		reader: ReviewPRReader,
		limits: Partial<ReviewPRLimits> = {},
		discussions?: ReviewPRDiscussionReader,
	) {
		this.vault = vault;
		this.discussions = discussions;
		this.reader = {
			readPullRequest: (request) => this.read(() => reader.readPullRequest(request)),
			readObject: (request) => this.read(() => reader.readObject(request)),
		};
		this.limits = { ...REVIEW_PR_LIMITS, ...limits };
		for (const key of Object.keys(REVIEW_PR_LIMITS) as (keyof ReviewPRLimits)[]) {
			if (
				!Number.isSafeInteger(this.limits[key]) ||
				this.limits[key] < 1 ||
				this.limits[key] > REVIEW_PR_LIMITS[key]
			)
				throw new ReviewPRCaptureError("quota");
		}
	}
	private async read<T>(action: () => Promise<T>): Promise<T> {
		// Retain admission until the actual transport settles, including after caller cancellation.
		if (this.pendingReads >= 3) throw new ReviewPRCaptureError("busy");
		this.pendingReads++;
		try {
			return await action();
		} finally {
			this.pendingReads--;
		}
	}
	async capture(request: ReviewPRCaptureRequest): Promise<ReviewPRCaptureResult> {
		if (this.busy) throw new ReviewPRCaptureError("busy");
		this.busy = true;
		const scope = new ReviewPRScope(this.limits, request.signal);
		const captureSource = `pr-capture-${randomUUID()}`;
		let objects: ReviewPRObjects | undefined;
		let sealed = false;
		try {
			if (
				![request.id, request.projectId, request.hostId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
				!Number.isSafeInteger(request.createdAt) ||
				request.createdAt < 0 ||
				!Array.isArray(request.knownSecrets) ||
				request.knownSecrets.some((secret) => typeof secret !== "string" || !secret || secret.length > 8192)
			)
				throw new ReviewPRCaptureError("identity");
			const identity = canonicalReviewPRIdentity(request.identity);
			// Freeze the new host log selection before any asynchronous acquisition can mutate it.
			const logs = reviewPRLogSelections(request.logs ?? []);
			if (logs.length && !this.discussions) throw new ReviewPRCaptureError("identity");
			const source = (value: unknown) => `pr-${createHash("sha256").update(canonicalJSON(value)).digest("hex")}`;
			const accountKey = { host: identity.host, accountId: identity.account.id };
			const repoKey = { ...accountKey, repositoryId: identity.repository.id };
			const sourceIds = [
				captureSource,
				source({ ...repoKey, pullRequestId: identity.pr.id }),
				source(repoKey),
				source(accountKey),
			];
			const metadata = async () => {
				const response = await scope.read(() =>
					this.reader.readPullRequest({ identity, signal: scope.signal, maxBytes: this.limits.metadataBytes }),
				);
				if (Buffer.byteLength(JSON.stringify(response) ?? "") > this.limits.metadataBytes)
					throw new ReviewPRCaptureError("quota");
				return pinReviewPR(identity, response);
			};
			const pinned = await metadata();
			objects = await ReviewPRObjects.create(scope, identity, this.reader, this.vault, request.projectId);
			const heads = await objects.history(pinned.head.oid, pinned.head.repository);
			const bases = await objects.history(pinned.base.oid, pinned.base.repository);
			const mergeBase = await objects.mergeBase(pinned.head.oid, pinned.base.oid);
			if (!heads.has(mergeBase) || !bases.has(mergeBase)) throw new ReviewPRCaptureError("ancestry");
			const snapshot = { ...pinned, mergeBase };
			const trees = {
				head: await objects.tree(heads.get(pinned.head.oid)!, pinned.head.repository),
				base: await objects.tree(bases.get(pinned.base.oid)!, pinned.base.repository),
				mergeBase: await objects.tree(heads.get(mergeBase)!, pinned.head.repository),
			};
			const maps = Object.fromEntries(
				Object.entries(trees).map(([key, entries]) => [key, new Map(entries.map((entry) => [entry.path, entry]))]),
			) as Record<keyof typeof trees, Map<string, ReviewTreeEntry>>;
			const paths = [
				...new Set(
					Object.values(trees)
						.flat()
						.map((entry) => entry.path),
				),
			].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
			const selections: ReviewSelection[] = [];
			let evidenceBytes = 0;
			const add = (
				label: string,
				bytes: Uint8Array,
				selected = true,
				category: ReviewSelection["category"] = "source",
			) => {
				if (
					selections.length >= REVIEW_VAULT_LIMITS.paths ||
					evidenceBytes + bytes.byteLength > this.limits.bytes ||
					bytes.byteLength > REVIEW_VAULT_LIMITS.blobBytes
				)
					throw new ReviewPRCaptureError("quota");
				evidenceBytes += bytes.byteLength;
				selections.push({
					selectionId: `pr-${selections.length}`,
					sourceId: captureSource,
					label,
					category,
					selected,
					bytes,
				});
			};
			for (const path of paths) {
				const entry = (key: keyof typeof trees) => {
					const value = maps[key].get(path);
					return value ? { oid: value.oid, mode: value.mode } : null;
				};
				add(
					`pr/inventory/${path}`,
					Buffer.from(
						canonicalJSON({ path, head: entry("head"), base: entry("base"), mergeBase: entry("mergeBase") }),
					),
				);
			}
			// Hydrate only immutable blobs. Symlink targets and gitlinks are inventory-only, never followed.
			for (const key of ["head", "base", "mergeBase"] as const) {
				const repository = key === "base" ? pinned.base.repository : pinned.head.repository;
				for (const entry of trees[key]) {
					const regular = entry.mode === "100644" || entry.mode === "100755";
					// Symlink blobs are needed by Git's canonical diff, but are not surrounding source.
					const bytes = entry.mode === "160000" ? Buffer.alloc(0) : await objects.blob(entry, repository);
					add(`pr/${key}/${entry.path}`, regular ? bytes : Buffer.alloc(0), regular);
				}
			}
			let diffBytes = 0;
			const changedPaths = new Set<string>();
			for (const path of paths) {
				const old = maps.mergeBase.get(path),
					current = maps.head.get(path);
				if (old?.oid === current?.oid && old?.mode === current?.mode) continue;
				const patch = await objects.patch(mergeBase, pinned.head.oid, path, this.limits.diffBytes - diffBytes);
				diffBytes += patch.length;
				if (diffBytes > this.limits.diffBytes) throw new ReviewPRCaptureError("quota");
				add(`pr/diff/${path}`, patch);
				changedPaths.add(path);
			}
			const discussionReport = this.discussions
				? await new ReviewPRDiscussions(
						scope,
						pinned,
						this.discussions,
						(action) => this.read(action),
						(label, bytes, selected) => add(label, bytes, selected, "discussion"),
						logs,
					).capture(changedPaths)
				: undefined;
			// Revalidate account AND fixed tips after acquisition. Movement is not silently retargeted.
			if (canonicalJSON(await metadata()) !== canonicalJSON(pinned)) throw new ReviewPRCaptureError("changed");
			add(
				"pr/capture.json",
				Buffer.from(
					canonicalJSON({
						version: 1,
						snapshot,
						trees: {
							head: heads.get(pinned.head.oid),
							base: bases.get(pinned.base.oid),
							mergeBase: heads.get(mergeBase),
						},
						inventoryPaths: paths.length,
						changedPaths: changedPaths.size,
						discussions: discussionReport
							? { report: "pr/discussions/capture.json", complete: discussionReport.complete }
							: null,
						sourceSelections: selections.length,
						diff: {
							from: mergeBase,
							to: pinned.head.oid,
							format: "git-myers-full-index-no-renames-per-path-v1",
							order: "UTF-8 byte path order",
							bytes: diffBytes,
						},
						coverage:
							"M/H diff and full H/B/M tree inventory; surrounding regular blobs only; vault omissions apply to all components",
						limits: [
							...(discussionReport
								? [
										"Discussion/check scope and freshness limits in pr/discussions/capture.json; vault redactions/omissions apply",
									]
								: ["No discussions/checks captured"]),
							"No checkout, hooks, external diff, textconv, filters, LFS hydration, submodule traversal or execution",
							"Head/base guidance is source data, not installed reviewer policy",
						],
					}),
				),
			);
			scope.check();
			const capture: ReviewCapture = {
				id: request.id,
				projectId: request.projectId,
				hostId: request.hostId,
				createdAt: request.createdAt,
				sourceIds,
				selections,
				knownSecrets: [...request.knownSecrets],
			};
			const manifest = await this.vault.capture(capture);
			sealed = true;
			scope.check();
			// Receipt filtering must not leave an apparently usable PR snapshot without its identity.
			if (!manifest.entries.some((entry) => entry.label === "pr/capture.json"))
				throw new ReviewPRCaptureError("identity");
			await objects.close();
			objects = undefined;
			scope.check();
			return { manifest, snapshot };
		} catch (error) {
			// Existing vault sealing is atomic but not interruptible. Cancelled seals are revoked before returning.
			if (sealed) await this.vault.eraseSource(captureSource);
			if (error instanceof ReviewPRCaptureError) throw error;
			if (error instanceof Error && error.message.startsWith("Review storage quota full"))
				throw new ReviewPRCaptureError("quota");
			throw new ReviewPRCaptureError("object");
		} finally {
			try {
				if (objects) await objects.close();
			} finally {
				scope.close();
				this.busy = false;
			}
		}
	}
}
