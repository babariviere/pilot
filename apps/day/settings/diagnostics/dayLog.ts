// Lines for Day's log (~/Library/Logs/Pilot/day.log) from the window's code: errors a
// screen caught, and why forms were not saved before a close. The connected window sets
// the sink; elsewhere (mock data, tests) these lines go nowhere.

export type LogEvent = "ui.error" | "forms.unsaved";

let sink: ((event: LogEvent, message: string) => void) | null = null;

/** Where log lines go. Set once by the connected window. */
export function setLogSink(next: (event: LogEvent, message: string) => void) {
	sink = next;
}

/** Logs one line. Never throws, and never waits. */
export function logEvent(event: LogEvent, message: string) {
	try {
		sink?.(event, message.slice(0, 2000));
	} catch {
		/* A log line never breaks what the user does. */
	}
}

/** The message of a caught error, for a log line. */
export function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
