import type {
	DurableOperation,
	ProjectPreferenceAuthor,
	ProjectPreferenceSource,
	ProjectPreferencesWrite,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import { type OperationJournal, OperationRejected, sameHost } from "./operation-journal.ts";
import type { KnowledgeCaller, KnowledgeProjects, KnowledgeSessions } from "./project-knowledge.ts";
import { InvalidProjectPreferences, PROJECT_PREFERENCES_LIMITS as LIMITS } from "./project-preferences-store.ts";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new InvalidProjectPreferences("Expected preference object");
	return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]): void {
	if (Object.keys(value).some((key) => !keys.includes(key)))
		throw new InvalidProjectPreferences("Unknown preference field");
}
function string(value: unknown, field: string, bytes: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > bytes || value.includes("\0"))
		throw new InvalidProjectPreferences(`Invalid ${field} (maximum ${bytes} UTF-8 bytes)`);
	return value.trim();
}
function integer(value: unknown, field: string, min = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < min) throw new InvalidProjectPreferences(`Invalid ${field}`);
	return value as number;
}
function identifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
		throw new InvalidProjectPreferences(`Invalid ${field}`);
	return value;
}

export class ProjectPreferencesService {
	private readonly store: MissionStore;
	private readonly projects: KnowledgeProjects;
	private readonly sessions: KnowledgeSessions;
	constructor(store: MissionStore, projects: KnowledgeProjects, sessions: KnowledgeSessions) {
		this.store = store;
		this.projects = projects;
		this.sessions = sessions;
	}

	/** Journal recovery is lookup-only; a committed domain row cannot replace a missing outer ACK. */
	async admitNative(op: DurableOperation, journal: OperationJournal, firstEntry: boolean) {
		if (!firstEntry) throw new Error("Preference outcome is unknown; Check its exact receipt only");
		let value: unknown;
		try {
			value = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid preference payload JSON");
		}
		try {
			const p = object(value);
			only(p, ["purpose", "projectId", "expectedRevision", "entries", "reason"]);
			if (
				op.kind !== "project-preferences-update" ||
				p.purpose !== op.kind ||
				p.projectId !== op.targetId ||
				!sameHost(op.origin, journal.destination)
			)
				throw new InvalidProjectPreferences("Invalid preference intent scope");
			const result = await this.write(identifier(p.projectId, "projectId"), {
				operationId: op.operationId,
				expectedRevision: p.expectedRevision,
				entries: p.entries,
				reason: p.reason,
			});
			return result.snapshot;
		} catch (error) {
			if (error instanceof InvalidProjectPreferences || error instanceof Conflict || error instanceof NotFound)
				throw new OperationRejected(error.message);
			throw error;
		}
	}

	private project(projectId: string, caller?: KnowledgeCaller): void {
		if (caller && caller.projectId !== projectId) throw new Conflict("Preferences use only the caller's own project");
		this.projects.require(identifier(projectId, "projectId"));
	}
	private reader(caller: KnowledgeCaller): void {
		caller.assertCurrent?.(false);
		this.project(caller.projectId);
		if (this.sessions.get(caller.sessionId)?.projectId !== caller.projectId)
			throw new Conflict("Preference reader changed project or no longer exists");
	}
	private owner(caller: KnowledgeCaller): string {
		this.reader(caller);
		caller.assertCurrent?.(true);
		const session = this.sessions.get(caller.sessionId);
		const member = this.store.membership(caller.sessionId);
		const mission = member ? this.store.get(member.missionId) : undefined;
		if (
			caller.readOnly ||
			session?.archivedAt ||
			session?.mode === "ask" ||
			session?.role ||
			session?.executionPermission?.level === "investigate" ||
			!member?.active ||
			!member.coordinator ||
			this.store.controls.fenceCurrent(member.missionId).held ||
			!mission ||
			mission.projectId !== caller.projectId ||
			mission.coordinatorSessionId !== caller.sessionId
		)
			throw new Conflict(
				"Only the current writable coordinator of this project's active mission can record preferences",
			);
		return JSON.stringify({
			missionId: mission.id,
			...this.store.interviewOwnerFence(mission.id, caller.sessionId),
			controls: this.store.controls.fenceCurrent(mission.id),
			inputGeneration: session?.inputGeneration ?? 0,
			permission: session?.executionPermission ?? null,
		});
	}

	async read(projectId: string, caller?: KnowledgeCaller) {
		await this.store.durable();
		this.project(projectId, caller);
		if (caller) this.reader(caller);
		const result = this.store.preferences.get(projectId);
		await this.store.durable();
		this.project(projectId, caller);
		if (caller) this.reader(caller);
		return result;
	}
	async history(projectId: string, before?: unknown, limit?: unknown, caller?: KnowledgeCaller) {
		const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : integer(Number(before), "before", 1);
		const count = limit === undefined ? LIMITS.history : integer(Number(limit), "limit", 1);
		if (count > LIMITS.history) throw new Error("Preference history limit is 20");
		await this.store.durable();
		this.project(projectId, caller);
		if (caller) this.reader(caller);
		const result = this.store.preferences.history(projectId, cursor, count);
		await this.store.durable();
		this.project(projectId, caller);
		if (caller) this.reader(caller);
		return result;
	}
	async lookup(projectId: string, operationId: unknown, caller?: KnowledgeCaller) {
		const operation = identifier(operationId, "operationId");
		await this.store.durable();
		this.project(projectId, caller);
		if (caller) this.reader(caller);
		const result = this.store.preferences.lookup(projectId, operation);
		await this.store.durable();
		this.project(projectId, caller);
		if (caller) this.reader(caller);
		return result;
	}

	async write(projectId: string, value: unknown, caller?: KnowledgeCaller) {
		this.project(projectId, caller);
		const fence = caller ? this.owner(caller) : undefined;
		const v = object(value);
		only(v, ["operationId", "expectedRevision", "entries", "reason", "source"]);
		if (!Array.isArray(v.entries) || v.entries.length > LIMITS.entries)
			throw new InvalidProjectPreferences("At most 16 project preferences");
		const entries = v.entries.map((value) => {
			const entry = object(value);
			only(entry, ["id", "text"]);
			return { id: identifier(entry.id, "entry id"), text: string(entry.text, "preference text", LIMITS.textBytes) };
		});
		if (new Set(entries.map((e) => e.id)).size !== entries.length)
			throw new InvalidProjectPreferences("Duplicate preference IDs");
		const write: ProjectPreferencesWrite = {
			operationId: identifier(v.operationId, "operationId"),
			expectedRevision: integer(v.expectedRevision, "expectedRevision"),
			entries,
			reason: string(v.reason, "reason", 512),
		};
		let source: ProjectPreferenceSource = { type: "user" };
		let author: ProjectPreferenceAuthor = { type: "user" };
		if (caller) {
			const s = object(v.source);
			only(s, ["type", "missionId", "eventId", "quote"]);
			if (s.type !== "mission_note")
				throw new InvalidProjectPreferences(
					"Cite an existing explicit user mission note, never agent-inferred guidance",
				);
			source = {
				type: "mission_note",
				missionId: identifier(s.missionId, "missionId"),
				eventId: integer(s.eventId, "eventId", 1),
				quote: string(s.quote, "quote", 1024),
			};
			author = { type: "coordinator", sessionId: caller.sessionId, missionId: source.missionId };
		} else if (v.source !== undefined)
			throw new InvalidProjectPreferences("User preference source is derived by the host");
		await this.store.durable();
		this.project(projectId, caller);
		if (caller) {
			if (this.owner(caller) !== fence)
				throw new Conflict("Preference coordinator authority changed during admission");
			if (source.type !== "mission_note" || this.store.missionOf(caller.sessionId) !== source.missionId)
				throw new Conflict("Preference source belongs to another mission");
			const note = this.store.preferences.humanNote(source.missionId, source.eventId);
			if (!note?.includes(source.quote))
				throw new NotFound("Exact user note quotation was not found in this mission");
			const current = this.store.preferences.get(projectId);
			for (const entry of entries) {
				if (
					!current.entries.some((old) => old.id === entry.id && old.text === entry.text) &&
					!source.quote.includes(entry.text)
				)
					throw new InvalidProjectPreferences(
						"New preference text must quote the explicit user choice, not paraphrase or infer policy",
					);
			}
		}
		// No await between final current authority/source checks and the revision-CAS transaction.
		const result = this.store.preferences.write(projectId, write, author, source);
		await this.store.durable();
		return result;
	}
}
