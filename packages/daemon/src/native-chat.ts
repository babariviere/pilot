/** Native standalone creation over the existing project, session and operation services. */
import type { DurableOperation } from "@pilot/protocol";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export interface Selection {
	projectId: string;
	projectPath: string;
	contextDigest: string;
	mode: "ask" | "build";
	model: string;
	thinking: string;
}
interface Intent extends Selection {
	purpose: "native-chat-create";
	draftId: string;
	message: string;
}
interface Dependencies {
	journal: OperationJournal;
	projects: Pick<ProjectStore, "list" | "require">;
	sessions: Pick<SessionManager, "spawnDurable" | "selectTaskModel">;
}
export class NativeChat {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	private project(projectId: string) {
		let p: ReturnType<ProjectStore["require"]>;
		try {
			p = this.deps.projects.require(projectId);
		} catch {
			throw new OperationRejected("Selected project no longer exists");
		}
		return { projectId: p.id, projectPath: p.path, contextDigest: payloadHash(canonicalJSON(p)) };
	}
	inventory() {
		const projects = this.deps.projects.list();
		if (projects.length > 256) throw new Error("Project inventory exceeds 256 projects");
		return { version: 1, complete: true, projects: projects.map((p) => ({ ...this.project(p.id), name: p.name })) };
	}
	/** Catalog selection only. Does not open a worker or send a provider request. */
	async prepare(projectId: string, mode: string): Promise<Selection> {
		if (mode !== "ask" && mode !== "build") throw new OperationRejected("Choose Ask or Build explicitly");
		const before = this.project(projectId);
		const p = this.deps.projects.require(projectId);
		const model = await this.deps.sessions.selectTaskModel(p.path, p.model);
		if (canonicalJSON(before) !== canonicalJSON(this.project(projectId)))
			throw new OperationRejected("Project changed; select it again");
		return { ...before, mode, ...model };
	}
	private request(op: DurableOperation): Intent {
		let p: Intent;
		try {
			p = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid chat payload");
		}
		if (
			!p ||
			Array.isArray(p) ||
			typeof p !== "object" ||
			p.purpose !== "native-chat-create" ||
			op.kind !== p.purpose ||
			!id(p.projectId) ||
			!id(p.draftId) ||
			op.targetId !== p.draftId ||
			!digest(p.contextDigest) ||
			op.bindingId !== p.contextDigest ||
			op.bindingGeneration !== 1 ||
			typeof p.projectPath !== "string" ||
			!p.projectPath.startsWith("/") ||
			p.projectPath.length > 4096 ||
			!["ask", "build"].includes(p.mode) ||
			typeof p.model !== "string" ||
			!p.model ||
			p.model.length > 256 ||
			typeof p.thinking !== "string" ||
			p.thinking.length > 128 ||
			typeof p.message !== "string" ||
			!p.message.trim() ||
			Buffer.byteLength(p.message) > 12000 ||
			!op.origin ||
			!sameHost(op.origin, this.deps.journal.destination) ||
			Object.keys(p).some(
				(k) =>
					![
						"purpose",
						"projectId",
						"projectPath",
						"contextDigest",
						"draftId",
						"mode",
						"model",
						"thinking",
						"message",
					].includes(k),
			)
		)
			throw new OperationRejected("Invalid project-pinned chat intent");
		return p;
	}
	/** Historical receipt lookup does not need a still-existing project or current model. */
	async lookup(op: DurableOperation) {
		this.request(op);
		return this.deps.journal.lookup(op);
	}
	async admit(op: DurableOperation, firstEntry: boolean) {
		const p = this.request(op);
		if (!firstEntry) throw new Error("Chat creation may have entered; Check only");
		const session = await this.createPinned(p, p.draftId, op.operationId, p.message);
		return { sessionId: session.id, projectId: p.projectId, admissionId: op.operationId };
	}
	/**
	 * Rechecks an exact project selection and its model policy. Returns the project check that
	 * creation repeats during admission. Opens no worker.
	 */
	async qualify(p: Selection): Promise<() => void> {
		const check = () => {
			if (
				canonicalJSON(this.project(p.projectId)) !==
				canonicalJSON({ projectId: p.projectId, projectPath: p.projectPath, contextDigest: p.contextDigest })
			)
				throw new OperationRejected("Project changed; select it again");
		};
		check();
		const selected = await this.prepare(p.projectId, p.mode);
		check();
		if (selected.model !== p.model || selected.thinking !== p.thinking)
			throw new OperationRejected("Model policy changed; select the project again");
		return check;
	}
	/** Creates one qualified chat. Once admission enters, failures remain Unknown: never re-enter it. */
	spawn(p: Selection, draftId: string, operationId: string, message: string, check: () => void, title?: string) {
		return this.deps.sessions.spawnDurable(
			{
				projectId: p.projectId,
				mode: p.mode,
				model: p.model,
				thinking: p.thinking,
				message,
				...(title ? { title } : {}),
			},
			draftId,
			operationId,
			() => {
				try {
					check();
				} catch {
					throw new Error("Chat project changed during admission");
				}
			},
		);
	}
	async createPinned(p: Selection, draftId: string, operationId: string, message: string) {
		return this.spawn(p, draftId, operationId, message, await this.qualify(p));
	}
}
