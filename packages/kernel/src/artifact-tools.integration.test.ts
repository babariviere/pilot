import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	getSystemMessageText,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SubmissionDraft } from "@earendil-works/pi-durable";
import { ArtifactStore, closePreviewBrowser } from "@pilot/artifacts";
import type { ArtifactRevision, SessionCompletion } from "@pilot/protocol";
import { createArtifactTools } from "./artifact-tools.ts";
import { ARTIFACT_SKILL_PATH } from "./artifact-skill.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

// Previews keep a browser warm for a minute. Close it so the test process exits promptly.
after(() => closePreviewBrowser());

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";

async function fixture(t: TestContext, mode: "on" | "only" = "on", inlineBudget?: number) {
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
		settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "codemode"] }),
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
			extensionFactories: [createCodemodeExtension({ models: false, mode, inlineBudget })],
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
		assert.doesNotMatch(
			adapter.session.systemPrompt,
			/proactively publish a diagram/,
			"ordinary Pi tools do not inject Pilot-only behavior",
		);
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
		assert.match(adapter.session.systemPrompt, /<name>pilot-artifacts<\/name>/);
		assert.ok(adapter.session.systemPrompt.includes(ARTIFACT_SKILL_PATH));
		assert.doesNotMatch(adapter.session.systemPrompt, /echarts\.init|mermaid\.initialize|@StateObject/);
		const codemode = adapter.session.agent.state.tools.find((tool) => tool.name === "codemode");
		assert.ok(codemode);
		if (mode === "only") {
			assert.match(codemode.description, /## artifacts/);
			assert.match(codemode.description, /### `artifact`/, "compact schema fits the default inline budget");
		}
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
const skill = await tools.read({path:${JSON.stringify(ARTIFACT_SKILL_PATH)}});
text({loadedSkill:skill.includes("name: pilot-artifacts")});
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
		assert.ok(text.includes('"loadedSkill":true'), text);
		assert.ok(text.includes('"source":"<h1>Demo</h1>"'), text);
		assert.ok(text.includes('"revision":2'), text);
		assert.ok(text.includes("Rendered offline"), text);
		assert.ok(!text.includes("COMPILED_HTML"), text);
		assert.ok(result.content.some((block) => block.type === "image" && block.data === png));
		assert.equal(publications, 2);
		assert.equal(f.faux.state.callCount, 0, "tool calls do not invoke the native model loop");
	});
}

test("bundled authoring skill extends configured skills and survives resource reload", async (t) => {
	const f = await fixture(t, "only");
	const userSkill = join(f.root, "user-skill.md");
	await writeFile(userSkill, "---\nname: user-skill\ndescription: A configured user skill\n---\nUser-only body.");
	const tools = createArtifactTools({
		preview: false,
		store: {
			list: async () => [],
			get: async () => assert.fail("only checking registration"),
			create: async () => assert.fail("only checking registration"),
			update: async () => assert.fail("only checking registration"),
		},
	});
	const adapter = await NativeAdapter.open({
		...f.options,
		loaderOptions: { ...f.options.loaderOptions!, additionalSkillPaths: [userSkill] },
		sessionOptions: { ...f.options.sessionOptions, customTools: tools },
	});
	f.cleanup.push(() => adapter.close());
	const checkSkills = () => {
		const loaded = adapter.session.resourceLoader.getSkills();
		assert.deepEqual(loaded.diagnostics, []);
		assert.deepEqual(loaded.skills.map((skill) => skill.name).sort(), ["pilot-artifacts", "user-skill"]);
		assert.equal(loaded.skills.find((skill) => skill.name === "pilot-artifacts")?.filePath, ARTIFACT_SKILL_PATH);
		assert.equal(
			adapter.session.getAllTools().find((tool) => tool.name === "artifact")?.namespace?.name,
			"artifacts",
		);
	};
	checkSkills();
	await adapter.session.reload();
	checkSkills();
});

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

for (const mode of ["on", "only"] as const) {
	for (const available of [true, false]) {
		test(`Pilot diagram system guidance follows artifact availability (${mode}, ${available})`, {
			timeout: 45_000,
		}, async (t) => {
			const f = await fixture(t, mode);
			const open = NativeAdapter.open;
			let adapter: NativeAdapter | undefined;
			t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
				adapter = await open.call(NativeAdapter, {
					...options,
					...f.options,
					sessionOptions: { ...options.sessionOptions, ...f.options.sessionOptions },
				});
				if (!available) {
					adapter.session.setActiveToolsByName(
						adapter.session.getActiveToolNames().filter((name) => name !== "artifact"),
					);
					adapter.refreshTools();
				}
				return adapter;
			});
			const session = await KernelSession.open(
				{
					sessionId: "diagram-guidance",
					cwd: f.root,
					storageDir: join(f.root, "storage"),
				},
				{ onWorking: () => {} },
			);
			f.cleanup.push(() => session.close());
			assert.ok(adapter);
			assert.equal(adapter.session.getCallableToolNames().includes("artifact"), available);
			if (mode === "only")
				assert.ok(
					!adapter.extension.tools?.some((tool) => tool.name === "artifact"),
					"guidance must not rely on direct declarations",
				);
			let prompt: string | undefined;
			f.faux.setResponses([
				(transcript) => {
					prompt = transcript.messages
						.filter((message) => message.role === "system")
						.map(getSystemMessageText)
						.join("\n");
					return fauxAssistantMessage("Explained.");
				},
			]);
			await session.submit("explain", "Explain the architecture", "followUp");
			await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
			assert.equal(f.faux.state.callCount, 1);
			assert.ok(prompt);
			if (available) {
				assert.match(prompt, /proactively publish a diagram with the artifact tool/);
				assert.match(prompt, /Artifact preview is optional verification/);
			} else {
				assert.doesNotMatch(prompt, /proactively publish a diagram|Artifact preview is optional verification/);
			}
		});
	}
}

for (const skillWasAdvertised of [true, false]) {
	test(`budget-omitted artifacts remain discoverable after restart (skill advertised before: ${skillWasAdvertised})`, {
		timeout: 20_000,
	}, async (t) => {
		// A zero inline budget deterministically reproduces the omitted declaration, regardless
		// of how many user extension/MCP tools compete for the normal 3000-token budget.
		const f = await fixture(t, "only", 0);
		// Also cover a cached pre-upgrade native prompt that never advertised the new skill.
		let advertiseSkill = skillWasAdvertised;
		f.options.loaderOptions = {
			...f.options.loaderOptions!,
			skillsOverride: (loaded) => (advertiseSkill ? loaded : { ...loaded, skills: [] }),
		};
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
		const spec = { sessionId: "restart-artifacts", cwd: f.root, storageDir: join(f.root, "storage") };
		const store = new ArtifactStore(f.root, { sessionId: spec.sessionId });
		const session = await KernelSession.open(spec, { onWorking: () => {} });
		f.cleanup.push(() => session.close());
		f.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: 'text(await tools.artifact({action:"create",title:"Before restart",kind:"html",source:"<h1>Before</h1>"}));',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Published before restart."),
		]);
		await session.submit("before", "Create an artifact", "followUp");
		await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		const [before] = await store.list();
		assert.ok(before);
		const oldAdapter = adapter;
		let enterRequest!: () => void;
		const requestEntered = new Promise<void>((resolve) => {
			enterRequest = resolve;
		});
		// Stop during a model request, leaving its prepared prompt and pending generation
		// durable for KernelSession.open's harness.resume(). No new submission on reopen.
		f.faux.setResponses([
			async (_transcript, options) => {
				enterRequest();
				assert.ok(options?.signal);
				await new Promise<void>((resolve) =>
					options.signal!.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("Interrupted request");
			},
		]);
		await session.submit("after", "Show the artifact after restarting", "followUp");
		await requestEntered;
		await Promise.all(usageRefreshes);
		await session.close();
		advertiseSkill = true;
		f.faux.setResponses([
			(transcript) => {
				assert.ok(adapter);
				assert.notEqual(adapter, oldAdapter);
				assert.ok(adapter.session.getCallableToolNames().includes("artifact"));
				assert.ok(!adapter.extension.tools?.some((tool) => tool.name === "artifact"));
				const codemode = adapter.extension.tools?.find((tool) => tool.name === "codemode");
				assert.ok(codemode);
				assert.doesNotMatch(codemode.description, /### `artifact`/);
				assert.match(codemode.description, /## artifacts \(tools not listed\)/);
				assert.match(codemode.description, /tools\.artifact/);
				assert.match(codemode.description, /pilot-artifacts skill/);
				const prompt = transcript.messages
					.filter((m) => m.role === "system")
					.map(getSystemMessageText)
					.join("\n");
				if (skillWasAdvertised) {
					assert.match(prompt, /<name>pilot-artifacts<\/name>/);
					assert.ok(prompt.includes(ARTIFACT_SKILL_PATH));
				} else {
					assert.doesNotMatch(prompt, /<name>pilot-artifacts<\/name>/);
				}
				assert.equal(
					adapter.session.resourceLoader.getSkills().skills.find((skill) => skill.name === "pilot-artifacts")
						?.filePath,
					ARTIFACT_SKILL_PATH,
				);
				assert.doesNotMatch(prompt, /echarts\.init|mermaid\.initialize|@StateObject/);
				return fauxAssistantMessage(
					fauxToolCall("codemode", {
						code: `
text(await describeNamespace("artifacts"));
text(await describeTool("artifact"));
text(await tools.read({path:${JSON.stringify(ARTIFACT_SKILL_PATH)}}));
`,
					}),
					{
						stopReason: "toolUse",
					},
				);
			},
			(transcript) => {
				const result = transcript.messages.findLast((m) => m.role === "toolResult");
				assert.ok(result?.role === "toolResult" && !result.isError);
				const description = result.content
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("\n");
				assert.match(description, /artifact\(args:/);
				assert.ok(
					description.includes(ARTIFACT_SKILL_PATH),
					"namespace instructions locate the skill even with an older cached prompt",
				);
				assert.match(description, /ArtifactView/);
				assert.match(description, /@StateObject/);
				assert.match(description, /mermaid\.initialize/);
				return fauxAssistantMessage(
					fauxToolCall("codemode", {
						code: `
const existing = await tools.artifact({action:"get",id:${JSON.stringify(before.id)}});
text(await tools.artifact({action:"update",id:existing.artifact.id,expectedRevision:existing.artifact.revision,title:"After restart",kind:"html",source:"<h1>After</h1>"}));
text(await tools.artifact({action:"create",title:"New after restart",kind:"html",source:"<h1>New</h1>"}));
`,
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Published after restart."),
		]);
		const restored = await KernelSession.open(spec, { onWorking: () => {} });
		f.cleanup.push(() => restored.close());
		await restored.conversation.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(f.faux.state.callCount, 6, "reopen retries the interrupted request without a new user message");
		const artifacts = await store.list();
		assert.equal(artifacts.length, 2);
		assert.equal(artifacts.find((artifact) => artifact.id === before.id)?.revision, 2);
		assert.equal((await store.get(before.id)).source, "<h1>After</h1>");
		const view = await restored.conversation.context(BACKGROUND_CONTEXT);
		const results = view.messages.filter((m) => m.role === "toolResult");
		assert.equal(results.length, 3);
		assert.ok(
			results.every((result) => !result.isError),
			JSON.stringify(results),
		);
		assert.equal(view.entries.filter((entry) => entry.kind === "pilot.artifact").length, 3);
		await Promise.all(usageRefreshes);
	});
}

test("busy codemode publications and automatic completion survive native tool refresh and reopen", {
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
		assert.ok(!tools.some((tool) => tool.name === "pilot_report_status"));
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
			// rather than a no-op refresh which would never reinstall the policy wrapper.
			adapter.session.setActiveToolsByName(
				adapter.session.getActiveToolNames().filter((name) => name !== "artifact"),
			);
			adapter.refreshTools();
			assert.notEqual(adapter.extension, before);
			assert.ok(!(await session.conversation.agent(context)).tools.some((tool) => tool.name === "artifact"));
			adapter.session.setActiveToolsByName([...adapter.session.getActiveToolNames(), "artifact"]);
			adapter.refreshTools();
			await assertReplaySafety(session);
			return fauxAssistantMessage("Which graph should I keep?");
		},
	]);
	await session.submit("make-artifact", "Create and revise a graph using codemode", "followUp");
	await session.conversation.waitForIdle(context);
	await live;
	const completion = await completed;
	assert.equal(completion.outcome, "done");
	assert.equal(completion.outcomeReason, undefined);
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
	assert.equal(f.faux.state.callCount, 2, "passive writes do not start extra model runs");
	await Promise.all(usageRefreshes);
	assert.ok(session.usage.context, "artifact and completion events retain context usage updates");
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
	assert.deepEqual(restored.completion, completion, "automatic outcome and completion version survive reopen");
	await assertReplaySafety(restored);
	let restoredEntries: unknown[] = [];
	await restored.watch("artifact-reopen", (events) => {
		for (const event of events)
			if (event.type === "snapshot")
				restoredEntries = event.entries.filter((entry) => entry.kind === "pilot.artifact");
	});
	assert.deepEqual(restoredEntries, entries, "reconnect snapshots retain both pinned revision references");
	assert.equal(f.faux.state.callCount, 2);
	f.faux.setResponses([fauxAssistantMessage("Kept the updated graph.")]);
	await restored.submit("choose-graph", "Keep the updated graph", "followUp");
	await restored.conversation.waitForIdle(context);
	assert.equal((await restoredCompletion).outcome, "done");
	// Completion is delivered before the monitor's final display-only usage read finishes.
	await Promise.all(usageRefreshes);
	await restored.close();
	const settled = await KernelSession.open(spec, { onWorking: () => {} });
	f.cleanup.push(() => settled.close());
	assert.equal(settled.completion?.outcome, "done", "new input settles automatically");
	assert.ok(settled.completion!.outcomeAt > completion.outcomeAt);
	assert.equal((await new ArtifactStore(f.root, { sessionId: spec.sessionId }).list())[0]?.revision, 2);
	assert.equal(f.faux.state.callCount, 3);
});
