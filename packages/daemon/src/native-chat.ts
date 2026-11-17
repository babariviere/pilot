/** Native standalone creation over the existing project, session and operation services. */
import type { DurableOperation } from "@pilot/protocol";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
/** Native operation kind: one fixed follow-up to one stopped chat, sent once. */
export const CHAT_CONTINUE = "chat-continue";
/** What Continue sends. The window cannot supply other words. */
export const CONTINUE_TEXT =
	"The user asked you to continue after this chat stopped. If you were waiting on an answer, that question was lost: ask it again. Otherwise pick up where you stopped.";
export interface Selection {
	projectId: string;
	projectPath: string;
	contextDigest: string;
	mode: "ask" | "build";
	model: string;
	thinking: string;
	allowanceMicros?: number | null;
	fundingRequired?: true;
}
interface Intent extends Selection {
	purpose: "native-chat-create";
	draftId: string;
	message: string;
}
interface Dependencies {
	journal: OperationJournal;
	projects: Pick<ProjectStore, "list" | "require">;
	sessions: Pick<
		SessionManager,
		"spawnDurable" | "selectTaskModel" | "activeFunding" | "get" | "sendDurable" | "lookupNativeAttentionInput"
	>;
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
		const funding = await (await this.deps.sessions.activeFunding())?.read(projectId);
		return {
			...before,
			mode,
			...model,
			...(funding ? { allowanceMicros: funding.quickFixDefaultMicros, fundingRequired: true as const } : {}),
		};
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
			(p.allowanceMicros !== undefined &&
				p.allowanceMicros !== null &&
				(!Number.isSafeInteger(p.allowanceMicros) || p.allowanceMicros < 0)) ||
			(p.fundingRequired !== undefined && p.fundingRequired !== true) ||
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
						"allowanceMicros",
						"fundingRequired",
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
	async spawn(
		p: Selection,
		draftId: string,
		operationId: string,
		message: string,
		check: () => void,
		title?: string,
		images?: string[],
	) {
		const funding = await this.deps.sessions.activeFunding();
		if (funding) {
			if (p.allowanceMicros == null) throw new OperationRejected("Choose an allowance before starting this work");
			check();
			await funding.open({ kind: "quick_fix", id: draftId, projectId: p.projectId }, p.allowanceMicros);
			check();
		}
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
			undefined,
			images,
			undefined,
			!!funding,
		);
	}
	async createPinned(p: Selection, draftId: string, operationId: string, message: string) {
		return this.spawn(p, draftId, operationId, message, await this.qualify(p));
	}
	/** The project's quick-fix default, for chats the user starts without an amount field. Empty while limits are off. */
	async defaultAllowance(projectId: string): Promise<Pick<Selection, "allowanceMicros" | "fundingRequired">> {
		const funding = await (await this.deps.sessions.activeFunding())?.read(projectId);
		if (!funding) return {};
		if (funding.quickFixDefaultMicros == null)
			throw new OperationRejected("Set a quick-fix default in Funding before starting this work");
		return { allowanceMicros: funding.quickFixDefaultMicros, fundingRequired: true };
	}
	/** Exact Continue envelope: this host, payload `{purpose, sessionId}` aimed at that chat. */
	private continueRequest(op: DurableOperation): string {
		let p: Record<string, unknown>;
		try {
			p = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid continue payload");
		}
		if (
			op.kind !== CHAT_CONTINUE ||
			!p ||
			typeof p !== "object" ||
			Object.keys(p).sort().join() !== "purpose,sessionId" ||
			p.purpose !== CHAT_CONTINUE ||
			!id(p.sessionId) ||
			op.targetId !== p.sessionId ||
			!digest(op.bindingId) ||
			op.bindingGeneration !== 1 ||
			op.origin?.hostId !== "local" ||
			!sameHost(op.origin, this.deps.journal.destination) ||
			!sameHost(op.destination, this.deps.journal.destination)
		)
			throw new OperationRejected("Invalid continue intent");
		return p.sessionId;
	}
	async lookupContinue(op: DurableOperation) {
		this.continueRequest(op);
		return this.deps.journal.lookup(op);
	}
	/** Sends CONTINUE_TEXT once to a stopped chat. Re-entry only reads whether the chat accepted it. */
	async continueChat(op: DurableOperation, firstEntry: boolean) {
		const sessionId = this.continueRequest(op);
		if (!firstEntry) {
			if (await this.deps.sessions.lookupNativeAttentionInput(sessionId, op.operationId))
				return { sessionId, operationId: op.operationId };
			throw new Error("Continue outcome is unknown; it is never sent again");
		}
		const chat = this.deps.sessions.get(sessionId);
		if (!chat || chat.archivedAt || chat.continuedTo) throw new OperationRejected("This chat can no longer continue");
		if (chat.outcome !== "stopped" || chat.working) throw new OperationRejected("Only a stopped chat can continue");
		if (chat.sleepPaused || chat.offlinePaused || chat.subscriptionPause)
			throw new OperationRejected("This chat is paused");
		await this.deps.sessions.sendDurable(sessionId, CONTINUE_TEXT, "followUp", op.operationId, {
			inputGeneration: chat.inputGeneration ?? 0,
		});
		return { sessionId, operationId: op.operationId };
	}
}
