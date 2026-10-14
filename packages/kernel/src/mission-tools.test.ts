import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
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

for (const busy of [false, true]) {
	test(`decision changes preserve the prompt and place one passive notice (${busy ? "busy" : "idle"})`, async (t) => {
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
			id: "shared",
			title: "Shared goal",
			goal: "Ship",
			status: "active",
			coordinator: "other",
			tasks: [],
			decisions: ["Original binding rule"],
			decisionEntries: [{ id: "rule", text: "Original binding rule" }],
			remainingDecisions: 10,
			decisionVersion: "first",
		};
		const calls: unknown[] = [];
		const session = await KernelSession.open(
			{
				sessionId: "member",
				cwd: f.root,
				storageDir: join(f.root, "durable"),
				mission,
			},
			{
				onWorking: () => {},
				callMission: async (action, args) => {
					calls.push([action, args]);
					return {};
				},
			},
		);
		f.cleanup.push(() => session.close());
		const writes: Promise<unknown>[] = [];
		const submit = session.conversation.submit.bind(session.conversation);
		t.mock.method(session.conversation, "submit", (...args: Parameters<typeof submit>) => {
			const promise = submit(...args);
			if (args[0].type === "write") writes.push(promise);
			return promise;
		});
		const prompts: string[] = [];
		let reached!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.after(() => release());
		f.faux.setResponses([
			async (context) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				reached();
				if (busy) await gate;
				return fauxAssistantMessage("First");
			},
			async (context) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				assert.match(JSON.stringify(context.messages), /Mission decisions changed/);
				return fauxAssistantMessage("Second");
			},
		]);
		await session.submit("first", "Begin", "followUp");
		await started;
		if (!busy) await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		const changed = {
			...mission,
			decisions: ["Revised binding rule"],
			decisionEntries: [{ id: "rule", text: "Revised binding rule" }],
			remainingDecisions: 11,
			decisionVersion: "second",
		};
		session.setMission(changed);
		session.setMission(changed);
		await Promise.all(writes);
		release();
		await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(prompts.length, 1, "a passive notice never starts generation");
		await session.submit("second", "Continue", "followUp");
		await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(prompts[0], prompts[1]);
		assert.match(prompts[1]!, /Original binding rule/);
		assert.match(prompts[1]!, /10 more decisions: mission decisions/);
		assert.doesNotMatch(prompts[1]!, /Revised binding rule/);
		const entries = (await session.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items;
		assert.equal(entries.filter((entry) => entry.kind === "pilot.activity").length, 1);
		const codemode = adapter.session.agent.state.tools.find((tool) => tool.name === "codemode")!;
		const result = await codemode.execute(
			"read-decisions",
			{ code: 'text(await tools.mission({action:"decisions"}));' },
			undefined,
		);
		assert.ok(!result.isError);
		assert.deepEqual(calls.at(-1), ["decisions", { _promptDecisions: mission.decisionEntries }]);
	});
}

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
	assert.ok(tool.outputSchema);
	assert.deepEqual(result.details, { ok: true });
	assert.deepEqual(result.structuredContent, { ok: true });
	assert.deepEqual(result.content, [{ type: "text", text: '{"ok":true}' }]);
	await assert.rejects(
		createMissionTool(async () => {
			throw new Error("This chat is not part of a mission.");
		}).execute("call", { action: "get" } as never, undefined, undefined, {} as never),
		/not part of a mission/,
	);
});

test("the mission tool declares and forwards batch task claims for members and coordinators", async () => {
	for (const coordinator of [false, true]) {
		const calls: unknown[] = [];
		const data = { claimed: [{ number: 1 }], skipped: [{ ref: "2", reason: "already claimed" }] };
		const tool = createMissionTool(async (action, args) => {
			calls.push([action, args]);
			return data;
		}, coordinator);
		const schema = tool.parameters as { properties: { ids: { minItems: number; items: { anyOf: unknown[] } } } };
		assert.equal(schema.properties.ids.minItems, 1);
		assert.equal(schema.properties.ids.items.anyOf.length, 2);
		assert.match(tool.description, /ranges.*1-5/);
		assert.match(tool.description, /claimed tasks and skipped tasks with reasons/);
		for (const args of [{ ids: ["1-5", 8, "task-id"] }, { id: "1-5" }, { id: "#1" }]) {
			const result = await tool.execute(
				"call",
				{ action: "claim", ...args } as never,
				undefined,
				undefined,
				{} as never,
			);
			assert.deepEqual(result.details, data);
			assert.deepEqual(calls.at(-1), ["claim", args]);
		}
	}
});

test("the mission tool declares and forwards coordinator actions", async () => {
	const calls: unknown[] = [];
	const tool = createMissionTool(async (action, args) => {
		calls.push([action, args]);
		return { ok: true };
	}, true);
	const schema = tool.parameters as {
		properties: { action: { enum: string[] }; message: unknown; model: unknown; thinking: unknown };
	};
	assert.deepEqual(schema.properties.action.enum.slice(-5), ["start", "send", "status", "bindPr", "unbindPr"]);
	assert.ok(schema.properties.message);
	assert.equal(tool.annotations?.destructiveHint, true);
	assert.match(tool.description, /batch is atomic/);
	assert.match(tool.description, /ties sort by task number/);
	assert.ok(schema.properties.model);
	assert.ok(schema.properties.thinking);
	assert.match(tool.description, /validation errors list allowed model IDs, prices and supported thinking levels/);
	assert.match(tool.description, /cheaper models for small tasks.*strongest allowed model for hard ones/);
	assert.match(tool.description, /cached read-only subscriptionUsage per provider/);
	for (const params of [
		{ action: "delete", id: "#3" },
		{ action: "group", ids: ["1-5", 8], milestone: "Next" },
		{ action: "task", id: "#3", order: 1.5 },
		{ action: "start", id: "#3", message: "Focus on tests", model: "test/model", thinking: "high" },
		{ action: "send", targetSessionId: "member", message: "Please clarify" },
		{ action: "status" },
	])
		await tool.execute("call", params as never, undefined, undefined, {} as never);
	assert.deepEqual(calls, [
		["delete", { id: "#3" }],
		["group", { ids: ["1-5", 8], milestone: "Next" }],
		["task", { id: "#3", order: 1.5 }],
		["start", { id: "#3", message: "Focus on tests", model: "test/model", thinking: "high" }],
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
	const schema = tool.parameters as {
		properties: { action: { enum: string[] }; message?: unknown; model?: unknown; thinking?: unknown };
	};
	for (const action of ["delete", "group", "start", "send", "status", "bindPr", "unbindPr"]) {
		assert.ok(!schema.properties.action.enum.includes(action));
		assert.ok(!tool.description.includes(`- ${action} (`));
	}
	assert.equal(schema.properties.message, undefined);
	assert.equal(tool.annotations?.destructiveHint, false);
	assert.ok(!("order" in schema.properties));
	assert.doesNotMatch(tool.description, /task order|For claim or group/);
	assert.doesNotMatch(tool.description, /subscriptionUsage|window percent\/reset/);
	assert.match(tool.description, /status "dropped"/);
	assert.equal(schema.properties.model, undefined);
	assert.equal(schema.properties.thinking, undefined);
	assert.equal((schema.properties as Record<string, unknown>).artifacts, undefined);
	assert.equal((schema.properties as Record<string, unknown>).links, undefined);
	assert.doesNotMatch(JSON.stringify(tool.parameters), /claim, start|comment or send|Opening instructions/);
	assert.doesNotMatch(tool.description, /owns the PR head|One owner per PR|transfers ownership|stop its tracking/);
	assert.doesNotMatch(JSON.stringify(tool.parameters), /bindPr|unbindPr/);
	assert.match(tool.description, /- claim:/);
	assert.ok(schema.properties.action.enum.includes("get"));
});

test("coordinator PR binding actions forward targets and optional owning tasks unchanged", async () => {
	const calls: unknown[] = [];
	const tool = createMissionTool(async (action, args) => {
		calls.push([action, args]);
		return { id: "member", state: "idle" };
	}, true);
	const schema = tool.parameters as { properties: Record<string, { maxLength?: number; description?: string }> };
	assert.equal(schema.properties.url.maxLength, 2048);
	assert.equal(schema.properties.targetSessionId.maxLength, 128);
	assert.equal(schema.properties.taskId.maxLength, 128);
	assert.match(schema.properties.taskId.description!, /bindPr/);
	assert.match(tool.description, /Neither binds a chat/);
	assert.match(tool.description, /Transfers sole PR-head ownership/);
	assert.match(tool.description, /Transfers sole PR-head ownership/);
	assert.match(tool.description, /unfinished ownership links/);
	assert.match(tool.description, /References\/branches stay/);
	assert.match(tool.description, /references never grant ownership/);
	assert.match(tool.description, /stopping tracking\/pushes\/follow-ups/);
	assert.match(tool.description, /removing unfinished ownership links/);
	const url = "https://github.com/example/repo/pull/7";
	for (const params of [
		{ action: "bindPr", targetSessionId: "member", url },
		{ action: "bindPr", targetSessionId: "member", url, taskId: "#3" },
		{ action: "unbindPr", targetSessionId: "member", url },
	]) {
		const result = await tool.execute("call", params as never, undefined, undefined, {} as never);
		assert.deepEqual(result.details, { id: "member", state: "idle" });
	}
	assert.deepEqual(calls, [
		["bindPr", { targetSessionId: "member", url }],
		["bindPr", { targetSessionId: "member", url, taskId: "#3" }],
		["unbindPr", { targetSessionId: "member", url }],
	]);
	assert.doesNotMatch(JSON.stringify(createMissionTool(async () => null).parameters), /bindPr|unbindPr/);
});

test("members can declare reference links and unlink by URL and task scope", async () => {
	const calls: unknown[] = [];
	const tool = createMissionTool(async (action, args) => {
		calls.push([action, args]);
		return { removed: true };
	});
	const schema = tool.parameters as { properties: { action: { enum: string[] }; relationship: { enum: string[] } } };
	assert.ok(schema.properties.action.enum.includes("unlink"));
	assert.deepEqual(schema.properties.relationship.enum, ["ownership", "reference"]);
	for (const params of [
		{ action: "link", url: "https://example.com", taskId: "#1", relationship: "reference" },
		{ action: "unlink", url: "https://example.com", taskId: "#1" },
		{ action: "unlink", url: "https://example.com" },
	])
		await tool.execute("call", params as never, undefined, undefined, {} as never);
	assert.deepEqual(calls, [
		["link", { url: "https://example.com", taskId: "#1", relationship: "reference" }],
		["unlink", { url: "https://example.com", taskId: "#1" }],
		["unlink", { url: "https://example.com" }],
	]);
});

test("coordinator declares bounded start references and forwards them unchanged", async () => {
	const calls: unknown[] = [];
	const tool = createMissionTool(async (action, args) => {
		calls.push([action, args]);
		return {};
	}, true);
	const { properties } = tool.parameters as { properties: Record<string, { maxItems?: number }> };
	assert.equal(properties.artifacts?.maxItems, 40);
	assert.equal(properties.links?.maxItems, 40);
	assert.match(tool.description, /Durable context belongs in the brief, decisions or task links/);
	assert.match(tool.description, /task body and reference list must fit 4000 characters/);
	const args = {
		id: "1",
		artifacts: [{ artifactId: "a", revision: 2 }],
		links: [{ url: "https://example.com", title: "Spec" }],
	};
	await tool.execute("call", { action: "start", ...args } as never, undefined, undefined, {} as never);
	assert.deepEqual(calls, [["start", args]]);
});

async function fixture(t: TestContext, mode: "on" | "only" = "on") {
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
			extensionFactories: [createCodemodeExtension({ models: false, mode })],
		},
	};
	return { root, options, faux, cleanup };
}

for (const mode of ["on", "only"] as const) {
	for (const coordinator of [false, true]) {
		test(`mission results are structured in codemode (${mode}, ${coordinator ? "coordinator" : "member"})`, {
			timeout: 15_000,
		}, async (t) => {
			const f = await fixture(t, mode);
			const calls: unknown[] = [];
			const tool = createMissionTool(async (action, args): Promise<JsonValue> => {
				calls.push([action, args]);
				switch (action) {
					case "get":
						return { mission: { title: "Shared goal", status: "active" }, decisions: [], doneTasks: 0 };
					case "brief":
						if (args.markdown !== undefined) return { revision: 2 };
						return { revision: 1, markdown: "# Goal", by: "you" };
					case "tasks":
						return { tasks: [{ id: "t1", number: 1, title: "Ship", status: "todo", resources: [] }] };
					case "task":
						return { id: args.id ?? "t1", status: args.status ?? "todo" };
					case "status":
						return { members: [{ id: "member", tasks: [] }] };
					default:
						throw new Error("Claim conflict");
				}
			}, coordinator);
			const adapter = await NativeAdapter.open({ ...f.options, hostTools: [tool] });
			f.cleanup.push(() => adapter.close());
			const codemode = adapter.session.agent.state.tools.find((candidate) => candidate.name === "codemode")!;
			adapter.session.agent.state.messages.push(
				fauxAssistantMessage(
					{ type: "toolCall", id: "structured-mission", name: "codemode", arguments: {} },
					{ stopReason: "toolUse" },
				),
			);
			const result = await codemode.execute(
				"structured-mission",
				{
					code: `
const description = await describeTool("mission");
text({objectDeclaration: !description.includes("Promise<string>")});
const got = await tools.mission({action: "get"});
const brief = await tools.mission({action: "brief"});
const saved = await tools.mission({action: "brief", markdown: brief.markdown + "\\nUpdated", expectedRevision: brief.revision});
const listed = await tools.mission({action: "tasks"});
const updated = await tools.mission({action: "task", id: listed.tasks[0].id, status: "in_progress"});
text({title: got.mission.title, decisions: got.decisions.length, done: got.doneTasks, revision: saved.revision, status: updated.status});
${coordinator ? 'const status = await tools.mission({action: "status"}); text({member: status.members[0].id});' : ""}
try { await tools.mission({action: "claim", id: "t1"}); text("unexpected success"); }
catch (error) { text({error: error.message}); }
`,
				},
				undefined,
			);
			const output = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			assert.ok(!result.isError, output);
			assert.ok(output.includes('"objectDeclaration":true'), output);
			assert.ok(
				output.includes('"title":"Shared goal","decisions":0,"done":0,"revision":2,"status":"in_progress"'),
				output,
			);
			if (coordinator) assert.ok(output.includes('"member":"member"'), output);
			assert.match(output, /Claim conflict/);
			assert.doesNotMatch(output, /unexpected success/);
			assert.deepEqual(calls, [
				["get", {}],
				["brief", {}],
				["brief", { markdown: "# Goal\nUpdated", expectedRevision: 1 }],
				["tasks", {}],
				["task", { id: "t1", status: "in_progress" }],
				...(coordinator ? [["status", {}]] : []),
				["claim", { id: "t1" }],
			]);
			assert.equal(f.faux.state.callCount, 0, "scripts do not invoke the native model loop");
		});
	}
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
			timeout: 30_000,
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
				assert.equal(!!declared, !ask && role !== undefined);
				assert.equal(adapter.session.getCallableToolNames().includes(MISSION_TOOL), role !== undefined);
				const schema = native.parameters as {
					properties: {
						action: { enum: string[] };
						message?: unknown;
						model?: unknown;
						thinking?: unknown;
					};
				};
				for (const action of ["delete", "group", "start", "send", "status", "bindPr", "unbindPr"]) {
					assert.equal(schema.properties.action.enum.includes(action), coordinator);
					assert.equal(native.description.includes(`- ${action} (`), coordinator);
				}
				assert.equal(!!schema.properties.message, coordinator);
				assert.equal("order" in schema.properties, coordinator);
				assert.equal(!!schema.properties.model, coordinator);
				assert.equal(!!schema.properties.thinking, coordinator);
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
					for (const action of ["delete", "group", "start", "send", "status", "bindPr", "unbindPr"])
						assert.equal(description.includes(`"${action}"`), coordinator, description);
				} else assert.doesNotMatch(description, /- start \(coordinator only\)/);
				let requestChecked = false;
				let requestFailure: unknown;
				f.faux.setResponses([
					async (context) => {
						try {
							const tool = getCurrentTools(context.messages).find((tool) => tool.name === MISSION_TOOL);
							assert.equal(!!tool, !ask && role !== undefined);
							if (ask)
								assert.deepEqual(
									getCurrentTools(context.messages).map((tool) => tool.name),
									["codemode"],
								);
							if (tool) assert.deepEqual(tool.parameters, native.parameters);
							const prompt = getCurrentSystemPrompt(context.messages);
							assert.equal(prompt.includes("You coordinate this mission"), coordinator);
							assert.equal(
								prompt.includes(
									"coordinator actions (delete, group, task order, start, send, status, bindPr, unbindPr)",
								),
								coordinator,
							);
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
test("members and coordinators declare and forward release selectors", async () => {
	for (const coordinator of [false, true]) {
		const calls: unknown[] = [];
		const tool = createMissionTool(async (action, args) => {
			calls.push([action, args]);
			return { released: [], skipped: [] };
		}, coordinator);
		assert.match(tool.description, /- release:/);
		for (const args of [{ id: "1-3" }, { ids: ["#1", 2, "task-id"] }]) {
			await tool.execute("call", { action: "release", ...args } as never, undefined, undefined, {} as never);
			assert.deepEqual(calls.at(-1), ["release", args]);
		}
	}
});
