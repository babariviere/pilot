import type { ControlMemory } from "./control-memory.ts";

/** Caller identity is supplied by the supervised worker, never by model arguments. */
export class ControlMemoryAccess {
	private readonly memory: ControlMemory;
	private readonly isControl: (sessionId: string) => boolean;
	constructor(memory: ControlMemory, isControl: (sessionId: string) => boolean) {
		this.memory = memory;
		this.isControl = isControl;
	}
	async call(sessionId: string, action: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.isControl(sessionId)) throw new Error("Only the control chat can read its memory");
		if (typeof args.id !== "number") throw new Error("Message id is required");
		if (action === "date") return { id: args.id, at: await this.memory.date(args.id) };
		if (action !== "zoom" || typeof args.n !== "number")
			throw new Error("Expected history action zoom (id,n) or date (id)");
		if (args.n !== 1) {
			if (args.offset !== undefined) throw new Error("Only whole messages have pages");
			return { untrusted: true, lines: await this.memory.children(args.id, args.n) };
		}
		if (args.offset !== undefined && typeof args.offset !== "number") throw new Error("Invalid page offset");
		return { untrusted: true, ...(await this.memory.message(args.id, args.offset as number | undefined)) };
	}
}
