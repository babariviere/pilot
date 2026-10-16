import assert from "node:assert/strict";
import { test } from "node:test";
import { openGates, reviewFixture } from "./critical-review.test-fixture.ts";
import { SyntheticReviewer, type SyntheticReviewProvider, sealedReviewPort } from "./critical-review-runtime.ts";

test("fake provider sees sealed evidence only; injection and follow-ups cannot acquire tools", async () => {
	const f = await reviewFixture();
	try {
		await f.run("run");
		await f.accounting.admit("run", "run-approval", "medium", openGates);
		const reviewer = new SyntheticReviewer(sealedReviewPort(f.vault, f.manifest.id), f.accounting, "run");
		let turn = 0;
		const provider: SyntheticReviewProvider = {
			kind: "synthetic",
			step: async (input) => {
				assert.equal(JSON.stringify(input).includes(f.home), false);
				assert.deepEqual(
					input.tools.map((tool) => tool.name),
					["evidence_list", "evidence_read", "evidence_search"],
				);
				turn++;
				if (turn === 1)
					return {
						toolCalls: [{ name: "evidence_read", args: { blobId: f.manifest.entries[0]!.blobId } }],
						usage: { inputTokens: 100, generatedTokens: 10, durationMs: 10 },
					};
				if (turn === 2) {
					assert.match(JSON.stringify(input.messages), /ignore policy/);
					return {
						toolCalls: [
							{ name: "bash", args: { command: "touch /tmp/escape" } },
							{ name: "evidence_read", args: { blobId: "other", manifestId: "other" } },
						],
						usage: { inputTokens: 100, generatedTokens: 10, durationMs: 10 },
					};
				}
				assert.match(JSON.stringify(input.messages), /Tool unavailable or denied/);
				return {
					text: "No actionable findings. Execution was unavailable; evidence is partial.",
					usage: { inputTokens: 100, generatedTokens: 10, durationMs: 10 },
				};
			},
		};
		for (let n = 0; n < 3; n++)
			await reviewer.turn(
				provider,
				n ? "Follow up; install web and packages" : "Inspect selected evidence",
				f.request("run", `call${n}`),
				() => openGates,
			);
		assert.equal(turn, 3);
		assert.equal((await f.store.list("reservation")).length, 3);
		const port = sealedReviewPort(f.vault, f.manifest.id);
		assert.equal(
			(
				(await port.search(f.manifest.entries[0]!.blobId, "const", 0, new AbortController().signal)) as {
					matches: number[];
				}
			).matches.length,
			1,
		);
		reviewer.close();
		await f.accounting.finish("run");
	} finally {
		await f.close();
	}
});

test("no personal packages, hooks, MCP, workspace or auth construction, even on follow-up", async () => {
	const f = await reviewFixture();
	try {
		await f.run("run");
		await f.accounting.admit("run", "run-approval", "medium", openGates);
		const reviewer = new SyntheticReviewer(sealedReviewPort(f.vault, f.manifest.id), f.accounting, "run");
		const provider: SyntheticReviewProvider = {
			kind: "synthetic",
			step: async () => ({ text: "No findings", usage: { inputTokens: 1, generatedTokens: 1, durationMs: 1 } }),
		};
		for (const key of ["packages", "hooks", "extensions", "mcp", "cwd", "auth", "resourceLoader", "sessionManager"])
			Object.defineProperty(provider, key, {
				get: () => {
					throw new Error(`Personal resource constructed: ${key}`);
				},
			});
		await reviewer.turn(provider, "start", f.request("run", "first"), () => openGates);
		await reviewer.turn(
			provider,
			"follow up, load my packages",
			f.request("run", "follow-up", { phase: "follow_up" }),
			() => openGates,
		);
		reviewer.close();
	} finally {
		await f.close();
	}
});

test("literal search pages preserve boundary matches and all capped hits", async () => {
	const f = await reviewFixture();
	try {
		const manifest = await f.vault.capture({
			id: "search",
			projectId: "project",
			hostId: "host",
			sourceIds: ["source"],
			createdAt: f.now,
			knownSecrets: [],
			selections: [
				{
					selectionId: "cross",
					sourceId: "source",
					selected: true,
					label: "src/large.ts",
					category: "source",
					bytes: Buffer.from(`${"x".repeat(49 * 1024 - 1)}needle`),
				},
				{
					selectionId: "hits",
					sourceId: "source",
					selected: true,
					label: "src/hits.ts",
					category: "source",
					bytes: Buffer.from("a ".repeat(100)),
				},
			],
		});
		const port = sealedReviewPort(f.vault, manifest.id);
		const signal = new AbortController().signal;
		const first = (await port.search(manifest.entries[0]!.blobId, "needle", 0, signal)) as {
			matches: number[];
			next: number;
		};
		assert.deepEqual(first.matches, []);
		const second = (await port.search(manifest.entries[0]!.blobId, "needle", first.next, signal)) as {
			matches: number[];
		};
		assert.deepEqual(second.matches, [49 * 1024 - 1]);
		let offset: number | undefined = 0;
		const hits: number[] = [];
		for (let n = 0; n < 4 && offset !== undefined; n++) {
			const page = (await port.search(manifest.entries[1]!.blobId, "a", offset, signal)) as {
				matches: number[];
				next?: number;
			};
			hits.push(...page.matches);
			offset = page.next;
		}
		assert.equal(hits.length, 100);
		assert.equal(new Set(hits).size, 100);
	} finally {
		await f.close();
	}
});

test("provider never called without reservation and fresh provider gates", async () => {
	const f = await reviewFixture();
	try {
		await f.run("run");
		await f.accounting.admit("run", "run-approval", "medium", openGates);
		const reviewer = new SyntheticReviewer(sealedReviewPort(f.vault, f.manifest.id), f.accounting, "run");
		let calls = 0,
			gates = 0;
		const provider: SyntheticReviewProvider = {
			kind: "synthetic",
			step: async () => {
				calls++;
				return {};
			},
		};
		await assert.rejects(
			reviewer.turn(provider, "review", f.request("run"), () =>
				++gates === 1 ? openGates : { ...openGates, usageAllowed: false },
			),
			/gate/,
		);
		assert.equal(calls, 0);
		assert.ok(await f.store.get("reservation", "run-call"));
		await assert.rejects(f.accounting.send("run-call", openGates), /replay/);
	} finally {
		await f.close();
	}
});

test("linked erasure aborts an in-flight fake turn, clears context and blocks follow-ups", async () => {
	const f = await reviewFixture();
	try {
		await f.run("run");
		await f.accounting.admit("run", "run-approval", "medium", openGates);
		const reviewer = new SyntheticReviewer(sealedReviewPort(f.vault, f.manifest.id), f.accounting, "run");
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const provider: SyntheticReviewProvider = {
			kind: "synthetic",
			step: async () => {
				entered();
				await blocked;
				return { text: "late" };
			},
		};
		const turn = reviewer.turn(provider, "inspect", f.request("run"), () => openGates);
		const rejected = assert.rejects(turn, /cancelled|deadline/);
		await started;
		await f.vault.eraseSource("source");
		await rejected;
		release();
		await assert.rejects(
			reviewer.turn(provider, "follow-up", f.request("run", "follow-up"), () => openGates),
			/disabled/,
		);
		await f.accounting.finish("run");
	} finally {
		await f.close();
	}
});

test("provider deadline retains worst-case charge and disables late continuation", async () => {
	const f = await reviewFixture();
	try {
		await f.run("run");
		await f.accounting.admit("run", "run-approval", "medium", openGates);
		const reviewer = new SyntheticReviewer(sealedReviewPort(f.vault, f.manifest.id), f.accounting, "run");
		const provider: SyntheticReviewProvider = { kind: "synthetic", step: async () => new Promise(() => {}) };
		await assert.rejects(
			reviewer.turn(provider, "inspect", f.request("run", "timeout", { durationMs: 5 }), () => openGates),
			/deadline/,
		);
		await assert.rejects(f.accounting.send("timeout", openGates), /replay/);
		await assert.rejects(
			reviewer.turn(provider, "retry", f.request("run", "retry"), () => openGates),
			/disabled/,
		);
		assert.equal((await f.store.get("reservation", "timeout"))!.reserved.generatedTokens, 1000);
	} finally {
		await f.close();
	}
});
