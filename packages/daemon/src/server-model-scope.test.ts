import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelList, ModelScope, ModelScopeConflict } from "@pilot/protocol";
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
	const scope = `${origin}/api/model-scope?cwd=${encodeURIComponent(home)}`;
	const put = (enabledModels: unknown, expectedHash: string) =>
		fetch(scope, {
			method: "PUT",
			headers: { "content-type": "application/json", "x-pilot-github-capability": capability },
			body: JSON.stringify({ enabledModels, expectedHash }),
		});
	return { home, origin, scope, put, sessions };
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

test("scope HTTP API provides stable CAS DTOs, refreshes /models, and keeps separate hosts independent", async (t) => {
	models(t);
	const local = await fixture(t);
	const other = await fixture(t);
	const path = join(local.home, "settings.json");
	await writeFile(path, '{"theme":"preserved","private":"private-credential-value"}');
	let response = await fetch(local.scope);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const initial = (await response.json()) as ModelScope;
	assert.deepEqual(initial, {
		enabledModels: null,
		contentHash: modelScopeHash(null),
		projectOverride: null,
		resolution: [],
		projectResolution: null,
		writable: true,
	});
	response = await local.put(["fixture/one", "not-installed/*"], initial.contentHash);
	assert.equal(response.status, 200);
	const updated = (await response.json()) as ModelScope;
	assert.deepEqual(updated.enabledModels, ["fixture/one", "not-installed/*"]);
	assert.equal(updated.resolution[1]?.unresolvedReason, "unknown");
	assert.doesNotMatch(JSON.stringify(updated), /private-credential|secret-endpoint|baseUrl|apiKey/);
	const listed = await fetch(`${local.origin}/api/models?cwd=${encodeURIComponent(local.home)}`);
	assert.deepEqual(
		((await listed.json()) as ModelList).models.map((entry) => entry.id),
		["fixture/one"],
	);
	assert.equal(((await (await fetch(other.scope)).json()) as ModelScope).enabledModels, null);
	assert.equal(local.sessions.list().length, 0);
	assert.equal(JSON.parse(await readFile(path, "utf8")).private, "private-credential-value");

	// A write by pi /scoped-models after GET must win over a stale app/sync request.
	await writeFile(path, '{"enabledModels":["fixture/two"],"theme":"externally-edited"}');
	response = await local.put(["fixture/one"], updated.contentHash);
	assert.equal(response.status, 409);
	const conflict = (await response.json()) as ModelScopeConflict;
	assert.deepEqual(conflict, { currentHash: modelScopeHash(["fixture/two"]), current: ["fixture/two"] });
	response = await local.put(null, conflict.currentHash);
	assert.equal(response.status, 200);
	assert.equal(((await response.json()) as ModelScope).enabledModels, null);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { theme: "externally-edited" });
	assert.equal(
		((await (await fetch(`${local.origin}/api/models?cwd=${encodeURIComponent(local.home)}`)).json()) as ModelList)
			.models.length,
		2,
	);
});

test("scope HTTP writes reject read-only hosts, invalid requests, oversized payloads and browser origins", async (t) => {
	models(t);
	const host = await fixture(t, true);
	const initial = (await (await fetch(host.scope)).json()) as ModelScope;
	assert.equal(initial.writable, false);
	assert.equal((await host.put(["fixture/one"], initial.contentHash)).status, 403);
	await assert.rejects(readFile(join(host.home, "settings.json")), { code: "ENOENT" });
	const writable = await fixture(t);
	for (const capability of [undefined, "wrong-capability"]) {
		const response = await fetch(writable.scope, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				...(capability ? { "x-pilot-github-capability": capability } : {}),
			},
			body: JSON.stringify({ enabledModels: [], expectedHash: initial.contentHash }),
		});
		assert.equal(response.status, 403);
		await response.arrayBuffer();
	}
	for (const patterns of [[""], [1], "*", Array(257).fill("*")]) {
		const response = await writable.put(patterns, initial.contentHash);
		assert.equal(response.status, 400);
		await response.arrayBuffer();
	}
	const oversized = await writable.put(["x".repeat(170 * 1024)], initial.contentHash);
	assert.equal(oversized.status, 413);
	await oversized.arrayBuffer();
	const browser = await fetch(writable.scope, {
		method: "PUT",
		headers: { origin: "https://untrusted.example", "content-type": "application/json" },
		body: JSON.stringify({ enabledModels: [], expectedHash: initial.contentHash }),
	});
	assert.equal(browser.status, 403);
	await browser.arrayBuffer();
});

test("scope HTTP failures never disclose SDK/provider errors or malformed settings content", async (t) => {
	models(t, true);
	const host = await fixture(t);
	const read = await fetch(host.scope);
	assert.equal(read.status, 503);
	assert.doesNotMatch(await read.text(), /private-credential/);
	const write = await host.put(["fixture/one"], modelScopeHash(null));
	assert.equal(write.status, 400);
	assert.doesNotMatch(await write.text(), /private-credential/);
	await writeFile(join(host.home, "settings.json"), '{"private":"private-credential-value", broken');
	const malformed = await host.put([], modelScopeHash(null));
	assert.equal(malformed.status, 400);
	assert.doesNotMatch(await malformed.text(), /private-credential/);
});
