import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	Type,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import type { MissionContext } from "./policy.ts";
import { KernelSession } from "./session.ts";

test("explorer uses read-only tools, reports findings, cancels research and restores without replay", {
	timeout: 30_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-explorer-"));
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => {
		for (const close of cleanup.reverse()) await close();
		await rm(root, { recursive: true, force: true });
	});
	await writeFile(join(root, "source.txt"), "exploration evidence");
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "explorer-test", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	let webCalls = 0;
	let cancelled = false;
	let webStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		webStarted = resolve;
	});
	const open = NativeAdapter.open;
	let native: NativeAdapter | undefined;
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
		native = await open.call(NativeAdapter, {
			...options,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["bash", "write", "edit"] }),
			sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
			// Offline stand-in for the supported bundled web definition; never a shell/MCP fallback.
			askExtensionTools: [
				{
					name: "web",
					label: "Web",
					description: "Offline research fixture",
					parameters: Type.Object({ wait: Type.Optional(Type.Boolean()) }),
					execute: async (_id, args, signal) => {
						webCalls++;
						if ((args as { wait?: boolean }).wait) {
							webStarted();
							await new Promise<void>((_resolve, reject) => {
								const abort = () => {
									cancelled = true;
									reject(signal?.reason ?? new Error("Research stopped"));
								};
								if (signal?.aborted) abort();
								else signal?.addEventListener("abort", abort, { once: true });
							});
						}
						return {
							content: [{ type: "text", text: "Permitted research source (offline)" }],
							details: undefined,
						};
					},
				},
			],
		});
		return native;
	});
	const mission: MissionContext = {
		id: "research",
		title: "Research",
		goal: "Understand the code",
		status: "active",
		planningVersion: 1,
		briefRevision: 0,
		role: "explorer",
		coordinator: "other",
		tasks: [{ number: 1, title: "Explore", status: "in_progress" }],
		decisions: [],
	};
	const spec = {
		sessionId: "explorer",
		cwd: root,
		agentDir: join(root, "agent"),
		storageDir: join(root, "storage"),
		mission,
		pilot: { ask: { source: root } },
	};
	const reports: string[] = [];
	const hooks = {
		onWorking: () => {},
		callMission: async (action: string) => {
			if (action !== "log" && action !== "comment") throw new Error("Coordinator-owned planning");
			reports.push(action);
			return { accepted: true };
		},
	};
	await assert.rejects(KernelSession.open({ ...spec, pilot: {} }, hooks), /requires the read-only Ask runtime/);
	let session = await KernelSession.open(spec, hooks);
	cleanup.push(() => session.close());
	await session.watch("explorer", () => {});
	const registered = native!.session.getAllTools().map((tool) => tool.name);
	for (const name of ["read", "find", "grep", "ls", "web", "mission", "artifact", "ask_user"])
		assert.ok(registered.includes(name), name);
	for (const name of ["bash", "write", "edit", "jobs", "subagents"]) assert.ok(!registered.includes(name), name);
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("write", { path: "source.txt", content: "Changed" }),
				fauxToolCall("codemode", {
					code: `
text(await tools.read({path:'source.txt'}));
text(await tools.find({pattern:'*.txt'}));
text(await tools.grep({pattern:'evidence',path:'source.txt'}));
text(await tools.ls({path:'.'}));
text(await tools.web({}));
text(await tools.mission({action:'log',text:'Found source.txt, exploration evidence. Coverage limited.'}));
text(await tools.mission({action:'comment',text:'Propose investigating another source before changing the brief.'}));
try { await tools.mission({action:'brief',markdown:'Unauthorized',expectedRevision:0}); } catch { text('planning denied'); }
for (const name of ['ba'+'sh','wr'+'ite','edit','jobs','subagents']) {
  try { await tools[name]({command:'touch unsafe',path:'source.txt',content:'changed'}); text('UNSAFE'); } catch { text('denied:'+name); }
}`,
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Findings reported, no implementation."),
	]);
	await session.submit("research", "Investigate only", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	const results = (await session.conversation.context(BACKGROUND_CONTEXT)).messages.filter(
		(message) => message.role === "toolResult",
	);
	assert.equal(results.length, 2);
	assert.equal(results.find((message) => message.toolName === "write")?.isError, true);
	assert.equal(results.find((message) => message.toolName === "codemode")?.isError, false, JSON.stringify(results));
	assert.match(JSON.stringify(results), /exploration evidence/);
	assert.match(JSON.stringify(results), /planning denied/);
	assert.doesNotMatch(JSON.stringify(results), /UNSAFE/);
	assert.deepEqual(reports, ["log", "comment"]);
	assert.equal(webCalls, 1);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code: "await tools.web({wait:true});" }), {
			stopReason: "toolUse",
		}),
	]);
	await session.submit("cancel-research", "Research a slow source", "followUp");
	await started;
	await session.abort();
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(cancelled, true);
	await session.close();
	session = await KernelSession.open(spec, hooks);
	await session.watch("restored", () => {});
	assert.equal(webCalls, 2, "stopped web research must not replay on reopen");
	faux.setResponses([fauxAssistantMessage("Research restored with no write capability.")]);
	await session.submit("restored", "Report retained findings", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.ok(!native!.session.getAllTools().some((tool) => tool.name === "bash" || tool.name === "write"));
	assert.equal(webCalls, 2);
	assert.deepEqual(reports, ["log", "comment"]);
	assert.equal(await readFile(join(root, "source.txt"), "utf8"), "exploration evidence");
});
