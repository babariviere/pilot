import { type FSWatcher, watch } from "node:fs";
import { Worker } from "node:worker_threads";
import type { McpServerState, McpServerStatus, McpSignInState, McpStatus } from "@pilot/protocol";
import { NotFound } from "./errors.ts";
import { type SignInState, SourceSignIns } from "./source-sign-in.ts";

/** What one check found for a server, before pilotd adds timing and sign-in progress. */
export type McpProbeServer = Omit<McpServerStatus, "checkedAt" | "signIn">;
export type McpProbeResult =
	| { servers: McpProbeServer[]; configProblems: number; complete: boolean }
	| { cancelled: true }
	| { error: string };
/** Connects to every server in the global mcp.json (or only `only`) and reports what it found. */
export type McpProbe = (options: { only?: string; signal: AbortSignal }) => Promise<McpProbeResult>;
export type McpLogin = (server: string, options: { again: boolean; signal: AbortSignal }) => Promise<void>;

/** Servers needing the user first, then the rest by name. */
const RANK: Record<McpServerState, number> = {
	needs_sign_in: 0,
	failed: 1,
	unknown: 2,
	connected: 3,
	disabled: 4,
};

/** Runs one check in a worker thread. A check never outlives `timeoutMs` per server plus shutdown. */
export function workerProbe(agentDir?: string, timeoutMs?: number): McpProbe {
	return ({ only, signal }) =>
		new Promise((resolve) => {
			if (signal.aborted) return resolve({ cancelled: true });
			const worker = new Worker(new URL("./mcp-status-worker.ts", import.meta.url), {
				workerData: { agentDir, only, timeoutMs },
			});
			let reply: McpProbeResult | undefined;
			let kill: ReturnType<typeof setTimeout> | undefined;
			const abort = () => {
				worker.postMessage("abort");
				kill ??= setTimeout(() => void worker.terminate(), 10_000);
			};
			signal.addEventListener("abort", abort, { once: true });
			worker.on("message", (message: McpProbeResult) => {
				reply = message;
			});
			worker.once("error", () => {});
			// Settle after exit, so stdio servers and credential writes are done before the next check.
			worker.once("exit", () => {
				clearTimeout(kill);
				signal.removeEventListener("abort", abort);
				resolve(signal.aborted ? { cancelled: true } : (reply ?? { error: "MCP check stopped" }));
			});
		});
}

export interface McpStatusOptions {
	probe: McpProbe;
	login?: McpLogin;
	/** Directory holding mcp.json and mcp-auth.json, watched for changes. Omit to skip watching. */
	watchDir?: string;
	debounceMs?: number;
	signInTimeoutMs?: number;
}

/**
 * The shared view of the user's pi MCP servers: checked at startup, when mcp.json or mcp-auth.json changes (a
 * sign-in or config edit anywhere, including `pi mcp login` in a terminal) and on request. Never polls.
 * One check runs at a time; requests during a check merge into one follow-up check.
 */
export class McpStatusService {
	private servers = new Map<string, McpProbeServer & { checkedAt?: number }>();
	private configProblems = 0;
	private running?: AbortController;
	/** Follow-up after the running check: every server, or these names. */
	private queued?: "all" | Set<string>;
	private watcher?: FSWatcher;
	private debounce?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private settled: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<(status: McpStatus) => void>();
	private readonly probe: McpProbe;
	private readonly signIns: SourceSignIns<string>;
	private readonly canLogin: boolean;
	private readonly watchDir?: string;
	private readonly debounceMs: number;

	constructor(options: McpStatusOptions) {
		this.probe = options.probe;
		this.watchDir = options.watchDir;
		this.debounceMs = options.debounceMs ?? 1_000;
		this.canLogin = !!options.login;
		this.signIns = new SourceSignIns<string>(
			(server, signInOptions) =>
				options.login ? options.login(server, signInOptions) : Promise.reject(new Error("Sign-in is unavailable")),
			(state) => this.signInChanged(state),
			options.signInTimeoutMs,
		);
	}

	/** First check, then watch pi's MCP files. */
	start(): void {
		if (this.stopped) return;
		this.check();
		if (!this.watchDir || this.watcher) return;
		try {
			this.watcher = watch(this.watchDir, { persistent: false }, (_event, file) => {
				const name = file?.toString();
				if (name !== "mcp.json" && name !== "mcp-auth.json") return;
				// Our own checks refresh tokens through mcp-auth.json. Config edits always count.
				if (name === "mcp-auth.json" && this.running) return;
				clearTimeout(this.debounce);
				this.debounce = setTimeout(() => this.check(), this.debounceMs);
				this.debounce.unref();
			});
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch {
			// No agent directory yet: checks on request still work.
		}
	}

	status(): McpStatus {
		const servers: McpServerStatus[] = [...this.servers.values()].map((server) => {
			const signIn = this.signInState(server.name);
			return { ...server, ...(signIn ? { signIn } : {}) };
		});
		servers.sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name));
		return {
			servers,
			checking: !!this.running,
			...(this.configProblems ? { configProblems: this.configProblems } : {}),
		};
	}

	get(name: string): McpServerStatus | undefined {
		return this.status().servers.find((server) => server.name === name);
	}

	onChange(listener: (status: McpStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Check every server, or one. Returns at once; the result arrives through onChange. */
	check(server?: string): McpStatus {
		if (this.stopped) return this.status();
		if (server !== undefined && !this.servers.has(server)) server = undefined;
		if (this.running) {
			if (server === undefined) this.queued = "all";
			else if (this.queued !== "all") {
				const queued = this.queued ?? new Set<string>();
				queued.add(server);
				this.queued = queued;
			}
			return this.status();
		}
		this.run(server === undefined ? "all" : new Set([server]));
		return this.status();
	}

	signIn(server: string, again = false): McpSignInState {
		const current = this.servers.get(server);
		if (!current) throw new NotFound(`Unknown MCP server: ${server}`);
		if (!this.canLogin || !current.canSignIn) throw new SignInUnavailable(`${server} does not use browser sign-in`);
		return publicSignIn(this.signIns.start(server, again));
	}

	cancelSignIn(server: string): McpSignInState | undefined {
		if (!this.servers.has(server)) throw new NotFound(`Unknown MCP server: ${server}`);
		const state = this.signIns.cancel(server);
		return state && publicSignIn(state);
	}

	async close(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.debounce);
		this.watcher?.close();
		this.watcher = undefined;
		this.queued = undefined;
		this.running?.abort();
		await Promise.all([this.signIns.stop(), this.settled]);
		this.listeners.clear();
	}

	private run(target: "all" | Set<string>): void {
		// Several single-server rechecks cost more than one full check.
		if (target !== "all" && target.size > 2) target = "all";
		const controller = new AbortController();
		this.running = controller;
		const names = target === "all" ? [...this.servers.keys()] : [...target];
		const checks =
			target === "all"
				? [this.probe({ signal: controller.signal })]
				: names.map((only) => this.probe({ only, signal: controller.signal }));
		// Servers keep their last state until this finishes; clients show that a check is running.
		this.emit();
		this.settled = Promise.all(checks)
			.then((results) => {
				if (controller.signal.aborted || this.stopped) return;
				const now = Date.now();
				for (const [index, result] of results.entries()) {
					if (!("servers" in result)) continue;
					if (result.complete) {
						this.servers = new Map(result.servers.map((server) => [server.name, { ...server, checkedAt: now }]));
						this.configProblems = result.configProblems;
					} else {
						const only = names[index]!;
						const found = result.servers.find((server) => server.name === only);
						if (found) this.servers.set(only, { ...found, checkedAt: now });
						else this.servers.delete(only);
					}
				}
			})
			.catch(() => {})
			.finally(() => {
				if (this.running === controller) this.running = undefined;
				if (this.stopped) return;
				const queued = this.queued;
				this.queued = undefined;
				if (queued) this.run(queued);
				else this.emit();
			});
	}

	private signInState(name: string): McpSignInState | undefined {
		const state = this.signIns.get(name);
		return state && publicSignIn(state);
	}

	private signInChanged(state: SignInState<string>): void {
		// A finished sign-in already reconnected in its worker; recheck for the tool count and shared state.
		if (state.state === "done") this.check(state.kind);
		else this.emit();
	}

	private emit(): void {
		if (this.stopped || this.listeners.size === 0) return;
		const status = this.status();
		for (const listener of this.listeners) listener(status);
	}
}

/** The server cannot use browser sign-in (stdio, fixed headers or a model provider login). */
export class SignInUnavailable extends Error {}

function publicSignIn(state: SignInState<string>): McpSignInState {
	const { kind: _kind, ...rest } = state;
	return rest;
}
