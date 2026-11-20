// A chat waiting for a coding slot: its place in line and what holds the
// slots now, as the service says. One line, the same wherever the chat shows.
// It needs no action: the chat starts by itself when its turn comes.

/** The service's queue view of one chat. Read only: it grants and starts nothing. */
export type CodingQueue = {
	/** "slots": every coding slot it may use is taken. "files": it waits for another task's shared files. */
	kind: "slots" | "files";
	/** 1-based place in line for the same project's slots. */
	position: number;
	/** At most 3 titles of the chats or tasks that hold the slots, or the task it waits for. */
	holders: string[];
};

/** The queue view, or null when it does not read. */
export function queueOf(x: unknown): CodingQueue | null {
	const q = x as Partial<CodingQueue> | null;
	if (!q || typeof q !== "object" || (q.kind !== "slots" && q.kind !== "files")) return null;
	if (!Number.isSafeInteger(q.position) || q.position! < 1) return null;
	if (!Array.isArray(q.holders) || q.holders.length > 3 || !q.holders.every((h) => typeof h === "string" && h !== ""))
		return null;
	return { kind: q.kind, position: q.position!, holders: [...q.holders] };
}

function ordinal(n: number): string {
	const teen = n % 100 >= 11 && n % 100 <= 13;
	const end = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${end}`;
}

/** "Waiting for a coding slot · 2nd in line · slots used by A, B". */
export function queueLine(q: CodingQueue): string {
	const what = q.kind === "files" ? "Waiting for shared files" : "Waiting for a coding slot";
	const held = q.holders.length
		? ` · ${q.kind === "files" ? "files used by" : "slots used by"} ${q.holders.join(", ")}`
		: "";
	return `${what} · ${ordinal(q.position)} in line${held}`;
}
