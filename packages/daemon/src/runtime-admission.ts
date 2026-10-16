import { ServiceUnavailable } from "./errors.ts";

export interface RuntimeBlocker {
	kind: string;
	id: string;
	sessionId?: string;
}
export interface RuntimeContributor {
	freezeAdmissions(): () => void;
	blockers(): readonly RuntimeBlocker[] | Promise<readonly RuntimeBlocker[]>;
	onChange?(listener: () => void): () => void;
}

/** Resource-local admissions include queued work and cleanup, not merely network ownership. */
export class RuntimeAdmission implements RuntimeContributor {
	private freezes = 0;
	private readonly active = new Set<RuntimeBlocker>();
	private readonly listeners = new Set<() => void>();
	begin(blocker: RuntimeBlocker): () => void {
		if (this.freezes) throw new ServiceUnavailable("Runtime admissions are frozen; retry after maintenance");
		if (this.active.size >= 128) throw new ServiceUnavailable("Runtime admissions are busy");
		this.active.add(blocker);
		this.emit();
		return () => {
			if (this.active.delete(blocker)) this.emit();
		};
	}
	freezeAdmissions(): () => void {
		this.freezes++;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.freezes--;
				this.emit();
			}
		};
	}
	blockers(): RuntimeBlocker[] {
		return [...this.active];
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

/** Composition seam for a remote-owned updater. It never stops work or owns an update journal. */
export class RuntimeResources {
	private readonly sources: readonly RuntimeContributor[];
	constructor(sources: readonly RuntimeContributor[]) {
		this.sources = sources;
	}
	freezeAdmissions(): () => void {
		const releases: (() => void)[] = [];
		try {
			for (const source of this.sources) releases.push(source.freezeAdmissions());
		} catch (error) {
			for (const release of releases.reverse()) release();
			throw error;
		}
		let released = false;
		return () => {
			if (!released) {
				released = true;
				for (const release of releases.reverse()) release();
			}
		};
	}
	async blockers(): Promise<RuntimeBlocker[]> {
		const results = await Promise.all(
			this.sources.map(async (source, index) => {
				try {
					return await source.blockers();
				} catch {
					return [{ kind: "unknown", id: `resource-${index}` }];
				}
			}),
		);
		return results.flat();
	}
	onChange(listener: () => void): () => void {
		const stops = this.sources.map((source) => source.onChange?.(listener));
		return () => {
			for (const stop of stops) stop?.();
		};
	}
}
