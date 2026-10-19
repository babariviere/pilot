import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { McpSetupSnapshot } from "@pilot/protocol";
import { GitHubSetupService } from "./github-setup.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

async function fixture(t: TestContext, readOnly = false) {
	const home = await mkdtemp(join(tmpdir(), "pilot-mcp-setup-api-"));
	const projects = new ProjectStore(home),
		sessions = new SessionManager(home, projects),
		terminals = new TerminalManager();
	const native = new GitHubSetupService(
		home,
		{ hostId: "fixture", daemonId: "fixture", lineageId: "fixture-lineage" },
		{ userHome: home, env: {} },
	);
	await native.status();
	const capability = JSON.parse(await readFile(join(home, "github-app-capability"), "utf8")).token as string;
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0, agentDir: home, mcpSetupReadOnly: readOnly },
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
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
		await terminals.shutdown();
		await native.close();
		await rm(home, { recursive: true, force: true });
	});
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const request = (method = "GET", body?: unknown, token: string | undefined = capability) =>
		fetch(`${origin}/api/mcp/setup`, {
			method,
			headers: { ...(token ? { "x-pilot-github-capability": token } : {}), "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { home, request, capability };
}

test("MCP setup HTTP requires the selected host's native capability for both reads and writes", async (t) => {
	const a = await fixture(t),
		b = await fixture(t);
	const wrongHost = await b.request("GET", undefined, a.capability);
	assert.equal(wrongHost.status, 403);
	await wrongHost.arrayBuffer();
	const denied = await a.request("GET", undefined, "");
	assert.equal(denied.status, 403);
	assert.equal((await denied.json()).error, "native_action_required");
	const initialResponse = await a.request();
	assert.equal(initialResponse.headers.get("cache-control"), "no-store");
	const initial = (await initialResponse.json()) as McpSetupSnapshot;
	assert.equal(initial.exists, false);
	const input = {
		expectedRevision: initial.revision,
		entries: [{ name: "example", config: { url: "https://example.test/mcp" } }],
	};
	const result = await a.request("PUT", input);
	assert.equal(result.status, 200);
	const committed = (await result.json()) as McpSetupSnapshot;
	assert.deepEqual(committed.entries, input.entries);
	assert.deepEqual(await (await a.request()).json(), committed);
	assert.equal(((await (await b.request()).json()) as McpSetupSnapshot).exists, false);
	assert.deepEqual(await (await a.request("PUT", input)).json(), committed);
});

test("MCP setup HTTP rejects secret-bearing input, existing config, read-only mode and malformed files without leaking them", async (t) => {
	const normal = await fixture(t),
		readOnly = await fixture(t, true);
	const initial = (await (await normal.request()).json()) as McpSetupSnapshot;
	const entries = [{ name: "example", config: { url: "https://example.test/mcp" } }];
	const input = { expectedRevision: initial.revision, entries };
	assert.equal((await readOnly.request("PUT", input)).status, 403);
	const unsafe = await normal.request("PUT", {
		...input,
		entries: [{ name: "private", config: { command: "example", args: ["private-token"] } }],
	});
	assert.equal(unsafe.status, 400);
	assert.equal((await unsafe.text()).includes("private-token"), false);
	const original = '{"unknown":"private-value","mcpServers":{}}';
	await writeFile(join(normal.home, "mcp.json"), original);
	const snapshot = (await (await normal.request()).json()) as McpSetupSnapshot;
	const conflict = await normal.request("PUT", { ...input, expectedRevision: snapshot.revision });
	assert.equal(conflict.status, 409);
	assert.equal((await conflict.text()).includes("private-value"), false);
	assert.equal(await readFile(join(normal.home, "mcp.json"), "utf8"), original);
	await writeFile(join(normal.home, "mcp.json"), "private-malformed-json");
	const invalid = await normal.request();
	assert.equal(invalid.status, 503);
	assert.equal((await invalid.text()).includes("private-malformed"), false);
});
