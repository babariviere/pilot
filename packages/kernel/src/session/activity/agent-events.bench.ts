/** Offline version comparison, 10,000 entries and a streamed 64 KiB answer. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { watchEvents } from "./agent-events.ts";

const runs = Number(process.argv[2] ?? 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error("Expected 1 to 10 runs");
globalThis.fetch = () => {
	throw new Error("Benchmark must stay offline");
};
for (let run = 0; run <= runs; run++) {
	const faux = fauxProvider({
		tokensPerSecond: 16_384,
		tokenSize: { min: 256, max: 256 },
		models: [{ id: "offline", contextWindow: 1_000_000 }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry: createRegistry(),
			settings: { progress: { partialIntervalMs: 250, outputIntervalMs: 250, persistWithinMs: 0 } },
		},
		context,
	);
	try {
		const model = faux.getModel();
		const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
		await root.commit(async (tx) => {
			for (let i = 0; i < 10_000; i++)
				await tx.appendEntry(root.id, {
					kind: "pi.user",
					model: [{ role: "user", content: `History ${i}: ${"x".repeat(128)}`, timestamp: i }],
				});
		}, context);
		const attached = performance.now();
		const stream = await watchEvents(harness, root.id, context);
		const attachMs = performance.now() - attached;
		let events = 0;
		stream.start(async (batch) => {
			events += batch.length;
		});
		faux.setResponses([fauxAssistantMessage("x".repeat(65_536))]);
		const cpu = process.cpuUsage();
		const started = performance.now();
		await (await root.submit({ type: "input", content: "Reply" }, context)).wait(context);
		await root.waitForIdle(context);
		const streamMs = performance.now() - started;
		const used = process.cpuUsage(cpu);
		assert.equal(faux.state.callCount, 1);
		assert.ok(events > 0);
		console.log(
			JSON.stringify({
				run,
				attachMs,
				streamMs,
				cpuMs: (used.user + used.system) / 1000,
				rssMB: process.memoryUsage().rss / 1e6,
				events,
			}),
		);
		const answer = (await root.context(context)).messages.findLast((message) => message.role === "assistant");
		assert.equal(answer?.content[0]?.type === "text" && answer.content[0].text.length, 65_536);
		await stream.stop();
	} finally {
		await harness.close(context);
	}
}
