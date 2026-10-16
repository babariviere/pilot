import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	decodeMcpResult,
	dedicatedSourceTool,
	PiSourceMcpClient,
	SourceRateLimited,
	SourceSignInRequired,
	sourceRateLimit,
	validSourceArguments,
} from "./source-mcp.ts";

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

test("Linear exposes fixed read tools and exactly one narrow state write and preserves sanitized retry-after timing", () => {
	assert.equal(dedicatedSourceTool("linear", "startIssue"), "save_issue");
	assert.equal(dedicatedSourceTool("slack", "startIssue"), undefined);
	assert.equal(dedicatedSourceTool("linear", "save_issue"), undefined);
	assert.equal(dedicatedSourceTool("linear", "states"), "list_issue_statuses");
	assert.equal(dedicatedSourceTool("linear", "me"), "get_user");
	assert.equal(dedicatedSourceTool("linear", "cycles"), "list_cycles");
	assert.equal(dedicatedSourceTool("linear", "issue"), "get_issue");
	assert.equal(dedicatedSourceTool("linear", "issues"), "list_issues");
	assert.equal(dedicatedSourceTool("linear", "update_issue"), undefined);
	assert.equal(dedicatedSourceTool("slack", "issue"), undefined);
	assert.equal(sourceRateLimit({ status: 429, headers: { "retry-after": "120" } })?.retryAfterMs, 120_000);
	assert.equal(sourceRateLimit(new Error("Too many requests"))?.retryAfterMs, 60_000);
	assert.throws(
		() =>
			decodeMcpResult({ isError: true, content: [{ type: "text", text: "Rate limited; retry-after: 90; secret" }] }),
		(error) =>
			error instanceof SourceRateLimited && error.retryAfterMs === 90_000 && !error.message.includes("secret"),
	);
});

test("Slack start exposes only the fixed eyes reaction and normalizes success without leaking provider text", () => {
	assert.equal(dedicatedSourceTool("slack", "startSlack"), "slack_add_reaction");
	assert.equal(dedicatedSourceTool("linear", "startSlack"), undefined);
	for (const tool of ["slack_add_reaction", "slack_remove_reaction", "slack_send_message", "slack_reply_to_thread"])
		assert.equal(dedicatedSourceTool("slack", tool), undefined);
	const args = { channel_id: "CEXAMPLE", message_ts: "1780000000.123456", emoji: "eyes" };
	assert.equal(validSourceArguments("startSlack", args), true);
	for (const invalid of [
		{ ...args, emoji: "white_check_mark" },
		{ ...args, emoji: ":eyes:" },
		{ ...args, text: "not allowed" },
		{ ...args, channel_id: "#bugs" },
		{ ...args, message_ts: "no" },
		{ ...args, emoji: undefined },
	])
		assert.equal(validSourceArguments("startSlack", invalid), false);
	for (const response of [
		{ structuredContent: { ok: true, private: "do not retain" } },
		{ content: [{ type: "text", text: '{"success":true}' }] },
		{ content: [{ type: "text", text: "Reaction :eyes: added to message (private detail)." }] },
	])
		assert.deepEqual(decodeMcpResult(response, "startSlack"), { ok: true });
	for (const response of [
		{ structuredContent: { ok: false, error: "missing_scope" } },
		{ isError: true, content: [{ type: "text", text: "Error: reaction could not be added (private)" }] },
		{ content: [{ type: "text", text: "unexpected response" }] },
		{ content: [{ type: "text", text: "Error: not_already_reacted" }] },
	])
		assert.throws(() => decodeMcpResult(response, "startSlack"), /Couldn't add Slack reaction/);
	assert.throws(
		() => decodeMcpResult({ isError: true, structuredContent: { error: "already_reacted" } }),
		/error/,
		"the exception never applies to other tools",
	);
});

test("check reads expose only reaction metadata and Done writes are fixed to white_check_mark", () => {
	assert.equal(dedicatedSourceTool("slack", "reactions"), "slack_get_reactions");
	assert.equal(dedicatedSourceTool("slack", "doneSlack"), "slack_add_reaction");
	assert.equal(dedicatedSourceTool("linear", "doneSlack"), undefined);
	const args = { channel_id: "CEXAMPLE", message_ts: "1780000000.123456", emoji: "white_check_mark" };
	assert.equal(validSourceArguments("doneSlack", args), true);
	for (const invalid of [
		{ ...args, emoji: "eyes" },
		{ ...args, name: "white_check_mark" },
		{ ...args, emoji: ":white_check_mark:" },
	])
		assert.equal(validSourceArguments("doneSlack", invalid), false);
	const { emoji: _, ...readArgs } = args;
	assert.equal(validSourceArguments("reactions", readArgs), true);
	assert.equal(validSourceArguments("reactions", args), false);
	for (const response of [
		{ structuredContent: { reactions: [{ name: "white_check_mark", count: 2, users: ["private-name"] }] } },
		{ content: [{ type: "text", text: '{"reactions":[{"name":"white_check_mark","count":1}]}' }] },
		{ content: [{ type: "text", text: "Reactions:\n:white_check_mark: (2)\nUsers: private-name" }] },
		{
			content: [
				{
					type: "text",
					text: JSON.stringify({
						result:
							"Reactions on message:\n\n:eyes: × 1 — Someone (U000000001)\n:white_check_mark: × 2 — Someone (U000000001)",
					}),
				},
			],
		},
	])
		assert.deepEqual(decodeMcpResult(response, "reactions"), { present: true });
	for (const result of [
		"No reactions found on this message.",
		"Reactions on message:\n\n:fire: × 3 — Someone (U000000001)\n:pray: × 1 — Someone (U000000001)",
		"Reactions on message:\n\n:white_check_mark: × 0 — ",
	])
		assert.deepEqual(
			decodeMcpResult({ content: [{ type: "text", text: JSON.stringify({ result }) }] }, "reactions"),
			{
				present: false,
			},
		);
	for (const reactions of [
		[],
		[{ name: "eyes", count: 2 }],
		[{ name: "white_check_mark", count: 0 }],
		"No reactions on this message.",
	])
		assert.deepEqual(decodeMcpResult({ structuredContent: { reactions } }, "reactions"), { present: false });
	assert.deepEqual(
		decodeMcpResult(
			{ structuredContent: { message: { text: "Reactions: white_check_mark (1)", reactions: [] } } },
			"reactions",
		),
		{ present: false },
	);
	for (const response of [
		{ structuredContent: { reactions: [{ name: "white_check_mark", count: -1 }] } },
		{ content: [{ type: "text", text: "white_check_mark" }] },
		{ structuredContent: { ok: false, error: "private" } },
	])
		assert.throws(() => decodeMcpResult(response, "reactions"), /Slack reactions response|read Slack reactions/);
	assert.deepEqual(decodeMcpResult({ isError: true, structuredContent: { error: "already_reacted" } }, "doneSlack"), {
		ok: true,
	});
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
 if (message.method === "tools/list") result = {tools:[{name:"slack_read_channel",inputSchema:{type:"object"},annotations:{readOnlyHint:true}}]};
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
					slack: { command: process.execPath, args: [server, marker] },
				},
			}),
		);
		const controller = new AbortController();
		const pending = client.call("slack", "history", {}, controller.signal);
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
test("pinned SDK wrapper calls fixed dedicated tools, reuses OAuth and detects required sign-in", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-mcp-"));
	const seen: Array<{ auth?: string; method: string; params?: unknown }> = [];
	let needsAuth = false,
		writes = false,
		hanging = false,
		limited = false;
	let reactionResponse: Parameters<typeof decodeMcpResult>[0] | undefined;
	let reactionThrows = false;
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
				tools: [
					"list_issues",
					"list_cycles",
					"get_issue",
					"list_issue_statuses",
					"get_user",
					"save_issue",
					"slack_read_channel",
					"slack_read_user_profile",
					"slack_search_public",
					"slack_search_public_and_private",
					"slack_read_thread",
					"slack_get_reactions",
					"slack_add_reaction",
				].map((name) => ({
					name,
					inputSchema: { type: "object" },
					annotations: { readOnlyHint: name !== "save_issue" && name !== "slack_add_reaction" && !writes },
				})),
			};
		if (message.method === "tools/call" && hanging) {
			called();
			return;
		}
		if (message.method === "tools/call" && message.params.name === "slack_add_reaction" && reactionThrows) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32000, message: "Slack API error: already_reacted (private detail)" },
				}),
			);
			return;
		}
		if (message.method === "tools/call")
			result =
				message.params.name === "slack_add_reaction" && reactionResponse
					? reactionResponse
					: limited
						? {
								isError: true,
								content: [{ type: "text", text: "Rate limit exceeded; retry-after: 120; secret" }],
							}
						: { content: [{ type: "text", text: '{"issues":[]}' }] };
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	try {
		await writeFile(
			join(home, "mcp.json"),
			JSON.stringify({ mcpServers: { linear: { url }, slack: { url }, unused: { command: "must-not-start" } } }),
		);
		await writeFile(
			join(home, "mcp-auth.json"),
			JSON.stringify({
				[`mcp__linear|${url}`]: {
					tokens: { access_token: "fixture-token", token_type: "Bearer" },
					tokensExpireAt: Date.now() + 3600000,
				},
			}),
		);
		const client = new PiSourceMcpClient(home),
			signal = new AbortController().signal;
		assert.deepEqual(await client.call("linear", "issues", { team: "ENG" }, signal), { issues: [] });
		assert.ok(
			seen.some((request) => request.auth === "Bearer fixture-token"),
			"pi OAuth key format is shared",
		);
		assert.deepEqual(seen.find((request) => request.method === "tools/call")?.params, {
			name: "list_issues",
			arguments: { team: "ENG" },
		});
		await client.call("slack", "history", { channel_id: "C1" }, signal);
		await client.call("slack", "thread", { channel_id: "C1", message_ts: "1.2" }, signal);
		await client.call("slack", "profile", { response_format: "detailed" }, signal);
		await client.call("slack", "mentions", { filters: "in:<#C1>", keywords: ["<@U1>"] }, signal);
		await client.call(
			"slack",
			"mentionsPrivate",
			{ filters: "in:<#C1>", keywords: ["<@U1>"], channel_types: "public_channel,private_channel" },
			signal,
		);
		assert.deepEqual(
			seen.filter((request) => request.method === "tools/call").map((request) => request.params),
			[
				{ name: "list_issues", arguments: { team: "ENG" } },
				{ name: "slack_read_channel", arguments: { channel_id: "C1" } },
				{ name: "slack_read_thread", arguments: { channel_id: "C1", message_ts: "1.2" } },
				{ name: "slack_read_user_profile", arguments: { response_format: "detailed" } },
				{ name: "slack_search_public", arguments: { filters: "in:<#C1>", keywords: ["<@U1>"] } },
				{
					name: "slack_search_public_and_private",
					arguments: { filters: "in:<#C1>", keywords: ["<@U1>"], channel_types: "public_channel,private_channel" },
				},
			],
		);
		await client.call("linear", "cycles", { teamId: "ENG", type: "current" }, signal);
		await client.call("linear", "issue", { id: "issue-1", fields: ["description"] }, signal);
		assert.deepEqual(
			seen
				.filter((request) => request.method === "tools/call")
				.slice(-2)
				.map((request) => request.params),
			[
				{ name: "list_cycles", arguments: { teamId: "ENG", type: "current" } },
				{ name: "get_issue", arguments: { id: "issue-1", fields: ["description"] } },
			],
		);
		limited = true;
		await assert.rejects(
			client.call("linear", "cycles", { teamId: "ENG", type: "current" }, signal),
			(error) =>
				error instanceof SourceRateLimited && error.retryAfterMs === 120_000 && !error.message.includes("secret"),
		);
		limited = false;
		await assert.rejects(client.call("alternative" as never, "issues", {}, signal), /Unknown dedicated MCP/);
		await assert.rejects(client.call("linear", "history", {}, signal), /Unknown dedicated MCP/);
		needsAuth = true;
		await assert.rejects(client.call("linear", "issues", {}, signal), SourceSignInRequired);
		await assert.rejects(client.call("linear", "missing", {}, signal), /Unknown dedicated MCP/);
		const abort = new AbortController();
		abort.abort(new Error("cancel"));
		await assert.rejects(client.call("linear", "issues", {}, abort.signal), /cancel/);
		needsAuth = false;
		writes = true;
		const before = seen.filter((request) => request.method === "tools/call").length;
		for (const tool of ["issues", "cycles", "issue"])
			await assert.rejects(client.call("linear", tool, {}, signal), /MCP request failed/);
		assert.equal(
			seen.filter((request) => request.method === "tools/call").length,
			before,
			"write-annotated tools never execute",
		);
		await client.call("linear", "startIssue", { id: "issue-1", state: "started-1" }, signal);
		assert.deepEqual(seen.filter((request) => request.method === "tools/call").at(-1)?.params, {
			name: "save_issue",
			arguments: { id: "issue-1", state: "started-1" },
		});
		const beforeInvalid = seen.length;
		for (const args of [
			{ state: "started-1" },
			{ id: "issue-1" },
			{ id: "issue-1", state: "" },
			{ id: "issue-1", state: "started-1", title: "not allowed" },
		])
			await assert.rejects(client.call("linear", "startIssue", args, signal), /Invalid Linear/);
		for (const tool of ["save_issue", "update_issue", "create_issue", "save_comment", "delete_issue"])
			await assert.rejects(client.call("linear", tool, {}, signal), /Unknown dedicated MCP/);
		assert.equal(seen.length, beforeInvalid, "invalid writes never connect");
		const reactionArgs = { channel_id: "CEXAMPLE", message_ts: "1780000000.123456", emoji: "eyes" };
		for (const response of [
			{ structuredContent: { ok: true } },
			{ isError: true, structuredContent: { ok: false, error: "already_reacted" } },
			{ isError: true, content: [{ type: "text", text: "Slack API error: already_reacted (private detail)" }] },
		]) {
			reactionResponse = response;
			assert.deepEqual(await client.call("slack", "startSlack", reactionArgs, signal), { ok: true });
			assert.deepEqual(seen.filter((request) => request.method === "tools/call").at(-1)?.params, {
				name: "slack_add_reaction",
				arguments: reactionArgs,
			});
		}
		const doneArgs = { ...reactionArgs, emoji: "white_check_mark" };
		assert.deepEqual(await client.call("slack", "doneSlack", doneArgs, signal), { ok: true });
		assert.deepEqual(seen.filter((request) => request.method === "tools/call").at(-1)?.params, {
			name: "slack_add_reaction",
			arguments: doneArgs,
		});
		reactionResponse = { isError: true, content: [{ type: "text", text: "missing_scope: private detail" }] };
		reactionThrows = true;
		assert.deepEqual(await client.call("slack", "startSlack", reactionArgs, signal), { ok: true });
		reactionThrows = false;
		await assert.rejects(
			client.call("slack", "startSlack", reactionArgs, signal),
			(error: Error) => /Couldn't add Slack reaction/.test(error.message) && !error.message.includes("private"),
		);
		const beforeInvalidSlack = seen.length;
		await assert.rejects(client.call("slack", "startSlack", { ...reactionArgs, emoji: "other" }, signal), /Invalid/);
		await assert.rejects(
			client.call("slack", "startSlack", { ...reactionArgs, text: "no messages" }, signal),
			/Invalid/,
		);
		assert.equal(seen.length, beforeInvalidSlack);

		writes = false;
		const requestsBeforeMissing = seen.length;
		await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { alternative: { url } } }));
		await assert.rejects(client.call("linear", "issues", {}, signal), /MCP request failed/);
		await assert.rejects(client.call("slack", "startSlack", reactionArgs, signal), /MCP request failed/);
		assert.equal(seen.length, requestsBeforeMissing, "a different server is never a fallback");
		await writeFile(
			join(home, "mcp.json"),
			JSON.stringify({
				mcpServers: { linear: { url, enabled: false }, alternative: { url } },
			}),
		);
		await assert.rejects(client.call("linear", "issues", {}, signal), /MCP request failed/);
		assert.equal(seen.length, requestsBeforeMissing, "a disabled dedicated server is not substituted");
		await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { linear: { url } } }));
		hanging = true;
		const received = new Promise<void>((resolve) => {
			called = resolve;
		});
		const controller = new AbortController();
		const pending = client.call("linear", "issues", {}, controller.signal);
		await received;
		controller.abort(new Error("cancel in flight"));
		await assert.rejects(pending, /cancel in flight/);
		await client.close();
		await assert.rejects(client.call("linear", "issues", {}, signal), /stopped/);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	}
});
