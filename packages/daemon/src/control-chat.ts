import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@earendil-works/pi-ai";
import { ControlCompactor } from "./control-compaction.ts";
import { ControlFiles } from "./control-files.ts";
import { ControlMemory } from "./control-memory.ts";
import { ControlMemoryAccess } from "./control-memory-access.ts";
import type { ControlMessageInput } from "./control-memory-disk.ts";
import type { ModelCatalog } from "./models.ts";

export class ControlChat {
	readonly memory: ControlMemory;
	private readonly compactor: ControlCompactor;
	private readonly access: ControlMemoryAccess;
	private readonly files: ControlFiles;
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
		fileRoots: (path: string) => readonly string[] = () => [],
	) {
		this.isControl = isControl;
		this.model = model;
		this.memory = new ControlMemory(home);
		this.access = new ControlMemoryAccess(this.memory, isControl);
		this.files = new ControlFiles(
			isControl,
			(path) => [
				join(home, "attachments"),
				...(process.platform === "darwin"
					? [join(homedir(), "Library", "Application Support", "Pilot", "Attachments")]
					: []),
				...fileRoots(path),
			],
			async (entry) => {
				await this.memory.auditAppend({
					operationId: `file:${randomUUID()}`,
					action: "read_file",
					phase: entry.outcome === "read" ? "succeeded" : "failed",
					at: Date.now(),
					caller: entry.caller,
					args: { path: entry.path },
					result: { ...entry },
				});
			},
		);
		this.compactor = new ControlCompactor(this.memory, (job, lines, signal) =>
			models.compactControl(cwd, this.provider, this.tools, job, lines, signal),
		);
	}
	async call(id: string, action: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.isControl(id)) throw new Error("Only the control chat may use this service");
		if (action === "file") return this.files.read(id, args);
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
		const lines = await this.memory.turnView(args.key);
		this.preparedKey = args.key;
		return { lines };
	}
	async stop(): Promise<void> {
		await this.compactor.stop();
		await this.memory.stop();
	}
}
