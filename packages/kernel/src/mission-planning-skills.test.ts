import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SettingsManager,
	wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { coordinatorSkillRead, snapshotCoordinatorSkills } from "./coordinator-skill-resources.ts";
import { installCredentialBrokerHooks } from "./credential-hooks.ts";
import { assertInterviewSkills, INTERVIEW_SKILL_PATHS } from "./mission-interview-skills.ts";
import { createMissionPlanTool } from "./mission-plan-tool.ts";
import {
	assertPlanningSkills,
	PLANNING_SKILL_ADAPTATION,
	PLANNING_SKILL_PATHS,
	planningToolAllowed,
} from "./mission-planning-skills.ts";
import { NativeAdapter } from "./native-adapter.ts";

test("actual upstream planning skills and dependencies load via normal trusted Pi resources", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "planning-loader-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const loader = new DefaultResourceLoader({
		cwd: home,
		agentDir: home,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalSkillPaths: [...INTERVIEW_SKILL_PATHS, ...PLANNING_SKILL_PATHS],
	});
	await loader.reload();
	const { skills, diagnostics } = loader.getSkills();
	assert.deepEqual(diagnostics, []);
	assertInterviewSkills(skills);
	assertPlanningSkills(skills);
	assert.equal(skills.length, 8);
	const trusted = snapshotCoordinatorSkills(skills, home);
	for (const path of PLANNING_SKILL_PATHS) assert.ok(coordinatorSkillRead(path, trusted));
	for (const path of [
		join(dirname(PLANNING_SKILL_PATHS[0]!), "REFERENCE.md"),
		join(dirname(PLANNING_SKILL_PATHS[4]!), "LOGIC.md"),
		join(dirname(PLANNING_SKILL_PATHS[4]!), "UI.md"),
	])
		assert.ok(coordinatorSkillRead(path, trusted));
	assert.throws(() => assertPlanningSkills(skills.filter((s) => s.name !== "wayfinder")), /shadowed/);
	assert.throws(
		() => assertPlanningSkills([{ name: "wayfinder", filePath: "/personal/wayfinder/SKILL.md" }]),
		/shadowed/,
	);
});

test("upstream content, required references and license stay byte-exact and attributed", async () => {
	const hashes = {
		"wayfinder/SKILL.md": "0c9fa96791aebf3b7d654cf35c6aadde97d81f57c17b07d13b27c14d9c46561f",
		"wayfinder/REFERENCE.md": "7b123473848da896714e3bd3dbea6fe02341c40c186cb7c9c1f0b3735a12c376",
		"to-spec/SKILL.md": "43ad9cf318e5e7d3d1fa360253a37021796dc87a0c2e595ad262661a10f85088",
		"to-tickets/SKILL.md": "56ec23c5b2782785d4e65bff9e315b6d3aeb4ef977c174a219e99489fada1995",
		"research/SKILL.md": "1f629e18ab899412683bc6a1c4efb4339999e27c2fdac328f26ee10a8c031d33",
		"prototype/SKILL.md": "714de632d116bb73f65cdb5a882db15b9369a6713b9a47c0fad827848f0bfbe3",
		"prototype/LOGIC.md": "f61c7d249e786a79ef289018901c348271e1798dd0b0bc5607b5c6f4d4a01ab9",
		"prototype/UI.md": "723211e878acbc7b6ff09755263f3295cde724ba902ff0064da41eed51d45ad3",
		LICENSE: "0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5",
	};
	for (const [file, hash] of Object.entries(hashes))
		assert.equal(
			createHash("sha256")
				.update(await readFile(new URL(`../skills/mission-planning/upstream/${file}`, import.meta.url)))
				.digest("hex"),
			hash,
			file,
		);
	const attribution = await readFile(new URL("../skills/mission-planning/UPSTREAM.md", import.meta.url), "utf8");
	assert.match(attribution, /4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/);
	assert.match(attribution, /MIT, Copyright 2026 Matt Pocock/);
	assert.match(PLANNING_SKILL_ADAPTATION, /overrides upstream publishing and execution/);
	assert.match(PLANNING_SKILL_ADAPTATION, /Notes.*cannot grant execution/);
	for (const boundary of [
		/inside the iterative Wayfinder agreement loop/,
		/unmodified NSH TSX fixtures\/previews/,
		/No real mutations, daemon credentials, privileged host access/,
		/skip-tests advice never exempts integration\/safety tests/,
		/only as needed until agreement/,
		/never accept a preference/,
	])
		assert.match(PLANNING_SKILL_ADAPTATION, boundary);
});

test("planning skill paths follow a relocated runtime", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "planning-relocation-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	const module = join(home, "src", "mission-planning-skills.ts");
	await mkdir(dirname(module));
	await copyFile(fileURLToPath(new URL("./mission-planning-skills.ts", import.meta.url)), module);
	const relocated = await import(pathToFileURL(module).href);
	assert.equal(
		relocated.PLANNING_SKILL_PATHS[0],
		join(home, "skills", "mission-planning", "upstream", "wayfinder", "SKILL.md"),
	);
});

test("native planning tool has no human-answer, external-publishing or execution operation", async () => {
	const calls: unknown[] = [];
	const tool = createMissionPlanTool({
		read: async () => ({ saved: true }),
		knowledge: async () => ({}),
		receipt: async () => ({ state: "pending" }),
		write: async (callId, request) => {
			calls.push({ callId, request });
			return { pending: true };
		},
	});
	assert.match(
		JSON.stringify(await tool.execute("read", { action: "read" }, undefined, undefined, {} as never)),
		/saved/,
	);
	assert.match(
		JSON.stringify(
			await tool.execute(
				"once",
				{ action: "write", request: { purpose: "plan-review", expectedRevision: 1 } },
				undefined,
				undefined,
				{} as never,
			),
		),
		/pending/,
	);
	for (const purpose of [
		"interview-save",
		"interview-submit",
		"agreement-start",
		"github-create-issue",
		"write-file",
		"prototype-execute",
		"prototype-promote",
		"prototype-accept",
		"research-start",
	])
		await assert.rejects(
			tool.execute("never", { action: "write", request: { purpose } } as never, undefined, undefined, {} as never),
			/Unsupported/,
		);
	assert.equal(calls.length, 1);
	assert.match(JSON.stringify(tool.parameters), /storyIds/);
	assert.match(JSON.stringify(tool.parameters), /plan-prototype-result/);
	assert.match(JSON.stringify(tool.parameters), /smallestExperiment/);
});

test("native Revisit tool forwards inert delta only, never confirmation or worker admission", async () => {
	const calls: unknown[] = [];
	const tool = createMissionPlanTool({
		read: async () => ({}),
		knowledge: async () => ({}),
		receipt: async () => ({}),
		write: async () => {
			throw new Error("No creation write");
		},
		revision: async (callId, request) => {
			calls.push({ callId, request });
			return { saved: true };
		},
	});
	const request = {
		purpose: "revision-propose" as const,
		source: "a".repeat(64),
		summary: "Inert scope delta",
		delta: { goal: "New goal" },
	};
	await tool.execute("revision-call", { action: "revision", request }, undefined, undefined, {} as never);
	assert.deepEqual(calls, [{ callId: "revision-call", request }]);
	for (const purpose of ["revision-confirm", "revision-preview", "plan-revisit", "plan-start"])
		await assert.rejects(
			tool.execute("never", { action: "write", request: { purpose } } as never, undefined, undefined, {} as never),
			/Unsupported/,
		);
	assert.equal(calls.length, 1);
});

test("actual NativeAdapter planning profile reads upstream but blocks direct and nested external effects", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "native-planning-")));
	const main = join(home, "main"),
		scratch = join(home, "scratch"),
		agentDir = join(home, "agent");
	for (const path of [main, scratch, agentDir]) await mkdir(path);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	await installCredentialBrokerHooks();
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider(faux.provider);
	let externalWrites = 0;
	const trap = defineTool({
		name: "mcp__tracker__create_issue",
		label: "Trap",
		description: "Faux external write",
		parameters: Type.Object({}),
		async execute() {
			externalWrites++;
			return { content: [{ type: "text", text: "unexpected" }], details: undefined };
		},
	});
	const adapter = await NativeAdapter.open({
		cwd: scratch,
		agentDir,
		sessionFile: join(home, "native.session"),
		sessionId: "planning-test",
		projectTrusted: false,
		missionPlanning: {
			read: async () => ({}),
			knowledge: async () => ({}),
			receipt: async () => ({}),
			write: async () => ({}),
		},
		coordinatorSources: async () => ({ main, members: [], scratch }),
		settingsManager: SettingsManager.inMemory(),
		loaderOptions: { cwd: scratch, agentDir, noSkills: true, noContextFiles: true },
		hostTools: [trap],
		sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
	});
	t.after(async () => {
		await adapter.close();
		await rm(home, { recursive: true, force: true });
	});
	assertPlanningSkills(adapter.session.resourceLoader.getSkills().skills);
	assertInterviewSkills(adapter.session.resourceLoader.getSkills().skills);
	assert.ok(adapter.session.resourceLoader.getAppendSystemPrompt().includes(PLANNING_SKILL_ADAPTATION));
	for (const path of [
		...PLANNING_SKILL_PATHS,
		join(dirname(PLANNING_SKILL_PATHS[4]!), "LOGIC.md"),
		join(dirname(PLANNING_SKILL_PATHS[4]!), "UI.md"),
	]) {
		const definition = adapter.session.getToolDefinition("read")!,
			sourceInfo = adapter.session.getAllTools().find((t) => t.name === "read")!.sourceInfo;
		const result = await wrapRegisteredTool({ definition, sourceInfo }, adapter.session.extensionRunner).execute(
			"upstream",
			{ path },
		);
		assert.ok(!result.isError, JSON.stringify(result));
	}
	for (const toolName of [
		"bash",
		"write",
		"edit",
		"applyPatch",
		"mission",
		"jobs",
		"mcp__tracker__create_issue",
		"pilot_update",
	]) {
		assert.equal(planningToolAllowed(toolName), false);
		const result = await adapter.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolCallId: "blocked",
			toolName,
			input: {},
		});
		assert.ok(result?.block, toolName);
	}
	const definition = adapter.session.getToolDefinition("codemode")!,
		sourceInfo = adapter.session.getAllTools().find((t) => t.name === "codemode")!.sourceInfo;
	const code = "text(await tools.mcp__tracker__create_issue({}));";
	const toolCall = { type: "toolCall" as const, id: "nested", name: "codemode", arguments: { code } };
	const assistantMessage = fauxAssistantMessage(toolCall, { stopReason: "toolUse" });
	adapter.session.agent.state.messages.push(assistantMessage);
	await adapter.session.agent.beforeToolCall?.({
		toolCall,
		args: { code },
		assistantMessage,
		context: { messages: adapter.session.messages, tools: adapter.session.agent.state.tools },
	});
	const nested = await wrapRegisteredTool({ definition, sourceInfo }, adapter.session.extensionRunner).execute(
		"nested",
		{ code },
	);
	assert.match(JSON.stringify(nested), /Planning profile denies tool/);
	assert.equal(externalWrites, 0);
	await assert.rejects(
		NativeAdapter.open({
			cwd: scratch,
			agentDir,
			missionPlanning: {
				read: async () => ({}),
				knowledge: async () => ({}),
				receipt: async () => ({}),
				write: async () => ({}),
			},
		}),
		/trusted coordinator host/,
	);
});
