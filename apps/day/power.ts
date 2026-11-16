// Pilot's pause for sleep, from the native root's last power frame, and the
// user's Resume. Reading costs no service request; Resume is one request,
// and sending it twice changes nothing.
import { signal } from "nsh";
import { call } from "./bridge";

/** Whether Pilot paused work for sleep, and since when (epoch ms). */
export type PowerView = { paused: boolean; since: number | null };

export interface PowerControls {
	view(): PowerView;
	busy(): boolean;
	/** Why the last Resume did not confirm, or nothing. */
	message(): string;
	read(): Promise<void>;
	resume(): Promise<void>;
}

/** The connected window's power controls. */
export function connectedPower(window: string): PowerControls {
	return powerControls(async (name) => {
		const r = await call<PowerView | null>(window, `day.power.${name}`, {});
		return r.ok ? r.snapshot : null;
	});
}

/** Power controls over `send`, which answers a read or a Resume with the new view, or null when it failed. */
export function powerControls(send: (name: "read" | "resume") => Promise<PowerView | null>): PowerControls {
	const view = signal<PowerView>({ paused: false, since: null });
	const busy = signal(false);
	const message = signal("");
	return {
		view,
		busy,
		message,
		async read() {
			const next = await send("read");
			if (next && (next.paused !== view().paused || next.since !== view().since)) view.set(next);
			if (next && !next.paused) message.set("");
		},
		async resume() {
			if (busy()) return;
			busy.set(true);
			try {
				const next = await send("resume");
				if (next) view.set(next);
				message.set(next && !next.paused ? "" : "Pilot could not confirm it resumed work. Try again.");
			} finally {
				busy.set(false);
			}
		},
	};
}
