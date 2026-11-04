import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, type TestContext, test } from "node:test";
import { AgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import type { ModelList } from "@pilot/protocol";
import { ModelCatalog } from "./models.ts";
import { requiredAuthRegistration } from "./testing/required-auth.ts";

before(() => installCredentialBrokerHooks());

type Model = Parameters<ModelRuntime["completeSimple"]>[0];
function model(id: string, extra: Partial<Model> = {}): Model {
	return {
		id,
		provider: "test",
		name: id,
		api: "openai-completions",
		baseUrl: "https://private.invalid",
		input: ["text"],
		reasoning: true,
		contextWindow: 32000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...extra,
	};
}
const models = [
	model("first"),
	model("second"),
	model("plain", { reasoning: false }),
	model("mapped", { thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" } }),
];

async function fixture(t: TestContext, settings: Record<string, unknown> = {}, choices = models) {
	const root = await mkdtemp(join(tmpdir(), "pilot-effective-defaults-"));
	const settingsFile = join(root, "settings.json");
	await writeFile(settingsFile, JSON.stringify(settings));
	const forbidden = () => assert.fail("catalogue resolution must not start work, resolve credentials or write");
	t.mock.method(globalThis, "fetch", forbidden);
	t.mock.method(SettingsManager, "create", forbidden);
	t.mock.method(AgentSession.prototype, "setModel", forbidden);
	t.mock.method(AgentSession.prototype, "setThinkingLevel", forbidden);
	const runtime = {
		...requiredAuthRegistration,
		getAvailable: async () => choices,
		getAvailableSnapshot: () => choices,
		getModel: (provider: string, id: string) => choices.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (provider: string) => choices.some((m) => m.provider === provider),
		checkAuth: forbidden,
		getAuth: forbidden,
		completeSimple: forbidden,
		streamSimple: forbidden,
		resolveModel: forbidden,
		login: forbidden,
	};
	const create = t.mock.method(ModelRuntime, "create", async (options: Parameters<typeof ModelRuntime.create>[0]) => {
		assert.equal(options?.allowModelNetwork, false);
		return runtime as unknown as ModelRuntime;
	});
	const catalog = new ModelCatalog(root);
	const bytes = await readFile(settingsFile);
	t.after(async () => {
		try {
			assert.deepEqual(await readFile(settingsFile), bytes, "reads preserve exact settings bytes");
			assert.equal(create.mock.callCount(), 1, "only the existing metadata runtime is loaded");
			assert.deepEqual(
				(await readdir(root)).sort(),
				["settings.json"],
				"no auth/model/session/settings files created",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	return { root, catalog, runtime };
}

function option(list: ModelList, id = "test/second") {
	const found = list.models.find((m) => m.id === id);
	assert.ok(found);
	return found;
}

test("new-chat defaults use per-model, global and SDK fallback without scope thinking pins", async (t) => {
	const { root, catalog } = await fixture(t, {
		enabledModels: ["test/second:off", "test/first"],
		defaultThinkingLevel: "low",
		modelThinkingLevels: { "test/second": "high" },
	});
	const list = await catalog.list(root);
	assert.equal(option(list).defaultThinking, "high");
	assert.equal(option(list).thinking, "off", "legacy pin is unchanged");
	assert.equal(option(list).modelChangeThinking, "off");
	assert.equal(option(list, "test/first").defaultThinking, "low");
	assert.equal(option(list, "test/first").modelChangeThinking, "low");
	assert.equal(list.resolvedDefaultModel, "test/first", "SDK startup ignores scope ordering");
});

test("SDK fallback and clamping include non-thinking models and mapped levels", async (t) => {
	const { root, catalog } = await fixture(t, { modelThinkingLevels: { "test/second": "max", "test/mapped": "off" } });
	const list = await catalog.list(root);
	assert.equal(option(list, "test/first").defaultThinking, "medium");
	assert.equal(option(list, "test/first").modelChangeThinking, undefined, "switch retains session thinking");
	assert.equal(option(list).defaultThinking, "high");
	assert.equal(option(list).modelChangeThinking, "high");
	assert.equal(option(list, "test/plain").defaultThinking, "off");
	assert.equal(option(list, "test/plain").modelChangeThinking, "off");
	assert.equal(option(list, "test/mapped").defaultThinking, "low");
});

test("explicit new-chat model inherits initial per-model thinking, not a guessed medium", async (t) => {
	const { root, catalog } = await fixture(t, {
		defaultProvider: "test",
		defaultModel: "first",
		modelThinkingLevels: { "test/first": "max" },
	});
	const list = await catalog.list(root);
	assert.equal(option(list).defaultThinking, "high", "initial level is clamped before the explicit model switch");
	assert.equal(option(list).modelChangeThinking, undefined);
	assert.equal(list.defaultModel, "test/first");
	assert.equal(list.resolvedDefaultModel, "test/first");
});

test("non-thinking initial selection carries off into an unconfigured explicit model", async (t) => {
	const { root, catalog } = await fixture(t, { defaultProvider: "test", defaultModel: "plain" });
	assert.equal(option(await catalog.list(root)).defaultThinking, "off");
});

test("missing configured model uses the SDK's provider fallback, not the first scoped row", async (t) => {
	const choices = [model("first"), model("gpt-5.4", { provider: "openai" })];
	// Read the SDK's own provider fallback table so this fixture follows its pinned provider policy.
	const { defaultModelPerProvider } = await import(
		new URL("./core/model-resolver.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
	);
	choices[1]!.id = defaultModelPerProvider.openai;
	const { root, catalog } = await fixture(t, { defaultProvider: "missing", defaultModel: "absent" }, choices);
	const list = await catalog.list(root);
	assert.equal(list.defaultModel, "missing/absent");
	assert.equal(list.resolvedDefaultModel, `openai/${choices[1]!.id}`);
});

test("out-of-scope actual startup defaults stay omitted without inventing an in-scope replacement", async (t) => {
	const { root, catalog } = await fixture(t, {
		defaultProvider: "test",
		defaultModel: "first",
		enabledModels: ["test/second"],
	});
	const list = await catalog.list(root);
	assert.equal(list.defaultModel, "test/first");
	assert.equal(list.resolvedDefaultModel, undefined);
	assert.equal(option(list).defaultThinking, "medium");
});

test("known but unauthenticated default uses the existing authenticated SDK fallback", async (t) => {
	const { root, catalog, runtime } = await fixture(t, { defaultProvider: "unauthed", defaultModel: "known" });
	const getModel = runtime.getModel;
	runtime.getModel = (provider, id) =>
		provider === "unauthed" ? model("known", { provider }) : getModel(provider, id);
	const list = await catalog.list(root);
	assert.equal(list.defaultModel, "unauthed/known");
	assert.equal(list.resolvedDefaultModel, "test/first");
});

test("empty authenticated snapshot has no fabricated default", async (t) => {
	const { root, catalog } = await fixture(t, {}, []);
	assert.deepEqual(await catalog.list(root), { models: [] });
});

test("missing auth metadata omits unknown defaults, retaining independent configured thinking", async (t) => {
	const { root, catalog, runtime } = await fixture(t, { modelThinkingLevels: { "test/second": "low" } });
	Object.assign(runtime, { hasConfiguredAuth: undefined });
	const list = await catalog.list(root);
	assert.equal(list.resolvedDefaultModel, undefined);
	assert.equal(option(list, "test/first").defaultThinking, undefined);
	assert.equal(option(list).defaultThinking, "low");
	assert.equal(option(list, "test/plain").defaultThinking, "off");
});

test("failed passive auth snapshot never triggers active credential resolution or leaks errors", async (t) => {
	const { root, catalog, runtime } = await fixture(t, { defaultProvider: "test", defaultModel: "first" });
	runtime.hasConfiguredAuth = () => {
		throw new Error("private auth error");
	};
	const list = await catalog.list(root);
	assert.equal(list.resolvedDefaultModel, undefined);
	assert.equal(option(list).defaultThinking, undefined);
	assert.doesNotMatch(JSON.stringify(list), /private|baseUrl|apiKey/);
});

test("task-start metadata matches actual admission, with scope thinking rather than new-chat inheritance", async (t) => {
	const { root, catalog } = await fixture(t, {
		enabledModels: ["test/second:off", "test/first"],
		modelThinkingLevels: { "test/second": "high" },
	});
	t.mock.method(console, "warn", () => {});
	const list = await catalog.listTaskModels(root);
	assert.equal(list.resolvedDefaultModel, "test/second");
	assert.equal(option(list).defaultThinking, "high");
	assert.equal(option(list).taskDefaultThinking, "off");
	assert.equal(option(list, "test/first").taskDefaultThinking, "medium");
	for (const entry of list.models)
		assert.equal((await catalog.selectTaskModel(root, entry.id)).thinking, entry.taskDefaultThinking);
	assert.equal((await catalog.selectTaskModel(root)).model, list.resolvedDefaultModel);
	assert.equal(option(await catalog.list(root)).taskDefaultThinking, undefined);
});

test("task-start rejected configured default never reports a new-chat or first-row fallback", async (t) => {
	const { root, catalog } = await fixture(t, { defaultProvider: "test", defaultModel: "frontier" }, [
		...models,
		model("gpt-6.1-sol"),
		model("frontier", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
	]);
	assert.equal((await catalog.list(root)).resolvedDefaultModel, "test/frontier");
	assert.equal((await catalog.listTaskModels(root)).resolvedDefaultModel, undefined);
	await assert.rejects(catalog.selectTaskModel(root), /exceeds the task-start price cap/);
});

test("directory snapshots stay separate and legacy JSON remains optional and unchanged", async (t) => {
	const { root, catalog } = await fixture(t, {
		defaultProvider: "test",
		defaultModel: "first",
		defaultThinkingLevel: "low",
	});
	const project = join(tmpdir(), `effective-project-${process.pid}-${Date.now()}`);
	await mkdir(join(project, ".pi"), { recursive: true });
	t.after(() => rm(project, { recursive: true, force: true }));
	const path = join(project, ".pi", "settings.json");
	const bytes = JSON.stringify({
		defaultModel: "second",
		defaultThinkingLevel: "high",
		enabledModels: ["test/second:off"],
	});
	await writeFile(path, bytes);
	const [global, scoped] = await Promise.all([catalog.list(root), catalog.list(project)]);
	assert.equal(global.resolvedDefaultModel, "test/first");
	assert.equal(scoped.resolvedDefaultModel, "test/second");
	assert.equal(option(global).defaultThinking, "low");
	assert.equal(option(scoped).defaultThinking, "high");
	assert.equal(option(scoped).modelChangeThinking, "off");
	assert.equal(await readFile(path, "utf8"), bytes);
	assert.deepEqual(JSON.parse(JSON.stringify(global)), global);
	const legacy: ModelList = {
		models: [{ id: "test/old", provider: "test", name: "Old", thinking: "high" }],
		defaultModel: "test/old",
	};
	assert.equal(
		JSON.stringify(legacy),
		'{"models":[{"id":"test/old","provider":"test","name":"Old","thinking":"high"}],"defaultModel":"test/old"}',
	);
});
