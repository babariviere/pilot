import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ScreenOperation } from "@pilot/protocol";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { pilotPrompt } from "./policy.ts";
import { createScreenTools, SCREEN_TOOL_NAMES } from "./screen-tools.ts";
import { KernelSession } from "./session.ts";

test("screen tools send one operation each and return the window's answer, picture or refusal", async () => {
	const calls: ScreenOperation[] = [];
	const png = await readFile(new URL("../../../apps/day/macos/Resources/LegacyApp/HomeSky.png", import.meta.url));
	const picture = {
		attachment: { uploadId: "6c1f2b9e-1111-4222-8333-944455556666", sha256: "a".repeat(64), bytes: png.length },
		width: 800,
		height: 600,
		mimeType: "image/png" as const,
	};
	const tools = new Map(
		createScreenTools(async (operation) => {
			calls.push(operation);
			if (operation.op === "screenshot") return { picture, data: png.toString("base64") };
			if (operation.op === "act") throw new Error("Needs a person: Send sends the message.");
			return { entries: [{ ref: "c1", component: "button", label: "New" }] };
		}).map((tool) => [tool.name, tool]),
	);
	assert.deepEqual([...tools.keys()], SCREEN_TOOL_NAMES);
	const run = (name: string, params: unknown) =>
		tools.get(name)!.execute("call", params as never, undefined, undefined, {} as never);
	const snapshot = await run("ui_snapshot", {});
	assert.deepEqual(JSON.parse((snapshot.content[0] as { text: string }).text), {
		entries: [{ ref: "c1", component: "button", label: "New" }],
	});
	await run("ui_query", { text: "New", kind: "button" });
	await assert.rejects(run("ui_act", { steps: [{ ref: "Send", action: "press" }] }), /Needs a person: Send/);
	const shot = await run("ui_screenshot", {});
	assert.match((shot.content[0] as { text: string }).text, /800×600, attachment 6c1f2b9e-1111-4222-8333-944455556666/);
	const image = shot.content[1] as { type: string; data: string; mimeType: string };
	assert.equal(image.type, "image");
	assert.ok(image.data.length > 0);
	assert.equal((shot as { structuredContent?: { type: string } }).structuredContent?.type, "image");
	assert.deepEqual(calls, [
		{ op: "snapshot" },
		{ op: "query", text: "New", kind: "button" },
		{ op: "act", steps: [{ ref: "Send", action: "press" }] },
		{ op: "screenshot" },
	]);
});

test("the screen prompt asks to read first, name presses and respect Needs a person", () => {
	const prompt = pilotPrompt({ role: "screen", ask: { source: "/project" } });
	assert.match(prompt, /ui_snapshot or ui_screenshot before you answer/);
	assert.match(prompt, /Needs a person/);
	assert.match(prompt, /make feedback/);
	assert.doesNotMatch(pilotPrompt({ ask: { source: "/project" } }), /ui_snapshot/);
});

test("only a screen agent chat lists the ui_* tools and diagnostic_context", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-screen-role-"));
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider(faux.provider);
	let native!: NativeAdapter;
	const open = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
		native = await open.call(NativeAdapter, {
			...options,
			agentDir: root,
			projectTrusted: false,
			bundledExtensions: false,
			askExtensionTools: [],
			settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
			loaderOptions: {
				cwd,
				agentDir: root,
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			sessionOptions: { ...options.sessionOptions, modelRuntime: runtime, model: faux.getModel() },
		});
		return native;
	});
	let session: KernelSession | undefined;
	t.after(async () => {
		await session?.close();
		await rm(root, { recursive: true, force: true });
	});
	const screenCalls: ScreenOperation[] = [];
	for (const screen of [true, false]) {
		session = await KernelSession.open(
			{
				sessionId: `screen-${screen}`,
				storageDir: join(root, `durable-${screen}`),
				cwd,
				projectId: "project",
				...(screen ? { role: "screen" as const } : {}),
				pilot: { ask: { source: cwd }, ...(screen ? { role: "screen" as const } : {}) },
			},
			{
				onWorking: () => {},
				callScreen: async (operation) => {
					screenCalls.push(operation);
					return { entries: [] };
				},
				callDiagnosticContext: async () => ({}) as never,
			},
		);
		const names = native.session.getAllTools().map((tool) => tool.name);
		for (const name of [...SCREEN_TOOL_NAMES, "diagnostic_context"]) assert.equal(names.includes(name), screen, name);
		for (const denied of ["bash", "write", "edit", "todo"]) assert(!names.includes(denied), denied);
		assert.ok(names.includes("read"));
		if (screen)
			await native.session
				.getToolDefinition("ui_snapshot")!
				.execute("snapshot", {}, undefined, undefined, {} as never);
		await session.close();
		session = undefined;
	}
	assert.deepEqual(screenCalls, [{ op: "snapshot" }]);
	await assert.rejects(
		KernelSession.open(
			{
				sessionId: "screen-build",
				storageDir: join(root, "durable-build"),
				cwd,
				projectId: "project",
				role: "screen",
				pilot: { role: "screen" },
			},
			{ onWorking: () => {} },
		),
		/read-only project chat/,
	);
});
