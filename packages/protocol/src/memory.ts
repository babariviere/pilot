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
	/** Preserved across canonical commits, checkpoints and deltas. Not inferred from reusable local IDs. */
	sharedOrigin?: import("./shared-context.ts").SharedSessionRef;
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
/**
 * One node of the memory tree as people browse it. A summary of more than 16 notes splits into its two halves; a
 * summary of 16 or fewer lists its notes, since compaction writes it from them directly. Newest first.
 */
export interface MemoryTreeNode extends MemoryNode {
	/** Absent when not loaded (past the requested depth or the node limit). With reveal, only paths to those notes. */
	children?: MemoryTreeNode[];
}
export interface MemoryTree {
	count: number;
	/** The top-level blocks, or the children of the requested range, newest first. */
	nodes: MemoryTreeNode[];
	/** The node limit stopped expansion early; nodes without children load on request. */
	truncated: boolean;
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
