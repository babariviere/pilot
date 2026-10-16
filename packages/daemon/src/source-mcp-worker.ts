/** The SDK exports the MCP extension, not standalone config/auth/connection helpers.
 * Isolate the pinned internal compatibility boundary here, as the kernel does for transport injection.
 * Reuse pi's validation, env/command expansion, auth file locks and refresh logic, never copy tokens.
 */
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { LoadedMcpConfig, McpServerEntry, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import { loadSlackRemovalRoute, slackRemovalCall } from "./slack-removal-route.ts";
import {
	decodeMcpResult,
	dedicatedSourceTool,
	SourceRateLimited,
	SourceToolError,
	slackAlreadyReacted,
	sourceRateLimit,
	validSourceArguments,
} from "./source-mcp.ts";

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
await installCredentialBrokerHooks();
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
/** Our own setup checks. Their fixed messages are safe for the daemon log, unlike transport errors. */
class SetupError extends Error {}
let connection: Connection | undefined;
let closing: Promise<void> | undefined;
// SDK connection.close() itself is not single-flight: a second close can miss the first transport's
// pending stdio shutdown. Await the same close before replying or allowing daemon shutdown.
const close = () => {
	if (!connection) return Promise.resolve();
	closing ??= connection.close();
	return closing;
};
parentPort!.on("message", () => {
	controller.abort(new Error("MCP request cancelled or timed out"));
	void close();
});
let reply: {
	value?: ReturnType<typeof decodeMcpResult>;
	error?: string;
	signIn?: boolean;
	retryAfterMs?: number;
	toolError?: boolean;
};
try {
	const { kind, tool: logicalTool, args } = workerData;
	if (!validSourceArguments(logicalTool, args)) throw new SetupError("Invalid Linear or Slack start update");
	const removal = kind === "slack" && logicalTool === "removeSlackEyes";
	const agentDir = workerData.agentDir ?? paths.getAgentDir();
	const removalConfig = removal ? await loadSlackRemovalRoute(agentDir) : undefined;
	if (removalConfig?.enabled === false) throw new SetupError("Slack eyes removal is disabled");
	const route = removalConfig ? slackRemovalCall(removalConfig, args.channel_id, args.message_ts) : undefined;
	const name = route?.tool ?? dedicatedSourceTool(kind, logicalTool);
	if (!name) throw new SetupError("Unknown dedicated MCP source tool");
	// Local user config only. A repository cannot supply an executable removal route.
	// Removal is entirely daemon-owned: do not load mcp.json or register its tools with agents.
	const entry: McpServerEntry | undefined = route
		? {
				name: "pilot-slack-removal",
				source: join(agentDir, "pilot-tracking.json"),
				config: { type: "http", ...route.server },
			}
		: config
				.loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false })
				.servers.find((entry) => entry.name === kind);
	if (!entry) throw new SetupError("Dedicated MCP server is not configured in pi");
	if (entry.config.enabled === false) throw new SetupError("MCP server is disabled or hidden");
	if (config.getMcpToolExposure(entry.config, name) === "hidden") throw new SetupError("MCP tool is hidden");
	if ("url" in entry.config && entry.config.auth)
		throw new SetupError("Tracking requires MCP OAuth or configured headers, not a model provider login");
	connection = new runtime.McpServerConnection({
		entry,
		cwd: agentDir,
		createTransport: runtime.createDefaultTransport,
		// Explicit Bearer configuration needs no OAuth store and must never fall back to one.
		credentials: removal
			? undefined
			: new runtime.McpOAuthCredentialStore(
					new auth.FileAuthStorageBackend(join(agentDir, "mcp-auth.json")),
					agentDir,
				),
		onTools: () => {},
	});
	if (controller.signal.aborted) throw controller.signal.reason;
	await connection.getClient();
	const tool = connection.tools.find((tool) => tool.name === name);
	if (
		!tool ||
		(!removal &&
			logicalTool !== "startIssue" &&
			logicalTool !== "startSlack" &&
			logicalTool !== "doneSlack" &&
			(tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true))
	)
		throw new SetupError("Tracking tool is missing or advertises writes");
	const result = await connection.callTool(name, route?.args ?? args, {
		signal: controller.signal,
		timeoutMs: 30_000,
	});
	reply = { value: decodeMcpResult(result, logicalTool) };
} catch (error) {
	const limited = error instanceof SourceRateLimited ? error : sourceRateLimit(error);
	// Never forward external tool text, config values, or transport errors that can contain secrets.
	reply =
		workerData.kind === "slack" && ["startSlack", "doneSlack"].includes(workerData.tool) && slackAlreadyReacted(error)
			? { value: { ok: true } }
			: {
					error:
						connection?.state === "needs-auth"
							? "Sign in required"
							: `MCP request failed: ${
									error instanceof SetupError || error instanceof SourceToolError
										? error.message
										: error instanceof SyntaxError
											? "invalid JSON"
											: "connection or transport error"
								}`,
					signIn: connection?.state === "needs-auth",
					...(limited ? { retryAfterMs: limited.retryAfterMs } : {}),
					...(!limited && error instanceof SourceToolError ? { toolError: true } : {}),
				};
} finally {
	await close();
}
parentPort!.postMessage(reply);
parentPort!.close();
