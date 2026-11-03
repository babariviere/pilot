import { ServiceUnavailable } from "./errors.ts";
import type { RuntimeBlocker, RuntimeContributor } from "./runtime-admission.ts";

/** Reversible maintenance admission. An admitted promise includes its cleanup and child-exit proof.
 * Freezing never aborts work. Owners must stop timer/event re-entry while frozen and replay durable
 * hints on resume. Do not wrap a timeout race instead of the underlying child lifetime.
 */
export class RuntimeBackground implements RuntimeContributor {
	private freezes = 0;
	private sequence = 0;
	private readonly active = new Map<number, string>();
	private readonly listeners = new Set<() => void>();
	private readonly name: string;
	private readonly resume?: () => void;
	private readonly pause?: () => void;
	private readonly inspect?: () => readonly RuntimeBlocker[];
	constructor(name: string, resume?: () => void, pause?: () => void, inspect?: () => readonly RuntimeBlocker[]) {
		this.name = name;
		this.resume = resume;
		this.pause = pause;
		this.inspect = inspect;
	}
	get frozen(): boolean {
		return this.freezes > 0;
	}
	begin(task = "work"): () => void {
		if (this.frozen) throw new ServiceUnavailable(`${this.name} is paused for maintenance`);
		if (this.active.size >= 128) throw new ServiceUnavailable(`${this.name} is busy`);
		const id = ++this.sequence;
		this.active.set(id, task);
		this.emit();
		return () => {
			if (this.active.delete(id)) this.emit();
		};
	}
	async run<T>(task: string, work: () => T | Promise<T>): Promise<T> {
		const end = this.begin(task);
		try {
			return await work();
		} finally {
			end();
		}
	}
	freezeAdmissions(): () => void {
		this.freezes++;
		// Keep the fence if an owner's timer cancellation fails.
		if (this.freezes === 1) this.pause?.();
		this.emit();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.freezes--;
			if (!this.freezes) this.resume?.();
			this.emit();
		};
	}
	blockers(): RuntimeBlocker[] {
		return [...this.active]
			.map(([id, task]) => ({ kind: "background", id: `${this.name}:${task}:${id}` }))
			.concat(this.inspect?.() ?? []);
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* Observation is not admission. */
			}
		}
	}
}
