// The user's saved Linear issues, read through the native root's passive
// `day.linear.read`: the selected project's own issues that Pilot saved and
// the cycle its last sync read. It is a copy Pilot saved, not a live view of
// Linear, not the team's issues and not other cycles. Reading only reads: it
// asks Linear nothing, starts nothing and writes nothing anywhere.
import type { Signal } from "nsh";
import type { SavedLinearRead } from "../../../../packages/protocol/src/sources/tracking.ts";
import { call } from "../bridge";
import { type Refusal, readReason } from "../refusals";
import { Feed, mirror } from "../source";

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
	manage?(itemId: string, pin: string, action: "manage" | "stop" | "resume"): Promise<string>;
	dispose(): void;
}

/** Why the saved issues could not be read, in one calm sentence. */
export function linearReason(refusal: Refusal): string {
	const unavailable = "This Pilot service cannot show Linear issues here yet.";
	return readReason(refusal, {
		denied: unavailable,
		unavailable,
		other: "Pilot could not read your saved Linear issues.",
	});
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
	#asked = false;
	#feed = new Feed(() => this.view());
	#reads = this.#feed.coalesce(async () => {
		const r = await call<SavedLinearRead>(this.#window, "day.linear.read", {});
		if (this.#feed.closed) return;
		const read = r.ok ? readOf(r.snapshot) : null;
		if (read) {
			this.#read = read;
			this.#refusal = null;
		} else this.#refusal = r.ok ? "invalid" : r.refusal;
	});

	constructor(window: string) {
		this.#window = window;
	}

	async manage(itemId: string, pin: string, action: "manage" | "stop" | "resume"): Promise<string> {
		const reply = await call<{ ok: boolean }>(this.#window, "day.linear.manage", { itemId, pin, action });
		await this.read();
		if (reply.ok) return "";
		return reply.refusal === "stale"
			? "This changed. Review the updated issue before acting again."
			: "Pilot could not confirm the change. Read the issue again before acting.";
	}

	view(): LinearView {
		const reason = this.#refusal ? linearReason(this.#refusal) : "";
		return {
			availability: this.#read ? "live" : this.#refusal ? "unavailable" : this.#asked ? "reading" : "idle",
			reason,
			read: this.#read,
			reading: this.#reads.busy(),
		};
	}

	onChange(listener: (view: LinearView) => void): () => void {
		return this.#feed.onChange(listener);
	}

	read(): Promise<void> {
		this.#asked = true;
		const reading = this.#reads().finally(() => this.#feed.publish());
		this.#feed.publish();
		return reading;
	}

	dispose(): void {
		this.#feed.close();
	}
}

/** The Linear page's view, mirrored in one signal that only the source's listener sets. */
export type LinearMirror = {
	source: LinearSource;
	view: Signal<LinearView>;
	close: () => void;
};

/** Mirrors `source`'s view. Rows that arrive, leave or change group glide to their places. */
export function mirrorLinear(source: LinearSource): LinearMirror {
	const shape = (v: LinearView) =>
		(v.read?.items ?? []).map((i) => `${i.id}/${i.metadata.statusType ?? ""}`).join(",");
	return { source, ...mirror(source, source.view(), shape) };
}
