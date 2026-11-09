/** Host-local bounded command execution. Trigger scheduling and durable retries belong to the caller. */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { runtimeEnvironment } from "@pilot/kernel/runtime-environment";
import { redactDiagnosticText } from "./diagnostic-redaction.ts";
import type { RuntimeBlocker } from "./runtime-admission.ts";
import { type SubprocessPool, subprocesses } from "./subprocess.ts";

export interface ActionResult {
	outcome: "ok" | "failed" | "timed_out" | "cancelled" | "interrupted" | "skipped";
	exitCode?: number;
	outputTail: string;
	truncated: boolean;
	durationMs: number;
	reason?: string;
}

export interface ActionRequest {
	actionId: string;
	projectId: string;
	sessionId?: string;
	cwd: string;
	/** Relative cwd is checked again against the canonical workspace at execution time. */
	relativeCwd?: string;
	run: { argv: string[] } | { shell: string } | { scriptCopy: string; args: string[] };
	env?: NodeJS.ProcessEnv;
	automationId?: string;
	trigger?: string;
	timeoutMs?: number;
	outputCapBytes?: number;
	signal?: AbortSignal;
	/** Must durably record running before spawn. Result output is already redacted. */
	record(state: "waiting" | "running" | ActionResult["outcome"], result?: ActionResult): Promise<void>;
	/** Recheck current owner controls after filesystem/preparation awaits, immediately before spawn. */
	revalidate?(): void;
}

interface Entry {
	request: ActionRequest;
	key: string;
	controller: AbortController;
	interrupted: boolean;
	resolve(result: ActionResult): void;
	reject(error: unknown): void;
	done: Promise<ActionResult>;
	removeAbort(): void;
}

/** Never hand broker/capability/provider secrets or shell-startup injection to a personal hook. */
export function actionEnvironment(additions: NodeJS.ProcessEnv = {}, base = runtimeEnvironment()): NodeJS.ProcessEnv {
	const safe = (key: string) =>
		!/^(PILOT_|PI_|BASH_FUNC_|DYLD_)|TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH|COOKIE|BROKER/i.test(key) &&
		!["BASH_ENV", "ENV", "NODE_OPTIONS", "LD_PRELOAD"].includes(key);
	return Object.fromEntries(
		[...Object.entries(base), ...Object.entries(additions)].filter(
			([key, value]) => value !== undefined && safe(key),
		),
	);
}

export function actionOutput(text: string): string {
	// Strip terminal framing before redaction; output never controls the timeline or prompt.
	return redactDiagnosticText(
		text
			.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
			.replace(/[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ""),
	);
}

function outputTail(text: string, cap: number): string {
	const bytes = Buffer.from(text);
	let start = Math.max(0, bytes.length - cap);
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

export class ActionRunner {
	private readonly queue: Entry[] = [];
	private readonly running = new Set<Entry>();
	private readonly listeners = new Set<(sessionId?: string) => void>();
	private readonly pool: SubprocessPool;
	private freezes = 0;
	private sleeping = false;
	private updating = false;
	private closing = false;

	constructor(pool: SubprocessPool = subprocesses) {
		this.pool = pool;
	}

	runAction(input: ActionRequest): Promise<ActionResult> {
		if (this.closing) return Promise.reject(new Error("Action runner is closed"));
		const request = { ...input, run: structuredClone(input.run), env: { ...input.env } };
		if ([...this.queue, ...this.running].some((entry) => entry.request.actionId === request.actionId))
			return Promise.reject(new Error("Action is already admitted"));
		if (this.queue.length >= 64) {
			const result: ActionResult = {
				outcome: "skipped",
				outputTail: "",
				truncated: false,
				durationMs: 0,
				reason: "too many automations waiting",
			};
			return request.record("skipped", result).then(() => result);
		}
		let resolve!: Entry["resolve"];
		let reject!: Entry["reject"];
		const done = new Promise<ActionResult>((yes, no) => {
			resolve = yes;
			reject = no;
		});
		const entry: Entry = {
			request,
			key: request.sessionId ?? `project:${request.projectId}`,
			controller: new AbortController(),
			interrupted: false,
			resolve,
			reject,
			done,
			removeAbort: () => {},
		};
		const abort = () => {
			entry.controller.abort();
			this.pump();
		};
		input.signal?.addEventListener("abort", abort, { once: true });
		entry.removeAbort = () => input.signal?.removeEventListener("abort", abort);
		if (input.signal?.aborted) entry.controller.abort();
		this.queue.push(entry);
		// Own the slot before any persistence await. Only a durable waiting record may enter the pump.
		void request.record("waiting").then(
			() => {
				ready.add(entry);
				this.changed(entry);
				this.pump();
			},
			(error) => this.finish(entry, undefined, error),
		);
		return done;
	}

	isWorking(sessionId: string): boolean {
		return [...this.queue, ...this.running].some((entry) => entry.request.sessionId === sessionId);
	}
	state(sessionId: string): { state: "running" | "waiting"; actionId: string } | undefined {
		const entry = [...this.running, ...this.queue].find((entry) => entry.request.sessionId === sessionId);
		return entry
			? { state: this.running.has(entry) ? "running" : "waiting", actionId: entry.request.actionId }
			: undefined;
	}

	async cancelSession(sessionId: string): Promise<void> {
		const entries = [...this.queue, ...this.running].filter((entry) => entry.request.sessionId === sessionId);
		for (const entry of entries) entry.controller.abort();
		this.pump();
		await Promise.allSettled(entries.map((entry) => entry.done));
	}

	/** No new starts. Running processes remain runtime blockers until they exit and their record drains. */
	setUpdatePaused(paused: boolean): void {
		this.updating = paused;
		this.pump();
	}
	/** The caller persists interrupted records before acknowledging OS sleep, without waiting for exit. */
	async pauseForSleep(): Promise<void> {
		this.sleeping = true;
		await Promise.all(
			[...this.running].map(async (entry) => {
				entry.interrupted = true;
				entry.controller.abort();
				await entry.request.record("interrupted");
			}),
		);
	}
	resumeAfterSleep(): void {
		this.sleeping = false;
		this.pump();
	}
	freezeAdmissions(): () => void {
		this.freezes++;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.freezes--;
				this.pump();
			}
		};
	}
	blockers(): RuntimeBlocker[] {
		return [...this.running].map((entry) => ({
			kind: "automation",
			id: entry.request.actionId,
			...(entry.request.sessionId ? { sessionId: entry.request.sessionId } : {}),
		}));
	}
	onChange(listener: (sessionId?: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async close(): Promise<void> {
		this.closing = true;
		await this.checkpointLifecycle();
		this.listeners.clear();
	}

	/** Explicit daemon control interrupts owned commands, never replays their shell effects. */
	async checkpointSession(sessionId: string): Promise<void> {
		const entries = [...this.queue, ...this.running].filter((entry) => entry.request.sessionId === sessionId);
		for (const entry of entries) {
			entry.interrupted = true;
			entry.controller.abort();
		}
		this.pump();
		const results = await Promise.allSettled(entries.map((entry) => entry.done));
		if (results.some((result) => result.status === "rejected")) throw new Error("Action checkpoint was not saved");
	}

	async checkpointLifecycle(): Promise<void> {
		const entries = [...this.queue, ...this.running];
		for (const entry of entries) {
			entry.interrupted = true;
			entry.controller.abort();
		}
		this.pump();
		await Promise.allSettled(entries.map((entry) => entry.done));
	}

	private pump(): void {
		for (const entry of [...this.queue]) {
			if (!ready.has(entry)) continue;
			if (entry.controller.signal.aborted) {
				this.launch(entry);
				continue;
			}
			if (this.sleeping || this.updating || this.freezes || this.closing || this.running.size >= 3) continue;
			if ([...this.running].some((active) => active.key === entry.key)) continue;
			// Preserve FIFO within each chat, even while its earlier waiting record is saving.
			if (
				this.queue.some(
					(earlier) =>
						earlier !== entry &&
						earlier.key === entry.key &&
						this.queue.indexOf(earlier) < this.queue.indexOf(entry),
				)
			)
				continue;
			this.launch(entry);
		}
	}
	private launch(entry: Entry): void {
		this.queue.splice(this.queue.indexOf(entry), 1);
		this.running.add(entry);
		this.changed(entry);
		void this.execute(entry).then(
			(result) => this.finish(entry, result),
			(error) => this.finish(entry, undefined, error),
		);
	}
	private finish(entry: Entry, result?: ActionResult, error?: unknown): void {
		const index = this.queue.indexOf(entry);
		if (index >= 0) this.queue.splice(index, 1);
		this.running.delete(entry);
		ready.delete(entry);
		entry.removeAbort();
		if (result) entry.resolve(result);
		else entry.reject(error);
		this.changed(entry);
		this.pump();
	}
	private changed(entry: Entry): void {
		for (const listener of this.listeners) listener(entry.request.sessionId);
	}
	private async execute(entry: Entry): Promise<ActionResult> {
		const { request, controller } = entry;
		const started = performance.now();
		let result: ActionResult;
		try {
			if (controller.signal.aborted) throw new Error("cancelled");
			await request.record("running");
			if (controller.signal.aborted) throw new Error("cancelled");
			const root = await realpath(request.cwd);
			const cwd = await realpath(resolve(root, request.relativeCwd ?? "."));
			const path = relative(root, cwd);
			if (path === ".." || path.startsWith("../") || isAbsolute(path) || !(await stat(cwd)).isDirectory())
				throw new Error("cwd must be a directory inside the workspace");
			const run = request.run;
			const argv =
				"argv" in run ? run.argv : "shell" in run ? ["/bin/sh", "-c", run.shell] : [run.scriptCopy, ...run.args];
			const timeoutMs = request.timeoutMs ?? 600_000;
			const cap = request.outputCapBytes ?? 256 * 1024;
			if (
				!argv.length ||
				!argv[0] ||
				argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
				!Number.isInteger(timeoutMs) ||
				timeoutMs < 1 ||
				timeoutMs > 3_600_000 ||
				!Number.isInteger(cap) ||
				cap < 1 ||
				cap > 256 * 1024
			)
				throw new Error("Invalid command bounds");
			request.revalidate?.();
			if (controller.signal.aborted) throw new Error("cancelled");
			const output = await this.pool.run(argv[0], argv.slice(1), {
				cwd,
				env: {
					...actionEnvironment(request.env),
					PILOT_AUTOMATION: request.automationId ?? request.actionId,
					PILOT_AUTOMATION_TRIGGER: request.trigger ?? "manual",
				},
				timeoutMs,
				maxBytes: cap,
				overflow: "tail",
				combinedOutput: true,
				detached: true,
				killSignal: "SIGTERM",
				forceKillMs: 5000,
				signal: controller.signal,
			});
			result = {
				outcome: entry.interrupted
					? "interrupted"
					: output.aborted
						? "cancelled"
						: output.timedOut
							? "timed_out"
							: output.code === 0 && !output.error
								? "ok"
								: "failed",
				...(output.code !== null ? { exitCode: output.code } : {}),
				outputTail: outputTail(actionOutput(output.stdout.toString("utf8")), cap),
				truncated: output.truncated,
				durationMs: performance.now() - started,
			};
		} catch (error) {
			result = {
				outcome: entry.interrupted ? "interrupted" : controller.signal.aborted ? "cancelled" : "failed",
				outputTail: "",
				truncated: false,
				durationMs: performance.now() - started,
				reason: actionOutput((error instanceof Error ? error.message : String(error)).slice(0, 512)),
			};
		}
		await request.record(result.outcome, result);
		return result;
	}
}

/** Waiting persistence may finish out of order; unready entries must never spawn. */
const ready = new WeakSet<Entry>();
