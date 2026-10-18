import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelList, ModelScope, ModelScopeConflict, ModelScopeUpdateResponse } from "@pilot/protocol";
import { GitHubSetupService } from "./github-setup.ts";
import { modelScopeHash } from "./model-scope.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { requiredAuthRegistration } from "./testing/required-auth.ts";

async function fixture(t: TestContext, readOnly = false) {
	const home = await mkdtemp(join(tmpdir(), "pilot-model-scope-api-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const native = new GitHubSetupService(
		home,
		{ hostId: "fixture-host", daemonId: "fixture", lineageId: "fixture-lineage" },
		{ userHome: home, env: {} },
	);
	await native.status();
	const capability = JSON.parse(await readFile(join(home, "github-app-capability"), "utf8")).token as string;
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0, modelScopeReadOnly: readOnly },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		native,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await sessions.shutdown();
		await terminals.shutdown();
		await native.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const scope = `${origin}/api/model-scope`;
	const put = (enabledModels: unknown, expectedHash: string) =>
		fetch(scope, {
			method: "PUT",
			headers: { "content-type": "application/json", "x-pilot-github-capability": capability },
			body: JSON.stringify({ enabledModels, expectedHash }),
		});
	return { home, origin, scope, put, sessions, projects };
}

function models(t: TestContext, fail = false) {
	const model = (id: string) => ({
		id,
		name: id,
		provider: "fixture",
		api: "openai-completions",
		baseUrl: "https://secret-endpoint.invalid/token",
		input: ["text"],
		reasoning: false,
		contextWindow: 32000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	t.mock.method(
		ModelRuntime,
		"create",
		async () =>
			({
				...requiredAuthRegistration,
				getAvailable: async () => {
					if (fail) throw new Error("private-credential-value");
					return [model("one"), model("two")];
				},
				getModelsOfType: () => [model("one"), model("two")],
			}) as unknown as ModelRuntime,
	);
}

test("scope HTTP contract supports CAS, unscoped candidates, idempotent retries and independent hosts", async (t) => {
	models(t);
	const local = await fixture(t);
	const other = await fixture(t);
	const path = join(local.home, "settings.json");
	const initialResponse = await fetch(local.scope);
	assert.equal(initialResponse.status, 200);
	assert.equal(initialResponse.headers.get("cache-control"), "no-store");
	const initial = (await initialResponse.json()) as ModelScope;
	assert.deepEqual(initial, {
		enabledModels: null,
		allModels: true,
		scopeHash: modelScopeHash(null),
		resolution: [],
		candidates: [
			{ id: "fixture/one", provider: "fixture", name: "one" },
			{ id: "fixture/two", provider: "fixture", name: "two" },
		],
	});
	await assert.rejects(readFile(path), { code: "ENOENT" });
	await writeFile(path, '{"theme":"preserved","defaultModel":"keep","private":"private-credential-value"}');
	assert.equal(((await (await fetch(local.scope)).json()) as ModelScope).scopeHash, initial.scopeHash);
	const desired = ["fixture/one:high", "not-installed/*", "fixture/one:high"];
	let response = await local.put(desired, initial.scopeHash);
	assert.equal(response.status, 200);
	const updated = (await response.json()) as ModelScopeUpdateResponse;
	assert.ok(updated.changed);
	assert.deepEqual(updated.enabledModels, desired);
	assert.equal(updated.allModels, false);
	assert.equal(updated.resolution[1]?.unresolved, "unknown");
	assert.deepEqual(updated.candidates, initial.candidates);
	assert.doesNotMatch(JSON.stringify(updated), /private-credential|secret-endpoint|baseUrl|apiKey/);
	const listed = await fetch(`${local.origin}/api/models?cwd=${encodeURIComponent(local.home)}`);
	assert.deepEqual(
		((await listed.json()) as ModelList).models.map((entry) => entry.id),
		["fixture/one"],
	);
	assert.equal(((await (await fetch(other.scope)).json()) as ModelScope).enabledModels, null);
	assert.equal(local.sessions.list().length, 0);
	assert.equal(JSON.parse(await readFile(path, "utf8")).defaultModel, "keep");
	assert.equal(JSON.parse(await readFile(path, "utf8")).private, "private-credential-value");

	const before = await readFile(path, "utf8");
	response = await local.put(desired, initial.scopeHash);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { changed: false, scopeHash: updated.scopeHash });
	assert.equal(await readFile(path, "utf8"), before);
	// A readback equal to the desired literal array also reconciles an uncertain outcome.
	assert.deepEqual(((await (await fetch(local.scope)).json()) as ModelScope).enabledModels, desired);

	await writeFile(path, '{"enabledModels":["fixture/two"],"theme":"externally-edited"}');
	response = await local.put(["fixture/one"], updated.scopeHash);
	assert.equal(response.status, 409);
	const conflict = (await response.json()) as ModelScopeConflict;
	assert.deepEqual(conflict, {
		error: "scope_conflict",
		scopeHash: modelScopeHash(["fixture/two"]),
		enabledModels: ["fixture/two"],
	});
	response = await local.put(null, conflict.scopeHash);
	assert.equal(response.status, 200);
	assert.equal(((await response.json()) as ModelScope).enabledModels, null);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { theme: "externally-edited" });
	response = await local.put(null, "stale");
	assert.deepEqual(await response.json(), { changed: false, scopeHash: modelScopeHash(null) });
	assert.equal(
		((await (await fetch(`${local.origin}/api/models?cwd=${encodeURIComponent(local.home)}`)).json()) as ModelList)
			.models.length,
		2,
	);
});

test("project override is optional read-only metadata; global resolution, candidates and hash do not change", async (t) => {
	models(t);
	const host = await fixture(t);
	const project = join(host.home, "project");
	await mkdir(join(project, ".pi"), { recursive: true });
	const projectFile = join(project, ".pi", "settings.json");
	const text = '{"enabledModels":["fixture/two"]}';
	await writeFile(projectFile, text);
	await host.put(["fixture/one"], modelScopeHash(null));
	const global = (await (await fetch(host.scope)).json()) as ModelScope;
	t.mock.method(host.projects, "require", () => ({ path: project }));
	const read = await fetch(`${host.scope}?projectId=project`);
	assert.equal(read.status, 200);
	assert.deepEqual(await read.json(), { ...global, projectOverride: ["fixture/two"] });
	await host.put(null, global.scopeHash);
	assert.equal(await readFile(projectFile, "utf8"), text);
});

test("existing Pi [] reads as all, but every PUT [] is rejected instead of normalizing or overwriting", async (t) => {
	models(t);
	const host = await fixture(t);
	const path = join(host.home, "settings.json");
	await writeFile(path, '{"enabledModels":[]}');
	const current = (await (await fetch(host.scope)).json()) as ModelScope;
	assert.equal(current.allModels, true);
	assert.deepEqual(current.enabledModels, []);
	assert.deepEqual(current.resolution, []);
	assert.equal(current.scopeHash, modelScopeHash([]));
	for (const hash of [current.scopeHash, "stale"]) {
		const response = await host.put([], hash);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "invalid_scope" });
	}
	assert.equal(await readFile(path, "utf8"), '{"enabledModels":[]}');
	const reset = await host.put(null, current.scopeHash);
	assert.equal(reset.status, 200);
	assert.deepEqual(await reset.json(), {
		...current,
		changed: true,
		enabledModels: null,
		scopeHash: modelScopeHash(null),
	});
});

test("scope HTTP writes return typed read-only/auth/validation errors and bound UTF-8 pattern lengths", async (t) => {
	models(t);
	const host = await fixture(t, true);
	const denied = await host.put(["fixture/one"], modelScopeHash(null));
	assert.equal(denied.status, 403);
	assert.deepEqual(await denied.json(), { error: "read_only" });
	await assert.rejects(readFile(join(host.home, "settings.json")), { code: "ENOENT" });
	const writable = await fixture(t);
	for (const capability of [undefined, "wrong-capability"]) {
		const response = await fetch(writable.scope, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				...(capability ? { "x-pilot-github-capability": capability } : {}),
			},
			body: JSON.stringify({ enabledModels: null, expectedHash: "stale" }),
		});
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "native_action_required" });
	}
	for (const patterns of [[], [""], [1], "*", ["é".repeat(129)], Array(257).fill("*")]) {
		const response = await writable.put(patterns, modelScopeHash(null));
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "invalid_scope" });
	}
	const oversized = await writable.put(["x".repeat(170 * 1024)], modelScopeHash(null));
	assert.equal(oversized.status, 413);
	await oversized.arrayBuffer();
	const browser = await fetch(writable.scope, {
		method: "PUT",
		headers: { origin: "https://untrusted.example", "content-type": "application/json" },
		body: JSON.stringify({ enabledModels: null, expectedHash: "stale" }),
	});
	assert.equal(browser.status, 403);
	await browser.arrayBuffer();
});

test("unreadable settings are typed failures; lost-ack no-ops do not need provider resolution", async (t) => {
	models(t, true);
	const host = await fixture(t);
	const read = await fetch(host.scope);
	assert.equal(read.status, 503);
	assert.deepEqual(await read.json(), { error: "model_scope_unavailable" });
	// The commit can succeed even when response resolution fails. Retrying the same desired value is safe.
	const desired = ["fixture/one"];
	const write = await host.put(desired, modelScopeHash(null));
	assert.equal(write.status, 503);
	assert.deepEqual(await write.json(), { error: "model_scope_unavailable" });
	const retry = await host.put(desired, modelScopeHash(null));
	assert.equal(retry.status, 200);
	assert.deepEqual(await retry.json(), { changed: false, scopeHash: modelScopeHash(desired) });
	const path = join(host.home, "settings.json");
	const broken = '{"private":"private-credential-value", broken';
	await writeFile(path, broken);
	for (const request of [() => fetch(host.scope), () => host.put(null, modelScopeHash(null))]) {
		const response = await request();
		assert.equal(response.status, 422);
		assert.deepEqual(await response.json(), { error: "settings_unreadable" });
		assert.equal(await readFile(path, "utf8"), broken);
	}
});
