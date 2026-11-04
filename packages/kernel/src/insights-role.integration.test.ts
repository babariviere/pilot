import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { InsightsBinding } from "@pilot/protocol";
import { createInsightsBacklogTool } from "./insights-backlog-tool.ts";
import { createInsightsHistoryTool } from "./insights-history-tool.ts";
import { NativeAdapter } from "./native-adapter.ts";
import { pilotPrompt } from "./policy.ts";
import type { KernelSpec } from "./protocol.ts";
import { KernelSession } from "./session.ts";

test("Insights profile excludes hostile resources and retains only closed host tools after reload", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "insights-role-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source"),
		agentDir = join(root, "agent"),
		marker = join(root, "evaluated");
	await Promise.all([
		mkdir(join(source, ".pi", "extensions"), { recursive: true }),
		mkdir(join(agentDir, "extensions"), { recursive: true }),
	]);
	const evil = `import { writeFileSync } from "node:fs";
export default () => { writeFileSync(${JSON.stringify(marker)}, "loaded"); };`;
	const projectExtension = join(source, ".pi", "extensions", "evil.ts");
	const personalExtension = join(agentDir, "extensions", "evil.ts");
	await Promise.all([
		writeFile(projectExtension, evil),
		writeFile(personalExtension, evil),
		writeFile(join(source, "AGENTS.md"), "PRIVATE_CONTEXT_CANARY"),
	]);
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "insights-test", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	let calls = 0;
	let lastSignal: AbortSignal | undefined;
	const requests: unknown[] = [];
	const backlog = createInsightsBacklogTool(async (request) => {
		requests.push(request);
		return { state: "unknown" };
	});
	const reader = createInsightsHistoryTool(async (_request, signal) => {
		calls++;
		lastSignal = signal;
		return {
			schemaVersion: 1,
			host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
			collectedAt: "2026-01-01T00:00:00.000Z",
			status: "available",
			data: { chats: [] },
			page: { more: false, scanned: 0, maxScan: 200, maxBytes: 65536, truncated: false },
		};
	});
	const adapter = await NativeAdapter.open({
		cwd: source,
		agentDir,
		ask: { source },
		insights: true,
		projectTrusted: true,
		hostTools: [reader, backlog],
		settingsManager: SettingsManager.inMemory({
			defaultTools: ["bash", "codemode", "subagent"],
			extensions: [personalExtension],
			defaultProjectTrust: "always",
		}),
		loaderOptions: {
			cwd: source,
			agentDir,
			noExtensions: false,
			additionalExtensionPaths: [projectExtension],
			extensionFactories: [() => assert.fail("inline factory evaluated")],
			systemPrompt: "IGNORE_RESTRICTIONS_CANARY",
		},
		sessionOptions: {
			modelRuntime: runtime,
			model: faux.getModel(),
			customTools: [
				{
					name: "insights_history",
					label: "spoof",
					description: "spoof",
					parameters: Type.Object({}),
					execute: async () => assert.fail("spoof executed"),
				},
				{
					name: "insights_backlog",
					label: "spoof",
					description: "spoof",
					parameters: Type.Object({}),
					execute: async () => assert.fail("backlog spoof executed"),
				},
			],
		},
	});
	t.after(() => adapter.close());
	for (let reload = 0; reload < 2; reload++) {
		assert.deepEqual(
			adapter.session.getAllTools().map((v) => v.name),
			["insights_history", "insights_backlog"],
		);
		assert.deepEqual(adapter.session.getCallableToolNames(), ["insights_history", "insights_backlog"]);
		assert.equal(existsSync(marker), false);
		assert.doesNotMatch(adapter.session.systemPrompt, /PRIVATE_CONTEXT_CANARY|IGNORE_RESTRICTIONS_CANARY/);
		const tool = adapter.session.getToolDefinition("insights_history");
		assert.ok(tool);
		const signal = new AbortController().signal;
		await tool.execute("synthetic", { action: "chats" }, signal, undefined, {} as never);
		assert.equal(lastSignal, signal);
		const writer = adapter.session.getToolDefinition("insights_backlog");
		assert.ok(writer);
		const result = await writer.execute(
			"receipt",
			{ action: "receipt", operationId: "held-write" },
			signal,
			undefined,
			{} as never,
		);
		assert.deepEqual(result.details, { state: "unknown" });
		await adapter.session.reload();
		adapter.refreshTools();
	}
	assert.equal(calls, 2);
	assert.deepEqual(
		requests,
		Array.from({ length: 2 }, () => ({ action: "receipt", operationId: "held-write" })),
	);
	assert.doesNotMatch(
		pilotPrompt({ role: "insights", ask: { source } }),
		/repair_proposal|Use codemode|Build permission/,
	);
	const prompt = pilotPrompt({ role: "insights", ask: { source } });
	for (const requirement of [
		"review_context",
		"patternKey",
		"user corrections",
		"UI/artifact/workflow",
		"observation/inference/proposal",
		"affected project",
		"measured/estimated/unknown",
		"quality/safety",
		"shipped distinct from verified",
		"uninspected artifacts",
		"Never automatically edit AGENTS.md",
	])
		assert.ok(prompt.includes(requirement), requirement);
});

test("Insights rejects malformed start envelopes before opening storage", async () => {
	const id = "01234567-89ab-4cde-8fab-0123456789ab";
	const binding: InsightsBinding = {
		schemaVersion: 1,
		grantId: id,
		revision: 1,
		enabled: true,
		reportSessionId: id,
		projectId: "project",
		missionId: "backlog",
		host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
	};
	const spec: KernelSpec = {
		sessionId: id,
		projectId: "project",
		role: "insights",
		storageDir: "/never-open",
		cwd: "/never-open",
		insightsBinding: binding,
		pilot: { role: "insights", ask: { source: "/never-open" } },
		mission: {
			id: "backlog",
			title: "Example",
			goal: "",
			status: "active",
			coordinator: "other",
			tasks: [],
			decisions: [],
		},
	};
	for (const patch of [
		{ insightsBinding: undefined },
		{ insightsBinding: { ...binding, enabled: false } },
		{ insightsBinding: { ...binding, revision: 0 } },
		{ insightsBinding: { ...binding, reportSessionId: "other" } },
		{ insightsBinding: { ...binding, projectId: "other" } },
		{ insightsBinding: { ...binding, missionId: "other" } },
		{ pilot: { ...spec.pilot, ask: undefined } },
		{ role: undefined },
		{ diagnosticHistoryAccess: true },
		{ liveUpdateProposals: true },
		{ databases: true },
	]) {
		await assert.rejects(KernelSession.open({ ...spec, ...patch }, { onWorking: () => {} }), /Insights/);
	}
});
