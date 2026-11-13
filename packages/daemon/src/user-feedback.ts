import type { DurableOperation, UserFeedback, UserFeedbackOrigin, UserFeedbackPage } from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import { type OperationJournal, OperationRejected, sameHost } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";
import { USER_FEEDBACK_LIMITS as LIMITS } from "./user-feedback-store.ts";
import type { UserFeedbackWorkService } from "./user-feedback-work.ts";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function identifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !ID.test(value)) throw new OperationRejected(`Invalid ${field}`);
	return value;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new OperationRejected("Expected feedback object");
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new OperationRejected("Unknown feedback field");
	return value as Record<string, unknown>;
}

interface Dependencies {
	store: MissionStore;
	projects: Pick<ProjectStore, "require">;
	sessions: Pick<SessionManager, "get">;
	/** The user's steps on each item. Without it a page lists none. */
	work?: Pick<UserFeedbackWorkService, "view">;
}

/**
 * The user's own feedback about Pilot: saved and listed, nothing more. It never creates missions,
 * dispatches work, spends budget or changes prompts; any later triage is a separate, explicit step.
 */
export class UserFeedbackService {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}

	/** The saved origin, read from the exact mission or chat. A missing one refuses the feedback. */
	private origin(value: unknown): UserFeedbackOrigin | null {
		if (value === null) return null;
		const o = object(value, ["kind", "missionId", "sessionId"]);
		if (o.kind === "mission" && o.sessionId === undefined) {
			const missionId = identifier(o.missionId, "missionId");
			const mission = this.deps.store.get(missionId);
			if (!mission) throw new OperationRejected("The mission this feedback names no longer exists");
			this.deps.projects.require(mission.projectId);
			return { kind: "mission", missionId, projectId: mission.projectId, title: mission.title };
		}
		if (o.kind === "chat" && o.missionId === undefined) {
			const sessionId = identifier(o.sessionId, "sessionId");
			const chat = this.deps.sessions.get(sessionId);
			if (!chat?.projectId) throw new OperationRejected("The chat this feedback names no longer exists");
			this.deps.projects.require(chat.projectId);
			return { kind: "chat", sessionId, projectId: chat.projectId, title: chat.title ?? "" };
		}
		throw new OperationRejected("Invalid feedback origin");
	}

	/** Journal recovery is lookup-only; a saved row cannot replace a missing outer ACK. */
	async admitNative(op: DurableOperation, journal: OperationJournal, firstEntry: boolean): Promise<UserFeedback> {
		if (!firstEntry) throw new Error("Feedback outcome is unknown; Check its exact receipt only");
		let value: unknown;
		try {
			value = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid feedback payload JSON");
		}
		const p = object(value, ["purpose", "text", "origin"]);
		if (op.kind !== "user-feedback" || p.purpose !== op.kind || !sameHost(op.origin, journal.destination))
			throw new OperationRejected("Invalid feedback intent scope");
		const id = identifier(op.targetId, "feedback ID");
		const text = p.text;
		if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > LIMITS.textBytes || text.includes("\0"))
			throw new OperationRejected(`Invalid feedback text (maximum ${LIMITS.textBytes} UTF-8 bytes)`);
		await this.deps.store.durable();
		try {
			const origin = this.origin(p.origin ?? null);
			const saved = this.deps.store.feedback.add({
				id,
				text,
				origin,
				recordedAt: Date.now(),
				operationId: op.operationId,
			});
			await this.deps.store.durable();
			return saved;
		} catch (error) {
			if (error instanceof Conflict || error instanceof NotFound) throw new OperationRejected(error.message);
			throw error;
		}
	}

	/** One page, newest first, with each item's steps. Passive. */
	async page(before?: string, limit?: string): Promise<UserFeedbackPage> {
		const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
		const count = limit === undefined ? LIMITS.page : Number(limit);
		if (!Number.isSafeInteger(cursor) || cursor < 1 || !Number.isSafeInteger(count) || count < 1)
			throw new OperationRejected("Invalid feedback page");
		if (count > LIMITS.page) throw new OperationRejected(`Feedback page limit is ${LIMITS.page}`);
		await this.deps.store.durable();
		const page = this.deps.store.feedback.page(cursor, count);
		const items = [];
		for (const item of page.items) items.push({ ...item, work: (await this.deps.work?.view(item.id)) ?? [] });
		return { ...page, items };
	}
}
