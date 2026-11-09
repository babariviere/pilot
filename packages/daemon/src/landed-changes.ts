/** Passive history plus explicit host observations. Reads never contact GitHub or resume work. */
import type {
	ChangeLandingResult,
	ChangeReportedCommits,
	LandedChangeHistory,
	LandedChangesPage,
	NativeReviewComparison,
	ReviewDispositionTarget,
} from "@pilot/protocol";
import type { ChangeLandingStore } from "./change-landing-store.ts";
import { Conflict } from "./errors.ts";
import type { HumanReviews } from "./human-reviews.ts";
import { dispositionTarget } from "./human-reviews.ts";
import { identifier } from "./jj-ownership-contract.ts";
import type { NativeReviewReader } from "./native-review.ts";
import { canonicalJSON } from "./operation-journal.ts";
import type { ReviewRequestStore } from "./review-request-store.ts";

interface Dependencies {
	projectId: string;
	reader: Pick<NativeReviewReader, "list" | "retainedHistory">;
	store: ChangeLandingStore;
	feedback: Pick<HumanReviews, "history">;
	requests: Pick<ReviewRequestStore, "forTarget">;
	/** Must check current project/membership/home and return a synchronous last-step fence. */
	authorize(): { revalidate(): void };
	/** Optional trusted host producer. Must derive upstream/PR ownership from host custody, not prose. */
	observe?(snapshot: LandedChangeHistory["snapshot"]): Promise<ChangeLandingResult>;
	/** Optional exact historical completion claims, never promoted to landing evidence. */
	reported?(target: ReviewDispositionTarget): ChangeReportedCommits;
}
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
function cursor(after: number) {
	if (!Number.isSafeInteger(after) || after < 0) throw new Conflict("Invalid change history cursor");
}
export class LandedChanges {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	private async access(snapshotId: string, comparison?: NativeReviewComparison) {
		const authority = this.deps.authorize();
		const {
			snapshot,
			comparison: retainedComparison,
			revalidate: checkCustody,
		} = await this.deps.reader.retainedHistory(snapshotId);
		if (snapshot.snapshotId !== snapshotId) throw new Conflict("Wrong retained snapshot");
		const target = dispositionTarget(this.deps.projectId, snapshot);
		const exact = comparison ?? retainedComparison;
		const revalidate = () => {
			authority.revalidate();
			checkCustody();
		};
		revalidate();
		if (
			!same(retainedComparison, exact) ||
			!same(exact.request, snapshot.request) ||
			exact.snapshotId !== snapshotId ||
			exact.status !== snapshot.status ||
			exact.capturedAt !== snapshot.capturedAt
		)
			throw new Conflict("Exact retained comparison changed");
		return { snapshot, target, comparison: exact, revalidate };
	}
	async page(after = 0): Promise<LandedChangesPage> {
		cursor(after);
		const authority = this.deps.authorize();
		const page = await this.deps.reader.list(after);
		authority.revalidate();
		if (page.comparisons.length > 20) throw new Conflict("Invalid retained comparison page");
		const changes: LandedChangesPage["changes"] = [],
			checks: (() => void)[] = [];
		for (const comparison of page.comparisons) {
			let access: Awaited<ReturnType<LandedChanges["access"]>>;
			try {
				access = await this.access(comparison.snapshotId, comparison);
			} catch {
				// Preserve the slot. Missing/corrupt/unavailable source is never an empty diff.
				changes.push({ snapshotId: comparison.snapshotId, sequence: comparison.sequence, unavailable: true });
				checks.push(() => {});
				continue;
			}
			checks.push(access.revalidate);
			changes.push({
				comparison,
				target: access.target,
				landing: this.deps.store.latest(access.target),
				observedLanding: this.deps.store.latestObserved(access.target),
			});
		}
		await this.deps.store.durable();
		authority.revalidate();
		for (let i = 0; i < checks.length; i++) {
			try {
				checks[i]!();
			} catch {
				const c = page.comparisons[i]!;
				changes[i] = { snapshotId: c.snapshotId, sequence: c.sequence, unavailable: true };
			}
		}
		const capture = "capture" in page ? page.capture : undefined;
		const reason =
			"unavailable" in page
				? page.unavailable
				: !changes.length &&
						(!capture || capture.unavailable || capture.pending || capture.failed || capture.unsupported?.length)
					? "No eligible retained capture is available at this read point"
					: undefined;
		return {
			version: 1,
			scope: "retained-comparisons-only",
			status: reason ? "unavailable" : "available",
			...(reason ? { reason } : {}),
			...(capture ? { capture } : {}),
			changes,
			next: page.next,
		};
	}
	/** Reopen exact bytes/history only. Terminal requests and historical approvals stay historical. */
	async open(snapshotId: string, landingAfter = 0, reviewAfter = 0): Promise<LandedChangeHistory> {
		cursor(landingAfter);
		cursor(reviewAfter);
		const access = await this.access(snapshotId);
		const landing = this.deps.store.history(access.target, landingAfter);
		const attention = this.deps.requests.forTarget(access.target);
		const reported = this.deps.reported?.(access.target) ?? {
			status: "unavailable" as const,
			reason: "Exact completion claim producer unavailable",
		};
		const records = await this.deps.feedback.history(access.target, reviewAfter);
		await this.deps.store.durable();
		access.revalidate();
		if (
			!same(attention, this.deps.requests.forTarget(access.target)) ||
			!same(reported, this.deps.reported?.(access.target) ?? reported)
		)
			throw new Conflict("Change attention or reported claims changed during read");
		return {
			version: 1,
			comparison: access.comparison,
			snapshot: access.snapshot,
			target: access.target,
			reported,
			landing,
			reviews: { records, next: records.length === 50 ? records[49]!.sequence : null },
			attention,
			approval: "not-evaluated",
			acceptance: "not-evaluated",
		};
	}
	/** Explicit observation only. Reusing an ID reads its original result, never refreshes or replays effects. */
	async observe(observationId: string, snapshotId: string) {
		identifier(observationId, /^[A-Za-z0-9_-]{1,128}$/);
		const access = await this.access(snapshotId);
		const prior = this.deps.store.lookup(observationId, access.target);
		if (prior) {
			await this.deps.store.durable();
			access.revalidate();
			return prior;
		}
		const result =
			access.snapshot.request.source !== "committed"
				? { status: "unknown" as const, reason: "Working-copy comparisons cannot establish commit landing" }
				: this.deps.observe
					? await this.deps.observe(structuredClone(access.snapshot))
					: { status: "unknown" as const, reason: "Host landing producer unavailable" };
		access.revalidate();
		if (result.status === "observed" || result.status === "not-contained") {
			const producer = result.producer;
			if (
				!/^[a-f0-9]{40}$/.test(result.integratedCommitId) ||
				!/^[a-f0-9]{40}$/.test(result.targetCommitId) ||
				!result.repository ||
				!result.defaultRef ||
				!Number.isSafeInteger(result.observedAt) ||
				result.observedAt < 1 ||
				(producer.kind === "default-branch-containment"
					? result.integratedCommitId !== access.target.headCommitId
					: producer.headCommitId !== access.target.headCommitId ||
						producer.baseCommitId !== access.target.baseCommitId)
			)
				throw new Conflict("Landing evidence does not match the retained comparison");
		}
		const record = this.deps.store.append(observationId, access.target, result, access.revalidate);
		await this.deps.store.durable();
		access.revalidate();
		return record;
	}
}
