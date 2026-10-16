import assert from "node:assert/strict";
import { test } from "node:test";
import { WatchService } from "./watch-service.ts";
import { LinearWatchSource } from "./watch-linear.ts";
import type { SourceMcpClient } from "./source-mcp.ts";
import type { WatchNotice } from "./watch-delivery.ts";
const input = {
	event: "linear.done" as const,
	target: { kind: "linear" as const, id: "ENG-1" },
	mode: "persistent" as const,
	note: "Continue",
};
test("only completed Linear states fire, with durable baseline and repeated completions after reopen", async () => {
	const s = new WatchService(":memory:");
	const source = new LinearWatchSource(s, {} as SourceMcpClient);
	const sent: WatchNotice[] = [];
	try {
		await s.add(input);
		s.bindSink({
			sessionId: "control",
			canSend: () => true,
			deliver: async (n) => {
				sent.push(n);
				return true;
			},
		});
		assert.equal(await source.observe("ENG-1", "started", "Issue"), 0);
		assert.equal(await source.observe("ENG-1", "canceled", "Issue"), 0);
		assert.equal(await source.observe("ENG-1", "duplicate", "Issue"), 0);
		assert.equal(await source.observe("ENG-1", "completed", "Issue"), 1);
		assert.equal(await source.observe("ENG-1", "completed", "Issue"), 0);
		await source.observe("ENG-1", "started", "Issue");
		assert.equal(await source.observe("ENG-1", "completed", "Issue"), 1);
		await s.flush(Date.now() + 60000);
		assert.equal(sent[0]!.items[0]!.count, 2);
	} finally {
		await source.stop();
		await s.close();
	}
});
test("out-of-scope polling uses only fixed list_issues, exact identifiers and bounded fair rotation", async () => {
	const s = new WatchService(":memory:");
	const calls: string[] = [];
	let done = false;
	const mcp = {
		call: async (kind: string, tool: string, args: Record<string, unknown>) => {
			assert.equal(kind, "linear");
			assert.equal(tool, "issues");
			calls.push(String(args.query));
			return {
				issues: [
					{ identifier: args.query, title: "Issue", statusType: done ? "completed" : "started" },
					{ identifier: "WRONG-1", title: "Wrong", statusType: "completed" },
				],
			};
		},
	} as unknown as SourceMcpClient;
	const source = new LinearWatchSource(s, mcp);
	try {
		for (let i = 1; i <= 30; i++) await s.add({ ...input, target: { kind: "linear", id: `ENG-${i}` } });
		await source.poll(new AbortController().signal);
		assert.equal(calls.length, 25);
		done = true;
		await source.poll(new AbortController().signal);
		assert.equal(calls.length, 50);
		assert.equal(new Set(calls).size, 30);
		// Cover one watched issue with the ordinary tracker. It is no longer queried by fallback.
		await source.tracked(
			"p",
			[
				{
					externalId: "uuid",
					title: "Issue",
					url: "https://linear.app/x/issue/ENG-1",
					status: "Done",
					updatedAt: 1,
					metadata: { identifier: "ENG-1", statusType: "completed" },
				},
			],
			["uuid"],
		);
		calls.length = 0;
		await source.poll(new AbortController().signal);
		assert.ok(!calls.includes("ENG-1"));
	} finally {
		await source.stop();
		await s.close();
	}
});
