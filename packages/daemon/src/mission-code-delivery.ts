/** Passive code evidence projections. Selected comparison scope is never the complete contribution. */
import type { NativeReviewSnapshot } from "@pilot/protocol";
import type { CodePullRequestObservation } from "./github-delivery.ts";
import type { NativeReviewReader } from "./native-review.ts";

export type CodeLedgerObservation =
	| Awaited<ReturnType<NativeReviewReader["contributions"]>>
	| { status: "unknown"; reason: string; changes: never[]; operationId?: never };
export type CodePairObservation =
	| { snapshotId: string; status: "unknown"; reason: string }
	| {
			snapshotId: string;
			status: "observed" | "partial";
			scope: "selected-pair-only";
			request: NativeReviewSnapshot["request"];
			changes: NativeReviewSnapshot["changes"];
			omissions: string[];
			ledgerRevision: "observed" | "unknown";
	  };

export async function observeCodeContributions(
	reader: Pick<NativeReviewReader, "contributions" | "get">,
	snapshotIds: string[],
) {
	let ledger: CodeLedgerObservation;
	try {
		ledger = await reader.contributions();
	} catch {
		ledger = { status: "unknown", reason: "Passive ownership/source observation unavailable", changes: [] };
	}
	const selected: CodePairObservation[] = [];
	for (const snapshotId of snapshotIds) {
		try {
			const s = await reader.get(snapshotId);
			const row = ledger.changes.find(
				(r) => r.repositoryId === s.request.repositoryId && r.changeId === s.request.changeId,
			);
			selected.push({
				snapshotId,
				status: s.status === "complete" ? "observed" : "partial",
				scope: "selected-pair-only",
				request: s.request,
				changes: s.changes,
				omissions: s.omissions,
				ledgerRevision:
					ledger.status === "observed" &&
					row?.ownership.status === "owned" &&
					row.discovery === "complete" &&
					row.current.status === "observed" &&
					row.current.operationId === ledger.operationId &&
					row.current.revisions.length === 1 &&
					row.current.revisions[0]?.commitId === s.request.head.commitId
						? "observed"
						: "unknown",
			});
		} catch {
			selected.push({ snapshotId, status: "unknown", reason: "Exact selected retained comparison unavailable" });
		}
	}
	return {
		ledger,
		selected,
		inventory: {
			status: "unknown" as const,
			reason:
				"Dirty, ignored, unmanaged and unproven work are not completely inventoried by retained comparisons or the ownership ledger",
		},
	};
}

/** Exact head/base equality only. No branch/name/prose match, guessed squash lineage or historical backfill. */
export function observeCodeIntegration(
	pairs: CodePairObservation[],
	prs: CodePullRequestObservation[],
	repository: string | null,
) {
	return pairs.map((pair) => {
		const matches =
			pair.status === "observed" && pair.ledgerRevision === "observed" && repository
				? prs.filter(
						(pr) =>
							pr.status === "observed" &&
							pr.identity.repository.toLowerCase() === repository.toLowerCase() &&
							pr.identity.head === pair.request.head.commitId &&
							pr.identity.base === pair.request.base.commitId,
					)
				: [];
		return {
			snapshotId: pair.snapshotId,
			status:
				matches.length && matches.every((pr) => pr.status === "observed" && pr.integration.status === "observed")
					? ("observed" as const)
					: ("unknown" as const),
			reason:
				"Exact selected head to observed owned-PR merge/default-target containment only; no complete-delivery or non-PR landing proof",
			pullRequests: matches.map((pr) => pr.url),
		};
	});
}
