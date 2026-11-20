/** Shared fakes for the kernel worker boundary: an IPC child for Worker tests and a SessionWorker for manager tests. */
import { EventEmitter } from "node:events";
import type { HostCalls, HostMethod, KernelCommand, KernelPacket, KernelUsage } from "@pilot/kernel";
import type { AgentEvent, SessionCompletion, SessionState } from "@pilot/protocol";
import { applyLivePacket, type SessionWorker } from "../kernel-worker.ts";

type Spec = Extract<KernelCommand, { type: "start" }>["spec"];
export type FakeRequest = Extract<KernelCommand, { requestId: string }>;

/** pilotd's answer to a host call of one of these methods, with the method's result type. */
export type HostResult<M extends HostMethod> = {
	type: "host.result";
	callId: string;
	result?: HostCalls[M]["result"];
	error?: string;
};

export const emptySnapshot: AgentEvent = {
	type: "snapshot",
	entries: [],
	tools: [],
	nestedTools: [],
	compactions: [],
	inbox: [],
	agent: {},
	usage: { models: {}, tools: {} },
};

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** A forked kernel child as Worker sees it: IPC send, exit and signals. Tests emit packets with emit("message"). */
export class FakeKernelProcess extends EventEmitter {
	connected = true;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly sent: KernelCommand[] = [];
	readonly killed: NodeJS.Signals[] = [];
	send(command: KernelCommand, callback?: (error: Error | null) => void): boolean {
		this.sent.push(command);
		callback?.(null);
		return true;
	}
	kill(signal: NodeJS.Signals): boolean {
		this.killed.push(signal);
		this.connected = false;
		this.signalCode = signal;
		this.emit("exit", null, signal);
		return true;
	}
}

/**
 * A kernel worker without a process. deliver() applies live packet state like Worker does, then hands the packet to
 * the session manager's callback. Inputs move it to working; other requests leave it idle.
 */
export class FakeKernelWorker<Request extends FakeRequest = FakeRequest> implements SessionWorker {
	/** Resolve or reject to finish startup; open() resolves it. */
	readonly gate = deferred();
	readonly ready = this.gate.promise;
	state: SessionState = "starting";
	usage?: KernelUsage;
	error?: string;
	toolsRunning?: boolean;
	compacting?: boolean;
	openTodoCount?: number;
	readonly sent: KernelCommand[] = [];
	readonly requests: Request[] = [];
	children = false;
	closed = false;
	closeGate?: Promise<void>;
	readonly spec: Spec;
	private readonly onPacket: (packet: KernelPacket) => void;
	private readonly onExit: (worker: SessionWorker, code: number | null) => void;
	private readonly admit: (command: Request) => Promise<void>;

	constructor(
		spec: Spec,
		onPacket: (packet: KernelPacket) => void,
		onExit: (worker: SessionWorker, code: number | null) => void,
		admit: (command: Request) => Promise<void> = async () => {},
	) {
		this.spec = spec;
		this.onPacket = onPacket;
		this.onExit = onExit;
		this.admit = admit;
		this.ready.catch(() => undefined);
	}

	get busy(): boolean {
		return this.state === "starting" || this.state === "working";
	}

	deliver(packet: KernelPacket): void {
		applyLivePacket(this, packet);
		this.onPacket(packet);
	}

	open(): void {
		this.state = "idle";
		this.deliver({ type: "ready", model: "test/model", working: false, usage: this.usage ?? {} });
		this.gate.resolve();
	}

	finish(completion?: SessionCompletion): void {
		this.state = "idle";
		this.deliver({ type: "working", working: false, ...(completion ? { completion } : {}) });
	}

	send(command: KernelCommand): void {
		this.sent.push(command);
		if (command.type === "watch") this.deliver({ type: "events", watchId: command.watchId, events: [emptySnapshot] });
	}

	async request(command: Request): Promise<void> {
		this.requests.push(command);
		await this.admit(command);
		if (command.type === "reloadPi") {
			this.deliver({ type: "piReloaded", requestId: command.requestId, commands: [] });
			return;
		}
		this.state = command.type === "input" ? "working" : "idle";
		this.deliver({ type: "working", working: this.state === "working" });
	}

	async hasChildren(): Promise<boolean> {
		return this.children;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.closeGate;
		this.gate.reject(new Error("closed"));
		this.onExit(this, 0);
	}

	crash(): void {
		this.state = "failed";
		this.error = "IPC connection failed";
		this.gate.reject(new Error(this.error));
		this.onExit(this, 1);
	}
}
