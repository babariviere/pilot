/** Host-only normalized read seam. No live GitHub transport, URL fetch or executable log/artifact reader. */
import { createHash } from "node:crypto";
import {
	pinReviewPR,
	ReviewPRCaptureError,
	type ReviewPRReadRequest,
	type ReviewPRSnapshot,
	reviewGitOID,
} from "./critical-review-pr-intake.ts";
import type { ReviewPRScope } from "./critical-review-pr-objects.ts";
import { canonicalJSON } from "./operation-journal.ts";

export const REVIEW_PR_DISCUSSION_LIMITS = Object.freeze({
	bytes: 20 * 1024 * 1024,
	pageBytes: 256 * 1024,
	pages: 20,
	items: 100,
	requests: 256,
	logs: 10,
	logBytes: 50 * 1024,
});
export type ReviewPRCollection = "general" | "reviews" | "inline" | "checks" | "statuses" | "files";
const collections: ReviewPRCollection[] = ["general", "reviews", "inline", "checks", "statuses", "files"];
export interface ReviewPRDiscussion {
	id: string;
	body: string;
	authorId: string | null;
	createdAt: number;
	updatedAt: number;
	/** General comments have no commit; reviews/inline comments may refer to an earlier head. */
	sha: string | null;
	reviewId?: string;
	replyToId?: string;
	path?: string;
	line?: number | null;
	originalLine?: number | null;
	side?: "LEFT" | "RIGHT";
	originalSha?: string | null;
	state?: string;
}
export interface ReviewPRCheck {
	id: string;
	sha: string;
	name: string;
	status: string;
	conclusion: string | null;
	startedAt: number | null;
	completedAt: number | null;
	/** Inert authorized check output, subject to the same page/export/redaction bounds. */
	output?: { title: string; summary: string; text: string | null };
}
export interface ReviewPRFile {
	path: string;
	previousPath?: string;
	status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
}
type Item = ReviewPRDiscussion | ReviewPRCheck | ReviewPRFile;
interface Observation {
	host: string;
	accountId: string;
	repositoryId: string;
	prId: string;
	/** Adapter observation time, not a globally atomic GitHub revision. */
	observedAt: number;
}
export type ReviewPRReadResult<T> = Observation &
	({ ok: true; value: T } | { ok: false; reason: "forbidden" | "rate_limit" | "unavailable" });
export interface ReviewPRDiscussionState {
	snapshot: ReviewPRSnapshot;
	body: string;
	updatedAt: number;
	changedFiles: number;
}
export interface ReviewPRLogSelection {
	checkId: string;
	sha: string;
	offset: number;
	bytes: number;
}
/** Only trusted adapters may normalize responses. Bound transport BEFORE parsing, including failures.
 * Never follow response links/redirects or acquire artifacts. Cursors are opaque tokens, not URLs.
 * Every operation rechecks authenticated host/account/repository/PR scope. No retry is implicit.
 */
export interface ReviewPRDiscussionReader {
	readState(request: ReviewPRReadRequest): Promise<ReviewPRReadResult<ReviewPRDiscussionState>>;
	readPage(
		request: ReviewPRReadRequest & {
			collection: ReviewPRCollection;
			cursor: string | null;
			limit: number;
			sha: string;
		},
	): Promise<ReviewPRReadResult<{ items: Item[]; total: number | null; next: string | null }>>;
	readLog(request: ReviewPRReadRequest & ReviewPRLogSelection): Promise<
		ReviewPRReadResult<{
			checkId: string;
			sha: string;
			offset: number;
			text: string;
			totalBytes: number | null;
			truncated: boolean;
		}>
	>;
}
export interface ReviewPRDiscussionReport {
	version: 1;
	head: string;
	startedAt: number;
	finishedAt: number;
	complete: boolean;
	issues: { component: string; reason: string }[];
	observations: { component: string; pass: number; observedAt: number; digest: string }[];
	collections: Partial<
		Record<ReviewPRCollection, { observed: number; captured: number; apiTotal: number | null; exhaustive: boolean }>
	>;
	inventory: {
		canonicalPaths: number;
		apiPaths: number;
		missing: number;
		unexpected: number;
		apiTotal: number | null;
	};
	logs: { requested: number; captured: number };
	resources: {
		requests: number;
		chargedReadBytes: number;
		exportBytes: number;
		limits: typeof REVIEW_PR_DISCUSSION_LIMITS;
	};
	limits: readonly string[];
}
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_=-]{1,128}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string";
const sha = (v: unknown): v is string => typeof v === "string" && reviewGitOID.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const digest = (v: unknown) => createHash("sha256").update(canonicalJSON(v)).digest("hex");

/** Freeze a bounded allowlist, rather than forwarding arbitrary caller properties to an adapter. */
export function reviewPRLogSelections(value: unknown): ReviewPRLogSelection[] {
	if (!Array.isArray(value) || value.length > REVIEW_PR_DISCUSSION_LIMITS.logs)
		throw new ReviewPRCaptureError("quota");
	return value.map((log: unknown) => {
		if (
			!record(log) ||
			!id(log.checkId) ||
			!sha(log.sha) ||
			!integer(log.offset) ||
			!integer(log.bytes) ||
			!Number.isSafeInteger(log.offset + log.bytes) ||
			log.bytes < 1 ||
			log.bytes > REVIEW_PR_DISCUSSION_LIMITS.logBytes
		)
			throw new ReviewPRCaptureError("identity");
		return { checkId: log.checkId, sha: log.sha, offset: log.offset, bytes: log.bytes };
	});
}

/** One invocation lives inside B08's capture scope, byte budget, read admission and erasure lineage. */
export class ReviewPRDiscussions {
	private bytes = 0;
	private requests = 0;
	private sequence = 0;
	private exportBytes = 0;
	private readonly report: ReviewPRDiscussionReport;
	private readonly scope: ReviewPRScope;
	private readonly snapshot: ReviewPRSnapshot;
	private readonly reader: ReviewPRDiscussionReader;
	private readonly transport: <T>(action: () => Promise<T>) => Promise<T>;
	private readonly add: (label: string, bytes: Uint8Array, selected?: boolean) => void;
	private readonly logs: readonly ReviewPRLogSelection[];
	constructor(
		scope: ReviewPRScope,
		snapshot: ReviewPRSnapshot,
		reader: ReviewPRDiscussionReader,
		transport: <T>(action: () => Promise<T>) => Promise<T>,
		add: (label: string, bytes: Uint8Array, selected?: boolean) => void,
		logs: readonly ReviewPRLogSelection[],
	) {
		this.scope = scope;
		this.snapshot = snapshot;
		this.reader = reader;
		this.transport = transport;
		this.add = add;
		this.logs = reviewPRLogSelections(logs);
		this.report = {
			version: 1,
			head: snapshot.head.oid,
			startedAt: Date.now(),
			finishedAt: 0,
			complete: true,
			issues: [],
			observations: [],
			collections: {},
			inventory: { canonicalPaths: 0, apiPaths: 0, missing: 0, unexpected: 0, apiTotal: null },
			logs: { requested: logs.length, captured: 0 },
			resources: { requests: 0, chargedReadBytes: 0, exportBytes: 0, limits: REVIEW_PR_DISCUSSION_LIMITS },
			limits: [
				"Mutable observations are not an atomic snapshot; unchanged re-reads cannot prove no intervening edits",
				"Passing checks, including exact-head checks, do not prove test coverage; other-SHA checks do not verify this head",
				"Only explicitly authorized log byte ranges; no artifacts, execution, external links, redirects or automatic retries",
				"File totals count API entries; canonical no-renames inventory counts paths (renames can count twice)",
				"Source binary/secret/unsafe/quota omissions remain in the vault manifest; LFS objects and submodules are not hydrated",
			],
		};
	}
	private issue(component: string, reason: string): void {
		this.report.complete = false;
		// Components and reasons are host constants, never API error text or private paths.
		if (!this.report.issues.some((v) => v.component === component && v.reason === reason))
			this.report.issues.push({ component, reason });
	}
	private store(component: string, value: unknown): boolean {
		const bytes = Buffer.from(canonicalJSON(value));
		// Reserve report space inside the approved 20 MiB export, including wrapper overhead.
		if (this.exportBytes + bytes.length > REVIEW_PR_DISCUSSION_LIMITS.bytes - 256 * 1024) {
			this.issue(component, "export-quota");
			return false;
		}
		this.exportBytes += bytes.length;
		this.add(`pr/discussions/${component}-${this.sequence++}.json`, bytes);
		return true;
	}
	private async read<T>(
		component: string,
		maxBytes: number,
		action: (request: ReviewPRReadRequest) => Promise<ReviewPRReadResult<T>>,
	): Promise<(ReviewPRReadResult<T> & { ok: true }) | undefined> {
		const remaining = REVIEW_PR_DISCUSSION_LIMITS.bytes - this.bytes;
		if (this.requests >= REVIEW_PR_DISCUSSION_LIMITS.requests || remaining < 1) {
			this.issue(component, "quota");
			return;
		}
		this.requests++;
		const limit = Math.min(maxBytes, remaining);
		let response: ReviewPRReadResult<T>;
		try {
			response = await this.scope.read(() =>
				this.transport(() => action({ identity: this.snapshot, signal: this.scope.signal, maxBytes: limit })),
			);
		} catch (error) {
			this.scope.check();
			if (error instanceof ReviewPRCaptureError) throw error;
			this.issue(component, "unavailable");
			return;
		}
		// Transport limits are an adapter obligation. Defensively reject oversized/malformed normalized responses too.
		const size = Buffer.byteLength(JSON.stringify(response) ?? "");
		if (size > limit) {
			this.issue(component, "quota");
			this.bytes = REVIEW_PR_DISCUSSION_LIMITS.bytes;
			return;
		}
		this.bytes += size;
		if (
			!record(response) ||
			response.host !== this.snapshot.host ||
			response.accountId !== this.snapshot.account.id ||
			response.repositoryId !== this.snapshot.repository.id ||
			response.prId !== this.snapshot.pr.id ||
			!integer(response.observedAt)
		)
			throw new ReviewPRCaptureError("identity");
		if (response.ok !== true) {
			this.report.observations.push({
				component,
				pass: 0,
				observedAt: response.observedAt,
				digest: digest({ reason: response.reason }),
			});
			this.issue(
				component,
				["forbidden", "rate_limit", "unavailable"].includes(response.reason) ? response.reason : "invalid",
			);
			return;
		}
		// Do not let a reused/mutated adapter response rewrite a previous observation or log authorization.
		return structuredClone(response);
	}
	private async state(pass: number): Promise<ReviewPRDiscussionState | undefined> {
		const response = await this.read("body", REVIEW_PR_DISCUSSION_LIMITS.pageBytes, (r) => this.reader.readState(r));
		if (!response) return;
		const v = response.value;
		if (!record(v) || !text(v.body) || !integer(v.updatedAt) || !integer(v.changedFiles)) {
			this.issue("body", "invalid");
			return;
		}
		if (canonicalJSON(pinReviewPR(this.snapshot, v.snapshot)) !== canonicalJSON(this.snapshot))
			throw new ReviewPRCaptureError("changed");
		this.report.observations.push({ component: "body", pass, observedAt: response.observedAt, digest: digest(v) });
		if (pass === 1)
			this.store("body", {
				...v,
				observedAt: response.observedAt,
				snapshotHead: this.snapshot.head.oid,
				trust: "untrusted-author-claim",
			});
		return v;
	}
	private validItem(collection: ReviewPRCollection, value: unknown): value is Item {
		if (!record(value)) return false;
		if (collection === "files")
			return (
				text(value.path) &&
				Buffer.byteLength(value.path) <= 400 &&
				(!Object.hasOwn(value, "previousPath") ||
					(text(value.previousPath) && Buffer.byteLength(value.previousPath) <= 400)) &&
				["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"].includes(
					value.status as string,
				)
			);
		if (!id(value.id)) return false;
		if (collection === "checks" || collection === "statuses")
			return (
				sha(value.sha) &&
				text(value.name) &&
				text(value.status) &&
				(value.conclusion === null || text(value.conclusion)) &&
				(value.startedAt === null || integer(value.startedAt)) &&
				(value.completedAt === null || integer(value.completedAt)) &&
				(!Object.hasOwn(value, "output") ||
					(record(value.output) &&
						text(value.output.title) &&
						text(value.output.summary) &&
						(value.output.text === null || text(value.output.text))))
			);
		return (
			text(value.body) &&
			(value.authorId === null || id(value.authorId)) &&
			integer(value.createdAt) &&
			integer(value.updatedAt) &&
			(value.sha === null || sha(value.sha)) &&
			(!Object.hasOwn(value, "originalSha") || value.originalSha === null || sha(value.originalSha)) &&
			(!Object.hasOwn(value, "reviewId") || id(value.reviewId)) &&
			(!Object.hasOwn(value, "replyToId") || id(value.replyToId)) &&
			(!Object.hasOwn(value, "path") || text(value.path)) &&
			(!Object.hasOwn(value, "line") || value.line === null || integer(value.line)) &&
			(!Object.hasOwn(value, "originalLine") || value.originalLine === null || integer(value.originalLine)) &&
			(!Object.hasOwn(value, "side") || value.side === "LEFT" || value.side === "RIGHT") &&
			(!Object.hasOwn(value, "state") || text(value.state))
		);
	}
	private async pages(collection: ReviewPRCollection, pass: number) {
		const items: Item[] = [],
			ids = new Set<string>(),
			cursors = new Set<string>();
		let cursor: string | null = null,
			total: number | null = null,
			exhaustive = false,
			captured = 0;
		const hash = createHash("sha256");
		for (let page = 0; page < REVIEW_PR_DISCUSSION_LIMITS.pages; page++) {
			const response = await this.read(collection, REVIEW_PR_DISCUSSION_LIMITS.pageBytes, (r) =>
				this.reader.readPage({
					...r,
					collection,
					cursor,
					limit: REVIEW_PR_DISCUSSION_LIMITS.items,
					sha: this.snapshot.head.oid,
				}),
			);
			if (!response) break;
			const v = response.value;
			if (
				!record(v) ||
				!Array.isArray(v.items) ||
				v.items.length > REVIEW_PR_DISCUSSION_LIMITS.items ||
				(v.total !== null && !integer(v.total)) ||
				(v.next !== null && !id(v.next))
			) {
				this.issue(collection, "invalid-page");
				break;
			}
			if (page > 0 && total !== v.total) this.issue(collection, "changing-total");
			total = v.total;
			for (const item of v.items) {
				if (!this.validItem(collection, item)) {
					this.issue(collection, "invalid-item");
					continue;
				}
				const key = collection === "files" ? (item as ReviewPRFile).path : (item as ReviewPRDiscussion).id;
				if (ids.has(key)) {
					this.issue(collection, "duplicate-id");
					continue;
				}
				ids.add(key);
				items.push(item);
				hash.update(canonicalJSON(item));
				if (
					pass === 1 &&
					this.store(collection, {
						item,
						observedAt: response.observedAt,
						snapshotHead: this.snapshot.head.oid,
						shaRelation:
							"sha" in item
								? item.sha === this.snapshot.head.oid
									? "exact-head-not-coverage-proof"
									: item.sha === null
										? "unscoped"
										: "other-head-not-current-verification"
								: "inventory-only",
					})
				)
					captured++;
			}
			this.report.observations.push({
				component: collection,
				pass,
				observedAt: response.observedAt,
				digest: digest(v),
			});
			if (v.next === null) {
				exhaustive = true;
				break;
			}
			if (cursors.has(v.next)) {
				this.issue(collection, "cursor-cycle");
				break;
			}
			cursors.add(v.next);
			cursor = v.next;
		}
		if (!exhaustive) this.issue(collection, "pagination-incomplete");
		if (total === null || total !== items.length) this.issue(collection, "total-unreconciled");
		return {
			items,
			total,
			exhaustive,
			captured,
			digest: hash.update(canonicalJSON({ total, exhaustive })).digest("hex"),
		};
	}
	async capture(changedPaths: ReadonlySet<string>): Promise<ReviewPRDiscussionReport> {
		const first = await this.state(1);
		const baseline = new Map<ReviewPRCollection, string>();
		let checks: ReviewPRCheck[] = [],
			files: ReviewPRFile[] = [];
		for (const collection of collections) {
			const result = await this.pages(collection, 1);
			baseline.set(collection, result.digest);
			this.report.collections[collection] = {
				observed: result.items.length,
				captured: result.captured,
				apiTotal: result.total,
				exhaustive: result.exhaustive,
			};
			if (collection === "checks") checks = result.items as ReviewPRCheck[];
			if (collection === "files") files = result.items as ReviewPRFile[];
		}
		const apiPaths = new Set(
			files.flatMap((f) => (f.status === "renamed" && f.previousPath ? [f.path, f.previousPath] : [f.path])),
		);
		this.report.inventory = {
			canonicalPaths: changedPaths.size,
			apiPaths: apiPaths.size,
			missing: [...changedPaths].filter((p) => !apiPaths.has(p)).length,
			unexpected: [...apiPaths].filter((p) => !changedPaths.has(p)).length,
			apiTotal: first?.changedFiles ?? null,
		};
		if (
			this.report.inventory.missing ||
			this.report.inventory.unexpected ||
			!first ||
			first.changedFiles !== files.length
		)
			this.issue("files", "inventory-unreconciled");
		for (const log of this.logs) {
			if (!checks.some((c) => c.id === log.checkId && c.sha === log.sha)) {
				this.issue("logs", "unauthorized-or-unobserved-check");
				continue;
			}
			const response = await this.read("logs", REVIEW_PR_DISCUSSION_LIMITS.pageBytes, (r) =>
				this.reader.readLog({ ...r, ...log, maxBytes: Math.min(r.maxBytes, log.bytes + 4096) }),
			);
			if (!response) continue;
			const v = response.value;
			if (
				!record(v) ||
				v.checkId !== log.checkId ||
				v.sha !== log.sha ||
				v.offset !== log.offset ||
				!text(v.text) ||
				typeof v.truncated !== "boolean" ||
				(v.totalBytes !== null && !integer(v.totalBytes)) ||
				Buffer.byteLength(v.text) > log.bytes ||
				(v.totalBytes !== null && v.totalBytes < log.offset + Buffer.byteLength(v.text))
			) {
				this.issue("logs", "invalid-excerpt");
				continue;
			}
			const end = log.offset + Buffer.byteLength(v.text);
			if (v.truncated || log.offset !== 0 || v.totalBytes === null || v.totalBytes !== end)
				this.issue("logs", "partial-excerpt");
			if (
				this.store("log", {
					...v,
					observedAt: response.observedAt,
					snapshotHead: this.snapshot.head.oid,
					shaRelation:
						v.sha === this.snapshot.head.oid
							? "exact-head-not-coverage-proof"
							: "other-head-not-current-verification",
				})
			)
				this.report.logs.captured++;
		}
		for (const collection of collections) {
			if ((await this.pages(collection, 2)).digest !== baseline.get(collection))
				this.issue(collection, "changed-during-capture");
		}
		const last = await this.state(2);
		if (!first || !last || digest(first) !== digest(last)) this.issue("body", "changed-or-unavailable");
		this.report.finishedAt = Date.now();
		this.report.resources = {
			requests: this.requests,
			chargedReadBytes: this.bytes,
			exportBytes: this.exportBytes,
			limits: REVIEW_PR_DISCUSSION_LIMITS,
		};
		this.add("pr/discussions/capture.json", Buffer.from(canonicalJSON(this.report)));
		if (!this.report.complete) this.add("pr/discussions/incomplete", Buffer.alloc(0), false);
		return this.report;
	}
}
