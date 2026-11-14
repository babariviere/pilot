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
	ModelRuntime,
	SettingsManager,
	wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { coordinatorSkillRead, snapshotCoordinatorSkills } from "./coordinator-skill-resources.ts";
import { installCredentialBrokerHooks } from "./credential-hooks.ts";
import {
	assertInterviewSkills,
	INTERVIEW_SKILL_ADAPTATION,
	INTERVIEW_SKILL_PATHS,
} from "./mission-interview-skills.ts";
import { NativeAdapter } from "./native-adapter.ts";

test("actual pinned upstream skills load through Pi and its coordinator trusted-reader snapshot", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "interview-skills-"));
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
		additionalSkillPaths: INTERVIEW_SKILL_PATHS,
	});
	await loader.reload();
	const { skills, diagnostics } = loader.getSkills();
	assert.deepEqual(diagnostics, []);
	assertInterviewSkills(skills);
	assert.deepEqual(skills.map((s) => s.name).sort(), ["domain-modeling", "grill-with-docs", "grilling"]);
	assert.equal(skills.find((s) => s.name === "grill-with-docs")!.disableModelInvocation, true);
	const trusted = snapshotCoordinatorSkills(skills, home);
	for (const path of INTERVIEW_SKILL_PATHS) assert.ok(coordinatorSkillRead(path, trusted));
	const glossary = join(dirname(INTERVIEW_SKILL_PATHS[2]!), "GLOSSARY-FORMAT.md");
	assert.ok(coordinatorSkillRead(glossary, trusted));
	assert.throws(() => assertInterviewSkills(skills.filter((s) => s.name !== "grilling")), /shadowed/);
	assert.throws(() => assertInterviewSkills([{ name: "grill-with-docs", filePath: "/custom/SKILL.md" }]), /shadowed/);
});

test("upstream sources and dependencies stay byte-exact, attributed and separate from the native adaptation", async () => {
	const hashes = [
		["grill-with-docs/SKILL.md", "7de372c13488f1ee96cc11cd8907b56b6809cc93eef776eeddd37de6b6cbe3fe"],
		["grilling/SKILL.md", "a146842ed93ca43d833550fa9adf02e58cb63c83fea9d4b4522995b82242d4e2"],
		["domain-modeling/SKILL.md", "7b925d7b1e341a2eeae33ad68a8a8c0ab889a38ddd22a7598e4c240e5a7556a3"],
		["domain-modeling/ADR-FORMAT.md", "944c92aa790e8fbdc9199640b170979abb8a34ba8d0fe18c2a01a63bce140ca0"],
		["domain-modeling/GLOSSARY-FORMAT.md", "21dcc40cdec8e151a829b98ab1517c1867bc444e3665134a98c6983411996801"],
		["LICENSE", "0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5"],
	];
	for (const [file, hash] of hashes) {
		const bytes = await readFile(new URL(`../skills/mission-interview/upstream/${file}`, import.meta.url));
		assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, file);
	}
	const source = await readFile(new URL("../skills/mission-interview/UPSTREAM.md", import.meta.url), "utf8");
	assert.match(source, /4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/);
	for (const boundary of [
		"whole frontier",
		"Generate substantive answer options only",
		"The interface provides a built-in free-text field for every question",
		"do not add a “Custom text” or equivalent option",
		"recommendations alone are not",
		"exact complete submitted snapshot",
		"cannot grant",
		"Autosaves and individual answers never resume",
	])
		assert.ok(INTERVIEW_SKILL_ADAPTATION.includes(boundary), boundary);
});

test("skill entry paths follow a relocated runtime, not the original checkout", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "interview-skills-relocated-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	const module = join(home, "src", "mission-interview-skills.ts");
	await mkdir(dirname(module), { recursive: true });
	await copyFile(fileURLToPath(new URL("./mission-interview-skills.ts", import.meta.url)), module);
	const relocated = await import(pathToFileURL(module).href);
	assert.equal(
		relocated.INTERVIEW_SKILL_PATHS[0],
		join(home, "skills", "mission-interview", "upstream", "grill-with-docs", "SKILL.md"),
	);
});

test("opted-in native coordinator loads and reads actual upstream entries", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "native-interview-skills-")));
	const main = join(home, "main"),
		scratch = join(home, "scratch"),
		agentDir = join(home, "agent");
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
	});
	for (const path of [main, scratch, agentDir]) await mkdir(path);
	// Install hooks before creating any faux runtime. Never use user account credentials.
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
	const adapter = await NativeAdapter.open({
		cwd: scratch,
		agentDir,
		sessionFile: join(home, "native.session"),
		sessionId: "interview-test",
		projectTrusted: false,
		coordinatorSources: async () => ({ main, members: [], scratch }),
		missionInterview: true,
		settingsManager: SettingsManager.inMemory(),
		loaderOptions: { cwd: scratch, agentDir, noSkills: true, noContextFiles: true },
		sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
	});
	t.after(async () => {
		await adapter.close();
		await rm(home, { recursive: true, force: true });
	});
	assertInterviewSkills(adapter.session.resourceLoader.getSkills().skills);
	assert.ok(adapter.session.resourceLoader.getAppendSystemPrompt().includes(INTERVIEW_SKILL_ADAPTATION));
	for (const [index, path] of INTERVIEW_SKILL_PATHS.entries()) {
		const id = `interview-read-${index}`;
		const toolCall = { type: "toolCall" as const, id, name: "read", arguments: { path } };
		const assistantMessage = fauxAssistantMessage(toolCall, { stopReason: "toolUse" });
		adapter.session.agent.state.messages.push(assistantMessage);
		const admission = await adapter.session.agent.beforeToolCall?.({
			toolCall,
			args: { path },
			assistantMessage,
			context: { messages: adapter.session.messages, tools: adapter.session.agent.state.tools },
		});
		assert.ok(!admission?.block);
		const definition = adapter.session.getToolDefinition("read")!;
		const sourceInfo = adapter.session.getAllTools().find((tool) => tool.name === "read")!.sourceInfo;
		const result = await wrapRegisteredTool({ definition, sourceInfo }, adapter.session.extensionRunner).execute(id, {
			path,
		});
		assert.ok(!result.isError, JSON.stringify(result));
		assert.match(JSON.stringify(result), /grill-with-docs|grilling|Domain Modeling/);
	}
	await assert.rejects(
		NativeAdapter.open({ cwd: scratch, agentDir, missionInterview: true }),
		/trusted coordinator host/,
	);
});
