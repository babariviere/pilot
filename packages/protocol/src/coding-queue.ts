/** A chat's place in the coding queue now. Read only: it grants, reserves and starts nothing. */
export interface CodingQueueView {
	/** "slots": every coding slot it may use is taken. "files": it waits for another task's shared files. */
	kind: "slots" | "files";
	/** 1-based place among chats waiting for the same project's slots, in the order the slots go to them. */
	position: number;
	/** Titles of at most 3 chats or tasks that hold the slots now, or for "files" the task it waits for. */
	holders: string[];
}
