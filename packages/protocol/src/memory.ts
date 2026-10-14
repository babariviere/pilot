/** Public ranges are inclusive, matching printed #lo-hi node IDs. */
export interface MemoryRange {
	lo: number;
	hi: number;
}
export interface MemoryEntry {
	index: number;
	id: string;
	deviceId: string;
	at: number;
	sessionId: string;
	text: string;
	/** Stable ids of earlier notes this one corrects. */
	replaces?: string[];
	/** Derived on read: index of the latest note that corrects this one. */
	replacedBy?: number;
}
export interface MemoryNode extends MemoryRange {
	text?: string;
	entry?: MemoryEntry;
	/** The summary is not built yet. Zoom can still open its children. */
	pending?: boolean;
	/** A replaced note, or a summary whose notes were all replaced. Hidden from wake. */
	replaced?: boolean;
}
export interface MemoryView {
	count: number;
	nodes: MemoryNode[];
	/** An old prefix may be omitted when compaction is behind. */
	omittedBefore: number;
	text: string;
}
export interface MemoryRecall {
	count: number;
	matches: number;
	/** Newest first, bounded by both lines and bytes. */
	entries: MemoryEntry[];
	truncated: boolean;
}
export interface MemoryCompaction {
	state: "idle" | "pending" | "running" | "backoff";
	pending: number;
	error?: string;
	retryAt?: number;
}
export interface ProjectMemorySummary {
	count: number;
	/** Newest first, at most five. */
	recent: MemoryEntry[];
	compaction: MemoryCompaction;
}
export interface MemoryNoteRequest {
	text: string;
	sessionId: string;
	/** Indices of notes this one corrects. */
	replaces?: number[];
}
