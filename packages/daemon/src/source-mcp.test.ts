import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { decodeMcpResult, PiSourceMcpClient, SourceSignInRequired } from "./source-mcp.ts";

test("MCP decoding accepts structured data or JSON envelopes, not markdown or error results", () => {
	assert.deepEqual(
		decodeMcpResult({ structuredContent: { issues: [] }, content: [{ type: "text", text: "ignored" }] }),
		{ issues: [] },
	);
	assert.deepEqual(decodeMcpResult({ content: [{ type: "text", text: '{"issues":[],"cursor":"next"}' }] }), {
		issues: [],
		cursor: "next",
	});
	const slack = { messages: "Channel: #bugs (C1)\n=== Message ===\nMessage TS: 1.2", pagination_info: "cursor" };
	assert.deepEqual(decodeMcpResult({ content: [{ type: "text", text: JSON.stringify(slack) }] }), slack);
	assert.throws(() => decodeMcpResult({ content: [{ type: "text", text: "# Issues\n1. example" }] }));
	assert.throws(() => decodeMcpResult({ isError: true, structuredContent: { secret: "do not display" } }), /error/);
	assert.throws(() => decodeMcpResult({ structuredContent: { text: "x".repeat(513 * 1024) } }), /512/);
});

test("in-flight stdio cancellation waits for process-group shutdown before returning", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-mcp-stdio-"));
	const client = new PiSourceMcpClient(home);
	const marker = join(home, "pids.json");
	let pids: number[] = [];
	try {
		const server = join(home, "server.mjs");
		await writeFile(
			server,
			`
import {createInterface} from "node:readline";
import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
process.on("SIGTERM", () => {});
for await (const line of createInterface({input:process.stdin})) {
 const message = JSON.parse(line);
 if (message.id === undefined) continue;
 let result = {};
 if (message.method === "initialize") result = {protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}};
 if (message.method === "tools/list") result = {tools:[{name:"history",inputSchema:{type:"object"},annotations:{readOnlyHint:true}}]};
 if (message.method === "tools/call") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:"ignore"});
  writeFileSync(process.argv[2], JSON.stringify([process.pid,child.pid]));
  continue;
 }
 console.log(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
}
setInterval(()=>{},1000);
`,
		);
		await writeFile(
			join(home, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					fixture: { command: process.execPath, args: [server, marker] },
				},
			}),
		);
		const controller = new AbortController();
		const pending = client.call(
			{ server: "fixture", tools: { history: "history" } },
			"history",
			{},
			controller.signal,
		);
		// Attach the rejection handler immediately, even if fixture startup unexpectedly fails.
		const settled = assert.rejects(pending, /cancel/);
		for (let i = 0; i < 1000; i++) {
			const data = await readFile(marker, "utf8").catch(() => undefined);
			if (data) {
				pids = JSON.parse(data);
				break;
			}
			await delay(10);
		}
		assert.equal(pids.length, 2, "stdio tool started");
		controller.abort(new Error("cancel stdio"));
		await settled;
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		for (let i = 0; i < 500 && pids.some(alive); i++) await delay(10);
		assert.ok(
			pids.every((pid) => !alive(pid)),
			"both server and child are gone when cancellation completes",
		);
	} finally {
		await client.close();
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		await rm(home, { recursive: true, force: true });
	}
});
test("pinned SDK wrapper reuses stored OAuth, dispatcher/tool bindings and detects required sign-in", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-mcp-"));
	const seen: Array<{ auth?: string; method: string; params?: unknown }> = [];
	let needsAuth = false,
		writes = false,
		hanging = false;
	let called!: () => void;
	const server = createServer(async (req, res) => {
		if (needsAuth) {
			res.writeHead(401, { "www-authenticate": "Bearer" });
			res.end("not signed in");
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const message = JSON.parse(Buffer.concat(chunks).toString());
		seen.push({ auth: req.headers.authorization, method: message.method, params: message.params });
		if (!("id" in message)) {
			res.writeHead(202);
			res.end();
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
				tools: [{ name: "CALL_TOOL", inputSchema: { type: "object" }, annotations: { readOnlyHint: !writes } }],
			};
		if (message.method === "tools/call" && hanging) {
			called();
			return;
		}
		if (message.method === "tools/call") result = { content: [{ type: "text", text: '{"issues":[]}' }] };
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	try {
		await writeFile(
			join(home, "mcp.json"),
			JSON.stringify({ mcpServers: { fixture: { url }, unused: { command: "must-not-start" } } }),
		);
		await writeFile(
			join(home, "mcp-auth.json"),
			JSON.stringify({
				[`mcp__fixture|${url}`]: {
					tokens: { access_token: "fixture-token", token_type: "Bearer" },
					tokensExpireAt: Date.now() + 3600000,
				},
			}),
		);
		const client = new PiSourceMcpClient(home),
			signal = new AbortController().signal;
		const binding = { server: "fixture", tools: { issues: "LINEAR_LIST" }, dispatchTool: "CALL_TOOL" };
		assert.deepEqual(await client.call(binding, "issues", { team: "ENG" }, signal), { issues: [] });
		assert.ok(
			seen.some((request) => request.auth === "Bearer fixture-token"),
			"pi OAuth key format is shared",
		);
		assert.deepEqual(seen.find((request) => request.method === "tools/call")?.params, {
			name: "CALL_TOOL",
			arguments: { name: "LINEAR_LIST", arguments: { team: "ENG" } },
		});
		needsAuth = true;
		await assert.rejects(client.call(binding, "issues", {}, signal), SourceSignInRequired);
		await assert.rejects(client.call(binding, "missing", {}, signal), /No MCP tool/);
		const abort = new AbortController();
		abort.abort(new Error("cancel"));
		await assert.rejects(client.call(binding, "issues", {}, abort.signal), /cancel/);
		needsAuth = false;
		writes = true;
		const before = seen.filter((request) => request.method === "tools/call").length;
		await assert.rejects(client.call(binding, "issues", {}, signal), /MCP request failed/);
		assert.equal(
			seen.filter((request) => request.method === "tools/call").length,
			before,
			"write-annotated tools never execute",
		);
		writes = false;
		hanging = true;
		const received = new Promise<void>((resolve) => {
			called = resolve;
		});
		const controller = new AbortController();
		const pending = client.call(binding, "issues", {}, controller.signal);
		await received;
		controller.abort(new Error("cancel in flight"));
		await assert.rejects(pending, /cancel in flight/);
		await client.close();
		await assert.rejects(client.call(binding, "issues", {}, signal), /stopped/);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	}
});
