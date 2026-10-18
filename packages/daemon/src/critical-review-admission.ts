/** In-memory safe-boundary primitive for a future author-tool adapter. Not installed in production. */
export class ReviewToolAdmission {
	private active = 0;
	private held = false;
	private readonly waiters = new Set<() => void>();
	private idle?: () => void;
	/** Surround only foreground tool execution, not the lifetime of jobs/children it starts. */
	async enter(signal: AbortSignal): Promise<() => void> {
		while (this.held) {
			signal.throwIfAborted();
			if (this.waiters.size >= 64) throw new Error("Tool admission busy");
			await new Promise<void>((resolve, reject) => {
				const ready = () => {
					this.waiters.delete(ready);
					signal.removeEventListener("abort", cancel);
					resolve();
				};
				const cancel = () => {
					this.waiters.delete(ready);
					signal.removeEventListener("abort", cancel);
					reject(signal.reason);
				};
				this.waiters.add(ready);
				signal.addEventListener("abort", cancel, { once: true });
			});
		}
		signal.throwIfAborted();
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--this.active === 0) this.idle?.();
		};
	}
	/** Blocks new starts immediately; waits for existing tools without cancelling any of them. */
	async hold(signal: AbortSignal): Promise<() => void> {
		signal.throwIfAborted();
		if (this.held) throw new Error("Tool admission already held");
		this.held = true;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			this.held = false;
			this.idle = undefined;
			signal.removeEventListener("abort", cancel);
			for (const ready of this.waiters) ready();
		};
		let rejectWait: (error: unknown) => void = () => {};
		const cancel = () => {
			release();
			rejectWait(signal.reason);
		};
		signal.addEventListener("abort", cancel, { once: true });
		if (this.active) {
			await new Promise<void>((resolve, reject) => {
				rejectWait = reject;
				this.idle = resolve;
			});
		}
		return release;
	}
}
