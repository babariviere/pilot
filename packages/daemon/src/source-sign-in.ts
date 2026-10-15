import type { SourceSignIn, TrackedKind } from "@pilot/protocol";

/** The browser approval was cancelled, timed out in the flow, or the worker stopped. */
export class SourceSignInCancelled extends Error {}
/** A sign-in failure whose message is safe to show (no server text, config values or tokens). */
export class SourceSignInFailed extends Error {}

export type SourceLogin<K extends string = TrackedKind> = (
	kind: K,
	options: { again: boolean; signal: AbortSignal },
) => Promise<void>;
/** A sign-in keyed by tracking kind, or by MCP server name for the Connections settings. */
export type SignInState<K extends string = TrackedKind> = Omit<SourceSignIn, "kind"> & { kind: K };

type Run<K extends string> = { state: SignInState<K>; controller?: AbortController; settled: Promise<void> };

/** One browser sign-in per server, bounded by a timeout, cancellable, with the last result kept. */
export class SourceSignIns<K extends string = TrackedKind> {
	private readonly runs = new Map<K, Run<K>>();
	private stopped = false;
	private readonly login: SourceLogin<K>;
	private readonly changed: (state: SignInState<K>) => void;
	private readonly timeoutMs: number;
	constructor(login: SourceLogin<K>, changed: (state: SignInState<K>) => void, timeoutMs = 300_000) {
		this.login = login;
		this.changed = changed;
		this.timeoutMs = timeoutMs;
	}
	get(kind: K): SignInState<K> | undefined {
		const state = this.runs.get(kind)?.state;
		return state && { ...state };
	}
	/** Returns the running sign-in when one is waiting, so repeated clicks never open a second browser flow. */
	start(kind: K, again = false): SignInState<K> {
		if (this.stopped) throw new Error("Sign-in is stopped");
		const previous = this.runs.get(kind);
		if (previous?.state.state === "waiting") return { ...previous.state };
		const startedAt = Date.now();
		const controller = new AbortController();
		const state: SignInState<K> = {
			kind,
			state: "waiting",
			...(again ? { again: true } : {}),
			startedAt,
			expiresAt: startedAt + this.timeoutMs,
		};
		const run: Run<K> = { state, controller, settled: Promise.resolve() };
		const timer = setTimeout(
			() => controller.abort(new SourceSignInFailed("Sign-in timed out. Try again.")),
			this.timeoutMs,
		);
		timer.unref();
		// A cancelled worker may still hold the loopback callback port briefly; start after it exits.
		run.settled = (previous?.settled ?? Promise.resolve())
			.then(() => {
				controller.signal.throwIfAborted();
				return this.login(kind, { again, signal: controller.signal });
			})
			.then(
				() => this.finish(kind, run, "done"),
				(error: unknown) => {
					const reason = controller.signal.aborted ? controller.signal.reason : error;
					if (reason instanceof SourceSignInFailed) this.finish(kind, run, "failed", reason.message);
					else if (reason instanceof SourceSignInCancelled || controller.signal.aborted)
						this.finish(kind, run, "cancelled");
					else this.finish(kind, run, "failed", "Sign-in didn't finish. Try again.");
				},
			)
			.finally(() => clearTimeout(timer));
		this.runs.set(kind, run);
		this.changed({ ...state });
		return { ...state };
	}
	/** Reports cancelled at once; the flow winds down in the background. */
	cancel(kind: K): SignInState<K> | undefined {
		const run = this.runs.get(kind);
		if (run?.state.state === "waiting") {
			const controller = run.controller;
			this.finish(kind, run, "cancelled");
			controller?.abort(new SourceSignInCancelled("Sign-in cancelled"));
		}
		return this.get(kind);
	}
	async stop(): Promise<void> {
		this.stopped = true;
		for (const kind of [...this.runs.keys()]) this.cancel(kind);
		await Promise.allSettled([...this.runs.values()].map((run) => run.settled));
	}
	private finish(kind: K, run: Run<K>, state: SourceSignIn["state"], error?: string): void {
		if (run.state.state !== "waiting" || this.runs.get(kind) !== run) return;
		run.state = { ...run.state, state, finishedAt: Date.now(), ...(error ? { error } : {}) };
		run.controller = undefined;
		this.changed({ ...run.state });
	}
}
