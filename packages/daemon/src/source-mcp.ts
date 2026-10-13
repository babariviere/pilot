import { Worker } from "node:worker_threads";
import type { SourceMcpConfig, TrackingJson } from "@pilot/protocol";

export class SourceSignInRequired extends Error {}
export interface SourceMcpClient {
	close?(): Promise<void>;
	call(
		binding: SourceMcpConfig,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<TrackingJson>;
}
/** No session, model, or separate tokens. Only the selected server connects, off the daemon event loop. */
export class PiSourceMcpClient implements SourceMcpClient {
	private readonly running = new Set<Worker>();
	private stopped = false;
	private readonly agentDir?: string;
	constructor(agentDir?: string) {
		this.agentDir = agentDir;
	}
	call(
		binding: SourceMcpConfig,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<TrackingJson> {
		if (this.stopped) return Promise.reject(new Error("MCP client stopped"));
		if (signal.aborted) return Promise.reject(signal.reason);
		if (Buffer.byteLength(JSON.stringify(args)) > 256 * 1024)
			return Promise.reject(new Error("MCP arguments exceed 256 KiB"));
		if (this.running.size >= 2) return Promise.reject(new Error("MCP client busy, retry shortly"));
		const name = binding.tools[tool];
		if (!name) return Promise.reject(new Error(`No MCP tool configured for ${tool}`));
		const worker = new Worker(new URL("./source-mcp-worker.ts", import.meta.url), {
			workerData: { agentDir: this.agentDir, binding, name, args },
		});
		this.running.add(worker);
		return new Promise((resolve, reject) => {
			let replied = false;
			const abort = () => worker.postMessage("abort");
			const timer = setTimeout(abort, 60_000);
			signal.addEventListener("abort", abort, { once: true });
			worker.once("message", (reply: { value?: TrackingJson; error?: string; signIn?: boolean }) => {
				replied = true;
				// Worker posts only after connection.close() and OAuth writes have settled.
				this.running.delete(worker);
				if (signal.aborted) reject(signal.reason);
				else if (reply.error) reject(reply.signIn ? new SourceSignInRequired(reply.error) : new Error(reply.error));
				else resolve(reply.value!);
			});
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
	if (result.isError) throw new Error("MCP tool returned an error");
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
