import type { WatchEvent, WatchTarget } from "./watches.ts";
export interface WatchObservation {
	/** Stable source identity and version. Repeated snapshots never create events. */
	source: string;
	version: string;
	event: WatchEvent;
	targets: WatchTarget[];
	at: number;
	text: string;
	outcome?: "done" | "failed" | "stopped";
	originSessionId?: string;
}
export interface WatchNotice {
	requestId: string;
	lastEventId: number;
	/** Trusted watch notes and untrusted event summaries stay separate. */
	items: { watchId: string; note: string; event: WatchEvent; text: string; count: number }[];
	overflow: number;
}
export interface WatchNoticeSink {
	readonly sessionId: string;
	/** Must recheck idleness at admission, and durably dedupe requestId. */
	canSend(requestId?: string): boolean;
	/** Append an event message and start a turn. False means retry the frozen notice. */
	deliver(notice: WatchNotice): Promise<boolean>;
}
