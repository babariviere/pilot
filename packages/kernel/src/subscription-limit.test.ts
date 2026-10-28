import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SubscriptionGate } from "@babariviere/pi-extensions/subscription-gate";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { OfflineGate, offlineRequestStream } from "./connectivity.ts";
import { subscriptionLimitReport, subscriptionRecovery } from "./subscription-limit.ts";
import { callParentSubscriptionLimit, startTodoBridge } from "./todo-bridge.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("only explicit subscription exhaustion on a subscription provider becomes a usage pause", () => {
	for (const text of [
		"You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.",
		'429 {"error":{"type":"usage_limit_reached"}}',
		"subscription_sharing_usage_limit_exceeded",
		"Claude AI usage limit reached",
		"You've hit your limit · resets 5pm (Europe/Paris)",
	]) {
		assert.deepEqual(subscriptionLimitReport(text, "openai-codex"), { provider: "openai" });
		assert.deepEqual(subscriptionLimitReport(text, "anthropic"), { provider: "anthropic" });
		assert.equal(subscriptionLimitReport(text, "openai"), undefined, "API billing remains an error");
	}
	for (const text of [
		"429 rate_limit_error",
		"too many requests",
		"overloaded",
		"401 Unauthorized",
		"insufficient_quota",
		"billing",
		"usage_not_included",
		"subscription_sharing_usage_unavailable",
		"usage limit status unavailable",
	])
		assert.equal(subscriptionLimitReport(text, "anthropic"), undefined, text);
	assert.deepEqual(
		subscriptionLimitReport(new Error("request failed", { cause: new Error("usage_limit_reached") }), "anthropic"),
		{ provider: "anthropic" },
	);
	const cycle: { cause?: unknown } = {};
	cycle.cause = cycle;
	assert.equal(subscriptionLimitReport(cycle, "anthropic"), undefined);
	const now = Date.now(),
		reset = now + 60_000;
	assert.deepEqual(subscriptionLimitReport(`usage_limit_reached {"resets_at":${reset / 1000}}`, "openai-codex", now), {
		provider: "openai",
		resetsAt: new Date(reset).toISOString(),
	});
	assert.deepEqual(subscriptionLimitReport('usage_limit_reached {"resetsAt":"invalid"}', "openai-codex", now), {
		provider: "openai",
	});
});

for (const thrown of [false, true])
	test(`usage recovery holds ${thrown ? "thrown" : "streamed"} request errors until the saved policy releases`, {
		timeout: 10_000,
	}, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pilot-limit-stream-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const path = join(root, "policy.json");
		const save = async (blocked: boolean) => {
			await writeFile(
				`${path}.tmp`,
				JSON.stringify({
					version: 1,
					windows: blocked ? [{ provider: "openai", label: "Usage limit", usedPercent: 100 }] : [],
				}),
			);
			await rename(`${path}.tmp`, path);
		};
		await save(false);
		const reported = deferred();
		const stop = new AbortController();
		t.after(() => stop.abort());
		let calls = 0,
			finished = false;
		const events: string[] = [];
		const model = fauxProvider({ provider: "openai-codex" }).getModel();
		const stream = offlineRequestStream(
			() => {
				calls++;
				if (calls === 1 && thrown) throw new Error("usage_limit_reached");
				const source = createAssistantMessageEventStream();
				const message =
					calls === 1
						? fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage_limit_reached" })
						: fauxAssistantMessage("done");
				if (calls === 1) source.push({ type: "error", reason: "error", error: message });
				source.end(message);
				return source;
			},
			model,
			new OfflineGate(""),
			stop.signal,
			subscriptionRecovery(
				() => model.provider,
				new SubscriptionGate(path, 5),
				async (limit) => {
					assert.equal(limit.provider, "openai");
					await save(true);
					reported.resolve();
				},
			),
		);
		const reading = (async () => {
			for await (const event of stream) events.push(event.type);
		})();
		const result = stream.result().then((message) => {
			finished = true;
			return message;
		});
		await reported.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls, 1);
		assert.equal(finished, false);
		assert.deepEqual(events, [], "no terminal failure reaches Harness");
		await save(false);
		assert.equal((await result).stopReason, "stop");
		await reading;
		assert.equal(calls, 2);
		assert.deepEqual(events, ["done"]);
	});

test("Stop cancels limit reporting even if the daemon has not acknowledged it", async () => {
	const stop = new AbortController(),
		entered = deferred(),
		ack = deferred();
	const recover = subscriptionRecovery(
		() => "anthropic",
		new SubscriptionGate(""),
		async () => {
			entered.resolve();
			await ack.promise;
		},
	);
	const waiting = recover("usage limit reached", stop.signal);
	await entered.promise;
	stop.abort(new Error("stopped"));
	await assert.rejects(waiting, /stopped/);
	ack.resolve();
});

test("children report usage limits through the existing private parent capability and await persistence", async (t) => {
	const entered = deferred(),
		finish = deferred();
	let done = false;
	const bridge = await startTodoBridge(
		async () => [],
		async (limit) => {
			assert.deepEqual(limit, { provider: "anthropic" });
			entered.resolve();
			await finish.promise;
		},
	);
	t.after(async () => {
		finish.resolve();
		await bridge.close();
	});
	const report = callParentSubscriptionLimit({ provider: "anthropic" }).then(() => {
		done = true;
	});
	await entered.promise;
	assert.equal(done, false);
	finish.resolve();
	await report;
	assert.equal(done, true);
	await assert.rejects(
		callParentSubscriptionLimit({ provider: "invalid" as "anthropic" }),
		/Invalid subscription limit/,
	);
});
