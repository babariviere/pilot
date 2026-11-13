/** Native-user output inspection. Never consumes reviewer allocations or executes saved source. */
import { createHash } from "node:crypto";
import { ArtifactNotFound, StoredArtifactTooLarge } from "@pilot/artifacts";
import type {
	ArtifactKind,
	DeliveredArtifact,
	DeliveredArtifactRequest,
	ProjectArtifact,
	ProjectArtifactRequest,
	SavedArtifactContent,
} from "@pilot/protocol";
import { redactDiagnosticText } from "./diagnostic-redaction.ts";
import { Conflict, NotFound } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, OperationRejected } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";
import type { UserVerifications } from "./user-verification.ts";

const id = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const uuid = (s: unknown): s is string =>
	typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);

type Stored = Awaited<ReturnType<SessionManager["readCapturedArtifactRevision"]>>;

/** Reads one numbered saved container. Failures become a reason, never another revision. */
async function capture(
	sessions: Pick<SessionManager, "readCapturedArtifactRevision">,
	sessionId: string,
	artifactId: string,
	revision: number,
): Promise<{ stored?: Stored; reason?: "missing" | "oversize" | "invalid" }> {
	try {
		return { stored: await sessions.readCapturedArtifactRevision(sessionId, artifactId, revision) };
	} catch (e) {
		return {
			reason:
				e instanceof StoredArtifactTooLarge ? "oversize" : e instanceof ArtifactNotFound ? "missing" : "invalid",
		};
	}
}

/**
 * The inert answer for one captured container: its text, or why it is held back.
 * Images never carry bytes; oversize and possible secrets are never cut or shown.
 */
function describe(
	a: Stored["artifact"],
	bytes: Stored["bytes"],
	title: string,
	knownSecrets: readonly string[],
): { metadata: { title: string; kind: ArtifactKind }; content: SavedArtifactContent } {
	const metadata = { title, kind: a.kind };
	if (a.kind === "image") return { metadata, content: { state: "unavailable", reason: "unsupported" } };
	if (Buffer.byteLength(a.source) > 512 * 1024)
		return { metadata, content: { state: "unavailable", reason: "oversize" } };
	if (
		redactDiagnosticText(a.source) !== a.source ||
		title !== a.title ||
		knownSecrets.some((s) => s && (a.source.includes(s) || a.title.includes(s)))
	)
		return { metadata: { ...metadata, title: "Artifact" }, content: { state: "unavailable", reason: "redacted" } };
	return {
		metadata,
		content: {
			state: "text",
			source: a.source,
			containerSha256: createHash("sha256").update(bytes).digest("hex"),
			containerBytes: bytes.byteLength,
		},
	};
}

interface Dependencies {
	store: MissionStore;
	projects: ProjectStore;
	sessions: Pick<SessionManager, "get" | "onChange" | "readCapturedArtifactRevision" | "artifacts">;
	verifications: UserVerifications;
}
export class DeliveredArtifacts {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}

	async read(request: DeliveredArtifactRequest, knownSecrets: readonly string[] = []): Promise<DeliveredArtifact> {
		// Snapshot before any await, including subject validation in the canonical projection.
		const r = structuredClone(request);
		if (
			!r ||
			Object.keys(r).sort().join() !==
				"artifactId,deliveryId,ownerSessionId,revision,sourceSessionId,subject,targetId" ||
			!hash(r.targetId) ||
			!hash(r.deliveryId) ||
			(r.ownerSessionId !== null && !id(r.ownerSessionId)) ||
			!id(r.sourceSessionId) ||
			typeof r.artifactId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.artifactId) ||
			!Number.isSafeInteger(r.revision) ||
			r.revision < 1
		)
			throw new OperationRejected("Exact delivered artifact pin required");
		const { store, sessions, projects, verifications } = this.deps;
		const safeTitle = (title: string) =>
			knownSecrets.some((s) => s && title.includes(s)) ? "Artifact" : redactDiagnosticText(title);
		const observe = () => {
			const page = verifications.readNow(r.subject);
			if (
				r.subject.kind !== "task" ||
				page.targetId !== r.targetId ||
				page.deliveryId !== r.deliveryId ||
				page.ownerSessionId !== r.ownerSessionId
			)
				throw new Conflict("Delivered artifact selection changed");
			const links = page.artifacts.filter((a) => a.artifactId === r.artifactId);
			const link = links.find((a) => a.sessionId === r.sourceSessionId && a.revision === r.revision);
			if (!link || links.some((a) => a.sessionId !== r.sourceSessionId))
				throw new Conflict("Exact delivered artifact link unavailable");
			for (const actor of new Set([r.sourceSessionId, ...(r.ownerSessionId ? [r.ownerSessionId] : [])])) {
				if (
					sessions.get(actor)?.projectId !== r.subject.projectId ||
					store.missionOf(actor) !== r.subject.missionId
				)
					throw new OperationRejected("Delivered artifact source membership changed");
			}
			return { link, definitionRevision: store.sharedDefinitionRevision(r.subject.taskId) };
		};
		await store.durable();
		const before = observe();
		let changed = false;
		// Capture ABA across source I/O, not just equal-looking before/after records.
		const offMission = store.onChange((mission) => {
			if (r.subject.kind === "task" && mission === r.subject.missionId) changed = true;
		});
		const offSession = sessions.onChange((s) => {
			if (s.id === r.sourceSessionId || s.id === r.ownerSessionId) changed = true;
		});
		const offProject = projects.onChange(() => {
			changed = true;
		});
		try {
			const { stored, reason } = await capture(sessions, r.sourceSessionId, r.artifactId, r.revision);
			if (changed || canonicalJSON(observe()) !== canonicalJSON(before))
				throw new Conflict("Delivered artifact access changed during read");
			const result: DeliveredArtifact = {
				version: 1,
				reference: r,
				metadata: { title: safeTitle(before.link.title), kind: before.link.kind },
				rendering: "unsupported",
				content: { state: "unavailable", reason: reason ?? "unsupported" },
			};
			if (!stored) return result;
			const a = stored.artifact;
			if (
				a.id !== r.artifactId ||
				a.revision !== r.revision ||
				a.sessionId !== r.sourceSessionId ||
				a.projectId !== r.subject.projectId ||
				a.kind !== before.link.kind
			)
				throw new Conflict("Captured artifact identity changed");
			return { ...result, ...describe(a, stored.bytes, safeTitle(a.title), knownSecrets) };
		} finally {
			offMission();
			offSession();
			offProject();
		}
	}

	/**
	 * One exact saved revision made by a chat that belongs to `projectId` now.
	 * Read-only text with the same limits and redaction as a delivered output;
	 * never a latest-revision fallback, preview preparation or execution.
	 */
	async readProject(request: ProjectArtifactRequest, knownSecrets: readonly string[] = []): Promise<ProjectArtifact> {
		const r = structuredClone(request);
		if (
			!r ||
			Object.keys(r).sort().join() !== "artifactId,projectId,revision,sourceSessionId" ||
			!id(r.projectId) ||
			!id(r.sourceSessionId) ||
			!uuid(r.artifactId) ||
			!Number.isSafeInteger(r.revision) ||
			r.revision < 1
		)
			throw new OperationRejected("Exact project artifact revision required");
		const { sessions, projects } = this.deps;
		const safeTitle = (title: string) =>
			knownSecrets.some((s) => s && title.includes(s)) ? "Artifact" : redactDiagnosticText(title);
		const observe = async () => {
			projects.require(r.projectId);
			if (sessions.get(r.sourceSessionId)?.projectId !== r.projectId)
				throw new OperationRejected("Artifact source is not part of this project");
			const summary = (await sessions.artifacts(r.sourceSessionId)).find((a) => a.id === r.artifactId);
			if (!summary || summary.revision < r.revision) throw new NotFound("Unknown artifact revision");
			return { kind: summary.kind, title: summary.title };
		};
		const before = await observe();
		let changed = false;
		const offSession = sessions.onChange((s) => {
			if (s.id === r.sourceSessionId) changed = true;
		});
		const offProject = projects.onChange(() => {
			changed = true;
		});
		try {
			const { stored, reason } = await capture(sessions, r.sourceSessionId, r.artifactId, r.revision);
			await observe();
			if (changed) throw new Conflict("Project artifact access changed during read");
			const result: ProjectArtifact = {
				version: 1,
				reference: r,
				metadata: { title: safeTitle(before.title), kind: before.kind },
				rendering: "unsupported",
				content: { state: "unavailable", reason: reason ?? "unsupported" },
			};
			if (!stored) return result;
			const a = stored.artifact;
			if (
				a.id !== r.artifactId ||
				a.revision !== r.revision ||
				a.sessionId !== r.sourceSessionId ||
				a.projectId !== r.projectId
			)
				throw new Conflict("Captured artifact identity changed");
			return { ...result, ...describe(a, stored.bytes, safeTitle(a.title), knownSecrets) };
		} finally {
			offSession();
			offProject();
		}
	}
}
