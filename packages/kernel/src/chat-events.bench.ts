/** Offline cold-reopen benchmark on 10,000 entries and a full 200-event audit.
 * node scripts/bench/chat-events.ts [runs] [baseline-snapshot-module]
 * The optional baseline module must export readSessionSnapshot, for a before/after comparison.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { CompactionStatsDoc } from "./chat-events.ts";
import { GitHubActionsDoc } from "./github-actions.ts";
import { readSessionSnapshot } from "./snapshot.ts";
import { openSessionStorage } from "./storage.ts";

const runs = Number(process.argv[2] ?? 5);
const baseline = process.argv[3]
	? (await import(pathToFileURL(resolve(process.argv[3])).href)).readSessionSnapshot
	: undefined;
const home = await mkdtemp(join(tmpdir(), "pilot-chat-events-bench-"));
try {
	const owned = await openSessionStorage(home);
	const session = createSession(owned.storage);
	const root = { id: ROOT_CONVERSATION_ID };
	await owned.storage.commit([{ type: "conversation", value: root }], context);
	let first = 0;
	let last = 0;
	for (let batch = 0; batch < 100; batch++)
		await session.commit(async (tx) => {
			for (let i = 0; i < 100; i++) {
				const entry = await tx.appendEntry(root.id, {
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [{ type: "text", text: "Offline history. ".repeat(64) }],
							api: "anthropic-messages",
							provider: "mock",
							model: "mock",
							stopReason: "stop",
							timestamp: batch * 100 + i,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					],
				});
				first ||= Number(entry.id);
				last = Number(entry.id);
			}
		}, context);
	await session.commit(async (tx) => {
		const audit = await tx.doc(GitHubActionsDoc);
		audit.actions = Array.from({ length: 200 }, (_, index) => ({
			id: `mock:${index}`,
			kind: "push",
			branch: "feat/events",
			afterEntryId: last - index,
			at: index,
			exitCode: null,
			summary: "git push",
			description: "pushed branch feat/events",
		}));
		const stats = await tx.doc(CompactionStatsDoc);
		stats.items.push({ firstKept: first, before: 142000, kept: 18000, at: 0 });
		await tx.appendEntry(root.id, {
			kind: "pi.compaction",
			head: first as never,
			model: [{ role: "user", content: "Mock kept summary", timestamp: 11000 }],
			data: { reason: "manual" },
		});
	}, context);
	await session.close(context);
	owned.release();
	const results: Record<string, number[]> = { before: [], after: [] };
	for (let run = 0; run <= runs; run++)
		for (const [name, read] of [
			["before", baseline],
			["after", readSessionSnapshot],
		] as const) {
			if (!read) continue;
			const start = performance.now();
			const snapshot = await read(home, home, false);
			const elapsed = performance.now() - start;
			const frame = snapshot.events.find((event: { type: string }) => event.type === "snapshot");
			assert.equal(frame.entries.length, 10001);
			assert.equal(
				snapshot.events.find((event: { type: string }) => event.type === "github_actions_update").actions.length,
				200,
			);
			if (run) results[name].push(elapsed);
		}
	for (const [name, samples] of Object.entries(results))
		if (samples.length) {
			console.log(
				`${name}: ${samples.map((value) => value.toFixed(1)).join(" ")} ms, median ${[...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!.toFixed(1)} ms`,
			);
		}
} finally {
	await rm(home, { recursive: true, force: true });
}
