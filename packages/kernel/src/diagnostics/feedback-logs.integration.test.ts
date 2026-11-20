import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { NativeAdapter, type NativeAdapterOptions } from "../native-adapter.ts";
import { KernelSession } from "../session.ts";
import { fakeHostCall } from "../testing/host-calls.ts";

test("feedback Ask registers only restricted protected logs across native reloads", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-feedback-logs-"));
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
	const calls: unknown[] = [];
	for (const feedbackLogs of [true, false]) {
		session = await KernelSession.open(
			{
				sessionId: `feedback-${feedbackLogs}`,
				storageDir: join(root, `durable-${feedbackLogs}`),
				cwd,
				pilot: { ask: { source: cwd } },
				feedbackLogs,
			},
			{
				onWorking: () => {},
				call: fakeHostCall({
					"diagnostics.logs": async ({ request }) => {
						calls.push(request);
						return {} as never;
					},
					"diagnostics.history": async () => assert.fail("feedback has no transcript grant"),
					"diagnostics.context": async () => assert.fail("feedback has no app-wide discovery"),
				}),
			},
		);
		for (const reload of [false, true]) {
			if (reload) {
				await native.session.reload();
				native.refreshTools();
			}
			const names = native.session.getAllTools().map((t) => t.name);
			assert.equal(names.includes("diagnostic_logs"), feedbackLogs);
			for (const denied of [
				"diagnostic_context",
				"diagnostic_history",
				"diagnostics",
				"repair_proposal",
				"bash",
				"write",
				"edit",
			])
				assert(!names.includes(denied), denied);
			if (feedbackLogs) {
				const tool = native.session.getToolDefinition("diagnostic_logs")!;
				const schema = JSON.stringify(tool.parameters);
				assert(schema.includes("lifecycle"));
				assert(!schema.includes('"daemon"'));
				await tool.execute(
					`origin-${reload}`,
					{ action: "inventory", sessionId: "origin" },
					undefined,
					undefined,
					{} as never,
				);
			}
		}
		await session.close();
		session = undefined;
	}
	assert.deepEqual(calls, [
		{ action: "inventory", sessionId: "origin" },
		{ action: "inventory", sessionId: "origin" },
	]);
});
