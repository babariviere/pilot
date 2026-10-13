import { Worker } from "node:worker_threads";
import type { TrackedKind, TrackingJson } from "@pilot/protocol";

/** Fixed read-only tools on the dedicated server named by kind. No overrides or fallback. */
export function dedicatedSourceTool(kind: TrackedKind, tool: string): string | undefined {
	if (kind === "linear" && tool === "issues") return "list_issues";
	if (kind === "linear" && tool === "cycles") return "list_cycles";
	if (kind === "linear" && tool === "issue") return "get_issue";
	if (kind === "linear" && tool === "teams") return "list_teams";
	if (kind === "slack" && tool === "history") return "slack_read_channel";
	if (kind === "slack" && tool === "thread") return "slack_read_thread";
	if (kind === "slack" && tool === "searchChannels") return "slack_search_channels";
	if (kind === "slack" && tool === "myChannels") return "slack_list_user_channels";
	return undefined;
}

export class SourceSignInRequired extends Error {}
/** The tool itself reported an error (for example, no access to one channel). The server was reachable. */
export class SourceToolError extends Error {}
export class SourceRateLimited extends Error {
	readonly retryAfterMs: number;
	constructor(retryAfterMs = 60_000) {
		super("Source rate limited");
		this.retryAfterMs = retryAfterMs;
	}
}
/** Extract only safe retry timing, never forward provider error text or credentials. */
export function sourceRateLimit(value: unknown): SourceRateLimited | undefined {
	if (!value || typeof value !== "object") return;
	const error = value as Record<string, unknown>;
	const payload = error.structuredContent as Record<string, unknown> | undefined;
	const detail =
		payload?.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : payload;
	const blocks = Array.isArray(error.content) ? error.content.slice(0, 2) : [];
	const text = [
		error.message,
		error.error,
		detail?.message,
		detail?.error,
		detail?.code,
		...blocks.map((block) => block?.text),
	]
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.slice(0, 8192))
		.join(" ")
		.slice(0, 16_384);
	if (
		![error.status, error.statusCode, error.code, detail?.status, detail?.code].some(
			(code) => code === 429 || code === "429",
		) &&
		!/rate[ _-]?limit|too many requests|\b429\b/i.test(text)
	)
		return;
	const data = error.data as Record<string, unknown> | undefined;
	const headers = error.headers as Record<string, unknown> | undefined;
	const seconds = Number(
		error.retryAfter ??
			data?.retryAfter ??
			detail?.retryAfter ??
			headers?.["retry-after"] ??
			text.match(/retry[ _-]?after["\s:=]+(\d+)/i)?.[1] ??
			60,
	);
	return new SourceRateLimited(
		Number.isFinite(seconds) ? Math.min(86_400_000, Math.max(1_000, seconds * 1000)) : 60_000,
	);
}
export interface SourceMcpClient {
	close?(): Promise<void>;
	call(kind: TrackedKind, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<TrackingJson>;
}
/** No session, model, or separate tokens. Only the selected server connects, off the daemon event loop. */
export class PiSourceMcpClient implements SourceMcpClient {
	private readonly running = new Set<Worker>();
	private stopped = false;
	private readonly agentDir?: string;
	constructor(agentDir?: string) {
		this.agentDir = agentDir;
	}
	call(kind: TrackedKind, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<TrackingJson> {
		if (this.stopped) return Promise.reject(new Error("MCP client stopped"));
		if (signal.aborted) return Promise.reject(signal.reason);
		if (Buffer.byteLength(JSON.stringify(args)) > 256 * 1024)
			return Promise.reject(new Error("MCP arguments exceed 256 KiB"));
		if (this.running.size >= 2) return Promise.reject(new Error("MCP client busy, retry shortly"));
		if (!dedicatedSourceTool(kind, tool)) return Promise.reject(new Error("Unknown dedicated MCP source tool"));
		const worker = new Worker(new URL("./source-mcp-worker.ts", import.meta.url), {
			workerData: { agentDir: this.agentDir, kind, tool, args },
		});
		this.running.add(worker);
		return new Promise((resolve, reject) => {
			let replied = false;
			const abort = () => worker.postMessage("abort");
			const timer = setTimeout(abort, 60_000);
			signal.addEventListener("abort", abort, { once: true });
			worker.once(
				"message",
				(reply: {
					value?: TrackingJson;
					error?: string;
					signIn?: boolean;
					retryAfterMs?: number;
					toolError?: boolean;
				}) => {
					replied = true;
					// Worker posts only after connection.close() and OAuth writes have settled.
					this.running.delete(worker);
					if (signal.aborted) reject(signal.reason);
					else if (reply.error)
						reject(
							reply.signIn
								? new SourceSignInRequired(reply.error)
								: reply.retryAfterMs
									? new SourceRateLimited(reply.retryAfterMs)
									: reply.toolError
										? new SourceToolError(reply.error)
										: new Error(reply.error),
						);
					else resolve(reply.value!);
				},
			);
			worker.once("error", reject);
			worker.once("exit", () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.running.delete(worker);
				if (!replied) reject(new Error("MCP worker exited without a result"));
			});
		});
	}
	/** Let pi finish credential refresh writes and terminate stdio process groups before daemon exit. */
	async close(): Promise<void> {
		this.stopped = true;
		await Promise.all(
			[...this.running].map(
				(worker) =>
					new Promise<void>((resolve) => {
						worker.once("exit", () => resolve());
						worker.postMessage("abort");
					}),
			),
		);
	}
}

/** Accept structuredContent or JSON text only. Markdown fields stay text for source-specific parsing. */
export function decodeMcpResult(result: {
	structuredContent?: unknown;
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
}): TrackingJson {
	if (result.isError) throw sourceRateLimit(result) ?? new SourceToolError("MCP tool returned an error");
	const value =
		result.structuredContent ??
		(() => {
			const blocks = result.content?.filter((block) => block.type === "text") ?? [];
			if (blocks.length !== 1 || typeof blocks[0]?.text !== "string")
				throw new Error("MCP tool did not return JSON");
			if (Buffer.byteLength(blocks[0].text) > 512 * 1024) throw new Error("MCP response exceeds 512 KiB");
			return JSON.parse(blocks[0].text) as unknown;
		})();
	const json = JSON.stringify(value);
	if (!json || Buffer.byteLength(json) > 512 * 1024) throw new Error("MCP response exceeds 512 KiB or is empty");
	return JSON.parse(json) as TrackingJson;
}
