import type { Tool } from "@earendil-works/pi-ai";
import { ControlCompactor } from "./control-compaction.ts";
import { ControlMemory } from "./control-memory.ts";
import { ControlMemoryAccess } from "./control-memory-access.ts";
import type { ControlMessageInput } from "./control-memory-disk.ts";
import type { ModelCatalog } from "./models.ts";

export class ControlChat {
	readonly memory: ControlMemory;
	private readonly compactor: ControlCompactor;
	private readonly access: ControlMemoryAccess;
	private tools: Tool[] = [];
	private provider = "";
	private readonly model: () => string | undefined;
	private readonly isControl: (id: string) => boolean;
	/** Notice origin belongs to the active turn, not to a model-supplied action argument. */
	private notice = true;
	private preparedKey?: string;
	get handlingNotice(): boolean {
		return this.notice;
	}
	constructor(
		home: string,
		cwd: string,
		models: ModelCatalog,
		isControl: (id: string) => boolean,
		model: () => string | undefined,
	) {
		this.isControl = isControl;
		this.model = model;
		this.memory = new ControlMemory(home);
		this.access = new ControlMemoryAccess(this.memory, isControl);
		this.compactor = new ControlCompactor(this.memory, (job, lines, signal) =>
			models.compactControl(cwd, this.provider, this.tools, job, lines, signal),
		);
	}
	async call(id: string, action: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.isControl(id)) throw new Error("Only the control chat may use this service");
		if (action === "zoom" || action === "date") return this.access.call(id, action, args);
		if (action === "record") {
			if (!args.message || typeof args.message !== "object" || Array.isArray(args.message))
				throw new Error("Message required");
			return this.compactor.append(args.message as ControlMessageInput);
		}
		if (
			action !== "prepare" ||
			typeof args.key !== "string" ||
			typeof args.requestId !== "string" ||
			!Array.isArray(args.tools)
		)
			throw new Error("Invalid control call");
		this.notice = args.requestId.startsWith("watch-notice:") || args.requestId.startsWith("mission-notice:");
		this.provider = this.model()?.split("/")[0] ?? "";
		this.tools = args.tools as Tool[];
		if (this.preparedKey === args.key) return { lines: await this.memory.turnView(args.key) };
		await this.memory.retry();
		this.compactor.wake();
		await this.compactor.settled();
		if ((await this.memory.state()).pending)
			throw new Error("Earlier chat messages could not be summarized; retry with your next message");
		const lines = await this.memory.turnView(args.key);
		this.preparedKey = args.key;
		return { lines };
	}
	async stop(): Promise<void> {
		await this.compactor.stop();
		await this.memory.stop();
	}
}
