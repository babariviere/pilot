/** Offline profile overhead comparison: node packages/kernel/src/bundled-extensions.bench.ts [runs]. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage, UserEntry } from "@earendil-works/pi-durable";
import { NativeAdapter } from "./native-adapter.ts";

const runs = Number(process.argv[2] ?? 5);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new Error("Expected 1 to 20 runs");
const historyMessages = 10_000;
const responseChars = 65_536;
const context = BACKGROUND_CONTEXT;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
	throw new Error("Profile benchmark must stay offline");
};

async function once(bundled: boolean) {
	const root = await mkdtemp(join(tmpdir(), "pilot-profile-bench-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	let adapter: NativeAdapter | undefined;
	let harness: Harness | undefined;
	try {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({
			models: [{ id: "offline", contextWindow: 1_000_000 }],
			tokenSize: { min: 16, max: 16 },
		});
		runtime.registerNativeProvider(faux.provider);
		const start = performance.now();
		adapter = await NativeAdapter.open({
			cwd: root,
			agentDir: root,
			projectTrusted: false,
			sessionId: "bench",
			sessionFile: join(root, "native.jsonl"),
			bundledExtensions: bundled,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
			sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
			loaderOptions: {
				cwd: root,
				agentDir: root,
				noExtensions: true,
				noContextFiles: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
			},
		});
		const startupMs = performance.now() - start;
		const registry = createRegistry();
		registry.install(adapter.extension);
		harness = await Harness.open(new MemoryStorage(), { models: adapter.models, registry }, context);
		const conversation = await harness.root(context, {
			agent: { model: adapter.model, extensions: [adapter.extension], tools: adapter.extension.tools ?? [] },
		});
		await adapter.bindHarness(harness, conversation.id);
		await conversation.commit(async (tx) => {
			await tx.appendEntry(UserEntry, conversation.id, {
				model: Array.from({ length: historyMessages }, (_, index) => ({
					role: "user" as const,
					content: `Synthetic history ${index}: ${"x".repeat(128)}`,
					timestamp: index,
				})),
			});
		}, context);
		faux.setResponses([fauxAssistantMessage("x".repeat(responseChars))]);
		const cpu = process.cpuUsage();
		const streamingStart = performance.now();
		await conversation.submit({ type: "input", content: "Reply with the scripted answer" }, context);
		await conversation.waitForIdle(context);
		const streamingMs = performance.now() - streamingStart;
		const used = process.cpuUsage(cpu);
		const answer = (await conversation.context(context)).messages.findLast((message) => message.role === "assistant");
		assert.equal(answer?.role === "assistant" && answer.stopReason, "stop");
		assert.equal(faux.state.callCount, 1);
		return {
			startupMs,
			streamingMs,
			cpuMs: (used.user + used.system) / 1000,
			rssMB: process.memoryUsage().rss / 1e6,
			callableTools: adapter.session.getCallableToolNames().length,
		};
	} finally {
		await harness?.close(context);
		await adapter?.close();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

try {
	const results = {
		baseline: [] as Awaited<ReturnType<typeof once>>[],
		bundled: [] as Awaited<ReturnType<typeof once>>[],
	};
	for (let run = 0; run <= runs; run++) {
		for (const variant of run % 2 ? (["bundled", "baseline"] as const) : (["baseline", "bundled"] as const)) {
			const result = await once(variant === "bundled");
			console.log(JSON.stringify({ run, variant, ...result }));
			if (run) results[variant].push(result);
		}
	}
	const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
	for (const [variant, rows] of Object.entries(results))
		console.log(
			JSON.stringify({
				variant,
				runs,
				historyMessages,
				responseChars,
				startupMedianMs: median(rows.map((row) => row.startupMs)),
				streamingMedianMs: median(rows.map((row) => row.streamingMs)),
				cpuMedianMs: median(rows.map((row) => row.cpuMs)),
				processRssMedianMB: median(rows.map((row) => row.rssMB)),
			}),
		);
} finally {
	globalThis.fetch = originalFetch;
}
