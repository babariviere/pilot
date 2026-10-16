/** Host-local pre-chat setup. Only fixed helpers, canonical auth and non-secret state survive a run. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CredentialClient, credentialEnvironment } from "@pilot/kernel/credential-client";
import type { CredentialEndpoint, CredentialStatus, CredentialStatuses } from "@pilot/kernel/credential-rpc";
import type {
	McpStatus,
	SetupChallenge,
	SetupReadiness,
	SetupRun,
	SetupServerMessage,
	SetupStartRequest,
} from "@pilot/protocol";
import type { IPty } from "node-pty";
import type { CredentialBroker } from "./credential-broker.ts";
import {
	SETUP_INPUT_BYTES,
	SETUP_METHODS,
	SETUP_OUTPUT_BYTES,
	supportedSetup,
	validManualAnswer,
	validSetupChallenge,
} from "./setup-provider.ts";
import { loadPty } from "./terminals.ts";

export class SetupError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}
type Run = {
	state: SetupRun;
	process: IPty;
	endpoint: CredentialEndpoint;
	challenge?: SetupChallenge;
	answered: boolean;
	inputBytes: number;
	outputBytes: number;
	buffer: string;
	listeners: Set<(message: SetupServerMessage) => void>;
	timer: ReturnType<typeof setTimeout>;
	killTimer?: ReturnType<typeof setTimeout>;
	exited: boolean;
	done: boolean;
	settled: Promise<void>;
	cancellation?: Promise<void>;
};
const providers = builtinProviders().map(({ id, name }) => ({ id, name }));
const active = (run: Run) => !run.exited || !!run.cancellation;
const busy = (run: Run) => ["starting", "waiting", "working"].includes(run.state.state);
type SetupOptions = {
	mcp?: () => McpStatus;
	timeoutMs?: number;
	/** Trusted embedding/test seam, never supplied by an HTTP request. */
	helperFile?: string;
};

export class SetupService {
	private readonly runs = new Map<string, Run>();
	private readonly listeners = new Set<() => void>();
	private readonly reader: CredentialClient;
	private readonly readerEndpoint: CredentialEndpoint;
	private freezes = 0;
	private stopped = false;
	private readonly broker: CredentialBroker;
	private readonly options: SetupOptions;
	constructor(broker: CredentialBroker, options: SetupOptions = {}) {
		this.broker = broker;
		this.options = options;
		this.readerEndpoint = broker.grant();
		this.reader = new CredentialClient(this.readerEndpoint);
	}
	async readiness(): Promise<SetupReadiness> {
		try {
			// One bounded metadata read, not one full auth/journal parse per built-in provider.
			const inventory = (await this.reader.request({ op: "statuses", namespace: "pi" })) as CredentialStatuses;
			const byProvider = new Map(inventory.map((entry) => [entry.providerId, entry.state]));
			const states = providers.map((provider) => ({
				...provider,
				methods: [...(SETUP_METHODS[provider.id] ?? [])],
				credential: byProvider.get(provider.id) ?? ("missing" as const),
			}));
			const mcp = this.options.mcp?.();
			return {
				providers: states,
				independentCredentials: true,
				integrations: (["linear", "slack"] as const).map((kind) => ({
					kind,
					state:
						mcp?.servers.find((entry) => entry.name === kind)?.state ??
						(!mcp || mcp.checking || mcp.configProblems ? "unknown" : "not_configured"),
					login: "unsupported",
					problem:
						"Configure this host's global pi MCP server independently. Browser-callback sign-in is not relayed between hosts; use pi mcp login on that host with a supported callback path.",
				})),
			};
		} catch {
			throw new SetupError(503, "Credential authority unavailable. No private credential fallback is used.");
		}
	}
	get(id: string): SetupRun {
		return { ...this.require(id).state };
	}
	list(): SetupRun[] {
		return [...this.runs.values()].map((run) => ({ ...run.state }));
	}
	start(request: SetupStartRequest): SetupRun {
		if (
			!request ||
			typeof request !== "object" ||
			Object.keys(request).some((key) => !["provider", "method"].includes(key)) ||
			!supportedSetup(request.provider, request.method)
		)
			throw new SetupError(
				409,
				"This provider or headless method is unsupported. No generic browser callback relay is available.",
			);
		if (this.freezes || this.stopped) throw new SetupError(409, "Setup admissions are frozen.");
		if ([...this.runs.values()].some((run) => active(run) && run.state.provider === request.provider))
			throw new SetupError(409, "A setup helper for this provider is still running. Reattach or cancel it first.");
		if (this.blockers().length >= 2) throw new SetupError(429, "Setup helper capacity reached.");
		if (this.runs.size >= 32) {
			const retired = [...this.runs].find(([, run]) => !active(run) && run.listeners.size === 0);
			if (!retired) throw new SetupError(429, "Detach older setup helpers before starting another.");
			this.runs.delete(retired[0]);
		}
		const id = randomUUID(),
			createdAt = Date.now();
		const timeout = Math.min(300_000, Math.max(100, this.options.timeoutMs ?? 300_000));
		let endpoint: CredentialEndpoint;
		try {
			endpoint = this.broker.grant(true, { namespace: "pi", key: request.provider });
		} catch {
			throw new SetupError(503, "Credential authority unavailable. No private credential fallback is used.");
		}
		let child: IPty;
		try {
			// Deliberately no inherited NODE_OPTIONS, provider keys, broker admin token, or login shell.
			child = loadPty().spawn(
				process.execPath,
				[
					this.options.helperFile ?? fileURLToPath(new URL("./setup-worker.ts", import.meta.url)),
					request.provider,
					request.method,
				],
				{
					name: "xterm-256color",
					cols: 80,
					rows: 24,
					cwd: this.broker.agentDir,
					env: {
						HOME: process.env.HOME ?? this.broker.agentDir,
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						TERM: "xterm-256color",
						...credentialEnvironment(endpoint),
						PILOT_READ_ONLY_CONFIG: "1",
					} as Record<string, string>,
				},
			);
		} catch {
			this.broker.revoke(endpoint);
			throw new SetupError(503, "Couldn't start the trusted setup helper.");
		}
		let resolveExit!: () => void;
		const run: Run = {
			state: {
				id,
				provider: request.provider,
				method: request.method,
				state: "starting",
				createdAt,
				expiresAt: createdAt + timeout,
				reauthenticationRequired: false,
			},
			process: child,
			endpoint,
			answered: false,
			inputBytes: 0,
			outputBytes: 0,
			buffer: "",
			listeners: new Set(),
			exited: false,
			done: false,
			settled: new Promise<void>((resolve) => {
				resolveExit = resolve;
			}),
			timer: setTimeout(() => {
				void this.cancel(id, "failed").catch(() => {});
			}, timeout),
		};
		run.timer.unref();
		this.runs.set(id, run);
		child.onData((data) => this.output(run, data));
		child.onExit(() => {
			run.exited = true;
			run.buffer = "";
			run.challenge = undefined;
			clearTimeout(run.timer);
			clearTimeout(run.killTimer);
			if (busy(run) && !run.cancellation) {
				if (run.done) {
					run.state = { ...run.state, state: "done" };
					this.broker.revoke(endpoint);
				} else void this.cancel(id, "failed").catch(() => {});
			}
			this.emit(run);
			resolveExit();
			this.changed();
		});
		this.changed();
		return { ...run.state };
	}
	/** Logout removes only canonical stored auth, not ambient variables or provider-side grants. */
	async logout(provider: string): Promise<CredentialStatus> {
		if (!providers.some(({ id }) => id === provider)) throw new SetupError(404, "Unknown provider.");
		const run = [...this.runs.values()].find((run) => run.state.provider === provider && active(run));
		if (run) await this.cancel(run.state.id);
		const endpoint = this.broker.grant(true, { namespace: "pi", key: provider });
		const client = new CredentialClient(endpoint);
		try {
			await client.request({ op: "delete", namespace: "pi", key: provider });
			return { state: "missing" };
		} catch {
			throw new SetupError(503, "Logout could not be confirmed. Recheck this host before signing in again.");
		} finally {
			this.broker.revoke(endpoint);
			await client.close();
		}
	}
	async cancel(id: string, state: "cancelled" | "failed" = "cancelled"): Promise<SetupRun> {
		const run = this.require(id);
		if (run.cancellation) {
			await run.cancellation;
			return { ...run.state };
		}
		if (!busy(run)) return { ...run.state };
		run.challenge = undefined;
		run.buffer = "";
		clearTimeout(run.timer);
		// Publish the terminal outcome only after the durable fence. Revocation also prevents a helper
		// still blocked in begin/commit from using its capability again.
		run.cancellation = this.broker
			.cancelSetup(run.endpoint)
			.then(
				({ reauthenticationRequired }) => {
					run.state = {
						...run.state,
						state,
						reauthenticationRequired,
						problem: reauthenticationRequired
							? "Sign-in did not complete. Stored authentication is fenced or another sign-in is pending; recheck readiness and sign in again if required."
							: "Sign-in did not complete. This cancellation did not fence the current authentication generation.",
					};
				},
				() => {
					run.state = {
						...run.state,
						state: "failed",
						reauthenticationRequired: true,
						problem: "Cancellation fence could not be confirmed. Reauthentication is required.",
					};
					throw new SetupError(503, run.state.problem!);
				},
			)
			.finally(() => {
				if (!run.exited) {
					try {
						run.process.kill("SIGTERM");
					} catch {}
					run.killTimer = setTimeout(() => {
						try {
							if (!run.exited) process.kill(-run.process.pid, "SIGKILL");
						} catch {}
					}, 1000);
					run.killTimer.unref();
				}
				this.emit(run);
				this.changed();
			});
		try {
			await run.cancellation;
		} catch {
			throw new SetupError(503, "Cancellation fence could not be confirmed. Reauthentication is required.");
		} finally {
			run.cancellation = undefined;
			this.changed();
		}
		return { ...run.state };
	}
	attach(id: string, listener: (message: SetupServerMessage) => void): () => void {
		const run = this.require(id);
		if (run.listeners.size >= 4) throw new SetupError(429, "Too many setup attachments.");
		run.listeners.add(listener);
		listener({ type: "setup.state", run: { ...run.state } });
		// Current pending challenge only, never prior terminal output or submitted answers.
		if (run.challenge && busy(run) && !run.answered)
			listener({ type: "setup.challenge", challenge: { ...run.challenge } });
		return () => {
			run.listeners.delete(listener);
		};
	}
	answer(id: string, challengeId: string, answer: string): void {
		const run = this.require(id);
		if (
			!busy(run) ||
			!run.challenge ||
			run.answered ||
			run.challenge.id !== challengeId ||
			typeof answer !== "string"
		)
			throw new SetupError(409, "This challenge is no longer accepting an answer.");
		if (!validManualAnswer(run.challenge, answer))
			throw new SetupError(400, "Paste the complete code#state response for this sign-in.");
		const frame = `${JSON.stringify({ id: challengeId, answer: answer.trim() })}\n`;
		const bytes = Buffer.byteLength(frame);
		// node-pty 1.1.0 has an unbounded native write queue. A non-resetting lifetime enqueue cap,
		// one outstanding challenge and two live helpers bound it even without a public drain API.
		if (run.inputBytes + bytes > SETUP_INPUT_BYTES) {
			void this.cancel(id, "failed").catch(() => {});
			throw new SetupError(413, "Setup lifetime input limit reached.");
		}
		run.inputBytes += bytes;
		run.answered = true;
		run.challenge = undefined;
		run.state = { ...run.state, state: "working" };
		try {
			run.process.write(frame);
		} catch {
			void this.cancel(id, "failed").catch(() => {});
			throw new SetupError(503, "Couldn't deliver the setup answer.");
		}
		this.emit(run);
	}
	resize(id: string, cols: number, rows: number): void {
		if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 500)
			throw new SetupError(400, "Invalid setup terminal size.");
		const run = this.require(id);
		if (!run.exited) {
			try {
				run.process.resize(cols, rows);
			} catch {}
		}
	}
	blockers(): { kind: "setup"; id: string }[] {
		return [...this.runs.values()].filter(active).map((run) => ({ kind: "setup", id: run.state.id }));
	}
	freezeAdmissions(): () => void {
		this.freezes++;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.freezes--;
			}
		};
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async close(): Promise<void> {
		this.stopped = true;
		await Promise.allSettled([...this.runs.keys()].map((id) => this.cancel(id)));
		await Promise.all([...this.runs.values()].map((run) => run.settled));
		this.broker.revoke(this.readerEndpoint);
		await this.reader.close();
		for (const run of this.runs.values()) run.listeners.clear();
		this.listeners.clear();
		this.runs.clear();
	}
	private require(id: string): Run {
		const run = this.runs.get(id);
		if (!run) throw new SetupError(404, "Unknown setup run. Start or reattach explicitly on the selected host.");
		return run;
	}
	private output(run: Run, data: string): void {
		if (!busy(run) || run.cancellation) return;
		run.outputBytes += Buffer.byteLength(data);
		if (run.outputBytes > SETUP_OUTPUT_BYTES) {
			void this.cancel(run.state.id, "failed").catch(() => {});
			return;
		}
		run.buffer += data;
		while (run.buffer.includes("\n") && busy(run)) {
			const end = run.buffer.indexOf("\n");
			const line = run.buffer.slice(0, end).trim();
			run.buffer = run.buffer.slice(end + 1);
			try {
				const message = JSON.parse(line) as { done?: boolean; failed?: boolean; challenge?: unknown };
				if (message.done === true && !run.done) {
					run.done = true;
					run.challenge = undefined;
				} else if (message.failed === true) {
					void this.cancel(run.state.id, "failed").catch(() => {});
				} else if (
					!run.challenge &&
					!run.answered &&
					validSetupChallenge(run.state.provider, message.challenge) &&
					message.challenge.type === run.state.method
				) {
					run.challenge = {
						id: message.challenge.id,
						type: message.challenge.type,
						url: message.challenge.url,
						...(message.challenge.userCode ? { userCode: message.challenge.userCode } : {}),
					};
					run.state = { ...run.state, state: "waiting" };
					this.emit(run);
					for (const listener of run.listeners)
						listener({ type: "setup.challenge", challenge: { ...run.challenge } });
				} else {
					void this.cancel(run.state.id, "failed").catch(() => {});
				}
			} catch {
				void this.cancel(run.state.id, "failed").catch(() => {});
			}
		}
	}
	private emit(run: Run): void {
		for (const listener of run.listeners) listener({ type: "setup.state", run: { ...run.state } });
	}
	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}
