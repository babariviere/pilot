import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSlackRemovalRoute, parseSlackRemovalRoute, slackRemovalCall } from "./slack-removal-route.ts";
import { decodeMcpResult, PiSourceMcpClient, validSourceArguments } from "./source-mcp.ts";

const route = {
	server: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer fixture-scoped-key" } },
	tool: "remove_reaction",
};
const parent = "1780000000.123456";
const args = { channel_id: "CEXAMPLE", message_ts: parent, emoji: "eyes" };

test("local route owns a strict HTTP server definition with explicit key auth and optional dispatcher", async () => {
	assert.deepEqual(parseSlackRemovalRoute(route), route);
	assert.deepEqual(slackRemovalCall(route, "CEXAMPLE", parent), {
		server: route.server,
		tool: route.tool,
		args: { channel: "CEXAMPLE", ts: parent, name: "eyes" },
	});
	const dispatcher = { tool: "dispatch", nameKey: "operation", argumentsKey: "payload" };
	assert.deepEqual(slackRemovalCall(parseSlackRemovalRoute({ ...route, dispatcher }), "CEXAMPLE", parent), {
		server: route.server,
		tool: "dispatch",
		args: { operation: "remove_reaction", payload: { channel: "CEXAMPLE", ts: parent, name: "eyes" } },
	});
	for (const headers of [{ Authorization: `Bearer \${REMOVAL_KEY}` }, { Authorization: "!read-local-key" }])
		assert.deepEqual(
			parseSlackRemovalRoute({ ...route, server: { ...route.server, headers } }).server.headers,
			headers,
		);
	assert.equal(parseSlackRemovalRoute({ ...route, enabled: false }).enabled, false);
	for (const invalid of [
		undefined,
		null,
		[],
		{},
		{ ...route, server: "my-slack-proxy" },
		{ ...route, token: "secret" },
		{ ...route, enabled: "false" },
		{ ...route, tool: "bad\nname" },
		{ ...route, dispatcher: {} },
		{ ...route, dispatcher: { ...dispatcher, argumentsKey: "operation" } },
		{ ...route, dispatcher: { ...dispatcher, nameKey: "__proto__" } },
		{ ...route, dispatcher: { ...dispatcher, extra: "not allowed" } },
		...[
			{},
			{ command: "must-not-start" },
			{ ...route.server, oauth: {} },
			{ ...route.server, url: "http://public.example.com/mcp" },
			{ ...route.server, url: "https://user:password@mcp.example.com/mcp" },
			{ ...route.server, url: "https://mcp.example.com/mcp#fragment" },
			{ ...route.server, url: "file:///tmp/mcp" },
			{ ...route.server, headers: {} },
			{ ...route.server, headers: { Authorization: "Bearer " } },
			{ ...route.server, headers: { Authorization: "Basic secret" } },
			{ ...route.server, headers: { Authorization: "Bearer key\nextra" } },
			{ ...route.server, headers: { Authorization: "!" } },
			{ ...route.server, headers: { Authorization: "Bearer key", extra: "not allowed" } },
		].map((server) => ({ ...route, server })),
	])
		assert.throws(() => parseSlackRemovalRoute(invalid), /Invalid Slack eyes removal route/);
	const home = await mkdtemp(join(tmpdir(), "slack-route-config-"));
	try {
		await assert.rejects(loadSlackRemovalRoute(home), /unconfigured or invalid/);
		for (const text of ["invalid private fixture", "x".repeat(16 * 1024 + 1), "{}"]) {
			await writeFile(join(home, "tracking.json"), text);
			await assert.rejects(
				loadSlackRemovalRoute(home),
				/^Error: Slack eyes removal route is unconfigured or invalid$/,
			);
		}
		await writeFile(join(home, "tracking.json"), JSON.stringify({ slackEyesRemoval: route }));
		assert.deepEqual(await loadSlackRemovalRoute(home), route);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("removal accepts explicit success only, discards provider text and fixes eyes and parent arguments", () => {
	for (const response of [
		{ structuredContent: { ok: true, channel: "CEXAMPLE", ts: parent, name: "eyes" } },
		{ content: [{ type: "text", text: '{"ok":true}' }] },
	])
		assert.deepEqual(decodeMcpResult(response, "removeSlackEyes"), { ok: true });
	for (const response of [
		{ isError: true, structuredContent: { ok: true } },
		{ structuredContent: { ok: false, error: "no_reaction: private fixture" } },
		{ structuredContent: { ok: true, error: "not authorized: private fixture" } },
		{ isError: true, content: [{ type: "text", text: "not authorized: private fixture" }] },
		{ content: [{ type: "text", text: "Reaction removed" }] },
		{ structuredContent: { error: "already_reacted" } },
		{ structuredContent: null },
	])
		assert.throws(() => decodeMcpResult(response, "removeSlackEyes"), /^Error: Couldn't remove Slack eyes reaction$/);
	assert.ok(validSourceArguments("removeSlackEyes", args));
	for (const invalid of [
		{ ...args, emoji: "white_check_mark" },
		{ ...args, message_ts: "bad" },
		{ ...args, channel_id: "bad" },
		{ ...args, name: "other" },
	])
		assert.equal(validSourceArguments("removeSlackEyes", invalid), false);
});

test("daemon calls only its inline server with a Bearer key, independently of mcp.json and OAuth", async () => {
	const home = await mkdtemp(join(tmpdir(), "slack-route-transport-"));
	const calls: unknown[] = [];
	const requests: Array<{ path?: string; authorization?: string }> = [];
	let rejectKey = false;
	let response: Parameters<typeof decodeMcpResult>[0] = { structuredContent: { ok: true } };
	const server = createServer(async (req, res) => {
		requests.push({ path: req.url, authorization: req.headers.authorization });
		if (rejectKey) {
			res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end("fixture revoked key");
			return;
		}
		if (req.url?.endsWith("/unavailable")) {
			res.writeHead(503).end("private fixture failure");
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const message = JSON.parse(Buffer.concat(chunks).toString());
		if (!("id" in message)) {
			res.writeHead(202).end();
			return;
		}
		let result: unknown = {};
		if (message.method === "initialize")
			result = {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1" },
			};
		if (message.method === "tools/list")
			result = {
				tools: ["remove_reaction", "dispatch"].map((name) => ({
					name,
					inputSchema: { type: "object" },
					annotations: { readOnlyHint: false },
				})),
			};
		if (message.method === "tools/call") {
			calls.push(message.params);
			result = response;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	const local = { ...route, server: { ...route.server, url } };
	const configDir = join(home, "config", "pilot");
	await mkdir(configDir, { recursive: true });
	const client = new PiSourceMcpClient(home, { configDir });
	const signal = new AbortController().signal;
	const configure = (value: unknown) =>
		writeFile(join(configDir, "tracking.json"), JSON.stringify({ slackEyesRemoval: value }));
	const authFile = JSON.stringify({
		[`mcp__pilot-slack-removal|${url}`]: {
			tokens: { access_token: "fixture-old-oauth-token", token_type: "Bearer" },
			tokensExpireAt: Date.now() + 3_600_000,
		},
	});
	try {
		await writeFile(join(home, "pilot-tracking.json"), JSON.stringify({ slackEyesRemoval: local }));
		await writeFile(
			join(home, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"my-slack-proxy": { url },
					slack: { command: "must-not-start" },
					general: { command: "must-not-start" },
				},
			}),
		);
		await writeFile(join(home, "mcp-auth.json"), authFile);
		await assert.rejects(client.call("slack", "removeSlackEyes", args, signal));
		assert.equal(requests.length, 0, "unconfigured inline route never discovers a fallback");
		// Invalid global MCP config must not prevent a separately configured daemon API call.
		await writeFile(join(home, "mcp.json"), "must not be parsed for removal");
		for (const configured of [
			local,
			{ ...local, dispatcher: { tool: "dispatch", nameKey: "name", argumentsKey: "arguments" } },
			{ ...local, dispatcher: { tool: "dispatch", nameKey: "operation", argumentsKey: "payload" } },
			{ ...local, server: { url, headers: { Authorization: "!printf 'Bearer fixture-scoped-key'" } } },
		]) {
			await configure(configured);
			assert.deepEqual(await client.call("slack", "removeSlackEyes", args, signal), { ok: true });
			const expected = slackRemovalCall(configured, "CEXAMPLE", parent);
			assert.deepEqual(calls.at(-1), { name: expected.tool, arguments: expected.args });
		}
		assert.ok(requests.length > 0);
		assert.ok(requests.every((request) => request.authorization === "Bearer fixture-scoped-key"));
		for (const error of ["no_reaction", "not authorized"]) {
			response = { isError: true, content: [{ type: "text", text: `${error}: private fixture detail` }] };
			await assert.rejects(
				client.call("slack", "removeSlackEyes", args, signal),
				(error: Error) =>
					!error.message.includes("private fixture") && /Couldn't remove Slack eyes reaction/.test(error.message),
			);
		}
		rejectKey = true;
		requests.length = 0;
		const callsBeforeRevocation = calls.length;
		await assert.rejects(
			client.call("slack", "removeSlackEyes", args, signal),
			(error: Error) =>
				!error.message.includes("fixture-scoped-key") && !error.message.includes("fixture-old-oauth-token"),
		);
		assert.equal(calls.length, callsBeforeRevocation);
		assert.ok(requests.length > 0);
		assert.ok(
			requests.every((request) => request.authorization === "Bearer fixture-scoped-key" && request.path === "/mcp"),
			"a revoked key cannot fall back to OAuth or attempt authorization discovery",
		);
		rejectKey = false;
		const requestsBeforeInvalid = requests.length;
		for (const invalid of [
			{ ...local, enabled: false },
			{ ...local, server: "my-slack-proxy" },
			{ ...local, server: { url } },
			{ ...local, server: { url, headers: { Authorization: "!exit 1" } } },
		]) {
			await configure(invalid);
			await assert.rejects(client.call("slack", "removeSlackEyes", args, signal));
		}
		assert.equal(requests.length, requestsBeforeInvalid, "disabled, invalid or missing-key config never connects");
		await configure({ ...local, tool: "missing-tool" });
		await assert.rejects(client.call("slack", "removeSlackEyes", args, signal));
		await configure({ ...local, server: { ...local.server, url: `${url}/unavailable` } });
		await assert.rejects(client.call("slack", "removeSlackEyes", args, signal));
		await assert.rejects(client.call("linear", "removeSlackEyes", args, signal), /Unknown dedicated/);
		await assert.rejects(client.call("slack", "remove_reaction", args, signal), /Unknown dedicated/);
		await assert.rejects(client.call("slack", "removeSlackEyes", { ...args, emoji: "other" }, signal), /Invalid/);
		assert.equal(calls.length, callsBeforeRevocation, "missing tools and failures never execute a fallback");
		assert.equal(await readFile(join(home, "mcp-auth.json"), "utf8"), authFile, "OAuth storage is untouched");
	} finally {
		await client.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	}
});
