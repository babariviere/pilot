/** Browser sign-in to a server in the user's global mcp.json, the way `pi mcp login` does it: same pinned SDK flow,
 * same locked mcp-auth.json and refresh locks. Runs off the daemon event loop. The authorization URL goes to
 * the parent, which opens the browser; tokens never leave pi's credential store.
 */
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { LoadedMcpConfig, McpServerEntry, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { credentialClient } from "@pilot/kernel/credential-client";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";

type OAuthState = { tokens?: unknown; tokensExpireAt?: number; clientInformation?: { client_id?: string } };
type OAuthStore = {
	load(): OAuthState | undefined | Promise<OAuthState | undefined>;
	save(state: OAuthState): void | Promise<void>;
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
};
interface Connection {
	state: string;
	challenge: unknown;
	readonly oauthUrl: string | undefined;
	oauthSettings(): unknown;
	getClient(): Promise<unknown>;
	reconnect(): Promise<void>;
	close(): Promise<void>;
}
await installCredentialBrokerHooks();
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const paths = (await import(new URL("./config.js", sdk).href)) as { getAgentDir(): string };
const config = (await import(new URL("./extensions/mcp/config.js", sdk).href)) as {
	loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
};
const runtime = (await import(new URL("./extensions/mcp/runtime.js", sdk).href)) as {
	createDefaultTransport: McpTransportFactory;
	McpOAuthCredentialStore: new (
		backend: unknown,
		lockDir: string,
	) => { forServer(name: string, url: string): OAuthStore };
	McpServerConnection: new (options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport: McpTransportFactory;
		credentials: unknown;
		onTools: () => void;
	}) => Connection;
	McpSignInCancelledError: new () => Error;
	signInMcpServer(options: {
		serverUrl: string;
		store: OAuthStore;
		settings: unknown;
		challenge: unknown;
		prompt: {
			showAuthorizationUrl(url: URL): void;
			promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
		};
	}): Promise<void>;
};
const auth = (await import(new URL("./core/auth-storage.js", sdk).href)) as {
	FileAuthStorageBackend: new (path: string) => unknown;
};

/** A message that is safe to show: never server text, config values or credentials. */
class Problem extends Error {}

/** Sign in again: hide the stored tokens from the flow so it cannot reuse them through a refresh, but keep
 * them on disk until new tokens arrive, so a cancelled or failed attempt leaves the current sign-in working. */
function withoutStoredTokens(store: OAuthStore): OAuthStore {
	let replaced = false;
	return {
		async load() {
			const state = await store.load();
			if (!state || replaced) return state;
			const { tokens: _tokens, tokensExpireAt: _expires, ...rest } = state;
			return rest;
		},
		async save(state) {
			if (state.tokens) replaced = true;
			else if (!replaced) {
				const current = await store.load();
				// Tokens belong to their client registration; keep them only while it is unchanged.
				if (current?.tokens && current.clientInformation?.client_id === state.clientInformation?.client_id)
					state = {
						...state,
						tokens: current.tokens,
						...(current.tokensExpireAt !== undefined ? { tokensExpireAt: current.tokensExpireAt } : {}),
					};
			}
			await store.save(state);
		},
		withRefreshLock: (fn) => store.withRefreshLock(fn),
	};
}

const controller = new AbortController();
let connection: Connection | undefined;
let closing: Promise<void> | undefined;
const close = () => {
	if (!connection) return Promise.resolve();
	closing ??= connection.close();
	return closing;
};
parentPort!.on("message", () => {
	controller.abort();
	void close().catch(() => {});
});
let reply: { ok?: true; cancelled?: true; error?: string };
try {
	const { kind, again } = workerData as { kind: string; again: boolean; agentDir?: string };
	if (typeof kind !== "string" || !kind) throw new Problem("Unknown MCP server.");
	const agentDir = (workerData.agentDir as string | undefined) ?? paths.getAgentDir();
	const broker = credentialClient();
	// Global user config only, like tracking calls. A repository cannot add a server to sign in to.
	const loaded = config.loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false });
	const entry = loaded.servers.find((entry) => entry.name === kind);
	if (!entry) throw new Problem(`pi has no MCP server named ${kind}. Add it to ~/.pi/agent/mcp.json first.`);
	if (entry.config.enabled === false) throw new Problem(`The ${kind} MCP server is turned off in pi.`);
	if ("url" in entry.config && entry.config.auth)
		throw new Problem("This server uses a model provider login, not MCP sign-in.");
	const credentials = new runtime.McpOAuthCredentialStore(
		new auth.FileAuthStorageBackend(join(agentDir, "mcp-auth.json")),
		agentDir,
	);
	connection = new runtime.McpServerConnection({
		entry,
		cwd: agentDir,
		createTransport: runtime.createDefaultTransport,
		credentials,
		onTools: () => {},
	});
	const url = connection.oauthUrl;
	if (!url) throw new Problem("This server does not use browser sign-in. Check its settings in pi.");
	// Connecting first tells whether sign-in is needed and records the server's challenge (scope, metadata).
	let connected = false;
	try {
		await connection.getClient();
		connected = true;
	} catch {
		controller.signal.throwIfAborted();
		if (!broker && connection.state !== "needs-auth")
			throw new Problem("Couldn't reach the server. Check pi mcp list.");
	}
	if (!connected || again) {
		controller.signal.throwIfAborted();
		const store = credentials.forServer(entry.name, url);
		const settings = connection.oauthSettings(),
			challenge = connection.challenge;
		const signIn = () =>
			runtime.signInMcpServer({
				serverUrl: url,
				store: again || broker ? withoutStoredTokens(store) : store,
				settings,
				challenge,
				prompt: {
					showAuthorizationUrl: (authorizationUrl) => parentPort!.postMessage({ open: authorizationUrl.href }),
					// Only the browser callback finishes the sign-in. Resolving empty cancels the flow.
					promptForRedirectUrl: (signal) =>
						new Promise<undefined>((resolve) => {
							const done = () => resolve(undefined);
							if (signal.aborted || controller.signal.aborted) return done();
							signal.addEventListener("abort", done, { once: true });
							controller.signal.addEventListener("abort", done, { once: true });
						}),
				},
			});
		if (broker) await broker.transaction("mcp", broker.mcpKey(entry.name, url), "login", signIn);
		else await signIn();
		connection.challenge = undefined;
		try {
			await connection.reconnect();
		} catch {
			throw new Problem("Signed in, but the server still refuses the connection. Check pi mcp list.");
		}
	}
	reply = { ok: true };
} catch (error) {
	reply =
		controller.signal.aborted || error instanceof runtime.McpSignInCancelledError
			? { cancelled: true }
			: { error: error instanceof Problem ? error.message : "Sign-in didn't finish. Try again." };
} finally {
	await close().catch(() => {});
}
parentPort!.postMessage(reply);
parentPort!.close();
