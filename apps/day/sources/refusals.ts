// What a refusal from the native root means. The wire codes mirror `code()` in native/src/bridge.rs.
import type { IntentOutcome, OutcomeStatus } from "pilot-day/native";

/** Why the root refused a call, or "lost" when no reply came. */
export type Refusal = (typeof CODES)[number] | "denied" | "lost";

const CODES = [
	"identity",
	"offline",
	"unavailable",
	"invalid",
	"stale",
	"storage",
	"unknown",
	"closed",
	"busy",
	"capacity",
] as const;
const wireCodes = new Set<string>(CODES);

/** Whether `code` is one of the root's refusal codes. */
export function isRefusal(code: string): code is Exclude<Refusal, "denied" | "lost"> {
	return wireCodes.has(code);
}

/** The read crossed a newer change, or the window is saving or closing: not a failed try. */
export function raced(refusal: Refusal): boolean {
	return refusal === "stale" || refusal === "busy" || refusal === "closed";
}

/** The service is down, slow or changing: what shows may still be right, and Pilot reads again by itself. */
export function passing(refusal: Refusal): boolean {
	return (
		refusal !== "closed" && (raced(refusal) || refusal === "offline" || refusal === "unknown" || refusal === "lost")
	);
}

/** Whether a new read can work. Not when access is refused, the service changed or the window closes. */
export function canReadAgain(refusal: Refusal): boolean {
	return refusal !== "denied" && refusal !== "identity" && refusal !== "closed" && refusal !== "busy";
}

/** The promise every write makes when its answer is lost: it is Unknown and is never sent again. */
export const LOST = "Pilot sent this but heard nothing back. It will not send it again; Check only reads.";

/** The promise when Pilot asked the browser to open a link and heard nothing back. */
export const OPEN_LOST = "Pilot asked your browser to open it but did not hear back. It will not try again by itself.";

/** A feature's own sentences, by refusal. `other` covers every refusal that has neither its own nor a shared one. */
export type Words = Partial<Record<Refusal, string>> & { other: string };

const SHARED: Partial<Record<Refusal, string>> = {
	offline: "Pilot could not reach its service.",
	identity: "The Pilot service changed. Open Pilot again.",
	closed: "Pilot is closing.",
	busy: "Pilot is saving this window before it closes.",
};

/** Why a read was refused, in one calm sentence. A read changes nothing, so no refusal is Unknown. */
export function readReason(refusal: Refusal, own: Words, after = ""): string {
	const mine = own[refusal];
	if (mine !== undefined) return mine;
	const shared =
		refusal === "invalid" ? "Pilot's service answered in a way this app does not understand." : SHARED[refusal];
	return shared ? `${shared} ${after}`.trim() : own.other;
}

/**
 * What a refused write means, in one calm sentence. `after` says what did not happen. Only a lost answer may
 * hide a sent write; it says so by default.
 */
export function writeRefusal(refusal: Refusal, own: Words, after = "Nothing was sent."): string {
	const mine = own[refusal];
	if (mine !== undefined) return mine;
	if (refusal === "lost") return LOST;
	const shared = SHARED[refusal];
	return shared ? `${shared} ${after}` : own.other;
}

/** What a refused or lost mutation means for the user, in one sentence. */
export function refusalOutcome(refusal: Refusal, revision: number): IntentOutcome {
	const status: OutcomeStatus =
		refusal === "unknown" || refusal === "lost" ? "unknown" : refusal === "stale" ? "stale" : "rejected";
	const message = writeRefusal(refusal, {
		unknown: LOST,
		// Rust already tried again where only the read around the target moved.
		stale: "This changed before Pilot could send it. Nothing was sent; your words stay. Look again.",
		unavailable: "This is not available here yet. Nothing was sent.",
		denied: "This is not available here yet. Nothing was sent.",
		other: "Pilot could not send this. Nothing was sent; your words stay.",
	});
	return { status, revision, message };
}
