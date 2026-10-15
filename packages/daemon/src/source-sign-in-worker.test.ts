import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approve, oauthFixture } from "./mcp-test-fixtures.ts";
import { PiSourceMcpClient } from "./source-mcp.ts";
import { SourceSignInFailed } from "./source-sign-in.ts";

test("pinned SDK sign-in runs pi's OAuth flow, stores tokens like pi mcp login and signs in again safely", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-mcp-sign-in-"));
	const server = await oauthFixture();
	const opened: string[] = [];
	let browser: (url: string) => Promise<void> = approve;
	const client = new PiSourceMcpClient(home, {
		openUrl: async (url) => {
			opened.push(url);
			await browser(url);
		},
	});
	t.after(async () => {
		await client.close();
		await server.close();
		await rm(home, { recursive: true, force: true });
	});
	await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: server.url } } }));
	const signal = new AbortController().signal;
	const key = `mcp__linear|${server.url}`;
	const stored = async () => JSON.parse(await readFile(join(home, "mcp-auth.json"), "utf8"))[key];

	await client.signIn("linear", { again: false, signal });
	assert.equal(opened.length, 1);
	assert.equal(new URL(opened[0]!).pathname, "/authorize");
	assert.equal((await stored()).tokens.access_token, "token-1", "same key and file as pi mcp login");
	assert.deepEqual(await client.call("linear", "issues", {}, signal), { issues: [], token: "token-1" });

	// Already signed in: nothing opens.
	await client.signIn("linear", { again: false, signal });
	assert.equal(opened.length, 1);

	// Sign in again, then cancel in the browser step: the working sign-in stays.
	const cancel = new AbortController();
	browser = async () => cancel.abort(new Error("cancelled by user"));
	await assert.rejects(client.signIn("linear", { again: true, signal: cancel.signal }), /cancelled by user/);
	assert.equal(opened.length, 2, "again opens the browser even with working tokens");
	assert.equal((await stored()).tokens.access_token, "token-1");
	assert.deepEqual(await client.call("linear", "issues", {}, signal), { issues: [], token: "token-1" });

	// Sign in again for real: a new authorization, never a silent refresh of the old grant.
	browser = approve;
	await client.signIn("linear", { again: true, signal });
	assert.equal((await stored()).tokens.access_token, "token-2");
	assert.ok(!server.grants.includes("refresh_token"));
	assert.deepEqual(await client.call("linear", "issues", {}, signal), { issues: [], token: "token-2" });

	// Expired or revoked tokens: sign-in required, then a fresh browser flow.
	server.valid.clear();
	server.state.refuseRefresh = true;
	await client.signIn("linear", { again: false, signal });
	assert.equal(opened.length, 4);
	assert.deepEqual(await client.call("linear", "issues", {}, signal), { issues: [], token: "token-3" });

	await assert.rejects(
		client.signIn("slack", { again: false, signal }),
		(error) => error instanceof SourceSignInFailed && /no MCP server named slack/.test(error.message),
	);
	await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { slack: { command: "must-not-start" } } }));
	await assert.rejects(
		client.signIn("slack", { again: false, signal }),
		(error) => error instanceof SourceSignInFailed && /browser sign-in/.test(error.message),
	);
});
