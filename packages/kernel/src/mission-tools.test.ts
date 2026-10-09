import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createMissionTool, MISSION_TOOL } from "./mission-tools.ts";
import { NativeAdapter } from "./native-adapter.ts";

test("the mission tool forwards actions with only the supplied arguments", async () => {
	const calls: unknown[] = [];
	const tool = createMissionTool(async (action, args) => {
		calls.push([action, args]);
		return { ok: true };
	});
	const result = await tool.execute(
		"call",
		{ action: "task", title: "Auth", status: "todo" } as never,
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(calls, [["task", { title: "Auth", status: "todo" }]]);
	assert.deepEqual(result.details, { ok: true });
	await assert.rejects(
		createMissionTool(async () => {
			throw new Error("This chat is not part of a mission.");
		}).execute("call", { action: "get" } as never, undefined, undefined, {} as never),
		/not part of a mission/,
	);
});

test("the mission tool declares and forwards coordinator actions", async () => {
	const calls: unknown[] = [];
	const tool = createMissionTool(async (action, args) => {
		calls.push([action, args]);
		return { ok: true };
	});
	const schema = tool.parameters as { properties: { action: { enum: string[] }; message: unknown } };
	assert.deepEqual(schema.properties.action.enum.slice(-3), ["start", "send", "status"]);
	assert.ok(schema.properties.message);
	for (const params of [
		{ action: "start", id: "#3", message: "Focus on tests" },
		{ action: "send", targetSessionId: "member", message: "Please clarify" },
		{ action: "status" },
	])
		await tool.execute("call", params as never, undefined, undefined, {} as never);
	assert.deepEqual(calls, [
		["start", { id: "#3", message: "Focus on tests" }],
		["send", { targetSessionId: "member", message: "Please clarify" }],
		["status", {}],
	]);
	await assert.rejects(
		createMissionTool(async () => {
			throw new Error("Only the mission coordinator can use status");
		}).execute("call", { action: "status" } as never, undefined, undefined, {} as never),
		/Only the mission coordinator/,
	);
});

test("mission tool declarations follow membership without re-registering", { timeout: 15_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-mission-tool-"));
	t.mock.method(globalThis, "fetch", () => assert.fail("mission tool integration must stay offline"));
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "pilot-mission-test", models: [{ id: "offline" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	const adapter = await NativeAdapter.open({
		cwd: root,
		agentDir: join(root, "agent"),
		projectTrusted: false,
		settingsManager: SettingsManager.inMemory({ defaultTools: ["read"] }),
		sessionOptions: {
			modelRuntime,
			model: faux.getModel(),
			customTools: [createMissionTool(async () => null)],
		},
		loaderOptions: {
			cwd: root,
			agentDir: join(root, "agent"),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Offline mission integration.",
		},
	});
	t.after(async () => {
		await adapter.close();
		await rm(root, { recursive: true, force: true });
	});
	const declared = () => adapter.extension.tools?.some((tool) => tool.name === MISSION_TOOL) ?? false;
	const installed: boolean[] = [];
	adapter.onToolsChanged = (extension) =>
		installed.push(!!extension.tools?.some((tool) => tool.name === MISSION_TOOL));
	assert.equal(adapter.setToolActive(MISSION_TOOL, false), false);
	assert.equal(declared(), false, "chats outside a mission do not declare the tool");
	assert.equal(adapter.setToolActive(MISSION_TOOL, true), true);
	assert.equal(declared(), true);
	assert.equal(adapter.session.getActiveToolNames().includes("read"), true, "other tools stay active");
	assert.deepEqual(installed, [false, true], "the durable registry is reinstalled on each change");
	assert.equal(adapter.setToolActive(MISSION_TOOL, true), true);
	assert.deepEqual(installed, [false, true], "no-op changes do not reinstall");
});
