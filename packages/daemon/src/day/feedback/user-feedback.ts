import type { DurableOperation, UserFeedback, UserFeedbackOrigin, UserFeedbackPage } from "@pilot/protocol";
import type { AttachmentStore } from "../artifacts/attachment-store.ts";
import { Conflict, NotFound } from "../../runtime/contracts/errors.ts";
import type { MissionStore } from "../../missions/missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, sameHost } from "../../transport/operations/operation-journal.ts";
import type { ProjectStore } from "../../projects/projects.ts";
import type { SessionManager } from "../../sessions/sessions.ts";
import { USER_FEEDBACK_LIMITS as LIMITS } from "./user-feedback-store.ts";
import { feedbackWorkIntent, type UserFeedbackWorkService } from "./user-feedback-work.ts";

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
	attachments?: Pick<AttachmentStore, "adopt">;
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

	/** Initial save and exact durable-row recovery. Neither dispatches an investigation. */
	async admitNative(op: DurableOperation, journal: OperationJournal, firstEntry: boolean): Promise<UserFeedback> {
		if (!firstEntry) return this.recover(op);
		let value: unknown;
		try {
			value = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid feedback payload JSON");
		}
		const p = object(value, ["purpose", "text", "origin", "attachments", "investigation"]);
		if (op.kind !== "user-feedback" || p.purpose !== op.kind || !sameHost(op.origin, journal.destination))
			throw new OperationRejected("Invalid feedback intent scope");
		const id = identifier(op.targetId, "feedback ID");
		const text = p.text;
		if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > LIMITS.textBytes || text.includes("\0"))
			throw new OperationRejected(`Invalid feedback text (maximum ${LIMITS.textBytes} UTF-8 bytes)`);
		await this.deps.store.durable();
		try {
			const origin = this.origin(p.origin ?? null);
			let investigation: UserFeedback["investigation"];
			if (p.investigation !== undefined) {
				const claim = object(p.investigation, ["operation"]);
				const nested = claim.operation as DurableOperation;
				try {
					// Validation/lookup only: the child has no journal reservation until native dispatch.
					const existing = await journal.lookup(nested);
					const intent = feedbackWorkIntent(nested);
					if (
						existing ||
						nested.operationId === op.operationId ||
						!sameHost(nested.origin, op.origin) ||
						intent.action !== "triage" ||
						intent.feedbackId !== id ||
						this.deps.sessions.get(nested.targetId)
					)
						throw new Error("Investigation must be a fresh same-host triage for this saved feedback");
				} catch (error) {
					throw new OperationRejected(error instanceof Error ? error.message : "Invalid investigation operation");
				}
				investigation = { operation: nested };
			}
			let images: import("@pilot/protocol").StagedAttachmentRef[] | undefined;
			if (p.attachments !== undefined) {
				if (
					!this.deps.attachments ||
					!Array.isArray(p.attachments) ||
					p.attachments.length > 4 ||
					p.attachments.some(
						(r) =>
							!r ||
							typeof r !== "object" ||
							Array.isArray(r) ||
							Object.keys(r).sort().join() !== "bytes,sha256,uploadId" ||
							typeof r.uploadId !== "string" ||
							!/^[a-f0-9-]{36}$/i.test(r.uploadId) ||
							typeof r.sha256 !== "string" ||
							!/^[a-f0-9]{64}$/.test(r.sha256) ||
							!Number.isSafeInteger(r.bytes) ||
							r.bytes < 33 ||
							r.bytes > 8 * 1024 * 1024,
					)
				)
					throw new OperationRejected("Attach up to four images");
				images = p.attachments;
				await this.deps.attachments.adopt(op, images);
			}
			const saved = this.deps.store.feedback.add({
				id,
				savePayloadHash: op.payloadHash,
				...(investigation ? { investigation } : {}),
				...(images ? { attachments: images } : {}),
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

	/** Confirms only the exact already-durable save. Never saves again or dispatches its child. */
	async recover(op: DurableOperation): Promise<UserFeedback> {
		await this.deps.store.durable();
		const saved = this.deps.store.feedback.byOperation(op.operationId);
		const original = JSON.parse(op.payload) as { investigation?: UserFeedback["investigation"] };
		if (
			!saved ||
			saved.id !== op.targetId ||
			saved.operationId !== op.operationId ||
			saved.savePayloadHash !== op.payloadHash ||
			canonicalJSON(saved.investigation ?? null) !== canonicalJSON(original.investigation ?? null)
		)
			throw new Error("Feedback outcome is unknown; no exact saved input was found");
		return saved;
	}

	/** One page, newest first, with each item's steps. Passive. */
	async page(
		before?: string,
		limit?: string,
		result?: { kind: string; id: string; projectId: string },
	): Promise<UserFeedbackPage> {
		const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
		const count = limit === undefined ? LIMITS.page : Number(limit);
		if (!Number.isSafeInteger(cursor) || cursor < 1 || !Number.isSafeInteger(count) || count < 1)
			throw new OperationRejected("Invalid feedback page");
		if (count > LIMITS.page) throw new OperationRejected(`Feedback page limit is ${LIMITS.page}`);
		await this.deps.store.durable();
		const page = result ? this.resultPage(result, cursor, count) : this.deps.store.feedback.page(cursor, count);
		const items = [];
		const setups = new Map();
		for (const item of page.items) items.push({ ...item, work: (await this.deps.work?.view(item.id, setups)) ?? [] });
		return { ...page, items, ...(result ? { result } : {}) };
	}

	private resultPage(result: NonNullable<UserFeedbackPage["result"]>, cursor: number, count: number) {
		const projectId = identifier(result.projectId, "project ID");
		let id = identifier(result.id, "result ID");
		const store = this.deps.store.feedback;
		if (result.kind === "mission") return store.resultPage({ kind: "mission", id, projectId }, cursor, count);
		if (result.kind !== "chat") throw new OperationRejected("Invalid feedback result scope");
		const seen = new Set<string>();
		while (!seen.has(id) && seen.size < 32) {
			const chat = this.deps.sessions.get(id);
			if (chat?.projectId !== projectId) break;
			const page = store.resultPage({ kind: "fix", id, projectId }, cursor, count);
			if (page.items.length) return page;
			// The daemon's committed continuation chain preserves the original feedback
			// link. Never follow unverified ancestry or cross projects.
			const prior = chat.continuationOf;
			if (!prior || this.deps.sessions.get(prior)?.continuedTo !== id) break;
			seen.add(id);
			id = prior;
		}
		return { items: [], more: false, before: null };
	}
}
