import { Worker } from "node:worker_threads";
import type { TrackedKind, TrackingJson } from "@pilot/protocol";
import { getPilotConfigDir } from "./config.ts";
import { RuntimeBackground } from "./runtime-background.ts";
import { SourceSignInCancelled, SourceSignInFailed } from "./source-sign-in.ts";
import {
	dedicatedSourceTool,
	SlackRemovalError,
	type SlackRemovalFailure,
	SourceConfigurationError,
	SourceRateLimited,
	SourceSignInRequired,
	SourceToolError,
	type SourceToolFailure,
	validSourceArguments,
} from "./source-tool-rules.ts";
import { isWatchNotice } from "./worker-notice.ts";

export interface SourceMcpClient {
	close?(): Promise<void>;
	call(kind: TrackedKind, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<TrackingJson>;
	/** Browser sign-in to the dedicated server, as `pi mcp login` does. Rejects with SourceSignInCancelled or
	 * SourceSignInFailed. With again, signs in even when the stored credentials still work. */
	signIn?(kind: TrackedKind, options: { again: boolean; signal: AbortSignal }): Promise<void>;
}
export type OpenUrl = (url: string) => void | Promise<void>;
/** pi's own launcher: no shell, best effort. */
const openBrowser: OpenUrl = async (url) => {
	const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { openBrowser } = (await import(new URL("./utils/open-browser.js", sdk).href)) as {
		openBrowser(target: string): void;
	};
	openBrowser(url);
};
/** No session, model, or separate tokens. Only the selected server connects, off the daemon event loop. */
export class PiSourceMcpClient implements SourceMcpClient {
	readonly runtime = new RuntimeBackground("source-mcp");
	private startWorker(file: string, workerData: Record<string, unknown>): Worker {
		const end = this.runtime.begin("worker");
		try {
			const worker = new Worker(new URL(file, import.meta.url), { workerData });
			worker.once("exit", end);
			return worker;
		} catch (error) {
			end();
			throw error;
		}
	}
	private readonly callWorkers = new Set<Worker>();
	/** Sign-ins wait for the user, so they do not take the two MCP call slots. At most one per kind. */
	private readonly signInWorkers = new Set<Worker>();
	private stopped = false;
	private readonly agentDir?: string;
	private readonly configDir: string;
	private readonly openUrl: OpenUrl;
	constructor(agentDir?: string, options: { openUrl?: OpenUrl; configDir?: string } = {}) {
		this.agentDir = agentDir;
		this.configDir = options.configDir ?? getPilotConfigDir();
		this.openUrl = options.openUrl ?? openBrowser;
	}
	signIn(kind: TrackedKind, options: { again: boolean; signal: AbortSignal }): Promise<void> {
		if (kind !== "linear" && kind !== "slack") return Promise.reject(new SourceSignInFailed("Unknown source."));
		return this.signInServer(kind, options);
	}
	/** Browser sign-in to any server in the user's global mcp.json, for the Connections settings. */
	async signInServer(name: string, options: { again: boolean; signal: AbortSignal }): Promise<void> {
		const { signal } = options;
		if (this.stopped) return Promise.reject(new Error("MCP client stopped"));
		if (signal.aborted) return Promise.reject(signal.reason);
		if (!name || name.length > 200) return Promise.reject(new SourceSignInFailed("Unknown MCP server."));
		const worker = this.startWorker("./source-sign-in-worker.ts", {
			agentDir: this.agentDir,
			kind: name,
			again: options.again,
		});
		this.signInWorkers.add(worker);
		return new Promise((resolve, reject) => {
			let reply: { ok?: true; cancelled?: true; error?: string } | undefined;
			let terminationTimer: ReturnType<typeof setTimeout> | undefined;
			const abort = () => {
				worker.postMessage("abort");
				// The flow stops at its next step; do not let a stuck discovery request hold the callback port.
				terminationTimer ??= setTimeout(() => void worker.terminate(), 10_000);
			};
			signal.addEventListener("abort", abort, { once: true });
			worker.on("message", (message: { open?: string; ok?: true; cancelled?: true; error?: string }) => {
				if (isWatchNotice(message)) return;
				if (typeof message.open === "string") {
					let url: URL | undefined;
					try {
						url = new URL(message.open);
					} catch {}
					if (url && (url.protocol === "https:" || url.protocol === "http:") && !signal.aborted)
						void Promise.resolve()
							.then(() => this.openUrl(url.href))
							.catch(() => {});
					return;
				}
				reply = message;
			});
			worker.once("error", () => {});
			// Settle after exit, so the callback port and credential writes are released before a retry.
			worker.once("exit", () => {
				clearTimeout(terminationTimer);
				signal.removeEventListener("abort", abort);
				this.signInWorkers.delete(worker);
				if (reply?.ok && !signal.aborted) resolve();
				else if (signal.aborted) reject(signal.reason);
				else if (reply?.cancelled) reject(new SourceSignInCancelled("Sign-in cancelled"));
				else reject(new SourceSignInFailed(reply?.error ?? "Sign-in didn't finish. Try again."));
			});
		});
	}
	async call(
		kind: TrackedKind,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<TrackingJson> {
		if (this.stopped) return Promise.reject(new Error("MCP client stopped"));
		if (signal.aborted) return Promise.reject(signal.reason);
		if (Buffer.byteLength(JSON.stringify(args)) > 256 * 1024)
			return Promise.reject(new Error("MCP arguments exceed 256 KiB"));
		if (this.callWorkers.size >= 2) return Promise.reject(new Error("MCP client busy, retry shortly"));
		if (!validSourceArguments(tool, args)) return Promise.reject(new Error("Invalid Linear or Slack start update"));
		if (!dedicatedSourceTool(kind, tool) && !(kind === "slack" && tool === "removeSlackEyes"))
			return Promise.reject(new Error("Unknown dedicated MCP source tool"));
		const worker = this.startWorker("./source-mcp-worker.ts", {
			agentDir: this.agentDir,
			configDir: this.configDir,
			kind,
			tool,
			args,
		});
		this.callWorkers.add(worker);
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
					failureCategory?: SourceToolFailure;
					configuration?: boolean;
					removalFailure?: SlackRemovalFailure;
				}) => {
					replied = true;
					// Worker posts only after connection.close() and OAuth writes have settled.
					this.callWorkers.delete(worker);
					if (signal.aborted) reject(signal.reason);
					else if (reply.error)
						reject(
							reply.removalFailure
								? new SlackRemovalError(reply.removalFailure)
								: reply.signIn
									? new SourceSignInRequired(reply.error)
									: reply.retryAfterMs
										? new SourceRateLimited(reply.retryAfterMs)
										: reply.toolError
											? new SourceToolError(reply.error, reply.failureCategory)
											: reply.configuration
												? new SourceConfigurationError(reply.error)
												: new Error(reply.error),
						);
					else resolve(reply.value!);
				},
			);
			worker.once("error", reject);
			worker.once("exit", () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.callWorkers.delete(worker);
				if (!replied) reject(new Error("MCP worker exited without a result"));
			});
		});
	}
	/** Let pi finish credential refresh writes and terminate stdio process groups before daemon exit. */
	async close(): Promise<void> {
		this.stopped = true;
		await Promise.all(
			[...this.callWorkers, ...this.signInWorkers].map(
				(worker) =>
					new Promise<void>((resolve) => {
						worker.once("exit", () => resolve());
						worker.postMessage("abort");
					}),
			),
		);
	}
}
