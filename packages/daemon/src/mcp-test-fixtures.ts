import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A local MCP server behind a minimal OAuth authorization server (discovery, registration, PKCE code flow). */
export async function oauthFixture() {
	let issued = 0;
	const valid = new Set<string>();
	const grants: string[] = [];
	const refreshTokens = new Set<string>();
	const state = { refuseRefresh: false, rotatingRefresh: false, dropRefreshReply: false };
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
			if (
				state.rotatingRefresh &&
				form.get("grant_type") === "refresh_token" &&
				!refreshTokens.delete(form.get("refresh_token")!)
			)
				return send(400, { error: "invalid_grant" });
			if (state.refuseRefresh && form.get("grant_type") === "refresh_token")
				return send(400, { error: "invalid_grant" });
			const token = `token-${++issued}`;
			if (state.rotatingRefresh && form.get("grant_type") === "refresh_token") valid.clear();
			valid.add(token);
			refreshTokens.add(`refresh-${issued}`);
			if (state.dropRefreshReply && form.get("grant_type") === "refresh_token") {
				req.socket.destroy();
				return;
			}
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
export async function approve(authorizationUrl: string) {
	const response = await fetch(authorizationUrl, { redirect: "manual" });
	const callback = await fetch(response.headers.get("location")!);
	assert.equal(callback.status, 200);
}
