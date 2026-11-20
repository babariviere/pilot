// The life every connected source shares ("Live data in the UI" in CODING_STANDARDS.md): listeners that hear
// only a changed view, one read in flight plus one more, answers applied in call order, automatic lookups of
// writes whose answer was lost, and one close.
import { type Signal, signal } from "nsh";
import { AutoCheck } from "./autoCheck";
import { glide } from "./ui";

/** A read that runs at most once at a time. A call meanwhile makes one more run after it. */
export type Coalesced = { (): Promise<void>; busy(): boolean };

/** Coalesces `run`. It stops once `stopped()` says so. */
export function coalesce(run: () => Promise<void>, stopped: () => boolean): Coalesced {
	let running: Promise<void> | null = null;
	let again = false;
	const read = () => {
		if (stopped()) return Promise.resolve();
		if (running) {
			again = true;
			return running;
		}
		// Publish the flight before invoking run: a listener can request another read synchronously.
		let start!: () => void;
		const flight = new Promise<void>((resolve, reject) => {
			start = () => {
				void drain().then(resolve, reject);
			};
		});
		running = flight;
		start();
		return flight;
	};
	const drain = async () => {
		try {
			do {
				again = false;
				await run();
			} while (again && !stopped());
		} finally {
			running = null;
		}
	};
	return Object.assign(read, { busy: () => running !== null });
}

/** Numbers calls, so an answer to an older call never replaces a newer one's. */
export class CallOrder {
	#sent = 0;
	#applied = 0;

	/** Numbers the next call. Also drops every answer still on its way for `latest`. */
	next(): number {
		return ++this.#sent;
	}

	/** Whether call `order` is the newest one numbered. */
	latest(order: number): boolean {
		return order === this.#sent;
	}

	/** Whether call `order`'s answer is newer than every answer applied. It is applied from now on. */
	apply(order: number): boolean {
		if (order <= this.#applied) return false;
		this.#applied = order;
		return true;
	}
}

/**
 * One source's listeners and life. `view` builds what the listeners hear. `lookUp` reads one Unknown write's
 * receipt and never sends it again: with it, every write the source `watch`es is looked up automatically.
 * `shown` is everything the screens read on a change, when that is more than the view.
 */
export class Feed<V> {
	#listeners = new Set<(view: V) => void>();
	#heard: string | null = null;
	#closed = false;
	#view: () => V;
	#shown: (view: V) => unknown;
	#auto: AutoCheck | null;

	constructor(view: () => V, lookUp?: (id: string) => Promise<void>, shown: (view: V) => unknown = (v) => v) {
		this.#view = view;
		this.#shown = shown;
		this.#auto = lookUp ? new AutoCheck(lookUp, () => this.publish()) : null;
	}

	get closed(): boolean {
		return this.#closed;
	}

	onChange(listener: (view: V) => void): () => void {
		if (this.#closed) return () => {};
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Tells the listeners the view, unless it equals the one they heard last. */
	publish(): void {
		if (this.#closed) return;
		const view = this.#view();
		const text = JSON.stringify(this.#shown(view));
		if (text === this.#heard) return;
		this.#heard = text;
		for (const listener of [...this.#listeners]) listener(view);
	}

	/** Coalesces `run` until this source closes. */
	coalesce(run: () => Promise<void>): Coalesced {
		return coalesce(run, () => this.#closed);
	}

	/** Follows exactly the Unknown writes in `ids`: new ones are looked up, settled ones are forgotten. */
	watch(ids: readonly string[]): void {
		this.#auto?.watch(ids);
	}

	/** Whether Pilot still looks write `id` up by itself. */
	checking(id: string): boolean {
		return this.#auto?.checking(id) ?? false;
	}

	/** The service is back: every followed write gets its lookups again. */
	restart(): void {
		this.#auto?.restart();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#auto?.close();
		this.#listeners.clear();
	}
}

/** What a mirror needs from its source. */
export type Mirrored<V> = { onChange(listener: (view: V) => void): () => void; dispose(): void };

/**
 * Mirrors a source's view in one signal that only the source's listener sets. When `shape` changes (which rows
 * show where), the rows glide to their places. Closing it closes the source.
 */
export function mirror<V>(
	source: Mirrored<V>,
	first: V,
	shape?: (view: V) => string,
): { view: Signal<V>; close: () => void } {
	const view = signal(first);
	const stop = source.onChange((next) => {
		if (shape && shape(next) !== shape(view())) glide();
		view.set(next);
	});
	return {
		view,
		close: () => {
			stop();
			source.dispose();
		},
	};
}
