import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiSourceMcpClient } from "./source-mcp.ts";
import { SourceSignInFailed } from "./source-sign-in.ts";

/** A local MCP server behind a minimal OAuth authorization server (discovery, registration, PKCE code flow). */
async function oauthFixture() {
	let issued = 0;
	const valid = new Set<string>();
	const grants: string[] = [];
	const state = { refuseRefresh: false };
	const server = createServer(async (req, res) => {
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const url = new URL(req.url!, origin);
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks).toString();
		const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(JSON.stringify(value));
		};
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
			return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
		if (url.pathname === "/.well-known/oauth-authorization-server")
			return send(200, {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		if (url.pathname === "/register") {
			const metadata = JSON.parse(body);
			return send(201, { ...metadata, client_id: "fixture-client" });
		}
		if (url.pathname === "/authorize") {
			const redirect = new URL(url.searchParams.get("redirect_uri")!);
			redirect.searchParams.set("code", "fixture-code");
			redirect.searchParams.set("state", url.searchParams.get("state")!);
			res.writeHead(302, { location: redirect.href });
			return res.end();
		}
		if (url.pathname === "/token") {
			const form = new URLSearchParams(body);
			grants.push(form.get("grant_type")!);
			if (state.refuseRefresh && form.get("grant_type") === "refresh_token")
				return send(400, { error: "invalid_grant" });
			const token = `token-${++issued}`;
			valid.add(token);
			return send(200, {
				access_token: token,
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: `refresh-${issued}`,
			});
		}
		if (url.pathname !== "/mcp") return send(404, {});
		const token = req.headers.authorization?.replace(/^Bearer /, "");
		if (!token || !valid.has(token))
			return send(
				401,
				{ error: "invalid_token" },
				{
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				},
			);
		if (req.method !== "POST") {
			res.writeHead(405);
			return res.end();
		}
		const message = JSON.parse(body);
		if (!("id" in message)) {
			res.writeHead(202);
			return res.end();
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "fixture", version: "1" },
					}
				: message.method === "tools/list"
					? {
							tools: [
								{ name: "list_issues", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
							],
						}
					: { content: [{ type: "text", text: JSON.stringify({ issues: [], token }) }] };
		send(200, { jsonrpc: "2.0", id: message.id, result });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
		grants,
		valid,
		state,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** Approve in a fake browser: follow the authorization redirect to pi's loopback callback. */
async function approve(authorizationUrl: string) {
	const response = await fetch(authorizationUrl, { redirect: "manual" });
	const callback = await fetch(response.headers.get("location")!);
	assert.equal(callback.status, 200);
}

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
