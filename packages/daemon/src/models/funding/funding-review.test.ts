import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openGates, reviewFixture } from "../../reviews/critical/critical-review.test-fixture.ts";
import { ReviewAccounting } from "../../reviews/critical/critical-review-accounting.ts";
import { Funding } from "./funding.ts";

test("review must fit both its review profile and its lifetime funding, without duplicate charges", async (t) => {
	const f = await reviewFixture();
	t.after(() => f.close());
	const dir = await mkdtemp(join(tmpdir(), "funded-review-")),
		funding = new Funding(join(dir, "funding.sqlite"));
	t.after(async () => {
		await funding.close();
		await rm(dir, { recursive: true, force: true });
	});
	const owner = { kind: "mission", id: "mission", projectId: "project" } as const;
	await funding.open(owner, 100);
	const accounting = new ReviewAccounting(f.store, {
		reserve: async (r) => {
			await funding.reserve(
				owner,
				r.callId,
				{
					provider: "fake",
					model: "fake",
					inputTokens: r.inputTokens,
					outputTokens: r.generatedTokens,
					rate: { input: 1_000_000, output: 5_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
				},
				"review",
			);
		},
		settle: async (id, u) =>
			funding.settle(
				owner,
				id,
				u ? { input: u.inputTokens, output: u.generatedTokens, cacheRead: 0, cacheWrite: 0 } : undefined,
			),
	});
	await f.run("run", "low");
	await accounting.admit("run", "run-approval", "low", openGates);
	await assert.rejects(accounting.reserve(f.request("run", "unfunded")), /cannot fund/);
	await assert.rejects(accounting.send("unfunded", openGates), /Funding reservation/);
	assert.equal((await funding.read()).accounts[0]!.spentMicros, 0);
	await funding.fund(owner, (await funding.read()).revision, 1_000_000);
	await accounting.reserve(f.request("run", "funded"));
	await accounting.send("funded", openGates);
	await accounting.settle("funded", { inputTokens: 20, generatedTokens: 2, durationMs: 10 });
	assert.equal((await funding.read()).accounts[0]!.spentMicros, 30);
	await assert.rejects(accounting.reserve(f.request("run", "oversized", { inputTokens: 100_000 })), /inputTokens/);
	assert.equal((await funding.read()).accounts[0]!.spentMicros, 30);
});
