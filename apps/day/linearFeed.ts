// The user's saved Linear issues, read through the native root's passive
// `day.linear.read`: the selected project's own issues that Pilot saved and
// the cycle its last sync read. It is a copy Pilot saved, not a live view of
// Linear, not the team's issues and not other cycles. Reading only reads: it
// asks Linear nothing, starts nothing and writes nothing anywhere.
import { type Signal, signal } from "nsh";
import type { Refusal } from "./bridge";
import { readSavedLinear, type SavedLinearRead } from "./linearRead";
import { glide } from "./motion";

/** What the Linear page shows. */
export type LinearView = {
	/** "idle" before the page asked; "unavailable" when no read could be shown. */
	availability: "idle" | "reading" | "live" | "unavailable";
	/** Why nothing is shown, or why what is shown is from an earlier read. */
	reason: string;
	/** The newest read Pilot could show, or null. */
	read: SavedLinearRead | null;
	/** A read is on its way. */
	reading: boolean;
};

/** The Linear page's source. The connected window has one; the mock window has none. */
export interface LinearSource {
	view(): LinearView;
	onChange(listener: (view: LinearView) => void): () => void;
	/** Reads the saved issues again. Passive: it sends, starts and asks Linear nothing. */
	read(): Promise<void>;
	dispose(): void;
}

/** Why the saved issues could not be read, in one calm sentence. */
export function linearReason(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Pilot again to see them.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot show Linear issues here yet.";
		case "invalid":
			return "Pilot's service answered in a way this app does not understand.";
		default:
			return "Pilot could not read your saved Linear issues.";
	}
}

/** A read the page can show: the exact scope it promises, and nothing else. */
function readOf(x: unknown): SavedLinearRead | null {
	const r = x as SavedLinearRead | null;
	if (!r || typeof r !== "object" || r.version !== 1 || r.scope !== "saved-own-issues") return null;
	if (!Array.isArray(r.items) || typeof r.total !== "number" || typeof r.more !== "number") return null;
	if (!r.source || typeof r.source !== "object" || typeof r.configurationCurrent !== "boolean") return null;
	return r;
}

/** The saved issues over this window's native root. */
export class ConnectedLinear implements LinearSource {
	#window: string;
	#read: SavedLinearRead | null = null;
	#refusal: Refusal | null = null;
	#reading: Promise<void> | null = null;
	#again = false;
	#asked = false;
	#listeners = new Map<number, (view: LinearView) => void>();
	#next = 0;
	#closed = false;

	constructor(window: string) {
		this.#window = window;
	}

	view(): LinearView {
		const reason = this.#refusal
			? this.#read
				? `${linearReason(this.#refusal)} What shows is from Pilot's last read.`
				: linearReason(this.#refusal)
			: "";
		return {
			availability: this.#read ? "live" : this.#refusal ? "unavailable" : this.#asked ? "reading" : "idle",
			reason,
			read: this.#read,
			reading: this.#reading !== null,
		};
	}

	onChange(listener: (view: LinearView) => void): () => void {
		const id = this.#next++;
		this.#listeners.set(id, listener);
		return () => {
			this.#listeners.delete(id);
		};
	}

	#publish() {
		if (this.#closed) return;
		const view = this.view();
		for (const listener of this.#listeners.values()) listener(view);
	}

	/** One read at a time; a read asked for meanwhile runs once after it, so the newest answer shows. */
	read(): Promise<void> {
		if (this.#reading) {
			this.#again = true;
			return this.#reading;
		}
		this.#asked = true;
		this.#reading = (async () => {
			do {
				this.#again = false;
				const r = await readSavedLinear(this.#window);
				if (this.#closed) return;
				if (r.ok) {
					const read = readOf(r.snapshot);
					if (read) {
						this.#read = read;
						this.#refusal = null;
					} else this.#refusal = "invalid";
				} else this.#refusal = r.refusal;
			} while (this.#again && !this.#closed);
		})().finally(() => {
			this.#reading = null;
			this.#publish();
		});
		this.#publish();
		return this.#reading;
	}

	dispose(): void {
		this.#closed = true;
		this.#listeners.clear();
	}
}

/** The Linear page's view, mirrored in one signal that only the source's listener sets. */
export type LinearMirror = {
	source: LinearSource;
	view: Signal<LinearView>;
	close: () => void;
};

/** Which rows show: what a glide follows. */
function shape(v: LinearView): string {
	return (v.read?.items ?? []).map((i) => `${i.id}/${i.metadata.statusType ?? ""}`).join(",");
}

/** Mirrors `source`'s view. Rows that arrive, leave or change group glide to their places. */
export function mirrorLinear(source: LinearSource): LinearMirror {
	const view = signal(source.view());
	const stop = source.onChange((next) => {
		if (shape(next) !== shape(view())) glide();
		view.set(next);
	});
	return {
		source,
		view,
		close: () => {
			stop();
			source.dispose();
		},
	};
}
