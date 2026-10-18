/** Offline retained-history probe. Each sample runs in a fresh process. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { createRegistry, Harness, UserEntry, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ControlTurn } from "./control-turn.ts";
import { NativeAdapter } from "./native-adapter.ts";

async function sample(variant: string, entries: number) {
	const control = variant !== "ordinary";
	globalThis.fetch = () => {
		throw new Error("Benchmark must remain offline");
	};
	const root = await mkdtemp(join(tmpdir(), "control-history-bench-"));
	process.env.PI_CODING_AGENT_DIR = root;
	let adapter: NativeAdapter | undefined;
	let harness: Harness | undefined;
	let events: Awaited<ReturnType<typeof watchEvents>> | undefined;
	try {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({
			models: [{ id: "offline", contextWindow: 10_000_000 }],
			tokenSize: { min: 128, max: 128 },
			tokensPerSecond: 8192,
		});
		runtime.registerNativeProvider(faux.provider);
		adapter = await NativeAdapter.open({
			cwd: root,
			agentDir: root,
			sessionId: "bench",
			control,
			projectTrusted: false,
			bundledExtensions: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
			sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
			loaderOptions: {
				cwd: root,
				agentDir: root,
				noContextFiles: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
			},
		});
		assert.ok(adapter.setToolActive("codemode", true));
		const storage = await openNodeSqliteStorage(join(root, "harness.sqlite"));
		let conversationId!: Parameters<Harness["conversation"]>[0];
		const turn = new ControlTurn(
			async () => ({
				lines: Array.from({ length: 256 }, (_, id) => ({
					id,
					n: 1,
					text: `Synthetic persisted summary ${"x".repeat(420)}`,
				})),
			}),
			() => harness!,
			storage,
			() => conversationId,
		);
		const registry = createRegistry();
		registry.install(
			control
				? turn.prepare(adapter.extension, (messages, block) => adapter!.prepareControlRequest(messages, block))
				: adapter.extension,
		);
		if (control) adapter.controlContext = (context) => turn.context(context);
		harness = await Harness.open(
			storage,
			{
				models: adapter.models,
				registry: variant === "control" ? turn.registry(registry) : registry,
				settings: {
					compaction: { enabled: false },
					toolExecution: "sequential",
					progress: { partialIntervalMs: 250 },
				},
			},
			BACKGROUND_CONTEXT,
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: adapter.model, extensions: [adapter.extension], tools: adapter.extension.tools ?? [] },
		});
		conversationId = conversation.id;
		// Reproduce the pre-mapping adapter for the retained-control comparison, only in this probe.
		if (variant === "retained-control") adapter.controlContext = (context) => conversation.context(context);
		await adapter.bindHarness(harness, conversation.id);
		await conversation.commit(async (tx) => {
			for (let index = 0; index < entries; index++)
				await tx.appendEntry(UserEntry, conversation.id, {
					model: [{ role: "user", content: `Synthetic history ${index}: ${"x".repeat(1024)}`, timestamp: index }],
				});
		}, BACKGROUND_CONTEXT);
		// Measure warm, already logged retained history, not a one-time log migration.
		if (control) await turn.record(BACKGROUND_CONTEXT);
		let partialEvents = 0;
		events = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
		events.start(async (batch) => {
			partialEvents += batch.filter(
				(event) => event.type === "message_start" || event.type === "message_update",
			).length;
		});
		const calls: number[] = [];
		let start = 0;
		faux.setResponses(
			Array.from({ length: 4 }, (_, round) => async (ctx) => {
				for (const message of ctx.messages)
					if (message.role === "toolResult") assert.equal(message.isError, false, JSON.stringify(message));
				calls.push(performance.now() - start);
				return round < 3
					? fauxAssistantMessage(
							[
								{ type: "text", text: "s".repeat(16_384) },
								{
									type: "toolCall",
									id: `round-${round}`,
									name: "codemode",
									arguments: { code: 'text("offline result");' },
								},
							],
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("s".repeat(16_384));
			}),
		);
		globalThis.gc?.();
		const rssBeforeMB = process.memoryUsage().rss / 1e6;
		const cpu = process.cpuUsage();
		start = performance.now();
		await conversation.submit({ type: "input", content: "Run the scripted tool rounds" }, BACKGROUND_CONTEXT);
		await conversation.waitForIdle(BACKGROUND_CONTEXT);
		await adapter.refreshUsage(BACKGROUND_CONTEXT);
		const elapsedMs = performance.now() - start;
		const used = process.cpuUsage(cpu);
		assert.equal(faux.state.callCount, 4);
		assert.ok(partialEvents > 0, "exercise durable streaming checkpoints");
		const rssAfterMB = process.memoryUsage().rss / 1e6;
		const maxRssMB = (process.resourceUsage().maxRSS * 1024) / 1e6;
		return {
			elapsedMs,
			cpuMs: (used.user + used.system) / 1000,
			firstRequestMs: calls[0],
			requestAtMs: calls,
			rssBeforeMB,
			rssAfterMB,
			maxRssMB,
			mirrorMessages: adapter.session.messages.length,
			partialEvents,
		};
	} finally {
		await events?.stop();
		await harness?.close(BACKGROUND_CONTEXT);
		await adapter?.close();
		await rm(root, { recursive: true, force: true });
	}
}

if (process.argv[2] === "sample") {
	console.log(JSON.stringify(await sample(process.argv[3]!, Number(process.argv[4]))));
} else {
	const runs = Number(process.argv[2] ?? 3);
	assert.ok(Number.isSafeInteger(runs) && runs >= 1 && runs <= 10);
	for (let run = 0; run < runs; run++)
		for (const entries of [0, 20_001]) {
			for (const variant of run % 2
				? ["control", "retained-control", "ordinary"]
				: ["ordinary", "retained-control", "control"]) {
				const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PILOT_")));
				const child = spawnSync(
					process.execPath,
					["--expose-gc", import.meta.filename, "sample", variant!, String(entries)],
					{ env, encoding: "utf8", timeout: 180_000 },
				);
				if (child.status !== 0) throw new Error(child.stderr || child.stdout || String(child.error));
				console.log(JSON.stringify({ run, variant, entries, ...JSON.parse(child.stdout.trim()) }));
			}
		}
}
