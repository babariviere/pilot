/** Offline disabled/enabled timing-overhead comparison. No user resources, credentials or network. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	Type,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage, UserEntry } from "@earendil-works/pi-durable";
import { NativeAdapter } from "../src/native-adapter.ts";
import { PerformanceLog } from "../src/performance.ts";

globalThis.fetch = async () => {
	throw new Error("Offline benchmark must not access the network");
};

const samples = Math.max(1, Math.min(15, Number.parseInt(process.argv[2] ?? "5", 10) || 5));
for (const history of [100, 1000]) {
	// Alternating order helps reveal host-load noise. This is feature-off/on, not an old installed binary.
	const variants = Array.from({ length: samples }, (_, index) =>
		index % 2 === 0 ? [false, true] : [true, false],
	).flat();
	for (const enabled of variants) {
		const home = await mkdtemp(join(tmpdir(), "pilot-timings-bench-"));
		let adapter: NativeAdapter | undefined;
		let harness: Harness | undefined;
		const histogram = monitorEventLoopDelay({ resolution: 10 });
		let toolCalls = 0;
		const timingLog = enabled ? new PerformanceLog(join(home, "performance.jsonl")) : undefined;
		try {
			const models = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				modelsStore: new InMemoryModelsStore(),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const faux = fauxProvider({
				provider: "offline-timings",
				models: [{ id: "fixture", contextWindow: 2_000_000 }],
				tokenSize: { min: 4, max: 4 },
			});
			models.registerNativeProvider(faux.provider);
			const agentDir = join(home, "agent");
			adapter = await NativeAdapter.open({
				cwd: home,
				agentDir,
				projectTrusted: false,
				// The fixture measures request timing, not Pilot's bundled capability profile. Durable subagents also
				// require file-backed storage, while this benchmark deliberately uses MemoryStorage below.
				bundledExtensions: false,
				performance: timingLog,
				settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
				sessionOptions: {
					modelRuntime: models,
					model: faux.getModel(),
					customTools: [
						{
							name: "fixture",
							label: "Fixture",
							description: "Offline tool",
							parameters: Type.Object({}),
							execute: async () => {
								toolCalls++;
								return { content: [{ type: "text", text: "Offline tool result" }], details: undefined };
							},
						},
					],
				},
				loaderOptions: {
					cwd: home,
					agentDir,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					systemPrompt: "Offline benchmark",
					appendSystemPrompt: [],
				},
			});
			adapter.setToolActive("fixture", true);
			const registry = createRegistry();
			registry.install(adapter.extension);
			harness = await Harness.open(
				new MemoryStorage(),
				{
					models: adapter.models,
					registry,
					settings: { toolExecution: "sequential", progress: { partialIntervalMs: 250, outputIntervalMs: 250 } },
				},
				context,
			);
			const conversation = await harness.root(context, {
				agent: { model: adapter.model, extensions: [adapter.extension], tools: null },
			});
			await conversation.commit(async (tx) => {
				for (let i = 0; i < history; i++)
					await tx.appendEntry(UserEntry, conversation.id, {
						model: [{ role: "user", content: `History ${i}: ${"x".repeat(1024)}`, timestamp: i }],
					});
			}, context);
			await adapter.bindHarness(harness, conversation.id);
			adapter.onToolsChanged = (extension) => registry.install(extension);
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("fixture", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("Streaming fixture. ".repeat(1024)),
			]);
			globalThis.gc?.();
			histogram.enable();
			await delay(20);
			const cpu = process.cpuUsage();
			const start = performance.now();
			await conversation.submit({ type: "input", requestId: "bench", content: "Run the offline fixture" }, context);
			await conversation.waitForIdle(context);
			if (toolCalls !== 1) throw new Error("Expected one offline native tool execution");
			const turnMs = performance.now() - start;
			// Include the async diagnostic I/O as well as its nonblocking effect on the turn.
			await timingLog?.flush();
			const elapsedMs = performance.now() - start;
			const usedCpu = process.cpuUsage(cpu);
			await delay(20);
			histogram.disable();
			await harness.close(context);
			await adapter.close();
			const lines = enabled ? (await readFile(join(home, "performance.jsonl"), "utf8")).trim().split("\n") : [];
			if (enabled && lines.length !== 2) throw new Error("Expected two content-free timing summaries");
			if (enabled && JSON.parse(lines[1]!).toolToPreparationMs === undefined)
				throw new Error("Expected a measured tool-to-preparation handoff");
			console.log(
				JSON.stringify({
					historyEntries: history,
					enabled,
					turnMs: Math.round(turnMs),
					elapsedMs: Math.round(elapsedMs),
					cpuMs: Math.round((usedCpu.user + usedCpu.system) / 1000),
					eventLoopP99Ms: histogram.percentile(99) / 1e6,
					rssMiB: Math.round(process.memoryUsage().rss / 1048576),
					records: lines.length,
					logBytes: lines.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0),
				}),
			);
		} finally {
			histogram.disable();
			await harness?.close(context);
			await adapter?.close();
			await rm(home, { recursive: true, force: true });
		}
	}
}
