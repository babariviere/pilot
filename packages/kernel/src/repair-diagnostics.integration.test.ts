import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { DiagnosticEvidenceSubject } from "@pilot/protocol";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

test("repair Build registers only granted diagnostic readers across native reloads", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-repair-diagnostics-"));
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
		assert.equal(options.diagnostics, false, "repair retains ordinary Build tools and resources");
		native = await open.call(NativeAdapter, {
			...options,
			agentDir: root,
			projectTrusted: false,
			bundledExtensions: false,
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
	const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
	const chat: DiagnosticEvidenceSubject = { kind: "chat", host, sessionId: "target", chatUrl: "pilot://chat/target" };
	const calls: unknown[] = [];
	for (const [index, subject] of [chat, { kind: "app", host }, undefined].entries()) {
		session = await KernelSession.open(
			{
				sessionId: `repair-${index}`,
				storageDir: join(root, `durable-${index}`),
				cwd,
				repairDiagnostics: subject as DiagnosticEvidenceSubject | undefined,
			},
			{
				onWorking: () => {},
				callDiagnostics: async (...args) => {
					calls.push(args);
					return {} as never;
				},
				callDiagnosticLogs: async () => ({}) as never,
				callDiagnosticHistory: async () => ({}) as never,
				callDiagnosticContext: async () => assert.fail("repair must not gain app-wide discovery"),
				callRepairProposal: async () => assert.fail("repair must not publish proposals"),
			},
		);
		for (const reload of [false, true]) {
			if (reload) {
				await native.session.reload();
				native.refreshTools();
			}
			const names = native.session.getAllTools().map((tool) => tool.name);
			assert.ok(names.includes("history_recall"), "ordinary own-history tools remain available");
			assert.equal(names.includes("diagnostics"), !!subject);
			assert.equal(names.includes("diagnostic_logs"), !!subject);
			assert.equal(names.includes("diagnostic_history"), subject?.kind === "chat");
			assert.equal(names.includes("diagnostic_context"), false);
			assert.equal(names.includes("repair_proposal"), false);
			if (subject) {
				const tool = native.session.getToolDefinition("diagnostics")!;
				await tool.execute(`read-${index}-${reload}`, {}, undefined, undefined, {} as never);
			}
		}
		await session.close();
		session = undefined;
	}
	assert.deepEqual(calls, [
		["target", undefined],
		["target", undefined],
		[undefined, undefined],
		[undefined, undefined],
	]);
});
