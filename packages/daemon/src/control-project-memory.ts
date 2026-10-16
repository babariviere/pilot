import type { ControlActions } from "./control-actions.ts";
import type { ProjectMemoryService } from "./project-memory.ts";

/** Explicit project routing is exclusive to the control role. No forget operation exists. */
export class ControlProjectMemory {
	private readonly memory: ProjectMemoryService;
	private readonly project: (id: string) => unknown;
	private readonly isControl: (id: string) => boolean;
	private readonly audit: () => ControlActions;
	constructor(
		memory: ProjectMemoryService,
		project: (id: string) => unknown,
		isControl: (id: string) => boolean,
		audit: () => ControlActions,
	) {
		this.memory = memory;
		this.project = project;
		this.isControl = isControl;
		this.audit = audit;
	}
	async call(caller: string, action: string, args: Record<string, unknown>, operationId?: string): Promise<unknown> {
		if (!this.isControl(caller)) throw new Error("Only the control chat may select another project's memory");
		if (typeof args.projectId !== "string" || !/^[\w-]{1,100}$/.test(args.projectId))
			throw new Error("A registered projectId is required");
		const projectId = args.projectId;
		this.project(projectId);
		if (action === "note") {
			if (typeof args.text !== "string") throw new Error("Memory note requires text");
			if (args.replaces !== undefined && !Array.isArray(args.replaces))
				throw new Error("replaces must be a list of note indices");
			const text = args.text,
				replaces = args.replaces as number[] | undefined;
			return this.audit().perform(
				caller,
				"memory_note",
				{ projectId, text, ...(replaces ? { replaces } : {}) },
				operationId ?? "",
				() => {
					this.project(projectId);
					if (!this.isControl(caller)) throw new Error("Control role changed");
					return this.memory.note(projectId, text, caller, replaces);
				},
			);
		}
		let quotedMemory: unknown;
		switch (action) {
			case "wake":
				quotedMemory = await this.memory.wake(projectId, 96);
				break;
			case "recall":
				if (typeof args.regex !== "string") throw new Error("Memory recall requires regex");
				quotedMemory = await this.memory.recall(projectId, args.regex, 96);
				break;
			case "zoom":
				if (typeof args.lo !== "number" || typeof args.hi !== "number")
					throw new Error("Memory zoom requires an inclusive range");
				quotedMemory = await this.memory.zoom(projectId, args.lo, args.hi);
				break;
			default:
				throw new Error("Control project memory is append-only; use wake, recall, zoom or note");
		}
		return { untrusted: true, projectId, quotedMemory };
	}
}
