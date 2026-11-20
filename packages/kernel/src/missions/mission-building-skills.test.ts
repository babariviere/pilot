/** Builders get the upstream implement, tdd, codebase-design and code-review skills word for word. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installCredentialBrokerHooks } from "../credentials/credential-hooks.ts";
import { assertBuildingSkills, BUILDING_SKILL_ADAPTATION, BUILDING_SKILL_PATHS } from "./mission-building-skills.ts";
import { NativeAdapter } from "../native-adapter.ts";
import { type MissionContext, missionPrompt } from "../runtime/policy.ts";

test("upstream building skills load as trusted Pi skills, with implement read by path", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "building-loader-"));
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
		additionalSkillPaths: BUILDING_SKILL_PATHS,
	});
	await loader.reload();
	const { skills, diagnostics } = loader.getSkills();
	assert.deepEqual(diagnostics, []);
	assertBuildingSkills(skills);
	assert.deepEqual(skills.map((s) => s.name).sort(), [
		"code-review",
		"codebase-design",
		"implement",
		"tdd",
		"writing-for-agents",
	]);
	assert.equal(skills.find((s) => s.name === "implement")?.disableModelInvocation, true);
	assert.match(BUILDING_SKILL_ADAPTATION, new RegExp(BUILDING_SKILL_PATHS[0]!.replaceAll("/", "\\/")));
	assert.match(BUILDING_SKILL_ADAPTATION, /mission tool: get with your task id .* brief .* decisions/);
	assert.throws(() => assertBuildingSkills([{ name: "tdd", filePath: "/personal/tdd/SKILL.md" }]), /shadowed/);
});

test("upstream building skills stay byte-exact and attributed", async () => {
	const hashes = {
		"code-review/SKILL.md": "9c921a8d88138a41401d8897ca1bb852088ab1b7b605cdd04edc13e3e8aab6dd",
		"codebase-design/DEEPENING.md": "f3dd099ce99289bd213914d8ee3e2429b78309c3957ca4583f7659551b1d53c1",
		"codebase-design/DESIGN-IT-TWICE.md": "c222ab5a82e0405672eb9062d62496139a08828e45d07fc5f18e4952c10fac1a",
		"codebase-design/SKILL.md": "2c20617f87ec8af6a434859f381b2f061a69b530444e74eb39e78bb016a6d1e2",
		"implement/SKILL.md": "483bdc4ccf4ac31d86ac7beeaa0d0db80313e71e120bb8c59b3196ae5decd53d",
		"tdd/mocking.md": "3ceb807fdf4a47d6a93d4d9a891e5ba6d362a6247bd08adc451feebfc17361ef",
		"tdd/SKILL.md": "5505d25bbaa8fc14a79e4d20163936958992a2995b7f1dd1d6197edc9ed722e0",
		"tdd/tests.md": "859f9e592c188fda4fc7277dd180e4ce9c7a2e13f6efe1f6f29eccc9d28c106a",
		"writing-for-agents/SKILL.md": "551adca942227b44192edba88acd4e8db911f0121ce58ad16944ccf6a896a74a",
		"writing-for-agents/SKILL-MECHANICS.md": "c768e6307c7c10728c401c213f2c4ba71c542127eeb7ad2956aabd15a0fa0059",
		LICENSE: "0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5",
	};
	for (const [file, hash] of Object.entries(hashes))
		assert.equal(
			createHash("sha256")
				.update(await readFile(new URL(`../../skills/building/${file}`, import.meta.url)))
				.digest("hex"),
			hash,
			file,
		);
	const attribution = await readFile(new URL("../../skills/SOURCE.md", import.meta.url), "utf8");
	assert.match(attribution, /5863806dd4e15c63174bee4e7515a4256792ecfa/);
	assert.match(attribution, /MIT, Copyright 2026 Matt Pocock/);
});

test("a Build chat uses the bundled building skills over same-named personal ones", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "native-building-shadow-")));
	const cwd = join(home, "work"),
		agentDir = join(home, "agent");
	for (const path of [cwd, agentDir]) await mkdir(path);
	for (const name of [...BUILDING_SKILL_PATHS.map((path) => basename(dirname(path))), "my-own"]) {
		await mkdir(join(agentDir, "skills", name), { recursive: true });
		await writeFile(
			join(agentDir, "skills", name, "SKILL.md"),
			`---\nname: ${name}\ndescription: Personal ${name}.\n---\n\nPersonal copy.\n`,
		);
	}
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
	const adapter = await NativeAdapter.open({
		cwd,
		agentDir,
		sessionFile: join(home, "native.session"),
		sessionId: "building-shadow-test",
		projectTrusted: false,
		settingsManager: SettingsManager.inMemory(),
		loaderOptions: { cwd, agentDir, noContextFiles: true },
		sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
	});
	t.after(async () => {
		await adapter.close();
		await rm(home, { recursive: true, force: true });
	});
	const { skills } = adapter.session.resourceLoader.getSkills();
	for (const path of BUILDING_SKILL_PATHS) {
		const name = basename(dirname(path));
		assert.deepEqual(
			skills.filter((skill) => skill.name === name).map((skill) => skill.filePath),
			[path],
			name,
		);
	}
	assert.ok(skills.some((skill) => skill.name === "my-own"));
});

test("only building mission members are told to follow implement", () => {
	const mission: MissionContext = {
		id: "m1",
		title: "API v2 redesign",
		goal: "Replace REST v1",
		status: "active",
		coordinator: "user",
		tasks: [{ number: 2, title: "Auth endpoints", status: "in_progress" }],
		decisions: [],
	};
	const told = (prompt: string) => prompt.includes(BUILDING_SKILL_ADAPTATION);
	assert.ok(told(missionPrompt(mission)));
	assert.ok(told(missionPrompt({ ...mission, coordinator: "other", role: "builder" })));
	assert.ok(!told(missionPrompt({ ...mission, coordinator: "self" })));
	assert.ok(!told(missionPrompt({ ...mission, role: "explorer" })));
	assert.ok(!told(missionPrompt({ ...mission, role: "reviewer" })));
	assert.ok(!told(missionPrompt(mission, false, true)), "investigate permission");
	assert.ok(!told(missionPrompt(mission, false, false, true, false)), "Ask chat");
});
