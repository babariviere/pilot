/** The SDK exports the MCP extension, not standalone config/auth/connection helpers.
 * Isolate the pinned internal compatibility boundary here, as the kernel does for transport injection.
 * Reuse pi's validation, env/command expansion, auth file locks and refresh logic, never copy tokens.
 */
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { LoadedMcpConfig, McpServerEntry, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import {
	decodeMcpResult,
	dedicatedSourceTool,
	SOURCE_WRITE_TOOLS,
	SourceRateLimited,
	SourceToolError,
	slackAlreadyReacted,
	sourceRateLimit,
	sourceToolFailure,
	validSourceArguments,
} from "../source-tool-rules.ts";

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
let publishSent = false;
let permitPublish: ((granted: boolean) => void) | undefined;
// SDK connection.close() itself is not single-flight: a second close can miss the first transport's
// pending stdio shutdown. Await the same close before replying or allowing daemon shutdown.
const close = () => {
	if (!connection) return Promise.resolve();
	closing ??= connection.close();
	return closing;
};
parentPort!.on("message", (message: unknown) => {
	if (message === "permitPublish" || message === "denyPublish") {
		permitPublish?.(message === "permitPublish");
		return;
	}
	permitPublish?.(false);
	controller.abort(new Error("MCP request cancelled or timed out"));
	void close();
});
let reply: {
	value?: ReturnType<typeof decodeMcpResult>;
	error?: string;
	signIn?: boolean;
	retryAfterMs?: number;
	toolError?: boolean;
	failureCategory?: ReturnType<typeof sourceToolFailure>;
	configuration?: boolean;
	notDispatched?: true;
};
try {
	const { kind, tool: logicalTool, args } = workerData;
	if (!validSourceArguments(logicalTool, args)) throw new SetupError("Invalid Linear or Slack start update");
	const agentDir = workerData.agentDir ?? paths.getAgentDir();
	const name = dedicatedSourceTool(kind, logicalTool);
	if (!name) throw new SetupError("Unknown dedicated MCP source tool");
	const entry: McpServerEntry | undefined = config
		.loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false })
		.servers.find((entry) => entry.name === kind);
	if (!entry) throw new SetupError("Dedicated MCP server is not configured in pi");
	if (entry.config.enabled === false) throw new SetupError("MCP server is disabled or hidden");
	if (config.getMcpToolExposure(entry.config, name) === "hidden") throw new SetupError("MCP tool is hidden");
	if ("url" in entry.config && entry.config.auth)
		throw new SetupError("Tracking requires MCP OAuth or configured headers, not a model provider login");
	const publishing = kind === "linear" && String(logicalTool).startsWith("publish");
	if (publishing) {
		// Do not send approved plan text to a custom server configured under the same alias.
		if (!("url" in entry.config) || new URL(entry.config.url).href !== "https://mcp.linear.app/mcp")
			throw new SetupError("Publishing requires the official Linear MCP connection");
		const nativeFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const target = input instanceof Request ? input.url : String(input);
			if (target === "https://mcp.linear.app/mcp") {
				if (logicalTool === "publishIssueWrite" && typeof init?.body === "string") {
					const request = JSON.parse(init.body) as { method?: string };
					if (request.method === "tools/call") {
						// The SDK may retry on OAuth challenges or expired MCP sessions.
						// A connector response is not proof that a write did not happen.
						if (publishSent) throw new Error("Linear write cannot be replayed");
						controller.signal.throwIfAborted();
						const allowed = await new Promise<boolean>((resolve) => {
							permitPublish = resolve;
							parentPort!.postMessage({ publishReady: true });
						});
						permitPublish = undefined;
						controller.signal.throwIfAborted();
						if (!allowed) throw new Error("Publishing authority changed");
						publishSent = true;
					}
				}
				return nativeFetch(input, { ...init, redirect: "error" });
			}
			return nativeFetch(input, init);
		};
	}
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
	const tool = connection.tools.find((tool) => tool.name === name);
	if (
		!tool ||
		(!SOURCE_WRITE_TOOLS.has(logicalTool) &&
			(tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true))
	)
		throw new SetupError("Tracking tool is missing or advertises writes");
	const options = { signal: controller.signal, timeoutMs: 30_000 };
	controller.signal.throwIfAborted();
	let value: ReturnType<typeof decodeMcpResult>;
	try {
		value = decodeMcpResult(await connection.callTool(name, args, options), logicalTool);
	} catch (error) {
		if (kind !== "slack" || logicalTool !== "startSlack" || !slackAlreadyReacted(error)) throw error;
		value = { ok: true };
	}
	reply = { value };
} catch (error) {
	const limited = error instanceof SourceRateLimited ? error : sourceRateLimit(error);
	const category = error instanceof SourceToolError ? error.category : sourceToolFailure(error);
	// Never forward external tool text, config values, or transport errors that can contain secrets.
	reply = {
		...(workerData.tool === "publishIssueWrite" && !publishSent ? { notDispatched: true as const } : {}),
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
		...(error instanceof SetupError ? { configuration: true } : {}),
		...(!limited && (error instanceof SourceToolError || category !== "tool_error")
			? { toolError: true, failureCategory: category }
			: {}),
	};
} finally {
	await close();
}
parentPort!.postMessage(reply);
parentPort!.close();
