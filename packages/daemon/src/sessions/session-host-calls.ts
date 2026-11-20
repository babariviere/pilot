/**
 * Host calls from kernel workers: one handler per method, one reply path, and the role gates as data. A restricted
 * profile (a planning worker or an Insights chat) may use only the methods its policy names.
 */
import type { HostCallPacket, HostCalls, HostMethod, KernelCommand } from "@pilot/kernel";

/** A shared in-flight limit. It protects pilotd from a worker that floods calls; a full pool refuses at once. */
export interface HostCallPool {
	limit: number;
	/** The refusal text the tool shows. */
	busy: string;
}

export interface HostCallHandler<M extends HostMethod, Context> {
	/** The handler runs for a worker that is being parked and checks that itself. Others get no reply. */
	whileParked?: true;
	/** A read with no durable write to join at shutdown. */
	readOnly?: true;
	/** Accounting from a worker that is still exiting. */
	whileClosing?: true;
	pool?: HostCallPool;
	/** The error text for a failed call: a fixed text, or one built from the error. */
	failure: string | ((error: unknown) => string);
	handle(context: Context, args: HostCalls[M]["args"], signal: AbortSignal): Promise<HostCalls[M]["result"]>;
}

export type HostCallTable<Context> = { [M in HostMethod]: HostCallHandler<M, Context> };

/** The methods a restricted profile may use: always, or only for the arguments a predicate allows. */
type HostCallPolicy = { [M in HostMethod]?: true | ((args: HostCalls[M]["args"]) => boolean) };

/** Calls every model-running worker needs: accounting, usage pauses and its own command guards. */
const RUNTIME: HostCallPolicy = {
	"question.guard": true,
	"model.configuration.guard": true,
	"usage-history": true,
	"usage-history.epoch": true,
	"subscription.limit": true,
};

export const HOST_CALL_PROFILES = {
	/**
	 * Planners use their bound native port and read sources, artifacts and metrics for research. They read and record
	 * project Knowledge, but documentation batches stay with coordinators. Mission ticket reads limited, linked Linear
	 * context without writes.
	 */
	planning: {
		...RUNTIME,
		planning: true,
		"planning.guard": true,
		knowledge: ({ action }) => action !== "batch",
		mission: ({ action }) => action === "ticket",
		"source.scope": true,
		"source.references": true,
		"artifact.reference": true,
		"publication.source": true,
		"diagnostics.context": true,
	},
	/** Insights reads its backlog and the diagnostic history it was granted, nothing else. */
	insights: {
		...RUNTIME,
		"insights.backlog": true,
		"diagnostics.context": true,
	},
} satisfies Record<string, HostCallPolicy>;

const PROFILE_REFUSALS = {
	planning: "Planning profile permits only its bound native port",
	insights: "Insights denies this capability",
} as const;

export interface HostCaller<Context> {
	sessionId: string;
	worker: object;
	context: Context;
	profile: keyof typeof HOST_CALL_PROFILES | undefined;
	parked: boolean;
	/** Sends the reply only while the worker that called is still the session's worker. */
	reply(command: Extract<KernelCommand, { type: "host.result" }>): void;
}

interface InFlight {
	sessionId: string;
	worker: object;
	method: HostMethod;
	controller: AbortController;
	done: Promise<void>;
}

export class HostCallDispatcher<Context> {
	private readonly table: HostCallTable<Context>;
	private readonly inFlight = new Map<string, InFlight>();
	private closing = false;

	constructor(table: HostCallTable<Context>) {
		this.table = table;
	}

	dispatch(caller: HostCaller<Context>, packet: HostCallPacket): void {
		const handler = this.table[packet.method] as HostCallHandler<HostMethod, Context> | undefined;
		const refuse = (error: string) => caller.reply({ type: "host.result", callId: packet.callId, error });
		if (!Object.hasOwn(this.table, packet.method) || !handler)
			return refuse(`Unknown host call ${String(packet.method)}`);
		if (this.closing && !handler.whileClosing) return refuse("pilotd is shutting down");
		if (caller.profile) {
			const allowed = (HOST_CALL_PROFILES[caller.profile] as HostCallPolicy)[packet.method] as
				| true
				| ((args: unknown) => boolean)
				| undefined;
			if (!allowed || (allowed !== true && (packet.args == null || !allowed(packet.args))))
				return refuse(PROFILE_REFUSALS[caller.profile]);
		}
		if (caller.parked && !handler.whileParked) return;
		const key = `${caller.sessionId}:${packet.callId}`;
		if (this.inFlight.has(key)) return refuse("This host call is already running");
		if (handler.pool && this.count((call) => this.table[call.method].pool === handler.pool) >= handler.pool.limit)
			return refuse(handler.pool.busy);
		const controller = new AbortController();
		// The handler starts now, so its checks before the first await run before any later packet.
		const done = new Promise<unknown>((resolve) =>
			resolve(handler.handle(caller.context, packet.args, controller.signal)),
		)
			.then(
				(result) => caller.reply({ type: "host.result", callId: packet.callId, result }),
				(error: unknown) =>
					caller.reply({
						type: "host.result",
						callId: packet.callId,
						error: typeof handler.failure === "string" ? handler.failure : handler.failure(error),
					}),
			)
			.finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, {
			sessionId: caller.sessionId,
			worker: caller.worker,
			method: packet.method,
			controller,
			done,
		});
	}

	cancel(sessionId: string, worker: object, callId: string): void {
		const call = this.inFlight.get(`${sessionId}:${callId}`);
		if (
			call?.worker === worker &&
			(call.method === "screen" || call.method === "diagnostics.context" || call.method === "diagnostics.logs")
		)
			call.controller.abort();
	}

	/** Calls still running, for one session or all, optionally only these methods. */
	running(sessionId?: string, methods?: readonly HostMethod[]): Promise<void>[] {
		return [...this.inFlight.values()]
			.filter(
				(call) =>
					(sessionId === undefined || call.sessionId === sessionId) && (!methods || methods.includes(call.method)),
			)
			.map((call) => call.done);
	}

	/** In-flight calls of these methods, across sessions. */
	size(methods: readonly HostMethod[]): number {
		return this.count((call) => methods.includes(call.method));
	}

	beginClosing(): void {
		this.closing = true;
		for (const call of this.inFlight.values()) if (this.table[call.method].readOnly) call.controller.abort();
	}

	writesToDrain(): Promise<void>[] {
		return [...this.inFlight.values()].filter((call) => !this.table[call.method].readOnly).map((call) => call.done);
	}

	private count(match: (call: InFlight) => boolean): number {
		let count = 0;
		for (const call of this.inFlight.values()) if (match(call)) count++;
		return count;
	}
}
