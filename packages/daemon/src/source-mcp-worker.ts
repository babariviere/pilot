/** SDK 1.0.4 exports the MCP extension, not standalone config/auth/connection helpers.
 * Isolate the pinned internal compatibility boundary here, as the kernel does for transport injection.
 * Reuse pi's validation, env/command expansion, auth file locks and refresh logic, never copy tokens.
 */
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { LoadedMcpConfig, McpServerEntry, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { decodeMcpResult } from "./source-mcp.ts";

interface Connection {
	state: string;
	tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
	getClient(): Promise<unknown>;
	callTool(
		name: string,
		args: Record<string, unknown>,
		options: { signal: AbortSignal; timeoutMs: number },
	): Promise<Parameters<typeof decodeMcpResult>[0]>;
	close(): Promise<void>;
}
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const paths = (await import(new URL("./config.js", sdk).href)) as { getAgentDir(): string };
const config = (await import(new URL("./extensions/mcp/config.js", sdk).href)) as {
	loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
	getMcpToolExposure(config: McpServerEntry["config"], name: string): string;
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
const controller = new AbortController();
let connection: Connection | undefined;
let closing: Promise<void> | undefined;
// SDK connection.close() itself is not single-flight: a second close can miss the first transport's
// pending stdio shutdown. Await the same close before replying or allowing daemon shutdown.
const close = () => (connection ? (closing ??= connection.close()) : Promise.resolve());
parentPort!.on("message", () => {
	controller.abort(new Error("MCP request cancelled or timed out"));
	void close();
});
let reply: { value?: ReturnType<typeof decodeMcpResult>; error?: string; signIn?: boolean };
try {
	const { binding, name, args } = workerData;
	const agentDir = workerData.agentDir ?? paths.getAgentDir();
	// Global user config only. A repository cannot execute a new MCP server through tracking settings.
	const loaded = config.loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false });
	const entry = loaded.servers.find((entry) => entry.name === binding.server);
	if (!entry) throw new Error(`MCP server ${binding.server} is not configured in pi`);
	if (entry.config.enabled === false) throw new Error("MCP server is disabled or hidden");
	if (config.getMcpToolExposure(entry.config, binding.dispatchTool ?? name) === "hidden")
		throw new Error("MCP tool is hidden");
	if ("url" in entry.config && entry.config.auth)
		throw new Error("Tracking requires MCP OAuth or configured headers, not a model provider login");
	connection = new runtime.McpServerConnection({
		entry,
		cwd: agentDir,
		createTransport: runtime.createDefaultTransport,
		credentials: new runtime.McpOAuthCredentialStore(
			new auth.FileAuthStorageBackend(join(agentDir, "mcp-auth.json")),
			agentDir,
		),
		onTools: () => {},
	});
	if (controller.signal.aborted) throw controller.signal.reason;
	await connection.getClient();
	const tool = connection.tools.find((tool) => tool.name === (binding.dispatchTool ?? name));
	if (!tool || tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true)
		throw new Error("Tracking tool is missing or advertises writes");
	const result = await connection.callTool(
		binding.dispatchTool ?? name,
		binding.dispatchTool ? { name, arguments: args } : args,
		{ signal: controller.signal, timeoutMs: 30_000 },
	);
	reply = { value: decodeMcpResult(result) };
} catch (error) {
	// Never forward external tool text, config values, or transport errors that can contain secrets.
	reply = {
		error:
			connection?.state === "needs-auth"
				? "Sign in required"
				: "MCP request failed. Check pi mcp list and the source tool configuration.",
		signIn: connection?.state === "needs-auth",
	};
} finally {
	await close();
}
parentPort!.postMessage(reply);
parentPort!.close();
