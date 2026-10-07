import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SubmissionDraft } from "@earendil-works/pi-durable";
import { ArtifactStore } from "@pilot/artifacts";
import type { ArtifactRevision, SessionCompletion } from "@pilot/protocol";
import { createArtifactTools } from "./artifact-tools.ts";
import { reportStatus } from "./attention.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";

async function fixture(t: TestContext, mode: "on" | "only" = "on") {
	const root = await mkdtemp(join(tmpdir(), "pilot-artifact-tools-"));
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => {
		try {
			for (const close of cleanup.reverse()) await close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	t.mock.method(globalThis, "fetch", () => assert.fail("artifact integration must stay offline"));
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "pilot-artifact-test", models: [{ id: "offline" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	const options: NativeAdapterOptions = {
		cwd: root,
		agentDir: join(root, "agent"),
		projectTrusted: false,
		settingsManager: SettingsManager.inMemory({ defaultTools: ["codemode"] }),
		sessionOptions: { modelRuntime, model: faux.getModel() },
		loaderOptions: {
			cwd: root,
			agentDir: join(root, "agent"),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Offline artifact integration.",
			extensionFactories: [createCodemodeExtension({ models: false, mode })],
		},
	};
	return { root, cleanup, options, faux };
}

for (const mode of ["on", "only"] as const) {
	test(`SDK customTools are discoverable through codemode (${mode}) with structured data and images`, {
		timeout: 15_000,
	}, async (t) => {
		const f = await fixture(t, mode);
		let publications = 0;
		const artifact: ArtifactRevision = {
			id: "artifact-1",
			sessionId: "session-1",
			title: "Demo",
			kind: "html",
			revision: 1,
			createdAt: 100,
			updatedAt: 100,
			source: "<h1>Demo</h1>",
			libraries: [],
			html: "COMPILED_HTML_HIDDEN",
		};
		const tools = createArtifactTools({
			store: {
				async create() {
					return artifact;
				},
				async update() {
					return { ...artifact, revision: 2 };
				},
				async get() {
					return artifact;
				},
				async list() {
					return [artifact];
				},
			},
			onArtifactsChanged: () => publications++,
			preview: async () => ({
				screenshot: { mimeType: "image/png", data: png, width: 800, height: 600 },
				consoleMessages: [{ level: "log", text: "Rendered offline" }],
				contentHeight: 600,
			}),
		});
		const adapter = await NativeAdapter.open({
			...f.options,
			sessionOptions: { ...f.options.sessionOptions, customTools: tools },
		});
		f.cleanup.push(() => adapter.close());
		for (const tool of tools) {
			assert.ok(adapter.session.getCallableToolNames().includes(tool.name), tool.name);
			const durable = adapter.extension.tools?.find((candidate) => candidate.name === tool.name);
			if (mode === "only") {
				assert.equal(durable, undefined, "hidden declarations must remain callable from scripts");
			} else {
				assert.equal(durable?.replay, "unsafe");
				assert.equal(durable?.executionMode, "sequential");
			}
		}
		const codemode = adapter.session.agent.state.tools.find((tool) => tool.name === "codemode");
		assert.ok(codemode);
		adapter.session.agent.state.messages.push(
			fauxAssistantMessage(
				{
					type: "toolCall",
					id: "offline-script",
					name: "codemode",
					arguments: {},
				},
				{ stopReason: "toolUse" },
			),
		);
		const result = await codemode.execute(
			"offline-script",
			{
				code: `
const registered = ALL_TOOLS.filter(t => t.name === "artifact").map(t => t.name).sort();
const created = await tools.artifact({action:"create",title:"Demo",kind:"html",source:"<h1>Demo</h1>"});
const got = await tools.artifact({action:"get",id:created.artifact.id});
const listed = await tools.artifact({action:"list"});
const updated = await tools.artifact({action:"update",id:created.artifact.id,title:"Demo",kind:"html",source:"<h1>Next</h1>",expectedRevision:1});
text({registered,created,source:got.artifact.source,count:listed.artifacts.length,revision:updated.artifact.revision});
const preview = await tools.artifact({action:"preview",title:"Demo",kind:"html",source:"<h1>Demo</h1>"});
image({type:"image",...preview.screenshot});
text({consoleMessages:preview.consoleMessages,contentHeight:preview.contentHeight});
`,
			},
			undefined,
		);
		assert.ok(!result.isError, JSON.stringify(result.content));
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		assert.ok(text.includes('"registered":["artifact"]'), text);
		assert.ok(text.includes('"source":"<h1>Demo</h1>"'), text);
		assert.ok(text.includes('"revision":2'), text);
		assert.ok(text.includes("Rendered offline"), text);
		assert.ok(!text.includes("COMPILED_HTML"), text);
		assert.ok(result.content.some((block) => block.type === "image" && block.data === png));
		assert.equal(publications, 2);
		assert.equal(f.faux.state.callCount, 0, "tool calls do not invoke the native model loop");
	});
}

test("KernelSession registers tools with the session directory and project identity, then notifies committed publication", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const open = NativeAdapter.open;
	let adapter: NativeAdapter | undefined;
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
		adapter = await open.call(NativeAdapter, {
			...options,
			...f.options,
			sessionId: options.sessionId,
			sessionFile: options.sessionFile,
			sessionOptions: { ...options.sessionOptions, ...f.options.sessionOptions },
		});
		return adapter;
	});
	let notifications = 0;
	const session = await KernelSession.open(
		{
			sessionId: "session-integration",
			projectId: "project-integration",
			cwd: f.root,
			storageDir: join(f.root, "storage"),
		},
		{
			onWorking: () => {},
			onArtifactsChanged: () => {
				notifications++;
				const directory = join(f.root, "artifacts");
				assert.ok(
					readdirSync(directory).some((id) => existsSync(join(directory, id, "latest.json"))),
					"notification observes a committed latest pointer",
				);
			},
		},
	);
	f.cleanup.push(() => session.close());
	assert.ok(adapter);
	const create = adapter.session.agent.state.tools.find((tool) => tool.name === "artifact");
	assert.ok(create);
	const result = await create.execute(
		"publish",
		{ action: "create", title: "Demo", kind: "html", source: "<h1>Demo</h1>" },
		undefined,
	);
	assert.equal(notifications, 1);
	const store = new ArtifactStore(f.root, { sessionId: "session-integration", projectId: "project-integration" });
	const [summary] = await store.list();
	assert.ok(summary);
	assert.equal(summary.sessionId, "session-integration");
	assert.equal(summary.projectId, "project-integration");
	assert.deepEqual(result.details, {
		artifact: { id: summary.id, sessionId: summary.sessionId, title: summary.title, revision: summary.revision },
	});
	assert.ok(!JSON.stringify(result).includes("<!doctype"));
	await writeFile(join(f.root, "generated.png"), Buffer.from(png, "base64"));
	const imageResult = await create.execute(
		"publish-image",
		{ action: "create", title: "Generated image", kind: "image", source: "generated.png" },
		undefined,
	);
	const imageReference = imageResult.details as { artifact: { id: string } };
	const savedImage = await store.get(imageReference.artifact.id);
	assert.equal(savedImage.kind, "image");
	assert.equal(savedImage.source, `data:image/png;base64,${png}`);
	assert.ok(savedImage.html.includes(savedImage.source));
	assert.ok(!JSON.stringify(imageResult).includes(png));
	assert.equal(notifications, 2);
	assert.equal(f.faux.state.callCount, 0);
});

test("busy codemode publications and attention survive native tool refresh and reopen", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const context = BACKGROUND_CONTEXT;
	const open = NativeAdapter.open;
	const refreshUsage = NativeAdapter.prototype.refreshUsage;
	const usageRefreshes: Promise<void>[] = [];
	t.mock.method(
		NativeAdapter.prototype,
		"refreshUsage",
		function (this: NativeAdapter, ...args: Parameters<typeof refreshUsage>) {
			const refresh = refreshUsage.apply(this, args);
			usageRefreshes.push(refresh);
			return refresh;
		},
	);
	let adapter: NativeAdapter | undefined;
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
		adapter = await open.call(NativeAdapter, {
			...options,
			...f.options,
			sessionId: options.sessionId,
			sessionFile: options.sessionFile,
			sessionOptions: { ...options.sessionOptions, ...f.options.sessionOptions },
		});
		return adapter;
	});
	const spec = {
		sessionId: "busy-artifacts",
		projectId: "project-1",
		cwd: f.root,
		storageDir: join(f.root, "storage"),
	};
	let notifications = 0;
	let finishCompletion!: (completion: SessionCompletion) => void;
	const completed = new Promise<SessionCompletion>((resolve) => {
		finishCompletion = resolve;
	});
	const transitions: Array<{ working: boolean; completion?: SessionCompletion }> = [];
	const session = await KernelSession.open(spec, {
		onWorking: (working, completion) => {
			transitions.push({ working, completion });
			if (!working && completion) finishCompletion(completion);
		},
		onArtifactsChanged: () => notifications++,
	});
	f.cleanup.push(() => session.close());
	const assertReplaySafety = async (kernel: KernelSession) => {
		const tools = (await kernel.conversation.agent(context)).tools;
		assert.equal(tools.find((tool) => tool.name === reportStatus.name)?.replay, "safe");
		for (const name of ["codemode", "artifact"]) {
			const tool = tools.find((candidate) => candidate.name === name);
			assert.ok(tool, name);
			assert.equal(tool.replay, "unsafe", name);
			assert.equal(tool.executionMode, "sequential", name);
		}
	};
	await assertReplaySafety(session);
	const submit = session.conversation.submit.bind(session.conversation);
	const writes: Array<{ draft: SubmissionDraft; id: number; status: string }> = [];
	t.mock.method(session.conversation, "submit", async (...args: Parameters<typeof submit>) => {
		const admitted = await submit(...args);
		if (args[0].type === "write") {
			const record = await admitted.status(context);
			writes.push({ draft: args[0], id: admitted.id, status: record.status });
		}
		return admitted;
	});
	const liveEntries: unknown[] = [];
	let finishLive!: () => void;
	const live = new Promise<void>((resolve) => {
		finishLive = resolve;
	});
	await session.watch("artifact-live", (events) => {
		for (const event of events) {
			if (event.type === "entry_appended" && event.entry.kind === "pilot.artifact") {
				liveEntries.push(event.entry);
				if (liveEntries.length === 2) finishLive();
			}
		}
	});
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: `
const created = await tools.artifact({action:"create",title:"Graph",kind:"html",source:"<h1>Graph</h1>"});
await tools.artifact({action:"update",id:created.artifact.id,expectedRevision:1,title:"Graph updated",kind:"html",source:"<h1>Updated</h1>"});
text("Published two revisions");
`,
			}),
			{ stopReason: "toolUse" },
		),
		async () => {
			assert.ok(adapter);
			const before = adapter.extension;
			// Change the declaration fingerprint, exercising the real onToolsChanged replacement,
			// rather than a no-op refresh which would never reinstall the attention wrapper.
			adapter.session.setActiveToolsByName(
				adapter.session.getActiveToolNames().filter((name) => name !== "artifact"),
			);
			adapter.refreshTools();
			assert.notEqual(adapter.extension, before);
			assert.ok(!(await session.conversation.agent(context)).tools.some((tool) => tool.name === "artifact"));
			adapter.session.setActiveToolsByName([...adapter.session.getActiveToolNames(), "artifact"]);
			adapter.refreshTools();
			await assertReplaySafety(session);
			return fauxAssistantMessage(
				fauxToolCall(reportStatus.name, { status: "needs_input", reason: "Choose which graph to keep" }),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("Which graph should I keep?"),
	]);
	await session.submit("make-artifact", "Create and revise a graph using codemode", "followUp");
	await session.conversation.waitForIdle(context);
	await live;
	const completion = await completed;
	assert.equal(completion.outcome, "needs_input");
	assert.equal(completion.outcomeReason, "Choose which graph to keep");
	assert.deepEqual(session.completion, completion);
	assert.deepEqual(
		transitions.map(({ working }) => working),
		[true, false],
	);
	assert.equal(transitions[0]?.completion, undefined);
	assert.deepEqual(transitions[1]?.completion, completion);
	assert.equal(notifications, 2);
	assert.equal(writes.length, 2);
	assert.deepEqual(
		writes.map((value) => value.status),
		["queued", "queued"],
		"busy tools only admit writes; post-tools places them",
	);
	const view = await session.conversation.context(context);
	const entries = view.entries.filter((entry) => entry.kind === "pilot.artifact");
	assert.equal(entries.length, 2);
	assert.deepEqual(liveEntries, entries);
	const [summary] = await new ArtifactStore(f.root, { sessionId: spec.sessionId, projectId: spec.projectId }).list();
	assert.ok(summary);
	assert.deepEqual(
		entries.map((entry) => entry.data),
		[
			{ artifact: { id: summary.id, sessionId: spec.sessionId, title: "Graph", revision: 1 } },
			{ artifact: { id: summary.id, sessionId: spec.sessionId, title: "Graph updated", revision: 2 } },
		],
	);
	for (const entry of entries) {
		assert.deepEqual(entry.model, []);
		assert.deepEqual(
			view.contributions[view.entries.indexOf(entry)],
			[],
			"display entries never contribute model messages",
		);
		assert.ok(!JSON.stringify(entry).includes("<!doctype"));
	}
	const outer = view.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
	assert.ok(outer?.role === "toolResult" && !outer.isError, JSON.stringify(outer));
	assert.ok(
		!Object.hasOwn(Object(outer.details), "artifact"),
		"codemode need not forward a nested pinned artifact reference",
	);
	for (const publication of writes.slice()) {
		const repeated = await submit(publication.draft, context);
		assert.equal(repeated.id, publication.id, "revision request IDs deduplicate admission");
	}
	assert.equal(
		(await session.conversation.context(context)).entries.filter((entry) => entry.kind === "pilot.artifact").length,
		2,
	);
	assert.equal(f.faux.state.callCount, 3, "passive writes do not start extra model runs");
	await Promise.all(usageRefreshes);
	assert.ok(session.usage.context, "artifact and attention events retain context usage updates");
	await session.close();
	let finishRestored!: (completion: SessionCompletion) => void;
	const restoredCompletion = new Promise<SessionCompletion>((resolve) => {
		finishRestored = resolve;
	});
	const restored = await KernelSession.open(spec, {
		onWorking: (working, value) => {
			if (!working && value) finishRestored(value);
		},
	});
	f.cleanup.push(() => restored.close());
	assert.deepEqual(restored.completion, completion, "blocking outcome and completion version survive reopen");
	await assertReplaySafety(restored);
	let restoredEntries: unknown[] = [];
	await restored.watch("artifact-reopen", (events) => {
		for (const event of events)
			if (event.type === "snapshot")
				restoredEntries = event.entries.filter((entry) => entry.kind === "pilot.artifact");
	});
	assert.deepEqual(restoredEntries, entries, "reconnect snapshots retain both pinned revision references");
	assert.equal(f.faux.state.callCount, 3);
	f.faux.setResponses([fauxAssistantMessage("Kept the updated graph.")]);
	await restored.submit("choose-graph", "Keep the updated graph", "followUp");
	await restored.conversation.waitForIdle(context);
	assert.equal((await restoredCompletion).outcome, "done");
	// Completion is delivered before the monitor's final display-only usage read finishes.
	await Promise.all(usageRefreshes);
	await restored.close();
	const settled = await KernelSession.open(spec, { onWorking: () => {} });
	f.cleanup.push(() => settled.close());
	assert.equal(settled.completion?.outcome, "done", "new input must not inherit the blocking signal");
	assert.ok(settled.completion!.outcomeAt > completion.outcomeAt);
	assert.equal((await new ArtifactStore(f.root, { sessionId: spec.sessionId }).list())[0]?.revision, 2);
	assert.equal(f.faux.state.callCount, 4);
});
