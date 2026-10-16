/** Shared daemon reachability and request-only recovery. Never retries a native tool. */
import { watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { formatFailure } from "./failure.ts";

export interface ConnectivityState {
	version: 1;
	online: boolean;
	checkedAt: number;
}

const REACHABILITY_URLS = ["https://www.gstatic.com/generate_204", "https://cp.cloudflare.com/generate_204"] as const;

/** Independent hosts share one deadline. No credentials, redirects or captive-portal success. */
export async function probeReachability(signal: AbortSignal, url?: string): Promise<boolean> {
	const finished = new AbortController();
	const deadline = AbortSignal.any([signal, finished.signal, AbortSignal.timeout(5_000)]);
	try {
		deadline.throwIfAborted();
		// One blocked host is not a host-wide outage. First validated success wins;
		// Promise.any consumes losing rejections, including cancellation after success.
		await Promise.any(
			(url === undefined ? REACHABILITY_URLS : [url]).map(async (url) => {
				const response = await fetch(url, {
					method: "HEAD",
					redirect: "manual",
					cache: "no-store",
					credentials: "omit",
					headers: { Connection: "close" },
					signal: deadline,
				});
				await response.body?.cancel();
				if (response.status !== 204) throw new Error("Reachability check did not return 204");
			}),
		);
		return !deadline.aborted;
	} catch {
		return false;
	} finally {
		finished.abort();
	}
}

function providerFailure(error: unknown): boolean {
	const value = error && typeof error === "object" ? (error as { status?: unknown; message?: unknown }) : undefined;
	if (typeof value?.status === "number" && value.status >= 400) return true;
	const text = (typeof error === "string" ? error : String(value?.message ?? "")).slice(0, 4096);
	return /\b[45]\d\d\b|unauthori[sz]ed|authentication|api.?key|quota|rate.?limit|overloaded|billing/i.test(text);
}

/** A transport hint alone is insufficient: auth, quota and HTTP/provider errors are not offline. */
export function isTransportFailure(error: unknown): boolean {
	const seen = new Set<unknown>();
	for (let depth = 0; error && depth < 5 && !seen.has(error); depth++) {
		seen.add(error);
		const value =
			typeof error === "object"
				? (error as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown })
				: undefined;
		if (providerFailure(error)) return false;
		const message = (typeof error === "string" ? error : String(value?.message ?? "")).slice(0, 4096);
		if (
			/^(?:ENETUNREACH|EHOSTUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(
				String(value?.code ?? ""),
			) ||
			/fetch failed|network (?:error|unreachable)|connection (?:error|reset|refused|closed)|socket (?:hang up|closed)|other side closed|\b(?:ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT)\b|(?:^|: )terminated$/i.test(
				message,
			)
		)
			return true;
		error = value?.cause;
	}
	return false;
}

/** One host-owned file for every kernel and child. Missing/invalid configured state holds recovery. */
export class OfflineGate {
	readonly path?: string;
	private readonly requestCheck: () => Promise<void>;
	constructor(
		path = process.env.PILOT_CONNECTIVITY_POLICY,
		requestCheck = () => writeFile(`${path}.check`, "", { mode: 0o600 }),
	) {
		this.path = path;
		this.requestCheck = requestCheck;
	}

	private async state(): Promise<ConnectivityState | undefined> {
		try {
			const text = await readFile(this.path!, "utf8");
			if (text.length > 1024) return;
			const state = JSON.parse(text) as ConnectivityState;
			if (state.version === 1 && typeof state.online === "boolean" && Number.isFinite(state.checkedAt)) return state;
		} catch {
			/* The daemon must confirm connectivity before a recovered request is sent. */
		}
	}

	async wait(signal?: AbortSignal, after = -Infinity): Promise<void> {
		if (!this.path) return;
		signal?.throwIfAborted();
		const state = await this.state();
		signal?.throwIfAborted();
		if (state?.online && state.checkedAt > after) return;
		await this.observe((state) => state.online && state.checkedAt > after, signal);
	}

	async untilOffline(signal: AbortSignal): Promise<void> {
		await this.observe((state) => !state.online, signal);
	}

	private async observe(
		ready: (state: ConnectivityState) => boolean,
		signal?: AbortSignal,
	): Promise<ConnectivityState> {
		while (true) {
			signal?.throwIfAborted();
			// Subscribe before reading so atomic rename between the read and wait cannot be lost.
			let wake!: () => void;
			const changed = new Promise<void>((resolve) => {
				wake = resolve;
			});
			let watcher: ReturnType<typeof watch> | undefined;
			try {
				watcher = watch(dirname(this.path!), (_event, file) => {
					if (!file || file === basename(this.path!)) wake();
				});
				watcher.on("error", wake);
			} catch {
				/* A coarse fallback also covers unavailable filesystem notifications. */
			}
			const timer = setTimeout(wake, 60_000);
			const abort = () => wake();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const state = await this.state();
				signal?.throwIfAborted();
				if (state && ready(state)) return state;
				await changed;
			} finally {
				clearTimeout(timer);
				watcher?.close();
				signal?.removeEventListener("abort", abort);
			}
		}
	}

	/** Confirm a real outage before hiding a model error. A newer daemon probe alone can release it. */
	async recover(error: unknown, signal?: AbortSignal): Promise<boolean> {
		if (!this.path || !isTransportFailure(error)) return false;
		signal?.throwIfAborted();
		const since = Date.now();
		await this.requestCheck();
		const state = await this.observe((state) => state.checkedAt > since, signal);
		signal?.throwIfAborted();
		if (state.online) return false;
		await this.wait(signal, since);
		return true;
	}
}

/** Recover only failed provider requests (offline or a host-confirmed usage hold), never native tools. */
export function offlineRequestStream(
	dispatch: (signal: AbortSignal) => AssistantMessageEventStream | Promise<AssistantMessage>,
	model: Model<Api>,
	gate: OfflineGate,
	signal?: AbortSignal,
	recoverProviderError?: (error: unknown, signal?: AbortSignal) => Promise<boolean>,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		try {
			while (true) {
				await gate.wait(signal);
				const request = new AbortController();
				const monitor = new AbortController();
				const requestSignal = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
				let offline = false;
				const watching = gate.path
					? gate
							.untilOffline(monitor.signal)
							.then(() => {
								offline = true;
								request.abort(new Error("Internet connectivity unavailable"));
							})
							.catch(() => {})
					: Promise.resolve();
				let message: AssistantMessage;
				try {
					const source = dispatch(requestSignal);
					if ("then" in source) message = await source;
					else {
						// Do not forward terminal errors: Harness must retain its request checkpoint during an outage.
						for await (const event of source)
							if (event.type !== "error" && event.type !== "done") stream.push(event);
						message = await source.result();
					}
				} catch (error) {
					if (offline && !signal?.aborted && !providerFailure(error)) continue;
					if (await recoverProviderError?.(error, signal)) continue;
					if (await gate.recover(error, signal)) continue;
					throw error;
				} finally {
					monitor.abort();
					await watching;
				}
				signal?.throwIfAborted();
				if (
					offline &&
					(message.stopReason === "aborted" ||
						(message.stopReason === "error" && !providerFailure(message.errorMessage)))
				)
					continue;
				if (message.stopReason === "error" && (await gate.recover(message.errorMessage, signal))) continue;
				if (message.stopReason === "error" && (await recoverProviderError?.(message.errorMessage, signal)))
					continue;
				if (message.stopReason === "error" || message.stopReason === "aborted")
					stream.push({ type: "error", reason: message.stopReason, error: message });
				else {
					// A successful response racing an outage is not repeated. Hold its tool round at the boundary.
					await gate.wait(signal);
					if (message.stopReason !== "pending") stream.push({ type: "done", reason: message.stopReason, message });
				}
				stream.end(message);
				return;
			}
		} catch (error) {
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: signal?.aborted ? "aborted" : "error",
				timestamp: Date.now(),
				errorMessage: formatFailure(error),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
			stream.end(message);
		}
	})();
	return stream;
}
