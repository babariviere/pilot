// The connected window's adapter to its native root: exact-name JSON calls
// through NSH's host channel (docs/technical/day-public-bridge.md). Each
// call names this window and the native types' exact fields; Rust picks
// the service, checks authority and journals effects. A mutation whose
// reply is lost is Unknown and is never sent again: only a receipt read looks it up.
// Invalidations carry no data; they only ask for a fresh read.
import { host } from "nsh";
import type { IntentOutcome } from "pilot-day/native";
import { isRefusal, type Refusal } from "./refusals";
import { agentActing, noteBlockedWrite, setBusyProbe } from "./ui/agent";

/** `value` is the root's whole answer, for calls whose answer holds more than a snapshot and an outcome. */
export type Reply<T> =
	| { ok: true; snapshot: T; outcome: IntentOutcome | null; value: Record<string, unknown> }
	| { ok: false; refusal: Refusal };

/** This window's ID from its launch parameters, or null when no native root opened it. */
export function windowId(): string | null {
	const params = host.params as Record<string, unknown> | undefined;
	const day = params?.day as { version?: unknown; window?: unknown } | undefined;
	return day && day.version === 1 && typeof day.window === "string" && day.window !== "" ? day.window : null;
}

/** Whether this app installed the local native preview component, not an access grant. */
export function artifactPreviewsAvailable(): boolean {
	const day = (host.params as { day?: { artifactPreview?: unknown } } | undefined)?.day;
	return day?.artifactPreview === true;
}

/**
 * Calls that only read, open or close what this window shows, or serve the screen agent itself. Every other
 * call may write to Pilot, so a screen agent's step never sends one (docs/technical/day-screen-agent.md).
 */
const PASSIVE =
	/\.(read|snapshot|check|checkNew|checkWork|checkRevision|inventory|inventorySnapshot|prepare|select|chat|chatSnapshot|history|source|list|scope|refresh|leave|close|preview|artifact|saved|results|models)$/;

/** Whether call `name` only reads. */
export function passiveCall(name: string): boolean {
	return PASSIVE.test(name) || name.startsWith("day.screen.") || name === "day.log.event";
}

// The screen agent waits for calls its steps started (ui/agent.ts). Its own calls are not the page's work.
const inFlight = new Set<Promise<unknown>>();
setBusyProbe(() => (inFlight.size > 0 ? Promise.race(inFlight).then(() => undefined) : null));

/** One exact call. It never throws; a lost reply is "lost", never a refusal. */
export async function call<T>(window: string, name: string, args: unknown): Promise<Reply<T>> {
	if (agentActing() && !passiveCall(name)) {
		// The control the agent used would write to Pilot: only the person may. Nothing is sent.
		noteBlockedWrite(name);
		return { ok: false, refusal: "denied" };
	}
	let reply: unknown;
	try {
		// No deadline: the root always answers or closes the channel, and a
		// timeout would turn an entered effect into a guess.
		const sent = host.call(name, { version: 1, window, args }, { timeout: 0 });
		const tracked = name.startsWith("day.screen.") ? null : sent.catch(() => undefined);
		if (tracked) {
			inFlight.add(tracked);
			void tracked.finally(() => inFlight.delete(tracked));
		}
		reply = await sent;
	} catch (error) {
		const code = (error as { code?: unknown } | null | undefined)?.code;
		// A denied or missing method never reached the root: nothing happened.
		const notSent =
			code === "ERR_ACCESS_DENIED" ||
			code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" ||
			code === "ERR_NSH_HOST_ERROR";
		return { ok: false, refusal: notSent ? "denied" : "lost" };
	}
	const r = reply as { version?: unknown; value?: { snapshot?: unknown; outcome?: unknown }; error?: unknown } | null;
	if (r && r.version === 1 && r.value && typeof r.value === "object") {
		return {
			ok: true,
			snapshot: r.value.snapshot as T,
			outcome: (r.value.outcome ?? null) as IntentOutcome | null,
			value: r.value as Record<string, unknown>,
		};
	}
	if (r && r.version === 1 && typeof r.error === "string" && isRefusal(r.error)) {
		return { ok: false, refusal: r.error };
	}
	return { ok: false, refusal: "invalid" };
}
