import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { configureBundledChildren } from "./bundled-extensions.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

async function until(check: () => boolean | Promise<boolean>) {
	const deadline = performance.now() + 20_000;
	while (!(await check())) {
		assert.ok(performance.now() < deadline, "condition did not settle");
		await delay(10);
	}
}

// The provider runs in the real bundled child process. All files and effects belong to a temp fixture.
function childProvider(root: string, mode: string): string {
	return `
import { existsSync, watch, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
const root = ${JSON.stringify(root)};
const mode = ${JSON.stringify(mode)};
globalThis.fetch = () => { throw new Error("Child fixture must stay offline"); };
export default pi => {
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	const call = step => fauxToolCall("codemode", {code: 'text(await tools.pause_effect({step:' + step + '}));'});
	faux.setResponses(Array.from({length: 20}, () => async (request, options) => {
		const results = request.messages.filter(message => message.role === "toolResult");
		if (results.length === 0) return fauxAssistantMessage(
			mode === "update" ? [call(1), call(2)] : [call(1)], {stopReason: "toolUse"});
		if (results.length === 1 && mode === "sleep") {
			if (!existsSync(join(root, "model-blocked"))) {
				writeFileSync(join(root, "model-blocked"), "ready");
				await new Promise((_, reject) => {
					const abort = () => reject(new Error("Paused generation"));
					if (options.signal.aborted) abort();
					else options.signal.addEventListener("abort", abort, {once: true});
				});
			}
			return fauxAssistantMessage([call(2)], {stopReason: "toolUse"});
		}
		return fauxAssistantMessage("CHILD_COMPLETE");
	}));
	pi.registerProvider(faux.provider);
	pi.registerTool({
		name: "pause_effect", label: "Offline effect", description: "Synthetic pause fixture",
		parameters: Type.Object({step: Type.Number()}),
		async execute(_id, {step}, signal) {
			appendFileSync(join(root, "effects"), String(step));
			if (mode === "update" && step === 1) await new Promise((resolve, reject) => {
				const watcher = watch(root, () => {
					if (existsSync(join(root, "release"))) finish();
				});
				const abort = () => finish(new Error("Interrupted synthetic tool"));
				function finish(error) {
					watcher.close(); signal?.removeEventListener("abort", abort);
					if (error) reject(error); else resolve();
				}
				signal?.addEventListener("abort", abort, {once:true});
				if (signal?.aborted) abort();
				else if (existsSync(join(root, "release"))) finish();
			});
			return {content:[{type:"text",text:"saved effect " + step}],details:{}};
		},
	});
};`;
}

for (const mode of ["update", "sleep"] as const) {
	test(`real child survives ${mode} replacement and its answer reaches an idle parent exactly once`, {
		timeout: 60_000,
	}, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pilot-child-pause-"));
		const agentDir = join(root, "agent");
		await mkdir(agentDir);
		const names = [
			"PI_CODING_AGENT_DIR",
			"PI_OFFLINE",
			"PILOT_PI_EXTENSIONS_PROFILE",
			"PILOT_ANTHROPIC_AUTH_EXTENSION",
		];
		const before = names.map((name) => process.env[name]);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_OFFLINE = "1";
		configureBundledChildren();
		let session: KernelSession | undefined;
		t.after(async () => {
			await writeFile(join(root, "release"), "ready");
			await session?.close();
			names.forEach((name, index) => {
				if (before[index] === undefined) delete process.env[name];
				else process.env[name] = before[index];
			});
			await rm(root, { recursive: true, force: true });
		});
		t.mock.method(globalThis, "fetch", () => assert.fail("Parent fixture must stay offline"));
		const extension = join(agentDir, "offline-child.ts");
		await writeFile(extension, childProvider(root, mode));
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				extensions: [extension],
				defaultProvider: "faux",
				defaultModel: "faux-1",
				defaultTools: ["+codemode"],
				codemode: { mode: "only" },
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const faux = fauxProvider({
			tokensPerSecond: 100_000,
			models: [{ id: "faux-1" }, { id: "claude-opus-5-5" }, { id: "gpt-6.1-sol" }],
		});
		runtime.registerNativeProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'text(await tools.subagent({action:"spawn",name:"implementation",model:"faux/faux-1",message:"Run the offline effects"}));',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The child is still working."),
			(request) => {
				assert.ok(
					JSON.stringify(request.messages).includes("CHILD_COMPLETE"),
					"the child result reaches the parent",
				);
				return fauxAssistantMessage("Reviewed the child result.");
			},
		]);
		const openAdapter = NativeAdapter.open;
		t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
			openAdapter.call(NativeAdapter, {
				...options,
				projectTrusted: false,
				settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
				sessionOptions: {
					...options.sessionOptions,
					modelRuntime: runtime,
					model: faux.getModel(),
					scopedModels: faux.models.map((model) => ({ model, thinkingLevel: "off" as const })),
				},
				loaderOptions: {
					cwd: root,
					agentDir,
					noExtensions: true,
					additionalExtensionPaths: ["builtin:codemode"],
					noSkills: true,
					noThemes: true,
					noContextFiles: true,
					noPromptTemplates: true,
				},
			}),
		);
		const spec = { sessionId: "parent", cwd: root, storageDir: join(root, "durable"), agentDir };
		const open = () => KernelSession.open(spec, { onWorking() {} });
		session = await open();
		await session.submit("start", "Delegate implementation", "followUp");
		await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(
			session.subagentList[0]?.state,
			"working",
			JSON.stringify(
				(await session.conversation.context(BACKGROUND_CONTEXT)).messages.filter(
					(message) => message.role === "toolResult",
				),
			),
		);
		await until(() => existsSync(join(root, mode === "update" ? "effects" : "model-blocked")));
		await until(() => session!.subagentList[0]?.conversationId !== undefined);
		const identity = session.subagentList[0]!.conversationId;
		if (mode === "update") {
			const paused = session.pauseForUpdate();
			await writeFile(join(root, "release"), "ready");
			await paused;
			assert.equal(await readFile(join(root, "effects"), "utf8"), "1", "the drain freezes the queued child tool");
		}
		await session.close();
		assert.equal(await readFile(join(root, "effects"), "utf8"), "1");
		session = await open();
		await until(() => faux.state.callCount === 3);
		await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		await until(() => session!.subagentList[0]?.state === "idle");
		assert.equal(await readFile(join(root, "effects"), "utf8"), "12", "finished effects are not replayed");
		assert.equal(session.subagentList[0]?.conversationId, identity);
		const context = await session.conversation.context(BACKGROUND_CONTEXT);
		assert.equal(
			context.messages.filter((message) => message.role === "user").length,
			2,
			"one original input and one child result",
		);
		assert.equal(faux.state.callCount, 3, "the parent automatically continues once");
	});
}
