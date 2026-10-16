import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSlackRemovalRoute, parseSlackRemovalRoute, slackRemovalCall } from "./slack-removal-route.ts";
import { decodeMcpResult, PiSourceMcpClient, validSourceArguments } from "./source-mcp.ts";

const route = { server: "my-slack-proxy", tool: "remove_reaction" };
const parent = "1780000000.123456";
const args = { channel_id: "CEXAMPLE", message_ts: parent, emoji: "eyes" };

test("local route validation is strict and supports direct and configurable dispatcher shapes", async () => {
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
	for (const invalid of [
		undefined,
		null,
		[],
		{},
		{ ...route, server: "" },
		{ ...route, token: "secret" },
		{ ...route, tool: "bad\nname" },
		{ ...route, dispatcher: {} },
		{ ...route, dispatcher: { ...dispatcher, argumentsKey: "operation" } },
		{ ...route, dispatcher: { ...dispatcher, nameKey: "__proto__" } },
		{ ...route, dispatcher: { ...dispatcher, extra: "not allowed" } },
	]) {
		assert.throws(() => parseSlackRemovalRoute(invalid), /Invalid Slack eyes removal route/);
	}
	const home = await mkdtemp(join(tmpdir(), "slack-route-config-"));
	try {
		await assert.rejects(loadSlackRemovalRoute(home), /unconfigured or invalid/);
		for (const text of ["invalid private fixture", "x".repeat(16 * 1024 + 1), "{}"]) {
			await writeFile(join(home, "pilot-tracking.json"), text);
			await assert.rejects(
				loadSlackRemovalRoute(home),
				/^Error: Slack eyes removal route is unconfigured or invalid$/,
			);
		}
		await writeFile(join(home, "pilot-tracking.json"), JSON.stringify({ slackEyesRemoval: route }));
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

test("fake MCP transport uses only the explicit local route, never another server or a raw tool request", async () => {
	const home = await mkdtemp(join(tmpdir(), "slack-route-transport-"));
	const calls: unknown[] = [];
	let response: Parameters<typeof decodeMcpResult>[0] = { structuredContent: { ok: true } };
	const server = createServer(async (req, res) => {
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
	const client = new PiSourceMcpClient(home);
	const signal = new AbortController().signal;
	const configure = (value: unknown) =>
		writeFile(join(home, "pilot-tracking.json"), JSON.stringify({ slackEyesRemoval: value }));
	try {
		await writeFile(
			join(home, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					[route.server]: { url },
					slack: { command: "must-not-start" },
					unused: { command: "must-not-start" },
				},
			}),
		);
		await assert.rejects(client.call("slack", "removeSlackEyes", args, signal));
		assert.equal(calls.length, 0, "unconfigured means no fallback");
		for (const configured of [
			route,
			{ ...route, dispatcher: { tool: "dispatch", nameKey: "name", argumentsKey: "arguments" } },
		]) {
			await configure(configured);
			assert.deepEqual(await client.call("slack", "removeSlackEyes", args, signal), { ok: true });
			const expected = slackRemovalCall(configured, "CEXAMPLE", parent);
			assert.deepEqual(calls.at(-1), { name: expected.tool, arguments: expected.args });
		}
		for (const error of ["no_reaction", "not authorized"]) {
			response = { isError: true, content: [{ type: "text", text: `${error}: private fixture detail` }] };
			await assert.rejects(
				client.call("slack", "removeSlackEyes", args, signal),
				(error: Error) =>
					!error.message.includes("private fixture") && /Couldn't remove Slack eyes reaction/.test(error.message),
			);
		}
		const count = calls.length;
		for (const value of [
			{ ...route, server: "not-configured" },
			{ ...route, tool: "missing-tool" },
		]) {
			await configure(value);
			await assert.rejects(client.call("slack", "removeSlackEyes", args, signal));
		}
		await configure(route);
		for (const config of [
			{ url, enabled: false },
			{ url, toolExposure: { remove_reaction: "hidden" } },
			{ url: `${url}/unavailable` },
		]) {
			await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { [route.server]: config } }));
			await assert.rejects(client.call("slack", "removeSlackEyes", args, signal));
		}
		await assert.rejects(client.call("linear", "removeSlackEyes", args, signal), /Unknown dedicated/);
		await assert.rejects(client.call("slack", "remove_reaction", args, signal), /Unknown dedicated/);
		await assert.rejects(client.call("slack", "removeSlackEyes", { ...args, emoji: "other" }, signal), /Invalid/);
		assert.equal(calls.length, count, "no hidden, disabled, missing or raw tool can execute");
	} finally {
		await client.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	}
});
