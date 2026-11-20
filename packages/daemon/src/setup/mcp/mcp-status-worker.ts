/** Connects to the user's global pi MCP servers once and reports what it found, the way `pi mcp list` does,
 * off the daemon event loop. Same pinned SDK internals as the tracking worker: pi's config loading, env and
 * command expansion, OAuth credential store and refresh locks. Only fixed, safe descriptions leave this worker.
 */
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { LoadedMcpConfig, McpServerEntry, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import type { McpProbeResult, McpProbeServer } from "./mcp-status.ts";

interface Connection {
	state: string;
	tools: unknown[];
	readonly oauthUrl: string | undefined;
	getClient(): Promise<unknown>;
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
	McpOAuthCredentialStore: new (backend: unknown, lockDir: string) => unknown;
	McpServerConnection: new (options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport: McpTransportFactory;
		credentials: unknown;
		onTools: () => void;
	}) => Connection;
};
const auth = (await import(new URL("./core/auth-storage.js", sdk).href)) as {
	FileAuthStorageBackend: new (path: string) => unknown;
};

const { only, timeoutMs = 20_000 } = workerData as { only?: string; timeoutMs?: number; agentDir?: string };
const agentDir = (workerData.agentDir as string | undefined) ?? paths.getAgentDir();
const controller = new AbortController();
const open = new Set<Connection>();
parentPort!.on("message", () => {
	controller.abort();
	for (const connection of open) void connection.close().catch(() => {});
});

/** Fixed sentences only: pi's errors can include URLs, commands, headers or server output. */
function problem(entry: McpServerEntry, timedOut: boolean): string {
	if (timedOut) return "The server didn't answer in time.";
	return "url" in entry.config ? "Couldn't connect to the server." : "Couldn't start the server.";
}

async function probe(entry: McpServerEntry, credentials: unknown): Promise<McpProbeServer> {
	const transport = "url" in entry.config ? "http" : "stdio";
	const base = { name: entry.name, transport } as const;
	if (entry.config.enabled === false) return { ...base, state: "disabled" };
	// Model provider logins need pi's model registry, which a status check should not load.
	if ("url" in entry.config && entry.config.auth)
		return { ...base, state: "unknown", problem: "Signs in with a model provider login. Check it in pi." };
	let connection: Connection | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	try {
		connection = new runtime.McpServerConnection({
			entry,
			cwd: agentDir,
			createTransport: runtime.createDefaultTransport,
			credentials,
			onTools: () => {},
		});
		open.add(connection);
		const canSignIn = connection.oauthUrl !== undefined;
		const connected = await Promise.race([
			connection.getClient().then(
				() => true,
				() => false,
			),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => {
					timedOut = true;
					resolve(false);
				}, timeoutMs);
			}),
		]);
		const signIn = canSignIn ? { canSignIn: true } : {};
		if (connected) return { ...base, ...signIn, state: "connected", tools: connection.tools.length };
		if (connection.state === "needs-auth") return { ...base, ...signIn, state: "needs_sign_in" };
		return { ...base, ...signIn, state: "failed", problem: problem(entry, timedOut) };
	} catch {
		return { ...base, state: "failed", problem: problem(entry, timedOut) };
	} finally {
		clearTimeout(timer);
		if (connection) {
			// Let OAuth refresh writes and stdio process-group shutdown settle before reporting.
			await connection.close().catch(() => {});
			open.delete(connection);
		}
	}
}

let reply: McpProbeResult;
try {
	// Global user config only, like tracking. A repository cannot make pilotd start its servers.
	const loaded = config.loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false });
	const entries = loaded.servers.filter((entry) => only === undefined || entry.name === only).slice(0, 64);
	const credentials = new runtime.McpOAuthCredentialStore(
		new auth.FileAuthStorageBackend(join(agentDir, "mcp-auth.json")),
		agentDir,
	);
	const servers: McpProbeServer[] = new Array(entries.length);
	let next = 0;
	// At most four servers start at once, so a large config never spawns every stdio server together.
	await Promise.all(
		Array.from({ length: Math.min(4, entries.length) }, async () => {
			while (next < entries.length && !controller.signal.aborted) {
				const index = next++;
				servers[index] = await probe(entries[index]!, credentials);
			}
		}),
	);
	reply = controller.signal.aborted
		? { cancelled: true }
		: { servers, configProblems: loaded.errors.length, complete: only === undefined };
} catch {
	reply = { error: "Couldn't read pi's MCP configuration." };
}
parentPort!.postMessage(reply);
parentPort!.close();
