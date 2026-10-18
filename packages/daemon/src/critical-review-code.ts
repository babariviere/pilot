/** Disabled host-only code/verification capture. No endpoint, author workspace manager or live provider calls it. */
import { Worker } from "node:worker_threads";
import type { CriticalReviewEvidence } from "@pilot/protocol";
import type { ReviewToolAdmission } from "./critical-review-admission.ts";
import {
	CODE_CAPTURE_LIMITS,
	type CodeTreeScan,
	type CodeWorkspace,
	readCodeGit,
} from "./critical-review-code-tree.ts";
import type { CriticalReviewVault, ReviewCapture, ReviewSelection } from "./critical-review-vault.ts";

export interface RecordedVerification {
	id: string;
	/** Host durable process/check receipt, not text parsed from author claims or logs. */
	receiptId: string;
	/** Bounded host-recorded command/check label, untrusted evidence rather than an instruction. */
	label: string;
	output: "complete" | "truncated" | "unavailable";
	kind: "job" | "test" | "check";
	state: "running" | "done" | "failed" | "cancelled" | "interrupted";
	exitCode: number | null;
	/** Explicit process/check conclusion; zero exit alone is not a test-suite/coverage claim. */
	conclusion: "passed" | "failed" | "unknown";
	testedSha: string | null;
	testedTree: string | null;
	testedTreeKind: "git_tree" | "code_inventory_v1" | null;
}
export interface CodeActivity {
	/** Capture-revision receipt, not reconstructed state at a historical transcript boundary. */
	revision: string;
	children: { id: string; state: "running" | "done" | "failed" | "cancelled" | "unknown" }[];
	jobs: RecordedVerification[];
	/** True only when this host observation is complete. Unknown is never absence. */
	complete: boolean;
}
export interface CodeActivityReader {
	/** No start, wait-for-completion, stop, wake, workspace creation or execution capability. */
	read(signal: AbortSignal): Promise<CodeActivity>;
}
export interface SessionCodeCapture extends Omit<ReviewCapture, "selections" | "sourceIds"> {
	sourceId: string;
	sessionId: string;
	attemptId: number;
	boundary: number;
	/** Null means unavailable. Never consult the workspace manager to restore it. */
	workspace: CodeWorkspace | null;
}
const opaque = /^[A-Za-z0-9_-]{1,128}$/;
const identifier = (value: unknown): value is string => typeof value === "string" && opaque.test(value);
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
let activeCaptures = 0;
let activityReads = 0;

function activity(value: CodeActivity): CodeActivity {
	// Validate and copy only bounded whitelisted fields synchronously. Never clone arbitrary provider extras/logs.
	const copy = value;
	if (
		!copy ||
		!identifier(copy.revision) ||
		typeof copy.complete !== "boolean" ||
		!Array.isArray(copy.children) ||
		!Array.isArray(copy.jobs) ||
		copy.children.length > 256 ||
		copy.jobs.length > 256
	)
		throw new Error("Invalid activity receipt");
	const ids = new Set<string>();
	for (const child of copy.children) {
		if (
			!identifier(child.id) ||
			ids.has(child.id) ||
			!["running", "done", "failed", "cancelled", "unknown"].includes(child.state)
		)
			throw new Error("Invalid child receipt");
		ids.add(child.id);
	}
	ids.clear();
	for (const job of copy.jobs) {
		if (
			!identifier(job.id) ||
			!identifier(job.receiptId) ||
			typeof job.label !== "string" ||
			job.label.length === 0 ||
			Buffer.byteLength(job.label) > 1024 ||
			job.label.includes("\0") ||
			!["complete", "truncated", "unavailable"].includes(job.output) ||
			ids.has(job.id) ||
			!["job", "test", "check"].includes(job.kind) ||
			!["running", "done", "failed", "cancelled", "interrupted"].includes(job.state) ||
			(job.exitCode !== null && (!Number.isSafeInteger(job.exitCode) || job.exitCode < 0 || job.exitCode > 255)) ||
			!["passed", "failed", "unknown"].includes(job.conclusion) ||
			(job.testedSha !== null && !sha.test(job.testedSha)) ||
			(job.testedTree === null
				? job.testedTreeKind !== null
				: job.testedTreeKind === "git_tree"
					? !sha.test(job.testedTree)
					: job.testedTreeKind !== "code_inventory_v1" || !digest.test(job.testedTree))
		)
			throw new Error("Invalid verification receipt");
		ids.add(job.id);
	}
	// Whitelist fields: a structural TypeScript type does not strip private log/path extras at runtime.
	return {
		revision: copy.revision,
		complete: copy.complete,
		children: copy.children.map(({ id, state }) => ({ id, state })),
		jobs: copy.jobs.map(
			({
				id,
				receiptId,
				label,
				output,
				kind,
				state,
				exitCode,
				conclusion,
				testedSha,
				testedTree,
				testedTreeKind,
			}) => ({
				id,
				receiptId,
				label,
				output,
				kind,
				state,
				exitCode,
				conclusion,
				testedSha,
				testedTree,
				testedTreeKind,
			}),
		),
	};
}

/** One owner per host-selected author; pending non-cooperative reads keep the owner busy after cancellation. */
export class SessionCodeCapturer {
	private busy = false;
	private pending = 0;
	private readonly admission: ReviewToolAdmission;
	private readonly reader: CodeActivityReader;
	constructor(admission: ReviewToolAdmission, reader: CodeActivityReader) {
		this.admission = admission;
		this.reader = reader;
	}
	private async observe(signal: AbortSignal): Promise<CodeActivity> {
		signal.throwIfAborted();
		if (activityReads >= 3) throw new Error("Activity capture busy");
		this.pending++;
		activityReads++;
		const read = Promise.resolve()
			.then(() => this.reader.read(signal))
			.then(activity)
			.finally(() => {
				this.pending--;
				activityReads--;
			});
		let cancel!: () => void;
		const aborted = new Promise<never>((_, reject) => {
			cancel = () => reject(new Error("Code capture cancelled"));
			signal.addEventListener("abort", cancel, { once: true });
		});
		try {
			return await Promise.race([read, aborted]);
		} finally {
			signal.removeEventListener("abort", cancel);
		}
	}
	private async scan(workspace: CodeWorkspace, signal: AbortSignal): Promise<CodeTreeScan> {
		signal.throwIfAborted();
		const worker = new Worker(new URL("./critical-review-code-worker.ts", import.meta.url), {
			workerData: workspace,
			resourceLimits: { maxOldGenerationSizeMb: 256 },
		});
		const commands = new Set<Promise<void>>();
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		try {
			return await new Promise<CodeTreeScan>((resolve, reject) => {
				const cancel = () => reject(new Error("Code capture cancelled or hold expired"));
				signal.addEventListener("abort", cancel, { once: true });
				worker.on("message", (message) => {
					if (message.kind === "git") {
						const command = readCodeGit(
							workspace,
							message.args,
							message.maxBuffer,
							message.input,
							controller.signal,
						)
							.then(
								(bytes) => {
									worker.postMessage({ bytes });
								},
								() => {
									worker.postMessage({ error: true });
								},
							)
							.finally(() => commands.delete(command));
						commands.add(command);
					} else if (message.kind === "result") {
						signal.removeEventListener("abort", cancel);
						resolve(message.value);
					}
				});
				worker.once("error", () => {
					signal.removeEventListener("abort", cancel);
					reject(new Error("Code inventory unavailable or over limit"));
				});
				worker.once("exit", () => {
					signal.removeEventListener("abort", cancel);
					reject(new Error("Code inventory exited"));
				});
				if (signal.aborted) cancel();
			});
		} finally {
			// Cancel only owned read-only Git child handles, never author tools/jobs. Await actual child cleanup.
			controller.abort();
			signal.removeEventListener("abort", abort);
			await Promise.allSettled(commands);
			await worker.terminate();
		}
	}
	async capture(
		vault: CriticalReviewVault,
		request: SessionCodeCapture,
		signal?: AbortSignal,
	): Promise<CriticalReviewEvidence> {
		const input = structuredClone(request);
		if (
			![input.id, input.projectId, input.hostId, input.sourceId, input.sessionId].every(identifier) ||
			!Number.isSafeInteger(input.attemptId) ||
			input.attemptId < 1 ||
			!Number.isSafeInteger(input.boundary) ||
			input.boundary < 0 ||
			(input.workspace !== null &&
				(!sha.test(input.workspace.baseline) ||
					![input.workspace.root, input.workspace.gitDirectory].every(
						(p) => typeof p === "string" && p.length <= 4096,
					)))
		)
			throw new Error("Invalid code capture scope");
		signal?.throwIfAborted();
		if (this.busy || this.pending || activeCaptures >= 2) throw new Error("Code capture busy");
		this.busy = true;
		activeCaptures++;
		const controller = new AbortController();
		const cancel = () => controller.abort(new Error("Code capture cancelled or invalidated"));
		const unsubscribe = vault.store.onPrivateInvalidation(cancel);
		signal?.addEventListener("abort", cancel, { once: true });
		const timer = setTimeout(cancel, CODE_CAPTURE_LIMITS.durationMs);
		let release: (() => void) | undefined;
		let holdTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const beforeActivity = await this.observe(controller.signal);
			let final: CodeTreeScan | undefined;
			const comparisons: unknown[] = [];
			let raceObserved = false,
				attempts = 0;
			if (input.workspace) {
				holdTimer = setTimeout(cancel, CODE_CAPTURE_LIMITS.holdMs);
				release = await this.admission.hold(controller.signal);
				for (let attempt = 0; attempt < 2; attempt++) {
					attempts++;
					const pre = await this.scan(input.workspace, controller.signal);
					const post = await this.scan(input.workspace, controller.signal);
					final = post;
					const watermark = ({
						status,
						head,
						treeDigest,
						indexDigest,
						observationDigest,
						raced,
					}: CodeTreeScan) => ({ status, head, treeDigest, indexDigest, observationDigest, raced });
					comparisons.push({ pre: watermark(pre), post: watermark(post) });
					const stable =
						pre.status === "available" &&
						post.status === "available" &&
						!pre.raced &&
						!post.raced &&
						pre.observationDigest === post.observationDigest;
					if (stable || (pre.status === "missing" && post.status === "missing")) break;
					raceObserved = true;
				}
				release();
				release = undefined;
				clearTimeout(holdTimer);
			}
			const afterActivity = await this.observe(controller.signal);
			controller.signal.throwIfAborted();
			const selections: ReviewSelection[] = [];
			const add = (label: string, bytes: Uint8Array | undefined, selected = true) =>
				selections.push({
					selectionId: `code-${selections.length}`,
					sourceId: input.sourceId,
					label,
					category: "source",
					selected,
					...(bytes ? { bytes } : {}),
				});
			if (final?.status === "available") {
				for (const [side, files] of [
					["baseline", final.baselineFiles],
					["tree", final.files],
				] as const) {
					for (const { bytes, stamp: _stamp, ...file } of files) {
						// Path-specific metadata: the vault can omit a secret path without leaking it through a global index.
						add(`code/${side}/inventory/${file.path}`, Buffer.from(JSON.stringify(file)));
						if (file.state === "present") add(`code/${side}/source/${file.path}`, bytes);
						else if (file.state !== "deleted") add(`code/${side}/omitted/${file.path}`, undefined, false);
					}
				}
			}
			const available = final?.status === "available";
			const normalize = (value: CodeActivity) => ({
				...value,
				jobs: value.jobs.map((job) => ({
					...job,
					outcome:
						job.state === "done" && job.exitCode === 0 && job.conclusion === "passed"
							? "passed"
							: job.state === "cancelled" || job.state === "interrupted"
								? job.state
								: job.state === "running"
									? "running"
									: job.state === "failed" ||
											job.conclusion === "failed" ||
											(job.exitCode !== null && job.exitCode !== 0)
										? "failed"
										: "unknown",
					// A SHA alone cannot prove which dirty files a process tested. Never substitute capture-time HEAD/tree.
					treeAssociation:
						job.testedTreeKind !== "code_inventory_v1" || !available
							? "unknown"
							: job.testedTree === final?.treeDigest
								? "same_tree"
								: "different_tree",
				})),
			});
			add(
				"code/capture.json",
				Buffer.from(
					JSON.stringify({
						version: 1,
						sessionId: input.sessionId,
						attemptId: input.attemptId,
						boundary: input.boundary,
						workspace: available ? "available" : "missing",
						conversationOnlyAvailable: !available,
						baseline: input.workspace?.baseline ?? null,
						baselineTree: final?.baselineTree ?? null,
						head: final?.head ?? null,
						treeDigest: final?.treeDigest ?? null,
						indexDigest: final?.indexDigest ?? null,
						attempts,
						raceObserved,
						comparisons,
						treeDigestAlgorithm: "sha256-code-inventory-v1",
						inventoryComparison: available && !raceObserved ? "matched" : "partial",
						coverage: {
							atomic: false,
							crossStoreAtomic: false,
							safeBoundary: input.workspace !== null,
							untracked: "nonignored_only",
							index: "digest_and_tracked_paths_not_staged_blob_content",
							childContent: "not_acquired",
							authorState: "not_mutated",
							verification: "host_receipts_not_log_claims",
							transcriptBoundaryAssociation: "capture_revision_only",
							vaultOmissionsAuthoritative: true,
							testCoverageProven: false,
						},
						activityBefore: normalize(beforeActivity),
						activityAfter: normalize(afterActivity),
					}),
				),
			);
			// Always incomplete as session evidence: child content, transcript/code atomicity and staged blobs aren't claimed.
			add("code/uncaptured-scope", undefined, false);
			return await vault.capture({ ...input, sourceIds: [input.sourceId], selections }, controller.signal);
		} finally {
			release?.();
			clearTimeout(holdTimer);
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			unsubscribe();
			this.busy = false;
			activeCaptures--;
		}
	}
}
