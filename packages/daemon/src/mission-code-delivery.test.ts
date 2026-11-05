import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodePullRequestObservation } from "./github-delivery.ts";
import { type CodePairObservation, observeCodeContributions, observeCodeIntegration } from "./mission-code-delivery.ts";
import type { NativeReviewReader } from "./native-review.ts";

const pair: Extract<CodePairObservation, { scope: string }> = {
	snapshotId: "a".repeat(64),
	status: "observed",
	scope: "selected-pair-only",
	ledgerRevision: "observed",
	omissions: [],
	request: {
		requestId: "request",
		repositoryId: "b".repeat(64),
		changeId: "k".repeat(32),
		operationId: "c".repeat(128),
		base: { changeId: "l".repeat(32), commitId: "d".repeat(40) },
		head: { changeId: "k".repeat(32), commitId: "e".repeat(40) },
		scope: { kind: "layer" },
		source: "committed",
	},
	changes: [
		{
			status: "A",
			beforePath: null,
			afterPath: "docs/exact.md",
			beforeMode: "000000",
			afterMode: "100644",
			beforeOid: "0".repeat(40),
			afterOid: "f".repeat(40),
		},
	],
};
function pr(number: number): Extract<CodePullRequestObservation, { status: "observed" }> {
	const url = `https://github.com/o/r/pull/${number}`;
	return {
		url,
		status: "observed",
		observedAt: 1,
		identity: {
			url,
			repository: "github.com/o/r",
			number,
			state: "MERGED",
			head: pair.request.head.commitId,
			base: pair.request.base.commitId,
			baseRef: "main",
			merge: "1".repeat(40),
			target: "2".repeat(40),
			defaultRef: "main",
		},
		checks: { status: "unknown", reason: "unavailable" },
		configuredChecks: { status: "unknown", reason: "unavailable" },
		integration: {
			status: "observed",
			reason: "exact containment",
			revision: "1".repeat(40),
			target: "2".repeat(40),
		},
	};
}
test("selected exact comparison scope exposes paths without full dirty or documentation delivery proof", async () => {
	const reader: Pick<NativeReviewReader, "get" | "contributions"> = {
		contributions: async () => ({
			status: "unknown",
			reason: "unsnapshotted/dirty inventory unavailable",
			operationId: pair.request.operationId,
			changes: [],
		}),
		get: async () => ({
			snapshotId: pair.snapshotId,
			request: pair.request,
			workerId: "worker",
			status: "complete",
			capturedAt: 1,
			enrollmentTaskIds: ["enrollment-not-task-purpose"],
			creation: {
				kind: "workspace-created",
				changeId: pair.request.changeId,
				commitId: pair.request.head.commitId,
				operationId: pair.request.operationId,
			},
			omissions: [],
			before: [],
			after: [],
			changes: pair.changes,
			diff: { sha256: "a".repeat(64), bytes: 0 },
		}),
	};
	const result = await observeCodeContributions(reader, [pair.snapshotId]);
	assert.equal(result.inventory.status, "unknown");
	assert.equal(result.selected[0]?.status, "observed");
	const selected = result.selected[0]!;
	assert.equal(selected.scope, "selected-pair-only");
	assert.equal(selected.ledgerRevision, "unknown");
	assert.equal(
		selected.changes[0]?.afterPath,
		"docs/exact.md",
		"exact selected paths, not historical receipt mapping",
	);
	reader.get = async () => {
		throw new Error("lost/denied");
	};
	assert.deepEqual((await observeCodeContributions(reader, [pair.snapshotId])).selected, [
		{ snapshotId: pair.snapshotId, status: "unknown", reason: "Exact selected retained comparison unavailable" },
	]);
});

test("multi-PR exact pairs each require their own merged default-target containment", () => {
	const lower = pr(1),
		upper = pr(2),
		second = structuredClone(pair);
	second.snapshotId = "9".repeat(64);
	second.request.head.commitId = upper.identity.head = "8".repeat(40);
	second.request.base.commitId = upper.identity.base = lower.identity.head;
	upper.identity.baseRef = "stack/lower";
	upper.integration = { ...upper.integration, status: "not-integrated" };
	const result = observeCodeIntegration([pair, second], [lower, upper], "github.com/o/r");
	assert.deepEqual(
		result.map((r) => r.status),
		["observed", "unknown"],
	);
	assert.deepEqual(
		result.map((r) => r.pullRequests),
		[[lower.url], [upper.url]],
	);
	assert.equal(
		observeCodeIntegration([second], [lower], "github.com/o/r")[0]?.status,
		"unknown",
		"lower PR never consumes top work",
	);
	upper.integration.status = "observed";
	assert.deepEqual(
		observeCodeIntegration([pair, second], [lower, upper], "github.com/o/r").map((r) => r.status),
		["observed", "observed"],
	);
});

test("wrong repository/base/head, partial source and unobserved source never establish selected integration", () => {
	for (const kind of ["repo", "base", "head", "partial", "ledger", "missing", "closed"] as const) {
		const source = structuredClone(pair),
			owned = pr(1);
		if (kind === "repo") owned.identity.repository = "github.com/other/repo";
		if (kind === "base") owned.identity.base = "3".repeat(40);
		if (kind === "head") owned.identity.head = "3".repeat(40);
		if (kind === "partial") source.status = "partial";
		if (kind === "ledger") source.ledgerRevision = "unknown";
		if (kind === "closed") {
			owned.identity.state = "CLOSED";
			owned.integration.status = "not-integrated";
		}
		assert.equal(
			observeCodeIntegration([source], kind === "missing" ? [] : [owned], "github.com/o/r")[0]?.status,
			"unknown",
			kind,
		);
	}
	assert.equal(observeCodeIntegration([pair], [pr(1)], null)[0]?.status, "unknown");
});
