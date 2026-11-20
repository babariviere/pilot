// Pilot looks up an uncertain send by itself. A send whose reply was lost is
// Unknown; Check only reads its receipt and never sends again, so running it
// without a click is safe. The window checks right away, then less often,
// and offers Check again only after these tries. A reconnect starts over.
import { errorText, logEvent } from "./dayLog";

/**
 * When each automatic look happens, from the moment an item is Unknown.
 * One look is one receipt read (milliseconds; 3 s seen under daemon stalls).
 * About two minutes cover a chat that starts cold (10-11 s seen) and a busy
 * service, and stay a handful of reads per uncertain item.
 */
export const CHECK_AFTER_MS = [0, 2_000, 5_000, 15_000, 30_000, 60_000];

/** Runs the automatic looks of uncertain items, one look per item at a time. */
export class AutoCheck {
	#tries = new Map<string, number>();
	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	#running = new Set<string>();
	#closed = false;
	#look: (id: string) => Promise<void>;
	#changed: () => void;

	/** `look` checks one item and publishes what it read. `changed` repaints when an item's state moves. */
	constructor(look: (id: string) => Promise<void>, changed: () => void) {
		this.#look = look;
		this.#changed = changed;
	}

	/** Follows exactly the items in `ids`: new ones are looked up, settled ones are forgotten. */
	watch(ids: readonly string[]) {
		if (this.#closed) return;
		const wanted = new Set(ids);
		for (const id of [...this.#tries.keys()]) {
			if (wanted.has(id)) continue;
			this.#tries.delete(id);
			const timer = this.#timers.get(id);
			if (timer !== undefined) clearTimeout(timer);
			this.#timers.delete(id);
		}
		for (const id of wanted) if (!this.#tries.has(id)) this.#schedule(id, 0);
	}

	/** Whether Pilot is still looking for `id` by itself. False once every try is used. */
	checking(id: string): boolean {
		return this.#timers.has(id) || this.#running.has(id);
	}

	/** Starts over after a reconnect: every followed item gets its tries again. */
	restart() {
		if (this.#closed) return;
		for (const id of [...this.#tries.keys()]) {
			if (this.checking(id)) continue;
			this.#schedule(id, 0);
		}
		this.#changed();
	}

	close() {
		this.#closed = true;
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}

	#schedule(id: string, tries: number) {
		this.#tries.set(id, tries);
		const wait = CHECK_AFTER_MS[tries];
		if (wait === undefined) {
			// Every try is used: the window offers Check again.
			this.#changed();
			return;
		}
		this.#timers.set(
			id,
			setTimeout(() => {
				this.#timers.delete(id);
				if (this.#closed || !this.#tries.has(id)) return;
				this.#running.add(id);
				void this.#look(id)
					.catch((error: unknown) => logEvent("ui.error", errorText(error)))
					.finally(() => {
						this.#running.delete(id);
						// Settled items were forgotten by `watch` meanwhile.
						if (!this.#closed && this.#tries.has(id)) this.#schedule(id, tries + 1);
					});
			}, wait),
		);
	}
}
