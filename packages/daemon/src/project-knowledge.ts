/** Project knowledge service: admission, validation and the supervised agent tool seam over ProjectKnowledgeStore. */
import { createHash } from "node:crypto";
import type {
	KnowledgeAuthor,
	KnowledgeDetail,
	KnowledgeKind,
	KnowledgePage,
	KnowledgeRelation,
	KnowledgeRevisionPage,
	KnowledgeSource,
	KnowledgeWrite,
	KnowledgeWriteResult,
	MissionKnowledgeLink,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import type { KnowledgeListFilter, PreparedKnowledgeWrite } from "./project-knowledge-store.ts";

export const KNOWLEDGE_LIMITS = {
	/** UTF-8 bytes of one revision's title, synopsis, body, sources and reason. */
	revisionBytes: 64 * 1024,
	sources: 64,
	title: 200,
	synopsis: 1_000,
	reason: 1_000,
	label: 200,
	excerpt: 2_000,
	query: 200,
	pageDefault: 25,
	pageMax: 50,
} as const;

const KINDS: readonly KnowledgeKind[] = ["investigation", "component"];
const RELATIONS: readonly KnowledgeRelation[] = ["supports", "supplements", "supersedes", "documents"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION = /^[\x21-\x7e]{1,256}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

/** Required Markdown headings, so every entry explains itself without opening its sources. */
const SECTIONS: Record<KnowledgeKind, { name: string; pattern: RegExp }[]> = {
	investigation: [
		{ name: "Question", pattern: /question/i },
		{ name: "Findings (or Conclusions)", pattern: /finding|conclusion/i },
		{ name: "Limitations (or Unknowns)", pattern: /limit|unknown/i },
	],
	component: [
		{ name: "Purpose (or Boundary)", pattern: /purpose|boundar/i },
		{ name: "Interfaces (or Architecture)", pattern: /interface|architecture/i },
		{ name: "Constraints (or Gaps)", pattern: /constraint|gap|limit/i },
	],
};

/** Supervised chat identity from session metadata, never from tool arguments. */
export interface KnowledgeCaller {
	sessionId: string;
	projectId: string;
	/** Ask, explorer and diagnostics chats read only. */
	readOnly: boolean;
}

export interface KnowledgeSessions {
	get(id: string): { projectId?: string } | undefined;
	/** Exact stored artifact revision; never wakes a worker. */
	artifact(sessionId: string, artifactId: string, revision?: number): Promise<{ revision: number }>;
}

export interface KnowledgeProjects {
	require(id: string): unknown;
}

function codePoints(value: string): number {
	let n = 0;
	for (const _ of value) n++;
	return n;
}

function text(value: unknown, field: string, max: number, options: { multiline?: boolean; optional?: boolean } = {}) {
	if (value === undefined && options.optional) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be text`);
	const trimmed = value.trim();
	if (!trimmed) {
		if (options.optional) return undefined;
		throw new Error(`${field} is required`);
	}
	if (codePoints(trimmed) > max) throw new Error(`${field} is longer than ${max} characters`);
	if (!options.multiline && /[\r\n]/.test(trimmed)) throw new Error(`${field} must be one line`);
	return trimmed;
}

function id(value: unknown, field: string): string {
	if (typeof value !== "string" || !ID.test(value)) throw new Error(`${field} must be an ID`);
	return value;
}

function integer(value: unknown, field: string, min: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
		throw new Error(`${field} must be an integer of at least ${min}`);
	return value;
}

function date(value: unknown, field: string, optional = true): string | undefined {
	if (value === undefined && optional) return undefined;
	if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(value)))
		throw new Error(`${field} must be an ISO date`);
	return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	return value as Record<string, unknown>;
}

function only(record: Record<string, unknown>, keys: string[], field: string): void {
	for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`${field}: unknown field ${key}`);
}

/** Fixed key order, so equal citations hash identically whatever order a client sent. */
export function parseKnowledgeSource(value: unknown, index: number): KnowledgeSource {
	const field = `sources[${index}]`;
	const v = object(value, field);
	const label = text(v.label, `${field}.label`, KNOWLEDGE_LIMITS.label, { optional: true });
	const tail = label === undefined ? {} : { label };
	switch (v.type) {
		case "repository": {
			only(v, ["type", "path", "commit", "dirty", "sha256", "section", "observedAt", "label"], field);
			const path = text(v.path, `${field}.path`, 1024)!;
			if (
				path.startsWith("/") ||
				path.includes("\\") ||
				path.includes("\0") ||
				path.split("/").some((part) => part === "..")
			)
				throw new Error(`${field}.path must be relative to the project root`);
			if (v.commit !== undefined && (typeof v.commit !== "string" || !/^[0-9a-f]{7,64}$/.test(v.commit)))
				throw new Error(`${field}.commit must be a hexadecimal commit`);
			if (v.sha256 !== undefined && (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)))
				throw new Error(`${field}.sha256 must be 64 hexadecimal characters`);
			if (v.dirty !== undefined && typeof v.dirty !== "boolean")
				throw new Error(`${field}.dirty must be true or false`);
			const section = text(v.section, `${field}.section`, KNOWLEDGE_LIMITS.label, { optional: true });
			const observedAt = date(v.observedAt, `${field}.observedAt`);
			return {
				type: "repository",
				path,
				...(v.commit !== undefined ? { commit: v.commit as string } : {}),
				...(v.dirty === true ? { dirty: true } : {}),
				...(v.sha256 !== undefined ? { sha256: v.sha256 as string } : {}),
				...(section !== undefined ? { section } : {}),
				...(observedAt !== undefined ? { observedAt } : {}),
				...tail,
			};
		}
		case "artifact": {
			only(v, ["type", "sessionId", "artifactId", "revision", "observedAt", "label"], field);
			const observedAt = date(v.observedAt, `${field}.observedAt`);
			return {
				type: "artifact",
				sessionId: id(v.sessionId, `${field}.sessionId`),
				artifactId: id(v.artifactId, `${field}.artifactId`),
				// Never substitute latest for a missing pin.
				revision: integer(v.revision, `${field}.revision`, 1),
				...(observedAt !== undefined ? { observedAt } : {}),
				...tail,
			};
		}
		case "mission": {
			only(
				v,
				["type", "missionId", "decisionId", "taskId", "eventId", "briefRevision", "quote", "observedAt", "label"],
				field,
			);
			const quote = text(v.quote, `${field}.quote`, KNOWLEDGE_LIMITS.excerpt, { optional: true, multiline: true });
			const observedAt = date(v.observedAt, `${field}.observedAt`);
			return {
				type: "mission",
				missionId: id(v.missionId, `${field}.missionId`),
				...(v.decisionId !== undefined ? { decisionId: id(v.decisionId, `${field}.decisionId`) } : {}),
				...(v.taskId !== undefined ? { taskId: id(v.taskId, `${field}.taskId`) } : {}),
				...(v.eventId !== undefined ? { eventId: integer(v.eventId, `${field}.eventId`, 1) } : {}),
				...(v.briefRevision !== undefined
					? { briefRevision: integer(v.briefRevision, `${field}.briefRevision`, 1) }
					: {}),
				...(quote !== undefined ? { quote } : {}),
				...(observedAt !== undefined ? { observedAt } : {}),
				...tail,
			};
		}
		case "web": {
			only(v, ["type", "url", "accessedAt", "publishedAt", "excerpt", "label"], field);
			const url = text(v.url, `${field}.url`, 2048)!;
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new Error(`${field}.url must be an absolute URL`);
			}
			if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
				throw new Error(`${field}.url must use http or https`);
			const excerpt = text(v.excerpt, `${field}.excerpt`, KNOWLEDGE_LIMITS.excerpt, {
				optional: true,
				multiline: true,
			});
			const publishedAt = date(v.publishedAt, `${field}.publishedAt`);
			return {
				type: "web",
				url,
				accessedAt: date(v.accessedAt, `${field}.accessedAt`, false)!,
				...(publishedAt !== undefined ? { publishedAt } : {}),
				...(excerpt !== undefined ? { excerpt } : {}),
				...tail,
			};
		}
		case "knowledge": {
			only(v, ["type", "knowledgeId", "revision", "relation", "finding", "label"], field);
			if (!RELATIONS.includes(v.relation as KnowledgeRelation))
				throw new Error(`${field}.relation must be one of ${RELATIONS.join(", ")}`);
			const finding = text(v.finding, `${field}.finding`, 64, { optional: true });
			return {
				type: "knowledge",
				knowledgeId: id(v.knowledgeId, `${field}.knowledgeId`),
				revision: integer(v.revision, `${field}.revision`, 1),
				relation: v.relation as KnowledgeRelation,
				...(finding !== undefined ? { finding } : {}),
				...tail,
			};
		}
		default:
			throw new Error(`${field}.type must be repository, artifact, mission, web or knowledge`);
	}
}

/** Validated write content. Rejects oversize writes; never truncates findings. */
export function parseKnowledgeWrite(
	value: unknown,
	append: boolean,
): Omit<PreparedKnowledgeWrite, "requestHash" | "author" | "origin" | "kind"> & {
	kind?: KnowledgeKind;
	originMissionId?: string;
} {
	const v = object(value, "Knowledge write") as Partial<Record<keyof KnowledgeWrite, unknown>>;
	only(
		v as Record<string, unknown>,
		["operationId", "expectedRevision", "kind", "title", "synopsis", "body", "sources", "reason", "originMissionId"],
		"Knowledge write",
	);
	if (typeof v.operationId !== "string" || !OPERATION.test(v.operationId))
		throw new Error("operationId must be 1-256 visible ASCII characters");
	const expectedRevision = integer(v.expectedRevision, "expectedRevision", append ? 1 : 0);
	if (!append && expectedRevision !== 0) throw new Conflict("Create requires expectedRevision 0");
	if (v.kind !== undefined && !KINDS.includes(v.kind as KnowledgeKind))
		throw new Error("kind must be investigation or component");
	if (!append && v.kind === undefined) throw new Error("kind is required to create an entry");
	if (append && v.originMissionId !== undefined) throw new Error("originMissionId applies only when creating");
	const title = text(v.title, "title", KNOWLEDGE_LIMITS.title)!;
	const synopsis = text(v.synopsis, "synopsis", KNOWLEDGE_LIMITS.synopsis, { multiline: true })!;
	if (typeof v.body !== "string" || !v.body.trim()) throw new Error("body is required: readable Markdown");
	const body = v.body.replace(/\r\n?/g, "\n").trim();
	const reason = text(v.reason, "reason", KNOWLEDGE_LIMITS.reason, { multiline: true, optional: true });
	if (append && reason === undefined) throw new Error("reason is required when appending a revision");
	if (v.sources !== undefined && !Array.isArray(v.sources)) throw new Error("sources must be a list");
	const raw = (v.sources as unknown[] | undefined) ?? [];
	if (raw.length > KNOWLEDGE_LIMITS.sources)
		throw new Error(`At most ${KNOWLEDGE_LIMITS.sources} sources per revision`);
	const sources = raw.map(parseKnowledgeSource);
	const bytes = Buffer.byteLength(JSON.stringify({ title, synopsis, body, sources, reason }), "utf8");
	if (bytes > KNOWLEDGE_LIMITS.revisionBytes)
		throw new Error(
			`Knowledge revision is ${bytes} bytes; the limit is ${KNOWLEDGE_LIMITS.revisionBytes}. Keep large evidence in its source and cite it.`,
		);
	return {
		operationId: v.operationId,
		expectedRevision,
		...(v.kind !== undefined ? { kind: v.kind as KnowledgeKind } : {}),
		title,
		synopsis,
		body,
		sources,
		...(reason !== undefined ? { reason } : {}),
		...(v.originMissionId !== undefined ? { originMissionId: id(v.originMissionId, "originMissionId") } : {}),
	};
}

/** The body must explain the entry, not just point at sources. */
export function assertReadableBody(kind: KnowledgeKind, body: string): void {
	const headings = body
		.split("\n")
		.map((line) => /^\s{0,3}#{1,6}\s+(.+)$/.exec(line)?.[1] ?? "")
		.filter(Boolean);
	const missing = SECTIONS[kind].filter((section) => !headings.some((heading) => section.pattern.test(heading)));
	if (missing.length)
		throw new Error(`A readable ${kind} body needs Markdown headings for: ${missing.map((m) => m.name).join(", ")}.`);
}

function encodeCursor(value: unknown[]): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decodeCursor(cursor: unknown): unknown[] {
	if (typeof cursor !== "string" || cursor.length > 1024) throw new Error("Invalid cursor");
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (Array.isArray(value)) return value;
	} catch {}
	throw new Error("Invalid cursor");
}
function pageLimit(value: unknown): number {
	if (value === undefined || value === null || value === "") return KNOWLEDGE_LIMITS.pageDefault;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > KNOWLEDGE_LIMITS.pageMax)
		throw new Error(`limit must be 1-${KNOWLEDGE_LIMITS.pageMax}`);
	return n;
}

export interface KnowledgeListQuery {
	kind?: unknown;
	missionId?: unknown;
	check?: unknown;
	q?: unknown;
	limit?: unknown;
	cursor?: unknown;
}

export class KnowledgeService {
	private readonly store: MissionStore;
	private readonly projects: KnowledgeProjects;
	private readonly sessions: KnowledgeSessions;
	constructor(store: MissionStore, projects: KnowledgeProjects, sessions: KnowledgeSessions) {
		this.store = store;
		this.projects = projects;
		this.sessions = sessions;
	}

	private admitProject(projectId: string): void {
		if (typeof projectId !== "string" || !ID.test(projectId)) throw new NotFound("Unknown project");
		this.projects.require(projectId);
	}

	/**
	 * The MissionStore durable-read seam: wait for pending commits, read the stored rows, then wait again so the reply
	 * never shows state that is not yet on disk. A durability failure fails the read.
	 */
	async durableRead<T>(read: () => T): Promise<T> {
		await this.store.durable();
		const value = read();
		await this.store.durable();
		return value;
	}

	/** Stored summaries only: no source reads, reconciliation, pending mutation or lazy rows. */
	list(projectId: string, query: KnowledgeListQuery = {}): KnowledgePage {
		this.admitProject(projectId);
		const filter: KnowledgeListFilter = {};
		if (query.kind !== undefined && query.kind !== null && query.kind !== "") {
			if (!KINDS.includes(query.kind as KnowledgeKind)) throw new Error("kind must be investigation or component");
			filter.kind = query.kind as KnowledgeKind;
		}
		if (query.missionId !== undefined && query.missionId !== null && query.missionId !== "") {
			const missionId = id(query.missionId, "missionId");
			if (this.store.get(missionId)?.projectId !== projectId)
				throw new NotFound("Mission not found in this project");
			filter.missionId = missionId;
		}
		if (query.check !== undefined && query.check !== null && query.check !== "") {
			if (query.check !== "needs_check") throw new Error("check must be needs_check");
			filter.needsCheck = true;
		}
		if (query.q !== undefined && query.q !== null && query.q !== "") {
			filter.q = text(query.q, "q", KNOWLEDGE_LIMITS.query);
		}
		const limit = pageLimit(query.limit);
		const binding = [projectId, filter.kind ?? "", filter.missionId ?? "", filter.needsCheck ? 1 : 0, filter.q ?? ""];
		let after: { createdAt: number; id: string } | undefined;
		if (query.cursor !== undefined && query.cursor !== null && query.cursor !== "") {
			const cursor = decodeCursor(query.cursor);
			if (JSON.stringify(cursor.slice(0, 5)) !== JSON.stringify(binding))
				throw new Error("This cursor belongs to a different project or filter; start again");
			const [createdAt, last] = cursor.slice(5);
			if (typeof createdAt !== "number" || typeof last !== "string") throw new Error("Invalid cursor");
			after = { createdAt, id: last };
		}
		const page = this.store.knowledge.list(projectId, filter, after, limit);
		const tail = page.entries.at(-1);
		return {
			entries: page.entries,
			more: page.more,
			cursor: page.more && tail ? encodeCursor([...binding, tail.createdAt, tail.id]) : null,
		};
	}

	detail(projectId: string, knowledgeId: string, revision?: unknown): KnowledgeDetail {
		this.admitProject(projectId);
		const exact =
			revision === undefined || revision === null || revision === ""
				? undefined
				: integer(typeof revision === "string" ? Number(revision) : revision, "revision", 1);
		const detail = this.store.knowledge.detail(projectId, id(knowledgeId, "id"), exact);
		if (!detail)
			throw new NotFound(exact === undefined ? "Knowledge entry not found" : "Knowledge revision not found");
		return detail;
	}

	revisions(projectId: string, knowledgeId: string, query: { cursor?: unknown; limit?: unknown } = {}) {
		this.admitProject(projectId);
		const entry = id(knowledgeId, "id");
		const limit = pageLimit(query.limit);
		let before: number | undefined;
		if (query.cursor !== undefined && query.cursor !== null && query.cursor !== "") {
			const [cursorEntry, revision] = decodeCursor(query.cursor);
			if (cursorEntry !== entry || typeof revision !== "number")
				throw new Error("This cursor belongs to another entry");
			before = revision;
		}
		const page = this.store.knowledge.revisions(projectId, entry, before, limit);
		if (!page) throw new NotFound("Knowledge entry not found");
		const tail = page.revisions.at(-1);
		return {
			revisions: page.revisions,
			more: page.more,
			cursor: page.more && tail ? encodeCursor([entry, tail.revision]) : null,
		} satisfies KnowledgeRevisionPage;
	}

	/** Existing, same-project citations only. Artifact pins are checked against their stored revision. */
	private async validateSources(projectId: string, knowledgeId: string | undefined, sources: KnowledgeSource[]) {
		for (const source of sources) {
			switch (source.type) {
				case "artifact": {
					if (this.sessions.get(source.sessionId)?.projectId !== projectId)
						throw new NotFound("Cited artifact's chat is not in this project");
					try {
						await this.sessions.artifact(source.sessionId, source.artifactId, source.revision);
					} catch {
						throw new NotFound(`Cited artifact ${source.artifactId} revision ${source.revision} was not found`);
					}
					if (this.sessions.get(source.sessionId)?.projectId !== projectId)
						throw new Conflict("Cited artifact's chat changed project");
					break;
				}
				case "mission":
					this.validateMissionSource(projectId, source);
					break;
				case "knowledge":
					if (source.knowledgeId === knowledgeId) {
						if (!this.store.knowledge.hasRevision(projectId, source.knowledgeId, source.revision))
							throw new NotFound("Cited revision of this entry was not found");
					} else if (!this.store.knowledge.hasRevision(projectId, source.knowledgeId, source.revision))
						throw new NotFound(
							`Cited knowledge ${source.knowledgeId} revision ${source.revision} was not found in this project`,
						);
					break;
			}
		}
	}

	private validateMissionSource(projectId: string, source: Extract<KnowledgeSource, { type: "mission" }>): void {
		const mission = this.store.get(source.missionId);
		if (!mission || mission.projectId !== projectId) throw new NotFound("Cited mission is not in this project");
		const missing = this.store.knowledge.missingMissionCitation(source);
		if (missing) throw new NotFound(`Cited ${missing} was not found in that mission`);
	}

	/** Create or append; the author and origin come from the admitted caller. ACK only after durable(). */
	async write(
		projectId: string,
		knowledgeId: string | undefined,
		value: unknown,
		author: KnowledgeAuthor,
		origin: { missionId?: string; taskId?: string; sessionId?: string } = {},
	): Promise<KnowledgeWriteResult> {
		this.admitProject(projectId);
		if (knowledgeId !== undefined) id(knowledgeId, "id");
		const parsed = parseKnowledgeWrite(value, knowledgeId !== undefined);
		const current = knowledgeId === undefined ? undefined : this.store.knowledge.summary(projectId, knowledgeId);
		if (knowledgeId !== undefined && !current) throw new NotFound("Knowledge entry not found in this project");
		const kind = parsed.kind ?? current!.kind;
		if (current && kind !== current.kind) throw new Conflict("An entry's kind cannot change");
		assertReadableBody(kind, parsed.body);
		const { originMissionId, ...content } = parsed;
		const createOrigin =
			knowledgeId === undefined
				? { ...origin, ...(originMissionId !== undefined ? { missionId: originMissionId } : {}) }
				: undefined;
		const requestHash = createHash("sha256")
			.update(
				JSON.stringify([
					knowledgeId ?? null,
					author,
					createOrigin ?? null,
					kind,
					content.expectedRevision,
					content.title,
					content.synopsis,
					content.body,
					content.sources,
					content.reason ?? null,
				]),
			)
			.digest("hex");
		// An exact retry returns its saved result before revalidating sources that may since have moved.
		const replay = () =>
			this.store.knowledge.write(projectId, knowledgeId, {
				...content,
				kind,
				requestHash,
				author,
				...(createOrigin ? { origin: createOrigin } : {}),
			});
		const known = this.store.knowledge.operation(projectId, content.operationId);
		if (!known) await this.validateSources(projectId, knowledgeId, content.sources);
		this.admitProject(projectId);
		const result = replay();
		await this.store.durable();
		return result;
	}

	linkState(missionId: string, knowledgeId: string): MissionKnowledgeLink {
		const mission = this.store.get(id(missionId, "missionId"));
		if (!mission) throw new NotFound("Mission not found");
		this.admitProject(mission.projectId);
		return this.store.knowledge.link(missionId, id(knowledgeId, "id"));
	}

	/** Link (pin or follow current) with compare-and-set on the stored link revision. */
	async link(missionId: string, knowledgeId: string, value: unknown, actor: KnowledgeAuthor) {
		const v = object(value, "Link");
		only(v, ["expectedLinkRevision", "revision", "followCurrent"], "Link");
		const expected = integer(v.expectedLinkRevision, "expectedLinkRevision", 0);
		if ((v.revision === undefined) === (v.followCurrent !== true))
			throw new Error("Pass exactly one of revision or followCurrent: true");
		const pinned = v.revision === undefined ? undefined : integer(v.revision, "revision", 1);
		const mission = this.store.get(id(missionId, "missionId"));
		if (!mission) throw new NotFound("Mission not found");
		this.admitProject(mission.projectId);
		const result = this.store.knowledge.setLink(
			missionId,
			id(knowledgeId, "id"),
			expected,
			{ linked: true, ...(pinned !== undefined ? { pinnedRevision: pinned } : {}) },
			actor,
		);
		await this.store.durable();
		return result;
	}

	async unlink(missionId: string, knowledgeId: string, expectedLinkRevision: unknown, actor: KnowledgeAuthor) {
		const expected = integer(
			typeof expectedLinkRevision === "string" && expectedLinkRevision !== ""
				? Number(expectedLinkRevision)
				: expectedLinkRevision,
			"expectedLinkRevision",
			1,
		);
		const mission = this.store.get(id(missionId, "missionId"));
		if (!mission) throw new NotFound("Mission not found");
		this.admitProject(mission.projectId);
		const result = this.store.knowledge.setLink(missionId, id(knowledgeId, "id"), expected, { linked: false }, actor);
		await this.store.durable();
		return result;
	}

	/** The supervised `knowledge` tool. The caller's project and identity come from its session, never arguments. */
	async call(
		caller: KnowledgeCaller,
		action: string,
		args: Record<string, unknown>,
		operationId?: string,
	): Promise<unknown> {
		if (args.projectId !== undefined) throw new Error("Knowledge uses this chat's own project");
		const projectId = caller.projectId;
		const author: KnowledgeAuthor = { type: "session", sessionId: caller.sessionId };
		const missionId = this.store.missionOf(caller.sessionId);
		const mission = missionId ? this.store.get(missionId) : undefined;
		const sameProjectMission = mission?.projectId === projectId ? mission : undefined;
		const coordinator = () => {
			if (!sameProjectMission || sameProjectMission.coordinatorSessionId !== caller.sessionId)
				throw new Conflict("Only this project's mission coordinator can link knowledge to its mission");
			return sameProjectMission.id;
		};
		const writer = () => {
			if (caller.readOnly) throw new Conflict("This chat is read-only; report findings for a writer to register");
		};
		switch (action) {
			case "list":
				if (args.linked === true && !sameProjectMission)
					throw new Error("linked applies only to a chat in a mission of this project");
				return this.durableRead(() =>
					this.list(projectId, {
						kind: args.kind,
						q: args.q,
						check: args.check,
						limit: args.limit,
						cursor: args.cursor,
						...(args.linked === true ? { missionId: sameProjectMission?.id } : {}),
					}),
				);
			case "get":
				return this.durableRead(() => {
					const detail = this.detail(projectId, args.id as string, args.revision);
					return sameProjectMission
						? { ...detail, missionLink: this.store.knowledge.link(sameProjectMission.id, detail.entry.id) }
						: detail;
				});
			case "revisions":
				return this.durableRead(() =>
					this.revisions(projectId, args.id as string, { cursor: args.cursor, limit: args.limit }),
				);
			case "create":
			case "append": {
				writer();
				const content = {
					operationId: typeof args.operationId === "string" ? args.operationId : operationId,
					expectedRevision: action === "create" ? 0 : args.expectedRevision,
					...(args.kind !== undefined ? { kind: args.kind } : {}),
					title: args.title,
					synopsis: args.synopsis,
					body: args.body,
					...(args.sources !== undefined ? { sources: args.sources } : {}),
					...(args.reason !== undefined ? { reason: args.reason } : {}),
				};
				const origin =
					action === "create"
						? {
								sessionId: caller.sessionId,
								...(sameProjectMission ? { missionId: sameProjectMission.id } : {}),
								...(sameProjectMission && args.taskId !== undefined
									? { taskId: this.store.resolveTask(sameProjectMission.id, args.taskId).id }
									: {}),
							}
						: undefined;
				if (action === "create" && args.taskId !== undefined && !sameProjectMission)
					throw new Error("taskId applies only to a chat in a mission of this project");
				return this.write(
					projectId,
					action === "create" ? undefined : (args.id as string),
					content,
					author,
					origin,
				);
			}
			case "link":
				writer();
				return this.link(
					coordinator(),
					args.id as string,
					{
						expectedLinkRevision: args.expectedLinkRevision,
						...(args.revision !== undefined ? { revision: args.revision } : { followCurrent: true }),
					},
					author,
				);
			case "unlink":
				writer();
				return this.unlink(coordinator(), args.id as string, args.expectedLinkRevision, author);
			default:
				throw new Error("Unknown knowledge action");
		}
	}
}
