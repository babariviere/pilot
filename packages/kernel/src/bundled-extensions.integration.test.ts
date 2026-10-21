import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PILOT_CHILD_PROFILE_PATH } from "@babariviere/pi-extensions/profile";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { getPackageDir, ModelRuntime, SettingsManager, wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { UsageObservation } from "@pilot/protocol";
import { ANTHROPIC_AUTH_PATH, CHILD_PROFILE_PATH, installBundledAnthropicAuth } from "./bundled-extensions.ts";
import { credentialEnvironment } from "./credential-client.ts";
import { NativeAdapter } from "./native-adapter.ts";
import { startTodoBridge } from "./todo-bridge.ts";
import { createTodoTool } from "./todo-tool.ts";
import { applyTodo, type TodoRecord } from "./todos.ts";

type ChildPacket = {
	type: string;
	id?: string;
	error?: string;
	result?: { ok: boolean; error?: string; answer?: { text: string } };
};

async function obsoleteAuth(root: string): Promise<string> {
	const pkg = join(root, "obsolete-auth");
	await mkdir(join(pkg, "src"), { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ name: "@gotgenes/pi-anthropic-auth", version: "0.0.0", pi: { extensions: ["src/index.ts"] } }),
	);
	const path = join(pkg, "src", "index.ts");
	await writeFile(
		path,
		`throw new Error('Obsolete auth import must never execute'); export default () => { throw new Error('Obsolete auth factory must never execute'); };`,
	);
	return path;
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-bundled-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const previous = process.env.PI_CODING_AGENT_DIR;
	const adapters: NativeAdapter[] = [];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		for (const adapter of adapters.reverse()) await adapter.close();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});
	t.mock.method(globalThis, "fetch", () => assert.fail("Bundled integration tests must stay offline"));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "pilot-bundled", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	const open = async () => {
		const adapter = await NativeAdapter.open({
			cwd: root,
			agentDir,
			sessionFile: join(root, "parent.jsonl"),
			sessionId: "bundled-test",
			hostTools: [
				createTodoTool(
					async () => [],
					() => "bundled-test",
				),
			],
			projectTrusted: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
			sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
		});
		adapters.push(adapter);
		return adapter;
	};
	return { root, agentDir, runtime, faux, open, adapters };
}

test("clean configuration has all bundled tools and required auth across reload", async (t) => {
	const f = await fixture(t);
	const adapter = await f.open();
	for (const name of ["applyPatch", "web", "browser", "todo", "jobs", "subagent"])
		assert.ok(adapter.session.getCallableToolNames().includes(name), name);
	assert.deepEqual(
		adapter.extension.tools?.map((tool) => tool.name),
		["codemode"],
	);
	const commands = adapter.session.extensionRunner.getRegisteredCommands();
	assert.ok(commands.some((command) => command.name === "anthropic-auth:status"));
	assert.equal(typeof f.runtime.getRegisteredProviderConfig("anthropic")?.streamSimple, "function");
	assert.deepEqual(await adapter.jobs(), []);
	await adapter.session.reload();
	for (const name of ["jobs", "subagent", "todo", "web"])
		assert.ok(adapter.session.getCallableToolNames().includes(name));
	assert.equal(typeof f.runtime.getRegisteredProviderConfig("anthropic")?.streamSimple, "function");
});

test("personal profile and auth copies never evaluate, while unrelated extensions still load", async (t) => {
	const f = await fixture(t);
	const marker = join(f.root, "duplicate-ran");
	const pkg = join(f.root, "personal-package");
	await mkdir(join(pkg, "extensions", "jobs"), { recursive: true });
	await mkdir(join(f.agentDir, "extensions"));
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ name: "@babariviere/pi-extensions", pi: { extensions: ["extensions/*/index.ts"] } }),
	);
	await mkdir(join(pkg, "extensions", "todos"), { recursive: true });
	await writeFile(
		join(pkg, "extensions", "todos", "index.ts"),
		"throw new Error('File-backed todos must not import'); export default () => {};",
	);
	const duplicate = join(pkg, "extensions", "jobs", "index.ts");
	await writeFile(
		duplicate,
		`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'duplicate'); export default () => {};`,
	);
	await symlink(duplicate, join(f.agentDir, "extensions", "renamed.ts"));
	await symlink(ANTHROPIC_AUTH_PATH, join(f.agentDir, "extensions", "personal-auth.ts"));
	await writeFile(
		join(f.agentDir, "extensions", "extra.ts"),
		`export default pi => pi.registerCommand('extra', {description:'kept', handler: async () => {}});`,
	);
	await writeFile(
		join(f.agentDir, "settings.json"),
		JSON.stringify({ packages: [pkg], extensions: [await obsoleteAuth(f.root)] }),
	);
	const adapter = await NativeAdapter.open({
		cwd: f.root,
		agentDir: f.agentDir,
		sessionFile: join(f.root, "parent.jsonl"),
		projectTrusted: false,
		sessionOptions: { modelRuntime: f.runtime, model: f.faux.getModel() },
	});
	f.adapters.push(adapter);
	for (let pass = 0; pass < 2; pass++) {
		await assert.rejects(readFile(marker), { code: "ENOENT" });
		const commands = adapter.session.extensionRunner.getRegisteredCommands();
		assert.equal(commands.filter((command) => command.name === "anthropic-auth:status").length, 1);
		assert.ok(commands.some((command) => command.name === "extra"));
		assert.ok(adapter.session.getCallableToolNames().includes("jobs"));
		if (!pass) await adapter.session.reload();
	}
});

for (const nested of [false, true])
	test(`bundled jobs execute and close through ${nested ? "codemode" : "direct"} calls`, async (t) => {
		const f = await fixture(t);
		const adapter = await f.open();
		const execute = async (name: string, args: JsonObject) => {
			adapter.session.agent.state.messages.push(
				fauxAssistantMessage(
					{ type: "toolCall", id: "bundled-job", name, arguments: args },
					{ stopReason: "toolUse" },
				),
			);
			const definition = adapter.session.getToolDefinition(name)!;
			const sourceInfo = adapter.session.getAllTools().find((tool) => tool.name === name)!.sourceInfo;
			return wrapRegisteredTool({ definition, sourceInfo }, adapter.session.extensionRunner).execute(
				"bundled-job",
				args,
			);
		};
		const result = nested
			? await execute("codemode", {
					code: 'text(await tools.jobs({action:"start", name:"test", command:"printf bundled-job-ok"}));',
				})
			: await execute("jobs", { action: "start", name: "test", command: "printf bundled-job-ok" });
		assert.ok(!result.isError, JSON.stringify(result));
		const list = (await execute("jobs", { action: "list" })).structuredContent as Array<{ id: string }>;
		assert.equal(list.length, 1);
		const done = await execute("jobs", { action: "wait", id: list[0]!.id, waitMs: 5000 });
		assert.equal((done.structuredContent as { state: string }).state, "done");
		await adapter.close();
	});

test("real Build subagent inherits PR delivery, required auth and safeguards without recursive orchestration", {
	timeout: 30_000,
}, async (t) => {
	const f = await fixture(t);
	const marker = join(f.root, "child-profile.json");
	const publication = join(f.root, "child-publication");
	const todos: TodoRecord[] = [];
	const policy = join(f.root, "subscription-policy.json");
	const savePolicy = (blocked: boolean) =>
		writeFile(
			policy,
			JSON.stringify({
				version: 1,
				windows: blocked ? [{ provider: "openai", label: "Usage limit", usedPercent: 100 }] : [],
				forced: [],
			}),
		);
	await savePolicy(false);
	let reported!: () => void;
	const limitReported = new Promise<void>((resolve) => {
		reported = resolve;
	});
	const accountingEpoch = { generation: randomUUID(), captureFloor: 0, retentionFloor: 0 };
	const parent = { sourceId: randomUUID(), operationId: "tool:7" };
	const usage = new Map<string, UsageObservation>();
	let usageComplete!: () => void;
	const usageCaptured = new Promise<void>((resolve) => {
		usageComplete = resolve;
	});
	const bridge = await startTodoBridge(
		async (args, actor) => applyTodo(todos, args, actor),
		async (limit) => {
			assert.equal(limit.provider, "openai");
			assert.equal(todos.length, 1, "the child's preceding tool completed before its usage pause");
			await savePolicy(true);
			reported();
		},
		async (row) => {
			usage.set(row.operationId, row);
			if ([...usage.values()].filter((row) => row.kind === "request").length === 4) usageComplete();
			return "stored";
		},
		async () => accountingEpoch,
	);
	t.after(() => bridge.close());
	const installed = fileURLToPath(
		new URL("../extensions/subagents/worker-bootstrap.mjs", `file://${PILOT_CHILD_PROFILE_PATH}`),
	);
	const fixturePath = join(f.agentDir, "offline-provider.ts");
	await writeFile(
		fixturePath,
		`
import { appendFileSync, writeFileSync } from 'node:fs';
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
import { Type } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default pi => {
	pi.registerTool({ name: "bash", label: "bash", description: "Offline publication stub", parameters: Type.Object({command: Type.String()}), execute: async (_id, {command}) => { appendFileSync(${JSON.stringify(publication)}, command + "\\n"); return {content:[{type:"text",text:"stub"}],details:undefined}; } });
 const faux = fauxProvider({provider:'openai-codex',models:[{id:'offline'}]});
 faux.setResponses([
  fauxAssistantMessage({type:'toolCall',id:'child-todo',name:'codemode',arguments:{code:'for (const parts of [["jj","git","push","--bookmark","fix/child"],["gh","pr","create"],["gh","pr","merge","1"],["gh","repo","delete","fixture/repo","--yes"]]) { try { await tools.bash({command:parts.join(" ")}); } catch {} } const item = await tools.todo({action:"create",title:"From real child"}); await tools.todo({action:"claim",id:item.id}); return item;'}}, {stopReason:'toolUse'}),
  fauxAssistantMessage("", {stopReason:'error',errorMessage:'usage_limit_reached'}),
  fauxAssistantMessage("CHILD_PROFILE_OK"), fauxAssistantMessage("CHILD_FOLLOWUP_OK")
 ]);
 pi.registerProvider(faux.provider);
 pi.on('session_start', (_event, ctx) => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({tools: pi.getAllTools().map(t => t.name), auth: typeof ctx.modelRegistry.getRegisteredProviderConfig('anthropic')?.streamSimple})));
};`,
	);
	await writeFile(
		join(f.agentDir, "settings.json"),
		JSON.stringify({
			extensions: [fixturePath, await obsoleteAuth(f.root)],
			defaultProvider: "openai-codex",
			defaultModel: "offline",
			defaultTools: ["+codemode"],
			codemode: { mode: "only" },
		}),
	);
	const child = spawn(process.execPath, [installed], {
		cwd: f.root,
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		env: {
			...process.env,
			...credentialEnvironment(undefined),
			NODE_OPTIONS: undefined,
			PILOT_CONNECTIVITY_POLICY: undefined,
			PI_OFFLINE: "1",
			PI_CODE_MODE_SUBAGENT: "1",
			PI_SUBAGENT_HOST_PACKAGE_DIR: getPackageDir(),
			PILOT_PI_EXTENSIONS_PROFILE: CHILD_PROFILE_PATH,
			PILOT_ANTHROPIC_AUTH_EXTENSION: ANTHROPIC_AUTH_PATH,
			PILOT_SUBSCRIPTION_POLICY: policy,
			PILOT_USAGE_HISTORY: JSON.stringify({ ...accountingEpoch, attribution: { chatId: randomUUID() } }),
			PILOT_USAGE_STORAGE: join(f.root, "child-storage"),
			PILOT_USAGE_PARENT: JSON.stringify(parent),
			PILOT_CONTROL_PERMISSION: JSON.stringify({ authorizationId: "child-grant", level: "implement" }),
		},
	});
	const closed = once(child, "exit");
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await closed;
	});
	let stderr = "";
	child.stderr!.on("data", (chunk) => {
		stderr = (stderr + String(chunk)).slice(-8192);
	});
	const packets: Array<ChildPacket> = [];
	const listeners = new Set<() => void>();
	child.on("message", (message) => {
		packets.push(message as ChildPacket);
		for (const listener of listeners) listener();
	});
	const packet = (type: string, id?: string) =>
		new Promise<ChildPacket>((resolve, reject) => {
			const timeout = setTimeout(() => {
				listeners.delete(check);
				reject(new Error(`Missing child ${type}: ${stderr}`));
			}, 20_000);
			const check = () => {
				const error = packets.find((packet) => packet.type === "error");
				const found = packets.find((packet) => packet.type === type && (id === undefined || packet.id === id));
				if (!error && !found) return;
				clearTimeout(timeout);
				listeners.delete(check);
				if (error) reject(new Error(error.error ?? "Child failed"));
				else resolve(found!);
			};
			listeners.add(check);
			check();
		});
	child.send({
		type: "start",
		spec: {
			name: "offline-child",
			directory: join(f.root, "child-storage"),
			request: {
				agent: { config: { name: "task" }, systemPrompt: "", sourcePath: "<builtin>", scope: "builtin" },
				task: "Push the task branch and open a PR through the offline stubs. Never merge or delete remote resources.",
				index: 0,
				overrides: { model: "openai-codex/offline" },
			},
			context: {
				cwd: f.root,
				sessionId: "bundled-test",
				sessionFile: join(f.root, "parent.jsonl"),
				runId: "test",
				timeoutMs: 20_000,
				projectTrusted: false,
			},
		},
	});
	await packet("ready");
	const observed = JSON.parse(await readFile(marker, "utf8"));
	assert.equal(observed.auth, "function");
	for (const name of ["web", "browser", "todo", "applyPatch"]) assert.ok(observed.tools.includes(name), name);
	for (const name of ["jobs", "subagent"]) assert.ok(!observed.tools.includes(name), name);
	for (const id of ["first", "second"]) {
		child.send({ type: "input", id, message: "Reply", followUp: false });
		if (id === "first") {
			await limitReported;
			assert.ok(!packets.some((packet) => packet.type === "answer"), "the child remains pending, not failed");
			await savePolicy(false);
		}
		const answer = await packet("answer", id);
		assert.equal(answer.result?.ok, true, answer.result?.error ?? stderr);
		assert.match(answer.result?.answer?.text ?? "", /CHILD_(?:PROFILE|FOLLOWUP)_OK/);
	}
	child.send({ type: "stop", id: "stop" });
	assert.equal(todos.length, 1, "child's tool writes to the parent list, not workspace files");
	assert.equal(todos[0].title, "From real child");
	assert.deepEqual(
		(await readFile(publication, "utf8")).trim().split("\n"),
		["jj git push --bookmark fix/child", "gh pr create"],
		"implement children can push task branches and open PRs, but merge and deletion never execute",
	);
	assert.ok(todos[0].assigned_to_session);
	await packet("stopped", "stop");
	await usageCaptured;
	const requests = [...usage.values()].filter((row) => row.kind === "request");
	assert.equal(requests.length, 4, "the rejected response and its retried invocation have separate identities");
	assert.equal(
		new Set(requests.map((row) => row.sourceId)).size,
		1,
		"the original child source survives tool rounds and follow-ups",
	);
	assert.notEqual(requests[0]!.sourceId, parent.sourceId);
	for (const row of requests) {
		assert.deepEqual(row.parent, parent);
		assert.deepEqual(row.physicalModel, { provider: "openai-codex", model: "offline" });
		assert.ok(row.tokens);
	}
	child.send({ type: "pause" });
	await packet("paused");
	await closed;
});

test("daemon auth installation preserves static Anthropic model definitions and request configuration", async (t) => {
	const f = await fixture(t);
	const modelsPath = join(f.agentDir, "models.json");
	await writeFile(
		modelsPath,
		JSON.stringify({
			providers: {
				anthropic: {
					baseUrl: "https://example.invalid/custom",
					headers: { "x-offline-fixture": "preserved" },
					models: [
						{
							id: "claude-offline",
							name: "Offline fixture",
							api: "anthropic-messages",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 32_000,
							maxTokens: 16,
						},
					],
				},
			},
		}),
	);
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const before = runtime.getModel("anthropic", "claude-offline");
	assert.ok(before);
	const authBefore = await runtime.getAuth(before, { apiKey: "sk-ant-api03-offline-fixture" });
	const configBefore = runtime.getCompatibilityRequestConfig(before);
	await installBundledAnthropicAuth(runtime, f.agentDir);
	assert.deepEqual(runtime.getModel("anthropic", "claude-offline"), before);
	assert.deepEqual(await runtime.getAuth(before, { apiKey: "sk-ant-api03-offline-fixture" }), authBefore);
	assert.equal(before.baseUrl, "https://example.invalid/custom");
	assert.deepEqual(runtime.getCompatibilityRequestConfig(before), configBefore);
	assert.equal(configBefore.headers?.["x-offline-fixture"], "preserved");
});

for (const apiKey of ["sk-ant-api03-offline-fixture", "sk-ant-oat01-offline-fixture"])
	test(`required auth ${apiKey.includes("oat") ? "shapes OAuth" : "preserves API-key"} requests on the real transport`, async (t) => {
		const f = await fixture(t);
		await installBundledAnthropicAuth(f.runtime, f.agentDir);
		const model = f.runtime.getModels("anthropic")[0]!;
		assert.ok(model);
		let body: Record<string, unknown> | undefined;
		const events = [
			{
				type: "message_start",
				message: {
					id: "offline",
					type: "message",
					role: "assistant",
					model: model.id,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
			{ type: "message_stop" },
		];
		const result = await f.runtime.completeSimple(
			{ ...model, baseUrl: "https://example.invalid" },
			{
				systemPrompt:
					"You are an expert coding assistant operating inside pi, a coding agent harness.\n\n<docs>\nPi documentation (read only when the user asks about pi itself, its SDK). REMOVE_THIS_DOC_SECTION\n</docs>\n\n<pilot>\nPRESERVE_PILOT_POLICY\n</pilot>",
				messages: [{ role: "user", content: "Synthetic offline request", timestamp: 1 }],
			},
			{
				apiKey,
				maxRetries: 0,
				maxTokens: 16,
				onPayload: (payload) => ({ ...(payload as object), metadata: { user_id: "caller-hook" } }),
				fetch: async (input, init) => {
					body = (await new Request(input, init).json()) as Record<string, unknown>;
					return new Response(
						events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			},
		);
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(body?.metadata, { user_id: "caller-hook" });
		const payload = JSON.stringify(body);
		assert.match(payload, /PRESERVE_PILOT_POLICY/);
		if (apiKey.includes("oat")) {
			assert.match(payload, /x-anthropic-billing-header/);
			assert.doesNotMatch(payload, /REMOVE_THIS_DOC_SECTION/);
		} else {
			assert.doesNotMatch(payload, /x-anthropic-billing-header/);
			assert.match(payload, /REMOVE_THIS_DOC_SECTION/);
		}
	});
