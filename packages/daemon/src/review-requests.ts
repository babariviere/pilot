/** Explicit optional suggestions only. Capture, feedback and task completion never call this. */
import type {
	NativeReviewComparison,
	ReviewDispositionTarget,
	ReviewRequestPage,
	ReviewRequestSuggestion,
	ReviewRequestTransition,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { dispositionTarget, type QualifiedFeedbackComparison } from "./human-reviews.ts";
import { exact, identifier } from "./jj-ownership-contract.ts";
import { canonicalJSON } from "./operation-journal.ts";
import type { ReviewRequestActor, ReviewRequestRecord, ReviewRequestStore } from "./review-request-store.ts";
import { dispositionPayload } from "./workflow-confirmations.ts";

interface Dependencies {
	store: ReviewRequestStore;
	authorize(actor: ReviewRequestActor, target: ReviewDispositionTarget): { revalidate(): void };
	qualify(
		target: ReviewDispositionTarget,
	): Promise<QualifiedFeedbackComparison & { comparison: NativeReviewComparison }>;
}
const id = (v: unknown) => identifier(v, /^[A-Za-z0-9_-]{1,128}$/);
function text(v: unknown, max: number) {
	if (typeof v !== "string" || !v.trim() || v.length > max) throw new Conflict("Invalid review suggestion text");
}
function cursor(v: number) {
	if (!Number.isSafeInteger(v) || v < 0) throw new Conflict("Invalid review request cursor");
}
function target(v: ReviewDispositionTarget) {
	return dispositionPayload({
		purpose: "review-disposition",
		targets: [v],
		disposition: "comment",
		body: "Validate exact request target",
		expectedPriorRecordId: null,
		packageDigest: "0".repeat(64),
	}).targets[0];
}
export class ReviewRequests {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	private current(records: ReviewRequestRecord[]) {
		for (const r of records)
			if (canonicalJSON(this.deps.store.get(r.requestId)) !== canonicalJSON(r))
				throw new Conflict("Review request changed during read");
	}
	private async access(actor: ReviewRequestActor, t: ReviewDispositionTarget) {
		const authority = this.deps.authorize(actor, t);
		const qualified = await this.deps.qualify(t);
		const checkCustody = qualified.revalidate;
		const revalidate = () => {
			authority.revalidate();
			checkCustody();
		};
		revalidate();
		if (
			canonicalJSON(dispositionTarget(t.projectId, qualified.snapshot)) !== canonicalJSON(t) ||
			qualified.comparison.snapshotId !== t.snapshotId ||
			canonicalJSON(qualified.comparison.request) !== canonicalJSON(qualified.snapshot.request) ||
			!Number.isSafeInteger(qualified.comparison.sequence) ||
			qualified.comparison.sequence < 1
		)
			throw new Conflict("Exact request comparison unavailable");
		return { ...qualified, revalidate };
	}
	/** Lookup never creates or reinstates an effect, even when the original receipt says pending. */
	async lookup(operationId: string, actor: ReviewRequestActor, payload?: string) {
		id(operationId);
		const receipt = this.deps.store.lookup(operationId, actor, payload);
		const record = receipt ? this.deps.store.get(receipt.requestId) : undefined;
		if (receipt && !record) throw new Conflict("Original request history unavailable");
		const access = receipt ? await this.access(actor, receipt.target) : undefined;
		if (record) this.current([record]);
		await this.deps.store.durable();
		access?.revalidate();
		if (record) this.current([record]);
		if (canonicalJSON(this.deps.store.lookup(operationId, actor, payload) ?? null) !== canonicalJSON(receipt ?? null))
			throw new Conflict("Review operation changed during lookup");
		return receipt ?? null;
	}
	async suggest(actor: ReviewRequestActor, raw: ReviewRequestSuggestion) {
		const input = structuredClone(raw);
		exact(input, ["operationId", "target", "title", "reason", "replacesRequestId", "replacesExpectedRevision"]);
		id(input.operationId);
		text(input.title, 200);
		text(input.reason, 4000);
		input.target = target(input.target);
		if (input.replacesRequestId !== null) {
			id(input.replacesRequestId);
			if (!Number.isSafeInteger(input.replacesExpectedRevision) || input.replacesExpectedRevision! < 1)
				throw new Conflict("Replacement requires exact prior revision");
		} else if (input.replacesExpectedRevision !== null) throw new Conflict("Unexpected replacement revision");
		const payload = canonicalJSON({ action: "suggest", ...input });
		const receipt = await this.lookup(input.operationId, actor, payload);
		if (receipt) return receipt;
		const access = await this.access(actor, input.target);
		const prior = input.replacesRequestId ? this.deps.store.get(input.replacesRequestId) : undefined;
		if (input.replacesRequestId && !prior) throw new Conflict("Replacement request unavailable");
		const oldAccess = prior ? await this.access(actor, prior.target) : undefined;
		const revalidate = () => {
			access.revalidate();
			oldAccess?.revalidate();
			if (prior) this.current([prior]);
		};
		revalidate();
		const result = this.deps.store.suggest(
			input.operationId,
			actor,
			payload,
			{ ...input, comparison: access.comparison },
			revalidate,
		);
		// Pin effect before invoking the barrier. A later change cannot turn into a positive latest read.
		const written = this.deps.store.get(result.requestId)!;
		await this.deps.store.durable();
		access.revalidate();
		oldAccess?.revalidate();
		this.current([written]);
		return result;
	}
	async transition(
		actor: ReviewRequestActor,
		action: "withdraw" | "snooze" | "resume" | "retire",
		raw: ReviewRequestTransition,
	) {
		const input = structuredClone(raw);
		exact(input, ["operationId", "requestId", "expectedRevision", "reason"]);
		id(input.operationId);
		id(input.requestId);
		text(input.reason, 4000);
		if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
			throw new Conflict("Exact request revision required");
		if (actor.kind === "coordinator" ? action !== "retire" : action === "retire")
			throw new Conflict("Unsupported review request actor/action");
		const payload = canonicalJSON({ action, ...input });
		const receipt = await this.lookup(input.operationId, actor, payload);
		if (receipt) return receipt;
		const prior = this.deps.store.get(input.requestId);
		if (!prior) throw new Conflict("Request unavailable");
		const access = await this.access(actor, prior.target);
		const revalidate = () => {
			access.revalidate();
			this.current([prior]);
		};
		const state = { withdraw: "withdrawn", snooze: "snoozed", resume: "pending", retire: "retired" } as const;
		const result = this.deps.store.transition(
			input.operationId,
			actor,
			payload,
			input.requestId,
			input.expectedRevision,
			state[action],
			input.reason,
			revalidate,
		);
		const written = this.deps.store.get(result.requestId)!;
		await this.deps.store.durable();
		access.revalidate();
		this.current([written]);
		return result;
	}
	async page(after = 0, sessionId?: string): Promise<ReviewRequestPage> {
		cursor(after);
		if (sessionId !== undefined) id(sessionId);
		const page = this.deps.store.page(after, sessionId),
			revalidations: Array<(() => void) | undefined> = [];
		const revalidateRows = () => {
			for (let i = 0; i < revalidations.length; i++) {
				try {
					revalidations[i]?.();
				} catch {
					// A revoked row stays redacted for this read, even if access later returns.
					revalidations[i] = undefined;
				}
			}
		};
		for (const record of page.records) {
			let revalidate: (() => void) | undefined;
			try {
				const access = await this.access({ kind: "native-user" }, record.target);
				if (canonicalJSON(access.comparison) !== canonicalJSON(record.comparison))
					throw new Conflict("Original request comparison changed");
				// Pin only the fence, not twenty full retained source manifests, before durable().
				revalidate = access.revalidate;
			} catch {
				// Only source access/qualification fails per row. Store and barrier failures still refuse the page.
			}
			revalidations.push(revalidate);
			this.current(page.records);
			revalidateRows();
		}
		await this.deps.store.durable();
		this.current(page.records);
		revalidateRows();
		return {
			requests: page.records.map((r, i) =>
				revalidations[i]
					? {
							requestId: r.requestId,
							sequence: r.sequence,
							state: r.state,
							actionability: "unknown",
							projectId: r.target.projectId,
							sessionId: r.target.sessionId,
							title: r.title,
							comparison: r.comparison,
						}
					: { requestId: r.requestId, sequence: r.sequence, state: r.state, unavailable: true },
			),
			next: page.next,
		};
	}
	async history(requestId: string, after = 0) {
		id(requestId);
		cursor(after);
		const current = this.deps.store.get(requestId);
		if (!current) throw new Conflict("Request history unavailable");
		const access = await this.access({ kind: "native-user" }, current.target);
		const records = this.deps.store.history(requestId, after);
		await this.deps.store.durable();
		access.revalidate();
		this.current([current]);
		return records;
	}
}
