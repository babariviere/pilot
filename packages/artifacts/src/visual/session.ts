/**
 * One visual in a quickjs-wasi VM, driven through runtime.js exactly as the app's helper drives it: load, render,
 * event, state. Calls are synchronous and bounded by the doc's per-phase time limits; run them off the event loop.
 */
import { readFile } from "node:fs/promises";
import { Intrinsics, JSException, type JSValueHandle, QuickJS } from "quickjs-wasi";
import { Compile } from "typebox/compile";
import { VISUAL_LIMITS, type VisualTree, VisualTreeSchema } from "./schema.ts";

/** The source's own lines: it is evaluated as VISUAL_PREFIX + source + "\n)" under this filename. */
export const VISUAL_FILENAME = "visual.js";
/** Strict mode, on the source's first line so line numbers match. */
export const VISUAL_PREFIX = '"use strict";(';
const RUNTIME_FILENAME = "pilot-visual-runtime.js";

export type VisualPhase = "setup" | "view" | "handler";
const PHASE_MS: Record<VisualPhase, number> = {
	setup: VISUAL_LIMITS.setupMs,
	view: VISUAL_LIMITS.viewMs,
	handler: VISUAL_LIMITS.handlerMs,
};

const treeCheck = Compile(VisualTreeSchema);

let runtimeText: Promise<string> | undefined;
/** runtime.js, shared verbatim with the app's helper. */
export function visualRuntime(): Promise<string> {
	runtimeText ??= readFile(new URL("./runtime.js", import.meta.url), "utf8").catch((error) => {
		runtimeText = undefined;
		throw error;
	});
	return runtimeText;
}

/** A failed rule, script error or limit, with the line inside the visual function when known. */
export class VisualFailure extends Error {
	readonly line?: number;
	constructor(message: string, line?: number) {
		super(message);
		this.line = line;
	}

	/** "line N: message", the form agents and the app show. */
	get report(): string {
		return (this.line === undefined ? "" : `line ${this.line}: `) + this.message;
	}
}

/** FNV-1a over UTF-16 code units, as runtime.js seeds Math.random from the artifact id. */
export function visualSeed(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** WASI with a fixed clock, seeded randomness and discarded output: nothing of the host leaks into the VM. */
function deterministicWasi(seed: number, now: number) {
	let state = (seed ^ 0x9e3779b9) >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return (value ^ (value >>> 14)) >>> 0;
	};
	return (memory: { buffer: ArrayBuffer }) => ({
		clock_time_get(clockId: number, _precision: bigint, resultPtr: number) {
			const nanoseconds = clockId === 0 ? BigInt(Math.round(now)) * 1_000_000n : 0n;
			new DataView(memory.buffer).setBigUint64(resultPtr, nanoseconds, true);
			return 0;
		},
		random_get(bufPtr: number, bufLen: number) {
			const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
			for (let index = 0; index < bufLen; index += 4) {
				const value = next();
				for (let byte = 0; byte < 4 && index + byte < bufLen; byte++) bytes[index + byte] = value >>> (byte * 8);
			}
			return 0;
		},
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let index = 0; index < iovsLen; index++) written += view.getUint32(iovsPtr + index * 8 + 4, true);
			view.setUint32(nwrittenPtr, written, true);
			return 0;
		},
	});
}

function lineOf(stack: string | undefined): number | undefined {
	const match = stack?.match(/visual\.js:(\d+)/);
	return match ? Number(match[1]) : undefined;
}

export interface VisualSessionOptions {
	/** Compiled quickjs-wasi/quickjs.wasm, from loadQuickJSWasm(). */
	wasm: object;
	/** Text of runtime.js. */
	runtime: string;
	/** The artifact id. The runtime seeds Math.random from it. */
	seed: string;
	/** Date.now() inside the visual. */
	now: number;
}

export class VisualSession {
	readonly engine: string;
	/** console output of the visual, bounded. */
	readonly logs: string[] = [];
	private readonly vm: QuickJS;
	private readonly api: JSValueHandle;
	private readonly options: VisualSessionOptions;
	private readonly clock: { deadline: number };
	private fn?: JSValueHandle;
	private source = "";

	private constructor(vm: QuickJS, options: VisualSessionOptions, clock: { deadline: number }) {
		this.vm = vm;
		this.options = options;
		this.clock = clock;
		this.engine = `quickjs-ng ${vm.versions.quickjs}`;
		this.api = vm.evalCode(options.runtime, RUNTIME_FILENAME);
	}

	static async open(options: VisualSessionOptions): Promise<VisualSession> {
		const clock = { deadline: Number.POSITIVE_INFINITY };
		const vm = await QuickJS.create({
			wasm: options.wasm as never,
			memoryLimit: VISUAL_LIMITS.heapBytes,
			maxStackSize: VISUAL_LIMITS.stackBytes,
			interruptHandler: () => performance.now() > clock.deadline,
			wasi: deterministicWasi(visualSeed(options.seed), options.now) as never,
			timezoneOffset: 0,
			intrinsics: Intrinsics.ALL & ~Intrinsics.WEAK_REF,
		});
		try {
			return new VisualSession(vm, options, clock);
		} catch (error) {
			vm.dispose();
			throw error;
		}
	}

	/** Evaluate the source (once) and run setup, optionally restoring a saved state. */
	load(source: string, data: string, state?: string): void {
		const { vm } = this;
		if (!this.fn || source !== this.source) {
			this.fn?.dispose();
			this.fn = undefined;
			this.fn = this.run("setup", () => vm.evalCode(`${VISUAL_PREFIX}${source}\n)`, VISUAL_FILENAME));
			this.source = source;
		}
		const fn = this.fn;
		this.call("setup", "load", () => [
			fn,
			vm.newString(source),
			vm.newString(data),
			state === undefined ? vm.undefined : vm.newString(state),
			vm.newString(this.options.seed),
			vm.newNumber(this.options.now),
		]);
	}

	/** Run the view. Returns the tree's JSON as the runtime produced it, and the parsed, schema-checked tree. */
	render(): { json: string; tree: VisualTree } {
		const json = this.call("view", "render", () => [this.vm.newNumber(this.options.now)]);
		const tree = JSON.parse(json) as VisualTree;
		if (!treeCheck.Check(tree)) {
			const [first] = treeCheck.Errors(tree);
			throw new VisualFailure(
				"Pilot's visual runtime produced a tree outside API 1 at " +
					(first?.instancePath || "/") +
					" (" +
					(first?.message ?? "invalid") +
					"). This is a Pilot bug, not a problem with the visual",
			);
		}
		return { json, tree };
	}

	/** Send a control event. Returns the state keys the handler assigned. Render afterwards. */
	event(id: string, value: unknown): string[] {
		const { vm } = this;
		const result = this.call("handler", "event", () => [
			vm.newString(id),
			value === undefined ? vm.undefined : vm.newString(JSON.stringify(value)),
			vm.newNumber(this.options.now),
		]);
		return (JSON.parse(result) as { changed: string[] }).changed;
	}

	/** Reader state as JSON, to pass back to load(). */
	state(): string {
		return this.call(undefined, "state", () => []);
	}

	dispose(): void {
		this.vm.dispose();
	}

	/** Run one runtime call under a phase's time limit, turning engine errors into failures. */
	private call(phase: VisualPhase | undefined, name: string, args: () => JSValueHandle[]): string {
		const { vm, api } = this;
		try {
			return this.run(phase, () =>
				vm.withScope(() => vm.callFunction(api.getProp(name), api, ...args()).toString()),
			);
		} finally {
			const lines = JSON.parse(vm.withScope(() => vm.callFunction(api.getProp("logs"), api).toString())) as string[];
			for (const line of lines) if (this.logs.length < VISUAL_LIMITS.logLines) this.logs.push(line);
		}
	}

	private run<T>(phase: VisualPhase | undefined, body: () => T): T {
		this.clock.deadline = phase ? performance.now() + PHASE_MS[phase] : Number.POSITIVE_INFINITY;
		try {
			return body();
		} catch (error) {
			throw failure(error, phase);
		} finally {
			this.clock.deadline = Number.POSITIVE_INFINITY;
		}
	}
}

function failure(error: unknown, phase?: VisualPhase): VisualFailure {
	if (error instanceof VisualFailure) return error;
	if (!(error instanceof JSException))
		return new VisualFailure(error instanceof Error ? error.message : String(error));
	const line = lineOf(error.stack);
	const { name, message } = error;
	error.dispose();
	if (name === "InternalError" && message === "interrupted" && phase)
		return new VisualFailure(
			(phase === "setup"
				? "the visual function took longer than "
				: phase === "view"
					? "the view took longer than "
					: "the handler took longer than ") +
				PHASE_MS[phase] +
				" ms",
			line,
		);
	if (/out of memory/.test(message))
		return new VisualFailure(
			`the visual used more than ${VISUAL_LIMITS.heapBytes / 1024 / 1024} MiB of memory`,
			line,
		);
	return new VisualFailure(name === "VisualError" ? message : `${name}: ${message}`, line);
}
