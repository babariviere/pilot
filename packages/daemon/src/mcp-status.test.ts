import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { McpStatus } from "@pilot/protocol";
import { NotFound } from "./errors.ts";
import {
	type McpProbe,
	type McpProbeResult,
	type McpProbeServer,
	McpStatusService,
	SignInUnavailable,
	workerProbe,
} from "./mcp-status.ts";
import { approve, oauthFixture } from "./mcp-test-fixtures.ts";
import { PiSourceMcpClient } from "./source-mcp.ts";

/** Resolves when `predicate` holds for a published status. */
function until(service: McpStatusService, predicate: (status: McpStatus) => boolean): Promise<McpStatus> {
	return new Promise((resolve) => {
		if (predicate(service.status())) return resolve(service.status());
		const stop = service.onChange((status) => {
			if (!predicate(status)) return;
			stop();
			resolve(status);
		});
	});
}

/** A probe whose checks finish when the test says so. */
function manualProbe() {
	const calls: Array<{ only?: string; finish: (result: McpProbeResult) => void }> = [];
	const probe: McpProbe = ({ only }) =>
		new Promise((resolve) => {
			calls.push({ ...(only !== undefined ? { only } : {}), finish: resolve });
		});
	return { probe, calls };
}

const server = (name: string, state: McpProbeServer["state"], extra: Partial<McpProbeServer> = {}): McpProbeServer => ({
	name,
	transport: "http",
	state,
	...extra,
});

test("status lists servers needing the user first and merges checks requested while one runs", async () => {
	const { probe, calls } = manualProbe();
	const service = new McpStatusService({ probe });
	service.start();
	assert.deepEqual(service.status(), { servers: [], checking: true });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.only, undefined, "the first check covers every server");

	calls[0]!.finish({
		complete: true,
		configProblems: 1,
		servers: [
			server("zeta", "connected", { tools: 3 }),
			server("alpha", "disabled"),
			server("datadog", "needs_sign_in", { canSignIn: true }),
			server("local", "failed", { transport: "stdio", problem: "Couldn't start the server." }),
		],
	});
	const checked = await until(service, (status) => !status.checking);
	assert.deepEqual(
		checked.servers.map((entry) => [entry.name, entry.state]),
		[
			["datadog", "needs_sign_in"],
			["local", "failed"],
			["zeta", "connected"],
			["alpha", "disabled"],
		],
	);
	assert.equal(checked.configProblems, 1);
	assert.ok(checked.servers.every((entry) => typeof entry.checkedAt === "number"));

	// One server, then two more requests while it runs: they merge into one follow-up check of everything.
	assert.equal(service.check("local").checking, true);
	assert.equal(calls[1]!.only, "local");
	service.check("zeta");
	service.check();
	assert.equal(calls.length, 2, "nothing starts while a check runs");
	calls[1]!.finish({ complete: false, configProblems: 0, servers: [] });
	await until(service, () => calls.length === 3);
	assert.equal(calls[2]!.only, undefined);
	assert.equal(service.get("local"), undefined, "a server gone from mcp.json disappears");
	assert.equal(service.status().checking, true, "servers keep their last state while the follow-up runs");
	assert.equal(service.get("datadog")?.state, "needs_sign_in");

	// Unknown names check everything rather than nothing.
	calls[2]!.finish({ complete: true, configProblems: 0, servers: [server("datadog", "connected", { tools: 9 })] });
	await until(service, (status) => !status.checking);
	service.check("missing");
	assert.equal(calls[3]!.only, undefined);
	calls[3]!.finish({ cancelled: true });
	await until(service, (status) => !status.checking);
	assert.equal(service.get("datadog")?.tools, 9, "a cancelled or failed check keeps the last result");
	await service.close();
});

test("sign-in runs only for servers that use it, reports progress and rechecks the server when done", async () => {
	const { probe, calls } = manualProbe();
	const logins: Array<{ server: string; again: boolean; finish: () => void }> = [];
	const service = new McpStatusService({
		probe,
		login: (name, { again, signal }) =>
			new Promise<void>((resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				logins.push({ server: name, again, finish: resolve });
			}),
	});
	service.start();
	calls[0]!.finish({
		complete: true,
		configProblems: 0,
		servers: [
			server("datadog", "needs_sign_in", { canSignIn: true }),
			server("local", "failed", { transport: "stdio" }),
		],
	});
	await until(service, (status) => !status.checking);

	assert.throws(() => service.signIn("missing"), NotFound);
	assert.throws(() => service.signIn("local"), SignInUnavailable);
	const waiting = service.signIn("datadog");
	assert.equal(waiting.state, "waiting");
	assert.equal(service.signIn("datadog").startedAt, waiting.startedAt, "repeated clicks reuse the running sign-in");
	while (logins.length === 0) await delay(5);
	assert.deepEqual(
		logins.map(({ server, again }) => [server, again]),
		[["datadog", false]],
	);
	assert.equal(service.get("datadog")?.signIn?.state, "waiting");

	logins[0]!.finish();
	await until(service, () => calls.length === 2);
	assert.equal(calls[1]!.only, "datadog", "a finished sign-in rechecks only that server");
	calls[1]!.finish({
		complete: false,
		configProblems: 0,
		servers: [server("datadog", "connected", { canSignIn: true, tools: 4 })],
	});
	const done = await until(service, (status) => !status.checking);
	assert.equal(done.servers[1]?.name, "datadog");
	assert.equal(done.servers[1]?.state, "connected");
	assert.equal(done.servers[1]?.signIn?.state, "done");

	service.signIn("datadog", true);
	assert.equal(service.cancelSignIn("datadog")?.state, "cancelled");
	await service.close();
});

test("edits to mcp.json or a sign-in elsewhere trigger one debounced check; the service never polls", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-mcp-watch-"));
	const { probe, calls } = manualProbe();
	const service = new McpStatusService({ probe, watchDir: dir, debounceMs: 20 });
	t.after(async () => {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	});
	service.start();
	calls[0]!.finish({ complete: true, configProblems: 0, servers: [] });
	await until(service, (status) => !status.checking);

	await writeFile(join(dir, "notes.txt"), "ignored");
	await delay(100);
	assert.equal(calls.length, 1, "other files are ignored");

	await writeFile(join(dir, "mcp.json"), "{}");
	await writeFile(join(dir, "mcp-auth.json"), "{}");
	await until(service, () => calls.length === 2);
	calls[1]!.finish({ complete: true, configProblems: 0, servers: [server("datadog", "connected")] });
	await until(service, (status) => !status.checking);
	await delay(100);
	assert.equal(calls.length, 2, "a burst of writes costs one check");
});

test("pinned SDK check reports connected, signed-out, failing and disabled servers without their error text", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-mcp-status-"));
	const oauth = await oauthFixture();
	const client = new PiSourceMcpClient(home, { openUrl: approve });
	const service = new McpStatusService({
		probe: workerProbe(home, 5_000),
		login: (name, options) => client.signInServer(name, options),
	});
	t.after(async () => {
		await service.close();
		await client.close();
		await oauth.close();
		await rm(home, { recursive: true, force: true });
	});
	const stdio = join(home, "server.mjs");
	await writeFile(
		stdio,
		`
import {createInterface} from "node:readline";
for await (const line of createInterface({input:process.stdin})) {
 const message = JSON.parse(line);
 if (message.id === undefined) continue;
 let result = {};
 if (message.method === "initialize") result = {protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}};
 if (message.method === "tools/list") result = {tools:[{name:"a",inputSchema:{type:"object"}},{name:"b",inputSchema:{type:"object"}}]};
 console.log(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
}
`,
	);
	await writeFile(
		join(home, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				local: { command: process.execPath, args: [stdio] },
				remote: { url: oauth.url },
				broken: { command: join(home, "secret-token-missing-binary") },
				off: { command: "never-started", enabled: false },
			},
		}),
	);
	service.start();
	const checked = await until(service, (status) => !status.checking && status.servers.length === 4);
	assert.deepEqual(
		checked.servers.map(({ name, transport, state, tools, problem, canSignIn }) => ({
			name,
			transport,
			state,
			...(tools !== undefined ? { tools } : {}),
			...(problem ? { problem } : {}),
			...(canSignIn ? { canSignIn } : {}),
		})),
		[
			{ name: "remote", transport: "http", state: "needs_sign_in", canSignIn: true },
			{ name: "broken", transport: "stdio", state: "failed", problem: "Couldn't start the server." },
			{ name: "local", transport: "stdio", state: "connected", tools: 2 },
			{ name: "off", transport: "stdio", state: "disabled" },
		],
	);
	assert.ok(!JSON.stringify(checked).includes("secret-token"), "no command, path or error text leaves pilotd");

	service.signIn("remote");
	const signedIn = await until(service, (status) =>
		status.servers.some((s) => s.name === "remote" && s.state === "connected"),
	);
	const remote = signedIn.servers.find((entry) => entry.name === "remote")!;
	assert.equal(remote.tools, 1);
	assert.equal(remote.signIn?.state, "done");
});
