import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, type TestContext, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import { ModelControls } from "./model-controls.ts";
import { ModelDefaultsRefused } from "./model-controls-store.ts";
import { ModelScopeConflictError } from "./model-scope.ts";
import { ModelCatalog } from "./models.ts";
import { nativePlanningFixture } from "../missions/planning/native-mission-planning.fixture.ts";
import { OperationJournal, payloadHash } from "../transport/operations/operation-journal.ts";
import { ProjectStore } from "../projects/projects.ts";
import { SessionManager } from "../sessions/sessions.ts";
import { SetupError } from "../setup/setup-error.ts";
import { offlineSessionOptions } from "../testing/offline-session-options.ts";
import { requiredAuthRegistration } from "../testing/required-auth.ts";

before(() => installCredentialBrokerHooks());

test("pre-effect refusals settle as rejected, not permanent Unknown, including busy sign-in", async (t) => {
	catalog(t);
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const models = new ModelCatalog(f.home);
	const setup = {
		readiness: async () => ({ providers: [], integrations: [], independentCredentials: true as const }),
		list: () => [],
		start: () => {
			throw new SetupError(409, "A setup helper for this provider is still running.");
		},
		cancel: async () => {
			throw new SetupError(404, "Unknown setup run.");
		},
		logout: async () => {
			throw new SetupError(404, "Unknown provider.");
		},
	};
	const service = new ModelControls(models, f.projects, setup);
	const read = await service.read(f.project.id);
	const attempt = async (action: string, value: unknown) => {
		const op = f.operation(
			f.project.id,
			{ purpose: "model-controls", projectId: f.project.id, binding: read.binding, action, value },
			read.binding,
		);
		return f.journal.execute(op, (op, entry) => service.admit(op, f.journal, entry.firstEntry));
	};
	for (const [action, value] of [
		["sign-in", { provider: "anthropic", method: "manual_code" }],
		["cancel", "missing"],
		["logout", "missing"],
		["project-model", "missing/model"],
		["defaults", null],
		["scope", []],
	] as const) {
		assert.equal((await attempt(action, value)).state, "rejected", action);
	}
	t.mock.method(models, "saveDefaults", async () => {
		throw new ModelDefaultsRefused("Changed before writing");
	});
	assert.equal((await attempt("defaults", read.defaults)).state, "rejected");
	t.mock.method(models, "updateScope", async () => {
		throw new ModelScopeConflictError({ error: "scope_conflict", scopeHash: "a".repeat(64), enabledModels: null });
	});
	assert.equal((await attempt("scope", ["fixture/small"])).state, "rejected");
	t.mock.method(service, "read", async () => {
		throw new Error("private-read-error");
	});
	const rejected = await attempt("defaults", read.defaults);
	assert.equal(rejected.state, "rejected");
	assert.doesNotMatch(JSON.stringify(rejected), /private-read-error/);
});

test("project override checks the store again after the asynchronous settings read returns", async (t) => {
	catalog(t);
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const service = new ModelControls(new ModelCatalog(f.home), f.projects);
	const shown = await service.read(f.project.id);
	const read = service.read.bind(service);
	let changed: Promise<unknown> | undefined;
	t.mock.method(service, "read", async (project?: string) => {
		const snapshot = await read(project);
		queueMicrotask(() => {
			changed = f.projects.update(f.project.id, { model: "fixture/small" });
		});
		return snapshot;
	});
	const op = f.operation(
		f.project.id,
		{
			purpose: "model-controls",
			projectId: f.project.id,
			binding: shown.binding,
			action: "project-model",
			value: "fixture/claude-opus-5-5",
		},
		shown.binding,
	);
	assert.equal(
		(await f.journal.execute(op, (op, entry) => service.admit(op, f.journal, entry.firstEntry))).state,
		"rejected",
	);
	await changed;
	assert.equal(f.projects.require(f.project.id).model, "fixture/small");
});

test("failed work offers capped choices from its own copy and saves only that chat's next attempt", async (t) => {
	catalog(t);
	const home = await mkdtemp(join(tmpdir(), "model-replacement-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, workspace: "direct" });
	const id = randomUUID();
	await mkdir(join(home, "sessions", id), { recursive: true });
	await writeFile(join(home, "settings.json"), '{"defaultProvider":"fixture","defaultModel":"small"}');
	await writeFile(
		join(home, "sessions", id, "meta.json"),
		JSON.stringify({
			id,
			projectId: project.id,
			cwd: home,
			title: "Affected chat",
			model: "fixture/missing",
			createdAt: 1,
			updatedAt: 2,
			outcome: "failed",
			outcomeAt: 3,
			failure: "Session startup: model unavailable",
			working: false,
		}),
	);
	const sessions = new SessionManager(
		home,
		projects,
		undefined,
		{
			worker: () => assert.fail("Choosing must not start work"),
		},
		{},
		offlineSessionOptions(),
	);
	await sessions.load();
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	const service = new ModelControls(new ModelCatalog(home), projects, undefined, sessions);
	const read = await service.read(project.id);
	assert.equal(read.failed[0]!.id, id);
	const replacement = await service.recovery(project.id, id);
	assert.ok(replacement.choices.models.some((m) => m.id === "fixture/small"));
	await assert.rejects(service.recovery("other", id), /changed/);
	const host = { hostId: "daemon", daemonId: "daemon", lineageId: "lineage" };
	const journal = new OperationJournal(join(home, "operations"), host);
	const payload = JSON.stringify({
		purpose: "model-controls",
		projectId: project.id,
		binding: read.binding,
		action: "failed-model",
		value: { sessionId: id, source: replacement.source, model: "fixture/small", thinking: "low" },
	});
	const operation = {
		schemaVersion: 1 as const,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: { ...host, hostId: "local" },
		destination: host,
		kind: "model-controls",
		targetId: project.id,
		bindingId: read.binding,
		bindingGeneration: 1,
		payload,
		payloadHash: payloadHash(payload),
	};
	const receipt = await journal.execute(operation, (op, entry) => service.admit(op, journal, entry.firstEntry));
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.deepEqual(sessions.get(id)?.nextAttemptModel, { model: "fixture/small", thinking: "low" });
	assert.equal(sessions.get(id)?.state, "failed");
	assert.equal(sessions.get(id)?.model, "fixture/missing");
	const stale = { ...operation, operationId: randomUUID(), producerId: randomUUID() };
	assert.equal(
		(await journal.execute(stale, (op, entry) => service.admit(op, journal, entry.firstEntry))).state,
		"rejected",
	);
	await writeFile(join(home, "settings.json"), '{"enabledModels":["fixture/small"]}');
	assert.deepEqual(
		(await service.recovery(project.id, id)).choices.models,
		[],
		"missing reference prices do not silently broaden recovery choices",
	);
});

function catalog(t: TestContext) {
	const choices = ["claude-opus-5-5", "small"].map((id) => ({
		id,
		provider: "fixture",
		name: id,
		api: "openai-completions",
		baseUrl: "https://private-provider.invalid/key",
		input: ["text"],
		reasoning: true,
		contextWindow: 32000,
		maxTokens: 1024,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	}));
	t.mock.method(
		ModelRuntime,
		"create",
		async () =>
			({
				...requiredAuthRegistration,
				getAvailable: async () => choices,
				getAvailableSnapshot: () => choices,
				getModel: (provider: string, id: string) => choices.find((m) => m.provider === provider && m.id === id),
				getModelsOfType: () => choices,
				hasConfiguredAuth: () => true,
				completeSimple: () => assert.fail("Settings must never start a completion"),
			}) as unknown as ModelRuntime,
	);
}

test("native AI settings HTTP uses exact durable receipts, preserves advanced config and never starts work", async (t) => {
	catalog(t);
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	await writeFile(
		join(f.home, "settings.json"),
		'{"defaultProvider":"fixture","defaultModel":"small","extensions":["keep"],"modelThinkingLevels":{"fixture/small":"high"}}',
	);
	const url = () => `${f.root}/api/model-controls?projectId=${f.project.id}`;
	const read = async () => {
		const r = await fetch(url(), { headers: { "x-pilot-github-capability": f.capability } });
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("cache-control"), "no-store");
		return r.json();
	};
	const denied = await fetch(url());
	assert.notEqual(denied.status, 200);
	await denied.arrayBuffer();
	const initial = await read();
	assert.equal(initial.task.resolvedDefaultModel, "fixture/small");
	assert.equal(initial.task.models.find((m: { id: string }) => m.id === "fixture/small").taskDefaultThinking, "high");
	assert.doesNotMatch(JSON.stringify(initial), /private-provider|baseUrl|apiKey/);
	const request = {
		purpose: "model-controls",
		action: "defaults",
		binding: initial.binding,
		projectId: f.project.id,
		value: { ...initial.defaults, defaultThinkingLevel: "low" },
	};
	const op = f.operation(f.project.id, request, initial.binding);
	const receipt = await (await f.post(op)).json();
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(receipt.result.saved, true);
	assert.deepEqual(await (await f.post(op)).json(), receipt);
	assert.deepEqual(await (await f.post(op, true)).json(), receipt);
	assert.ok((await readFile(join(f.home, "settings.json"), "utf8")).includes('"extensions":["keep"]'));
	assert.equal(
		(await read()).task.models.find((m: { id: string }) => m.id === "fixture/small").taskDefaultThinking,
		"high",
		"per-model default stays authoritative",
	);
	const stale = f.operation(
		f.project.id,
		{ ...request, value: { ...initial.defaults, defaultThinkingLevel: "off" } },
		initial.binding,
	);
	assert.equal((await (await f.post(stale)).json()).state, "rejected");
	const current = await read();
	const project = f.operation(
		f.project.id,
		{
			purpose: "model-controls",
			action: "project-model",
			binding: current.binding,
			projectId: f.project.id,
			value: "fixture/claude-opus-5-5",
		},
		current.binding,
	);
	assert.equal((await (await f.post(project)).json()).state, "accepted");
	assert.equal((await read()).project.model, "fixture/claude-opus-5-5");
	await f.restart();
	assert.deepEqual(await (await f.post(op, true)).json(), receipt);
	assert.equal((await read()).project.model, "fixture/claude-opus-5-5");
	assert.equal(f.sessions.list().length, 0);
});

test("uncertain AI settings operations and provider errors never leak secrets or re-enter", async (t) => {
	catalog(t);
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	let writes = 0;
	t.mock.method(ModelCatalog.prototype, "saveDefaults", async () => {
		writes++;
		throw new Error("private-provider-token");
	});
	const r = await fetch(`${f.root}/api/model-controls`, { headers: { "x-pilot-github-capability": f.capability } });
	const s = await r.json();
	const op = f.operation(
		"global-models",
		{ purpose: "model-controls", projectId: null, action: "defaults", value: s.defaults, binding: s.binding },
		s.binding,
	);
	assert.equal((await (await f.post(op)).json()).state, "pending");
	assert.equal((await (await f.post(op, true)).json()).state, "pending");
	assert.equal((await (await f.post(op)).json()).state, "pending");
	assert.equal(writes, 1);
	const files = await readdir(join(f.home, "operations"));
	const journal = (
		await Promise.all(
			files.filter((f) => f.endsWith(".json")).map((file) => readFile(join(f.home, "operations", file), "utf8")),
		)
	).join("\n");
	assert.doesNotMatch(journal, /private-provider-token/);
	await f.restart();
	assert.equal((await (await f.post(op, true)).json()).state, "pending");
	assert.equal(writes, 1);
});
