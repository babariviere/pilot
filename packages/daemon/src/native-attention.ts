/** Native capability ingress. Reuses attention receipts and ordinary input admission, never auto-resumes. */
import { createHash } from "node:crypto";
import type {
	AgentQuestion,
	AssistanceRequest,
	AssistanceSubject,
	AttentionResult,
	DurableOperation,
	HumanActionContent,
	HumanActionRecord,
	ImmutableArtifactReference,
	NativeAttentionEnvelope,
	NativeAttentionQuestion,
	NativeAttentionRead,
	NativeAttentionRequest,
	OperationHost,
} from "@pilot/protocol";
import { assistanceSource, nativeQuestionAssistance } from "./assistance-source.ts";
import { attentionURL, verifyAttentionResources } from "./attention-resources.ts";
import { ReadOnlyAttentionExecutor } from "./attention-executor.ts";
import { AttentionError, AttentionService } from "./attention-service.ts";
import { attentionDigest } from "./attention-store.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, sameHost } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

interface Dependencies {
	home: OperationHost;
	store: MissionStore;
	projects: ProjectStore;
	sessions: SessionManager;
	journal: OperationJournal;
	/** No callback, UI flag or default model can qualify help. Not installed by daemon startup. */
	executor?: ReadOnlyAttentionExecutor;
}
const equal = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(v);
function fail(code: "invalid" | "forbidden" | "stale" | "unknown" | "unavailable", message: string): never {
	throw new AttentionError(code, message);
}
function keys(v: unknown, required: string[]) {
	if (
		!v ||
		typeof v !== "object" ||
		Array.isArray(v) ||
		Object.keys(v).some((k) => !required.includes(k)) ||
		required.some((k) => !Object.hasOwn(v, k))
	)
		fail("invalid", "Expected exact native attention fields");
}
function result<T>(work: () => Promise<T>): Promise<AttentionResult<T>> {
	return work().then(
		(value) => ({ ok: true as const, value }),
		(e) => ({
			ok: false as const,
			error: {
				code: e instanceof AttentionError ? e.code : "unknown",
				message:
					e instanceof AttentionError
						? e.message
						: "Attention outcome unavailable; look up the exact saved intent",
			},
		}),
	);
}
const value = <T>(r: AttentionResult<T>): T => {
	if (!r.ok) throw new AttentionError(r.error.code, r.error.message);
	return r.value;
};

export class NativeAttention {
	private readonly deps: Dependencies;
	private closed = false;
	private readonly pending = new Set<Promise<AttentionResult<unknown>>>();
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	/** Join admission, provider, accounting and final attention durability, not only a cancel ACK. */
	async close(): Promise<void> {
		this.closed = true;
		await this.deps.executor?.close();
		await Promise.allSettled([...this.pending]);
	}
	/** Authentication is performed by the caller before this exact home/project check. */
	envelope(input: NativeAttentionEnvelope) {
		if (
			input?.version !== 1 ||
			!id(input.projectId) ||
			!input.home ||
			input.home.hostId !== "local" ||
			!sameHost(input.home, this.deps.home)
		)
			fail("forbidden", "Current native home and project required");
		this.deps.projects.require(input.projectId);
	}
	private session(projectId: string, sessionId: string) {
		const project = this.deps.projects.require(projectId),
			session = this.deps.sessions.get(sessionId);
		if (
			!session ||
			session.projectId !== projectId ||
			session.archivedAt ||
			session.continuedTo ||
			session.role ||
			session.control ||
			session.mode === "ask"
		)
			fail("forbidden", "Current writable same-project origin required");
		const member = this.deps.store.membership(sessionId);
		if (
			session.missionId &&
			(!member?.active ||
				member.missionId !== session.missionId ||
				this.deps.store.require(session.missionId).projectId !== projectId)
		)
			fail("forbidden", "Current origin membership required");
		return { project, session, member };
	}
	private authority(projectId: string, sessionId: string) {
		const { project, session: s, member } = this.session(projectId, sessionId);
		return attentionDigest({
			home: this.deps.home,
			...(this.deps.executor instanceof ReadOnlyAttentionExecutor
				? { helpConfiguration: this.deps.executor.configurationDigest(projectId) }
				: {}),
			project,
			member: member ?? null,
			session: {
				id: s.id,
				projectId: s.projectId,
				cwd: s.cwd,
				mode: s.mode ?? "build",
				inputGeneration: s.inputGeneration ?? 0,
				missionId: s.missionId ?? null,
				sleepPaused: s.sleepPaused ?? false,
				offlinePaused: s.offlinePaused ?? false,
				subscriptionPause: s.subscriptionPause ?? null,
				outcome: s.outcome ?? null,
				outcomeAt: s.outcomeAt ?? null,
			},
			mission: s.missionId
				? {
						mission: this.deps.store.require(s.missionId),
						control: this.deps.store.controls.fenceCurrent(s.missionId),
					}
				: null,
		});
	}
	private authorize(projectId: string, content: HumanActionContent) {
		if (
			content.projectId !== projectId ||
			!equal(this.session(projectId, content.sessionId).session.missionId ?? null, content.missionId)
		)
			fail("forbidden", "Human action origin changed");
		return this.authority(projectId, content.sessionId);
	}
	private async artifact(projectId: string, ref: ImmutableArtifactReference) {
		const pin = this.authority(projectId, ref.sessionId);
		const stored = await this.deps.sessions.readStoredArtifactRevision(ref.sessionId, ref.artifactId, ref.revision);
		return (
			this.authority(projectId, ref.sessionId) === pin &&
			createHash("sha256").update(stored.bytes).digest("hex") === ref.sha256
		);
	}
	private service(projectId: string, question?: NativeAttentionQuestion) {
		const subject = assistanceSource(
			this.deps.store,
			(project, mission) => {
				if (project !== projectId) fail("forbidden", "Decision project changed");
				const owner = this.deps.store.require(mission).coordinatorSessionId;
				if (!owner) fail("unavailable", "Decision owner unavailable");
				return this.authority(projectId, owner);
			},
			nativeQuestionAssistance((sessionId) => {
				if (
					!question ||
					question.session.id !== sessionId ||
					question.scope.authorityDigest !== this.authority(projectId, sessionId)
				)
					return undefined;
				return {
					projectId,
					sessionId,
					entryId: question.scope.subject.kind === "question" ? question.scope.subject.entryId : 0,
					eventId: question.scope.eventId,
					questionPending: true,
					stopped: false,
					question: question.question,
					authorityDigest: question.scope.authorityDigest,
				};
			}),
		);
		return new AttentionService({
			store: this.deps.store.attention,
			subject,
			produce:
				this.deps.executor instanceof ReadOnlyAttentionExecutor
					? (request, source) => this.produce(projectId, request, source)
					: undefined,
			authorize: (content) => ({ digest: this.authorize(projectId, content), actor: "user" }),
			verifyArtifact: (ref) => this.artifact(projectId, ref),
			verifyAction: async (content) => {
				const pin = this.authorize(projectId, content),
					root = this.session(projectId, content.sessionId).session.cwd;
				const valid = await verifyAttentionResources(root, content, (ref) => this.artifact(projectId, ref));
				return valid && pin === this.authorize(projectId, content);
			},
		});
	}
	private async produce(projectId: string, request: AssistanceRequest, source: string) {
		const controller = new AbortController();
		const check = () => this.executionAuthority(projectId, request);
		const changed = () => {
			try {
				check();
			} catch {
				controller.abort();
			}
		};
		const stops = [
			this.deps.sessions.onChange(changed),
			this.deps.projects.onChange(changed),
			this.deps.store.onChange(changed),
		];
		try {
			return await this.deps.executor!.produce(request, source, {
				signal: controller.signal,
				assertCurrent: check,
				revalidate: async () => {
					check();
					const current = await this.currentQuestion(projectId, request.scope.subject);
					if (current && !equal(current.scope, request.scope)) fail("stale", "Help question changed");
					const now = this.service(projectId, current).prepare(request.scope.subject);
					if (!equal(value(now), request.scope)) fail("stale", "Help source changed");
				},
			});
		} finally {
			for (const stop of stops) stop();
		}
	}
	private executionAuthority(projectId: string, request: AssistanceRequest): void {
		const subject = request.scope.subject;
		const owner =
			subject.kind === "question"
				? subject.sessionId
				: this.deps.store.require(subject.missionId).coordinatorSessionId;
		if (!owner || request.scope.projectId !== projectId) fail("forbidden", "Current help owner required");
		if (this.authority(projectId, owner) !== request.scope.authorityDigest) fail("stale", "Help actor changed");
		const { session } = this.session(projectId, owner);
		if (
			session.outcome === "stopped" ||
			session.sleepPaused ||
			session.offlinePaused ||
			session.subscriptionPause ||
			(session.missionId && this.deps.store.controls.fenceCurrent(session.missionId).held)
		)
			fail("forbidden", "Attention work is stopped or paused");
		if (subject.kind !== "question" && !equal(value(this.service(projectId).prepare(subject)), request.scope))
			fail("stale", "Help decision or proposal changed");
	}
	private async question(projectId: string, sessionId: string): Promise<NativeAttentionQuestion | undefined> {
		const { session: s } = this.session(projectId, sessionId),
			authorityDigest = this.authority(projectId, sessionId);
		if (s.outcome === "stopped") return undefined;
		const q = await this.deps.sessions.pendingQuestion(sessionId);
		if (authorityDigest !== this.authority(projectId, sessionId))
			fail("stale", "Question authority changed during read");
		if (!q) return undefined;
		const data = q.data as unknown as AgentQuestion;
		if (
			!data ||
			typeof data.question !== "string" ||
			!Array.isArray(data.options) ||
			data.options.length > 9 ||
			data.databaseAccess !== undefined ||
			Buffer.byteLength(JSON.stringify(data)) > 32768
		)
			return undefined;
		return {
			scope: {
				subject: { kind: "question", sessionId, entryId: q.id },
				projectId,
				eventId: q.id,
				contentDigest: attentionDigest(JSON.stringify(data)),
				authorityDigest,
			},
			question: data,
			session: { id: s.id, title: s.title, missionId: s.missionId, inputGeneration: s.inputGeneration ?? 0 },
		};
	}
	private async currentQuestion(projectId: string, subject: AssistanceSubject) {
		if (subject.kind !== "question") return undefined;
		const q = await this.question(projectId, subject.sessionId);
		if (!q || !equal(q.scope.subject, subject)) fail("stale", "That ordinary question is no longer current");
		return q;
	}
	private async read(projectId: string): Promise<NativeAttentionRead> {
		const project = canonicalJSON(this.deps.projects.require(projectId));
		if (!this.deps.store.attention.actionsReadable(projectId))
			fail("unavailable", "Attention read exceeds 4096 records or 8 MiB; nothing was truncated or evicted");
		const candidates = this.deps.sessions
			.list()
			.filter(
				(s) =>
					s.projectId === projectId &&
					!s.archivedAt &&
					!s.role &&
					!s.control &&
					!s.continuedTo &&
					s.mode !== "ask" &&
					(s.outcome === "question" || s.attentionReason?.kind === "asks"),
			);
		if (candidates.length > 4096) fail("unavailable", "Attention read capacity reached (4096); nothing was evicted");
		const questions: NativeAttentionQuestion[] = [];
		// Limit cold-reader concurrency rather than fan out one SQLite worker per chat.
		for (const s of candidates) {
			const q = await this.question(projectId, s.id);
			if (q) questions.push(q);
		}
		const actions: NativeAttentionRead["actions"] = [];
		for (const record of this.deps.store.attention.actions(projectId)) {
			// Inaccessible retained records are not exposed through a receipt/read escape.
			const authorityDigest = this.authorize(projectId, record.content);
			value(await this.service(projectId).read({ id: record.id, revision: record.revision, digest: record.digest }));
			actions.push({ record, authorityDigest });
		}
		await this.deps.store.durable();
		if (canonicalJSON(this.deps.projects.require(projectId)) !== project)
			fail("stale", "Selected project changed during attention read");
		for (const q of questions)
			if (!equal(q, await this.question(projectId, q.session.id)))
				fail("stale", "Question changed during attention read");
		for (const a of actions)
			if (
				a.authorityDigest !== this.authorize(projectId, a.record.content) ||
				!equal(a.record, this.deps.store.attention.humanAction(a.record.id))
			)
				fail("stale", "Action changed during attention read");
		return {
			version: 1,
			projectId,
			questions,
			actions,
			capabilities: {
				help:
					this.deps.executor instanceof ReadOnlyAttentionExecutor && this.deps.executor.available(projectId)
						? 1
						: "unavailable",
				continuation: "unavailable",
			},
		};
	}
	/** Receipt mode is lookup-only, including a request that never reached the daemon. */
	dispatch(input: NativeAttentionRequest, lookup = false): Promise<AttentionResult<unknown>> {
		if (this.closed)
			return Promise.resolve({ ok: false, error: { code: "unavailable", message: "Attention is closed" } });
		const pending = this.dispatchEntered(input, lookup);
		this.pending.add(pending);
		void pending.finally(() => this.pending.delete(pending)).catch(() => {});
		return pending;
	}
	private dispatchEntered(input: NativeAttentionRequest, lookup: boolean): Promise<AttentionResult<unknown>> {
		return result(async () => {
			this.envelope(input);
			const base = ["version", "home", "projectId", "kind"];
			if (input.kind === "read") {
				keys(input, base);
				return this.read(input.projectId);
			}
			if (input.kind === "action") {
				keys(input, [...base, "authorityDigest", "command"]);
				const cmd = input.command,
					service = this.service(input.projectId);
				if (lookup) return value(await service.lookupOperation(cmd));
				if (this.deps.store.attention.operation(cmd.operationId)) {
					value(await service.lookupOperation(cmd));
					throw new AttentionError("conflict", "Operation already recorded; use exact lookup");
				}
				const content =
					cmd.kind === "create" || cmd.kind === "replace"
						? cmd.content
						: value(await service.read(cmd.expected)).content;
				if (this.authorize(input.projectId, content) !== input.authorityDigest)
					fail("stale", "Shown action authority changed");
				return value(await service.mutate(cmd));
			}
			if (input.kind === "help") {
				keys(input, [...base, "request"]);
				const q = await this.currentQuestion(input.projectId, input.request.scope.subject),
					service = this.service(input.projectId, q);
				const record = value(
					await (lookup ? service.lookupAssistance(input.request) : service.assist(input.request)),
				);
				if (q && !equal(q, await this.question(input.projectId, q.session.id)))
					fail("stale", "Help source changed");
				return record;
			}
			if (input.kind === "resource") {
				keys(input, [...base, "expected", "authorityDigest"]);
				const record = value(await this.service(input.projectId).read(input.expected));
				if (input.authorityDigest !== this.authorize(input.projectId, record.content))
					fail("stale", "Shown resource authority changed");
				const root = this.session(input.projectId, record.content.sessionId).session.cwd;
				if (!(await verifyAttentionResources(root, record.content, (ref) => this.artifact(input.projectId, ref))))
					fail("stale", "Action resources changed");
				value(await this.service(input.projectId).read(input.expected));
				if (input.authorityDigest !== this.authorize(input.projectId, record.content))
					fail("stale", "Resource authority changed");
				// This grants navigation to this destination only. It reports no external action.
				return { expected: input.expected, url: attentionURL(record.content.destination.uri) };
			}
			fail("invalid", "Unsupported native attention purpose");
		});
	}
	/** Exact human-report gate for future consumers. No dispatch, wake, approval or permission grant. */
	completion(projectId: string, request: Pick<HumanActionRecord, "id" | "revision" | "digest">, operationId: string) {
		return this.service(projectId).completion(request, operationId);
	}
	private answerEnvelope(op: DurableOperation) {
		if (
			op.kind !== "attention-answer" ||
			op.origin?.hostId !== "local" ||
			!sameHost(op.origin, this.deps.home) ||
			!sameHost(op.destination, this.deps.home) ||
			op.bindingGeneration !== 1
		)
			throw new OperationRejected("Exact native attention envelope required");
		const payload = JSON.parse(op.payload) as {
			projectId: string;
			scope: AssistanceRequest["scope"];
			message: string;
		};
		keys(payload, ["projectId", "scope", "message"]);
		this.session(payload.projectId, op.targetId);
		if (
			payload.scope?.subject?.kind !== "question" ||
			payload.scope.subject.sessionId !== op.targetId ||
			payload.scope.projectId !== payload.projectId ||
			typeof payload.message !== "string" ||
			!payload.message.trim() ||
			payload.message.length > 8000
		)
			throw new OperationRejected("Exact current ordinary question required");
		return payload;
	}
	async lookupAnswer(op: DurableOperation) {
		this.answerEnvelope(op);
		const r = await this.deps.journal.lookup(op);
		this.answerEnvelope(op);
		return r;
	}
	/** Re-entry can only discover an already accepted exact input. Unknown is never sent again. */
	async answer(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		const p = this.answerEnvelope(op);
		if (!firstEntry) {
			if (await this.deps.sessions.lookupNativeAttentionInput(op.targetId, op.operationId))
				return { sessionId: op.targetId };
			throw new Error("Exact input acknowledgement unavailable; never replay");
		}
		const q = await this.currentQuestion(p.projectId, p.scope.subject);
		if (!q || !equal(q.scope, p.scope) || op.bindingId !== attentionDigest(p.scope))
			throw new OperationRejected("Question revision or authority changed");
		const session = this.session(p.projectId, op.targetId).session;
		if (
			session.sleepPaused ||
			session.offlinePaused ||
			session.subscriptionPause ||
			(session.missionId && this.deps.store.controls.fenceCurrent(session.missionId).held)
		)
			throw new OperationRejected("Question work is currently held");
		await this.deps.sessions.sendDurable(op.targetId, p.message, "followUp", op.operationId, {
			questionReplyId: q.scope.subject.kind === "question" ? q.scope.subject.entryId : undefined,
			inputGeneration: q.session.inputGeneration,
		});
		return { sessionId: op.targetId };
	}
}
