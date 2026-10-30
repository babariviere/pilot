import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { McpStatus, ServerMessage } from "@pilot/protocol";
import { WebSocket } from "ws";
import { type McpProbeResult, McpStatusService } from "./mcp-status.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("MCP API reports status, rechecks, signs in and pushes changes over the control socket", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-mcp-api-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const checks: Array<{ only?: string; finish: (result: McpProbeResult) => void }> = [];
	const logins: string[] = [];
	const mcp = new McpStatusService({
		probe: ({ only }) =>
			new Promise((finish) => {
				checks.push({ ...(only !== undefined ? { only } : {}), finish });
			}),
		login: async (server, { signal }) => {
			logins.push(server);
			await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		},
	});
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
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
		mcp,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const ws = new WebSocket(`${origin.replace("http:", "ws:")}/api/ws`);
	const nextMcp = (matches: (status: McpStatus) => boolean = () => true) =>
		new Promise<McpStatus>((resolve) => {
			const listener = (data: Buffer) => {
				const message = JSON.parse(data.toString()) as ServerMessage;
				if (message.type === "mcp" && matches(message.mcp)) {
					ws.off("message", listener);
					resolve(message.mcp);
				}
			};
			ws.on("message", listener);
		});
	t.after(async () => {
		ws.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await mcp.close().catch(() => {});
		await sessions.shutdown();
		await terminals.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	const initial = nextMcp();
	await once(ws, "open");
	assert.deepEqual(await initial, { servers: [], checking: false });

	const request = (path: string, method = "GET", body?: unknown) =>
		fetch(`${origin}${path}`, {
			method,
			...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
		});
	// Reading status and opening the control socket must not schedule any connection or login.
	assert.deepEqual(await (await request("/api/mcp")).json(), { servers: [], checking: false });
	assert.equal(checks.length, 0);
	assert.deepEqual(logins, []);
	const checked = nextMcp((status) => !status.checking && status.servers.length === 2);
	const started = await request("/api/mcp/check", "POST", {});
	assert.equal(started.status, 200);
	assert.equal(((await started.json()) as McpStatus).checking, true);
	checks[0]!.finish({
		complete: true,
		configProblems: 0,
		servers: [
			{ name: "datadog", transport: "http", state: "needs_sign_in", canSignIn: true },
			{ name: "local", transport: "stdio", state: "connected", tools: 2 },
		],
	});
	assert.equal((await checked).servers[0]?.name, "datadog");
	assert.deepEqual(await (await request("/api/mcp")).json(), mcp.status());
	assert.equal(checks.length, 1, "GET must not recheck a previously reported roster");
	assert.deepEqual(logins, [], "GET must not sign in");

	const waiting = nextMcp((status) => status.servers[0]?.signIn?.state === "waiting");
	const signIn = await request("/api/mcp/servers/datadog/sign-in", "POST", {});
	assert.equal(signIn.status, 200);
	assert.equal(((await signIn.json()) as { state: string }).state, "waiting");
	await waiting;
	assert.deepEqual(logins, ["datadog"]);
	const staleCancel = await request("/api/mcp/servers/datadog/sign-in", "DELETE", { expectedStartedAt: 0 });
	assert.equal(staleCancel.status, 409);
	await staleCancel.arrayBuffer();
	assert.equal(mcp.get("datadog")?.signIn?.state, "waiting");
	const cancelled = await request("/api/mcp/servers/datadog/sign-in", "DELETE");
	assert.equal(((await cancelled.json()) as { state: string }).state, "cancelled");

	for (const [path, method, body, status] of [
		["/api/mcp/servers/local/sign-in", "POST", {}, 409],
		["/api/mcp/servers/missing/sign-in", "POST", {}, 404],
		["/api/mcp/servers/datadog/sign-in", "POST", { again: "yes" }, 400],
		["/api/mcp/check", "POST", { server: 1 }, 400],
		["/api/mcp", "DELETE", undefined, 404],
	] as const) {
		const rejected = await request(path, method, body);
		assert.equal(rejected.status, status, `${method} ${path}`);
		await rejected.arrayBuffer();
	}
});
