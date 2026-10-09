import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxProvider,
	fauxAssistantMessage,
	getCurrentTools,
	getCurrentSystemPrompt,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createMissionTool, MISSION_TOOL } from "./mission-tools.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import type { MissionContext } from "./policy.ts";
import { KernelSession } from "./session.ts";

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
	}, true);
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

test("ordinary member declarations omit privileged actions and their guidance", () => {
	const tool = createMissionTool(async () => null);
	const schema = tool.parameters as { properties: { action: { enum: string[] }; message?: unknown } };
	for (const action of ["start", "send", "status"]) {
		assert.ok(!schema.properties.action.enum.includes(action));
		assert.ok(!tool.description.includes(`- ${action} (`));
	}
	assert.equal(schema.properties.message, undefined);
	assert.doesNotMatch(JSON.stringify(tool.parameters), /claim, start|comment or send|Opening instructions/);
	assert.match(tool.description, /- claim:/);
	assert.ok(schema.properties.action.enum.includes("get"));
});

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-mission-tool-"));
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => {
		for (const close of cleanup.reverse()) await close();
		await rm(root, { recursive: true, force: true });
	});
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
	const options: NativeAdapterOptions = {
		cwd: root,
		agentDir: join(root, "agent"),
		projectTrusted: false,
		settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "codemode"] }),
		sessionOptions: {
			modelRuntime,
			model: faux.getModel(),
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
			extensionFactories: [createCodemodeExtension({ models: false, mode: "on" })],
		},
	};
	return { root, options, faux, cleanup };
}

test("mission tool declarations follow membership without re-registering", { timeout: 15_000 }, async (t) => {
	const f = await fixture(t);
	const adapter = await NativeAdapter.open({ ...f.options, hostTools: [createMissionTool(async () => null)] });
	f.cleanup.push(() => adapter.close());
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

for (const ask of [false, true]) {
	for (const initialRole of ["other", "self"] as const) {
		test(`role-specific declarations refresh live in ${ask ? "Ask" : "Build"}, starting as ${initialRole}`, {
			timeout: 15_000,
		}, async (t) => {
			const f = await fixture(t);
			const open = NativeAdapter.open;
			let adapter!: NativeAdapter;
			t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
				adapter = await open.call(NativeAdapter, {
					...options,
					...f.options,
					sessionOptions: { ...options.sessionOptions, ...f.options.sessionOptions },
				});
				return adapter;
			});
			const mission: MissionContext = {
				id: "m1",
				title: "Shared goal",
				goal: "Ship",
				status: "active",
				coordinator: initialRole,
				tasks: [],
				decisions: [],
			};
			let admitted = 0;
			const session = await KernelSession.open(
				{
					sessionId: "member",
					cwd: f.root,
					storageDir: join(f.root, "durable"),
					mission,
					...(ask ? { pilot: { ask: { source: f.root } } } : {}),
				},
				{
					onWorking: () => {},
					callMission: async () => {
						admitted++;
						return { ok: true };
					},
				},
			);
			f.cleanup.push(() => session.close());
			let requests = 0;
			const check = async (role: MissionContext["coordinator"] | undefined) => {
				const coordinator = role === "self";
				const native = adapter.session.getAllTools().find((tool) => tool.name === MISSION_TOOL)!;
				const declared = (await session.conversation.agent(BACKGROUND_CONTEXT)).tools.find(
					(tool) => tool.name === MISSION_TOOL,
				);
				assert.equal(!!declared, role !== undefined);
				assert.equal(adapter.session.getCallableToolNames().includes(MISSION_TOOL), role !== undefined);
				const schema = native.parameters as { properties: { action: { enum: string[] }; message?: unknown } };
				for (const action of ["start", "send", "status"]) {
					assert.equal(schema.properties.action.enum.includes(action), coordinator);
					assert.equal(native.description.includes(`- ${action} (`), coordinator);
				}
				assert.equal(!!schema.properties.message, coordinator);
				const codemode = adapter.session.agent.state.tools.find((tool) => tool.name === "codemode")!;
				const result = await codemode.execute(
					`describe-${requests}`,
					{ code: 'text(await describeTool("mission"));' },
					undefined,
				);
				const description = result.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n");
				if (role !== undefined) {
					assert.ok(!result.isError, description);
					for (const action of ["start", "send", "status"])
						assert.equal(description.includes(`"${action}"`), coordinator, description);
				} else assert.doesNotMatch(description, /- start \(coordinator only\)/);
				let requestChecked = false;
				let requestFailure: unknown;
				f.faux.setResponses([
					async (context) => {
						try {
							const tool = getCurrentTools(context.messages).find((tool) => tool.name === MISSION_TOOL);
							assert.equal(!!tool, role !== undefined);
							if (tool) assert.deepEqual(tool.parameters, native.parameters);
							const prompt = getCurrentSystemPrompt(context.messages);
							assert.equal(prompt.includes('mission({action: "start", id})'), coordinator);
							requestChecked = true;
						} catch (error) {
							requestFailure = error;
						}
						return fauxAssistantMessage("Checked");
					},
				]);
				await session.submit(`request-${requests++}`, "Inspect the available actions", "followUp");
				await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
				assert.ifError(requestFailure);
				assert.equal(requestChecked, true);
				const before = admitted;
				const invocation = await codemode.execute(
					`invoke-${requests}`,
					{ code: 'text(await tools.mission({action: "status"}));' },
					undefined,
				);
				assert.equal(!!invocation.isError, !coordinator, JSON.stringify(invocation.content));
				assert.equal(admitted, before + (coordinator ? 1 : 0), "nested calls validate the current schema");
			};
			await check(initialRole);
			for (const role of ["self", "other", "user", undefined, "self", undefined, "other"] as const) {
				session.setMission(role === undefined ? undefined : { ...mission, coordinator: role });
				await check(role);
			}
			for (const role of ["self", "other"] as const) {
				session.setMission({ ...mission, coordinator: role });
				await adapter.session.reload();
				adapter.refreshTools();
				await check(role);
			}
			const before = adapter.extension;
			session.setMission({ ...mission, coordinator: "other", goal: "Updated goal" });
			assert.equal(adapter.extension, before, "non-role context changes do not rebuild tools");
		});
	}
}
