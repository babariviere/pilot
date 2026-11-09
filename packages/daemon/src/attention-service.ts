/** Inactive host seam. No provider, scheduler, ask reply, approval or work-resume authority. */
import type {
	AssistanceOutput,
	AssistanceRecord,
	AssistanceRequest,
	AssistanceScope,
	AssistanceSubject,
	AttentionErrorCode,
	AttentionResult,
	HumanActionCommand,
	HumanActionCompletion,
	HumanActionContent,
	HumanActionIdentity,
	HumanActionRecord,
	ImmutableArtifactReference,
} from "@pilot/protocol";
import { type AttentionStore, attentionDigest } from "./attention-store.ts";
import { canonicalJSON } from "./operation-journal.ts";

export class AttentionError extends Error {
	readonly code: AttentionErrorCode;
	constructor(code: AttentionErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
function fail(code: AttentionErrorCode, message: string): never {
	throw new AttentionError(code, message);
}
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
function object(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
	if (
		!v ||
		typeof v !== "object" ||
		Array.isArray(v) ||
		required.some((k) => !Object.hasOwn(v, k)) ||
		Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
	)
		fail("invalid", "Unexpected fields");
}
function text(v: unknown, max = 8000): asserts v is string {
	if (typeof v !== "string" || !v.trim() || v.length > max) fail("invalid", "Expected nonempty limited text");
}
function uri(value: unknown, file = false): void {
	text(value, 2048);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		fail("invalid", "Expected an absolute reference URI");
	}
	if (
		parsed.username ||
		parsed.password ||
		(file
			? parsed.protocol !== "file:" || parsed.host !== "" || parsed.search !== "" || parsed.hash !== ""
			: parsed.protocol !== "https:")
	)
		fail("invalid", "Unsupported or credential-bearing reference URI");
}
function artifact(v: unknown): asserts v is ImmutableArtifactReference {
	object(v, ["kind", "sessionId", "artifactId", "revision", "sha256"]);
	if (
		v.kind !== "artifact" ||
		!identifier(v.sessionId) ||
		!identifier(v.artifactId) ||
		!positive(v.revision) ||
		!hash(v.sha256)
	)
		fail("invalid", "Expected exact immutable artifact revision");
}
function identity(v: unknown): asserts v is HumanActionIdentity {
	object(v, ["id", "revision", "digest"]);
	if (!identifier(v.id) || !positive(v.revision) || !hash(v.digest)) fail("invalid", "Invalid action identity");
}
function content(v: unknown): asserts v is HumanActionContent {
	object(v, [
		"projectId",
		"sessionId",
		"missionId",
		"action",
		"reason",
		"files",
		"destination",
		"completionRequirements",
	]);
	if (!identifier(v.projectId) || !identifier(v.sessionId) || (v.missionId !== null && !identifier(v.missionId)))
		fail("invalid", "Invalid origin");
	text(v.action);
	text(v.reason);
	if (!Array.isArray(v.files) || v.files.length > 16) fail("invalid", "Too many action files");
	for (const file of v.files) {
		if (file?.kind === "artifact") artifact(file);
		else {
			object(file, ["kind", "uri", "version", "sha256"]);
			if (file.kind !== "file" || !hash(file.sha256)) fail("invalid", "Expected pinned file bytes");
			uri(file.uri, true);
			text(file.version, 128);
		}
	}
	object(v.destination, ["uri", "targetId", "version"]);
	uri(v.destination.uri);
	text(v.destination.targetId, 256);
	text(v.destination.version, 128);
	if (
		!Array.isArray(v.completionRequirements) ||
		!v.completionRequirements.length ||
		v.completionRequirements.length > 16
	)
		fail("invalid", "Completion requirements are required");
	for (const requirement of v.completionRequirements) text(requirement, 1000);
	if (Buffer.byteLength(JSON.stringify(v)) > 32 * 1024) fail("invalid", "Action exceeds 32 KiB");
}
function request(v: unknown): asserts v is AssistanceRequest {
	object(v, ["requestId", "scope", "kind"], ["question"]);
	if (!identifier(v.requestId) || !["simpler", "context", "visual", "question"].includes(String(v.kind)))
		fail("invalid", "Invalid assistance request");
	if (v.kind === "question") text(v.question, 2000);
	else if (v.question !== undefined) fail("invalid", "Only inline questions have question text");
	object(v.scope, ["subject", "projectId", "eventId", "contentDigest", "authorityDigest"]);
	const s = v.scope;
	if (!identifier(s.projectId) || !positive(s.eventId) || !hash(s.contentDigest) || !hash(s.authorityDigest))
		fail("invalid", "Invalid assistance scope");
	if ((s.subject as AssistanceSubject)?.kind === "question") {
		object(s.subject, ["kind", "sessionId", "entryId"]);
		if (!identifier(s.subject.sessionId) || !positive(s.subject.entryId))
			fail("invalid", "Invalid question identity");
	} else {
		object(s.subject, ["kind", "missionId", "id"]);
		if (
			!["proposal", "binding_decision"].includes(String(s.subject.kind)) ||
			!identifier(s.subject.missionId) ||
			!identifier(s.subject.id)
		)
			fail("invalid", "Invalid mission subject");
	}
}
function command(v: unknown): asserts v is HumanActionCommand {
	if (!v || typeof v !== "object") fail("invalid", "Expected command");
	const kind = (v as HumanActionCommand).kind;
	if (kind === "create") {
		object(v, ["kind", "operationId", "id", "content"]);
		if (!identifier(v.id)) fail("invalid", "Invalid action ID");
		content(v.content);
	} else if (kind === "replace") {
		object(v, ["kind", "operationId", "expected", "content"]);
		identity(v.expected);
		content(v.content);
	} else if (kind === "complete") {
		object(v, ["kind", "operationId", "expected", "report"]);
		identity(v.expected);
		text(v.report);
	} else if (["progress", "defer", "resume", "cancel"].includes(kind)) {
		object(v, ["kind", "operationId", "expected", "progress"]);
		identity(v.expected);
		if (typeof v.progress !== "string" || v.progress.length > 8000) fail("invalid", "Invalid progress");
	} else fail("invalid", "Unsupported action command");
	if (!identifier((v as HumanActionCommand).operationId)) fail("invalid", "Invalid operation identity");
}

export interface AttentionDependencies {
	store: AttentionStore;
	/** Trusted source only: verifies current permissions, pending question/proposal or actual binding decision.
	 * Returns full exact source bytes and an event identity. Never resolves a historical ask as pending. */
	subject(subject: AssistanceSubject): { scope: AssistanceScope; source: string };
	/** Optional configured producer. No replay after entered, and no tool/approval capability is passed. */
	generate?(request: AssistanceRequest, source: string): Promise<AssistanceOutput>;
	/** Must read exact immutable bytes and digest; latest revision is not a substitute. */
	verifyArtifact?(ref: ImmutableArtifactReference): Promise<boolean>;
	/** Authenticated host identity, not a UI-provided actor flag. Must check origin/membership/current home.
	 * Agents may create/replace/cancel their own request. Only native user authority can report completion. */
	authorize(
		content: HumanActionContent,
		kind: HumanActionCommand["kind"] | "read",
	): { digest: string; actor: "user" | "agent" };
	/** Validate exact current files/destination/package version without publishing or other side effects. */
	verifyAction(content: HumanActionContent): Promise<boolean>;
}

export class AttentionService {
	private readonly deps: AttentionDependencies;
	constructor(deps: AttentionDependencies) {
		this.deps = deps;
	}
	private async result<T>(work: () => Promise<T>): Promise<AttentionResult<T>> {
		try {
			return { ok: true, value: await work() };
		} catch (e) {
			return {
				ok: false,
				error:
					e instanceof AttentionError
						? { code: e.code, message: e.message }
						: {
								code: "unknown",
								message: "Outcome unavailable; look up the exact identity, do not replay effects",
							},
			};
		}
	}
	private current(scope: AssistanceScope): string {
		const now = this.deps.subject(structuredClone(scope.subject));
		if (!same(scope, now.scope) || attentionDigest(now.source) !== scope.contentDigest)
			fail("stale", "Assistance source or authority changed");
		if (Buffer.byteLength(now.source) > 32 * 1024) fail("invalid", "Assistance source exceeds 32 KiB");
		return now.source;
	}
	prepare(subject: AssistanceSubject): AttentionResult<AssistanceScope> {
		try {
			const { scope } = this.deps.subject(structuredClone(subject));
			request({ requestId: "prepare", scope, kind: "context" });
			this.current(scope);
			return { ok: true, value: structuredClone(scope) };
		} catch (e) {
			return {
				ok: false,
				error:
					e instanceof AttentionError
						? { code: e.code, message: e.message }
						: { code: "unavailable", message: "Assistance source unavailable" },
			};
		}
	}
	assist(input: AssistanceRequest): Promise<AttentionResult<AssistanceRecord>> {
		return this.result(async () => {
			request(input);
			const req = structuredClone(input);
			const source = this.current(req.scope);
			if (this.deps.store.assistance(req.requestId)) fail("conflict", "Request already entered; use exact lookup");
			if (!this.deps.store.capacity())
				fail("unavailable", "Attention record capacity reached (4096); no records were evicted");
			if (!this.deps.generate) fail("unavailable", "No assistance producer configured");
			this.deps.store.enter(req);
			await this.deps.store.durable();
			try {
				this.current(req.scope);
				const output = structuredClone(await this.deps.generate(structuredClone(req), source));
				if (output.kind !== req.kind) fail("invalid", "Assistance result kind changed");
				if (output.kind === "visual") {
					object(output, ["kind", "explanation", "artifact"]);
					text(output.explanation);
					artifact(output.artifact);
					if (!this.deps.verifyArtifact || !(await this.deps.verifyArtifact(output.artifact)))
						fail("unavailable", "Exact visual revision unavailable");
				} else if (output.kind === "question") {
					object(output, ["kind", "question", "answer"]);
					text(output.answer);
					if (output.question !== req.question) fail("invalid", "Inline question changed");
				} else {
					object(output, ["kind", "text"]);
					text(output.text);
				}
				this.current(req.scope);
				const record: AssistanceRecord = { request: req, state: "ready", output };
				this.deps.store.settle(record);
				await this.deps.store.durable();
				this.current(req.scope);
				return record;
			} catch (e) {
				if (this.deps.store.assistance(req.requestId)?.state === "entered") {
					this.deps.store.settle({
						request: req,
						state: e instanceof AttentionError && e.code === "stale" ? "stale" : "failed",
					});
					await this.deps.store.durable();
				}
				throw e;
			}
		});
	}
	lookupAssistance(input: AssistanceRequest): Promise<AttentionResult<AssistanceRecord>> {
		return this.result(async () => {
			request(input);
			const req = structuredClone(input);
			this.current(req.scope);
			const row = this.deps.store.assistance(req.requestId);
			if (!row) fail("unknown", "No exact assistance receipt; do not regenerate automatically");
			if (!same(row.request, req)) fail("conflict", "Request identity reused");
			if (
				row.output?.kind === "visual" &&
				(!this.deps.verifyArtifact || !(await this.deps.verifyArtifact(structuredClone(row.output.artifact))))
			)
				fail("unavailable", "Exact visual revision unavailable");
			await this.deps.store.durable();
			this.current(req.scope);
			if (!same(row, this.deps.store.assistance(req.requestId))) fail("unknown", "Assistance changed during lookup");
			if (row.state === "entered") fail("unknown", "Generation entered without a settled receipt; never replay");
			return row;
		});
	}
	private authorize(value: HumanActionContent, kind: HumanActionCommand["kind"] | "read"): string {
		const authority = this.deps.authorize(structuredClone(value), kind);
		if (!hash(authority.digest)) fail("unavailable", "Current authority identity unavailable");
		if (["complete", "defer", "resume", "progress"].includes(kind) && authority.actor !== "user")
			fail("forbidden", "Explicit native user authority required");
		return authority.digest;
	}
	private exact(expected: HumanActionIdentity): HumanActionRecord {
		const row = this.deps.store.humanAction(expected.id);
		if (!row) fail("not_found", "Human action not found");
		if (row.revision !== expected.revision || row.digest !== expected.digest) fail("stale", "Human action changed");
		return row;
	}
	mutate(input: HumanActionCommand): Promise<AttentionResult<HumanActionRecord>> {
		return this.result(async () => {
			command(input);
			const cmd = structuredClone(input);
			if (this.deps.store.operation(cmd.operationId))
				fail("conflict", "Operation already recorded; use exact lookup");
			const before = cmd.kind === "create" ? undefined : this.exact(cmd.expected);
			if (before && (before.state === "completed" || before.state === "cancelled"))
				fail("stale", "Human action is terminal");
			const value = cmd.kind === "create" || cmd.kind === "replace" ? cmd.content : before!.content;
			if (
				before &&
				!same(
					[value.projectId, value.sessionId, value.missionId],
					[before.content.projectId, before.content.sessionId, before.content.missionId],
				)
			)
				fail("invalid", "Replacement cannot change origin");
			const authority = this.authorize(value, cmd.kind);
			if (cmd.kind === "create" || cmd.kind === "replace" || cmd.kind === "complete") {
				if (!(await this.deps.verifyAction(structuredClone(value))))
					fail("stale", "Exact action files or destination changed");
			}
			if (this.authorize(value, cmd.kind) !== authority) fail("stale", "Action authority changed");
			const record = this.deps.store.write(cmd, () => {
				if (!this.deps.store.capacity())
					fail("unavailable", "Attention record capacity reached (4096); no records were evicted");
				if (cmd.kind === "create") {
					if (this.deps.store.humanAction(cmd.id)) fail("conflict", "Human action ID already exists");
				} else this.exact(cmd.expected);
				return {
					id: cmd.kind === "create" ? cmd.id : cmd.expected.id,
					revision: (before?.revision ?? 0) + 1,
					digest: attentionDigest(value),
					content: value,
					state:
						cmd.kind === "complete"
							? "completed"
							: cmd.kind === "cancel"
								? "cancelled"
								: cmd.kind === "defer"
									? "deferred"
									: cmd.kind === "progress"
										? before!.state
										: "pending",
					progress: "progress" in cmd ? cmd.progress : cmd.kind === "replace" ? "" : (before?.progress ?? ""),
					completion:
						cmd.kind === "complete"
							? { operationId: cmd.operationId, report: cmd.report, source: "user_report" }
							: null,
				};
			});
			await this.deps.store.durable();
			if (this.authorize(value, cmd.kind) !== authority)
				fail("unknown", "Authority changed after write; look up receipt");
			if (!same(record, this.deps.store.humanAction(record.id)))
				fail("unknown", "Action changed after write; look up receipt");
			return record;
		});
	}
	/** Passive exact receipt lookup. A historical receipt does not release a newer dependency. */
	lookupOperation(
		input: HumanActionCommand,
	): Promise<AttentionResult<{ record: HumanActionRecord; current: boolean }>> {
		return this.result(async () => {
			command(input);
			const cmd = structuredClone(input);
			const row = this.deps.store.operation(cmd.operationId);
			if (!row) fail("unknown", "No exact completion receipt; never infer success or replay external work");
			if (!same(row.command, cmd)) fail("conflict", "Operation identity reused");
			const authority = this.authorize(row.record.content, "read");
			await this.deps.store.durable();
			if (this.authorize(row.record.content, "read") !== authority)
				fail("unknown", "Authority changed during lookup");
			return { record: row.record, current: same(row.record, this.deps.store.humanAction(row.record.id)) };
		});
	}
	read(expected: HumanActionIdentity): Promise<AttentionResult<HumanActionRecord>> {
		return this.result(async () => {
			identity(expected);
			const ref = structuredClone(expected);
			const row = this.exact(ref);
			const authority = this.authorize(row.content, "read");
			await this.deps.store.durable();
			this.exact(ref);
			if (this.authorize(row.content, "read") !== authority) fail("unknown", "Authority changed during read");
			return row;
		});
	}
	/** Exact durable user-report gate only. Consumers must separately check current execution authority.
	 * No wake, ask reply, tool call, scheduler admission or retry is performed here. */
	completion(expected: HumanActionIdentity, operationId: string): Promise<AttentionResult<HumanActionCompletion>> {
		return this.result(async () => {
			identity(expected);
			if (!identifier(operationId)) fail("invalid", "Invalid completion operation");
			const ref = structuredClone(expected);
			const row = this.deps.store.operation(operationId);
			if (!row) fail("unknown", "Exact completion receipt unavailable; do not replay");
			if (row.command.kind !== "complete" || !same(row.command.expected, ref))
				fail("stale", "Completion belongs to another request revision");
			const record = row.record;
			const authority = this.authorize(record.content, "read");
			if (!same(record, this.deps.store.humanAction(record.id))) fail("stale", "Completion is no longer current");
			if (!(await this.deps.verifyAction(structuredClone(record.content))))
				fail("stale", "Completion resources changed");
			await this.deps.store.durable();
			if (
				this.authorize(record.content, "read") !== authority ||
				!same(record, this.deps.store.humanAction(record.id))
			)
				fail("unknown", "Completion changed while checking");
			return {
				request: ref,
				completed: { id: record.id, revision: record.revision, digest: record.digest },
				operationId,
				source: "user_report",
			};
		});
	}
}
