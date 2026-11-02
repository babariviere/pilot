/**
 * Project-owned research and component documentation. The project is canonical; missions link subsets and never own
 * an entry. Reads are passive: they return stored bodies, links and check metadata only.
 */
export type KnowledgeKind = "investigation" | "component";
export type KnowledgeRelation = "supports" | "supplements" | "supersedes" | "documents";

/** Typed locators to existing sources. Labels are display text supplied by the writer, never inferred. */
export type KnowledgeSource =
	| {
			type: "repository";
			/** Relative to the project root. Local opening may be unavailable; the entry body stays readable. */
			path: string;
			/** Exact commit when known. Live or dirty observations say so instead of inventing one. */
			commit?: string;
			dirty?: boolean;
			sha256?: string;
			section?: string;
			observedAt?: string;
			label?: string;
	  }
	| { type: "artifact"; sessionId: string; artifactId: string; revision: number; observedAt?: string; label?: string }
	| {
			type: "mission";
			missionId: string;
			decisionId?: string;
			taskId?: string;
			eventId?: number;
			briefRevision?: number;
			/** Historical quotation, not current authority. */
			quote?: string;
			observedAt?: string;
			label?: string;
	  }
	| { type: "web"; url: string; accessedAt: string; publishedAt?: string; excerpt?: string; label?: string }
	| {
			type: "knowledge";
			knowledgeId: string;
			revision: number;
			relation: KnowledgeRelation;
			/** Stable local finding label in the cited revision. */
			finding?: string;
			label?: string;
	  };

/** Derived by the host from the admitted caller, never from a payload claim. */
export type KnowledgeAuthor = { type: "user" } | { type: "session"; sessionId: string };

/** Immutable provenance, not ownership. A missing origin stays visible as unavailable. */
export interface KnowledgeOrigin {
	missionId?: string;
	taskId?: string;
	sessionId?: string;
	recordedAt: number;
}

/**
 * POST /api/projects/:projectId/knowledge (expectedRevision 0) or PUT .../knowledge/:id (append).
 * The same operation with identical content returns its saved result; a reused operation with different content,
 * or a stale expectedRevision, conflicts. At most 64 KiB of UTF-8 content and 64 sources.
 */
export interface KnowledgeWrite {
	operationId: string;
	expectedRevision: number;
	/** Required on create; an append may repeat it but cannot change it. */
	kind?: KnowledgeKind;
	title: string;
	synopsis: string;
	/** Readable Markdown: investigations need Question, Findings and Limitations headings; components Purpose, Interfaces and Constraints or Gaps. */
	body: string;
	sources?: KnowledgeSource[];
	/** Why this revision exists. Required for appends. */
	reason?: string;
	/** HTTP create only: an originating mission of the same project. */
	originMissionId?: string;
}

export type KnowledgeFreshnessState = "not_checked" | "checked" | "needs_check";
/** Last checked against named sources within stated coverage, never timeless truth. Never set by a save. */
export interface KnowledgeFreshness {
	state: KnowledgeFreshnessState;
	/** The last successful check of exactly this revision. */
	checked?: { at: number; checker: string; coverage: string };
	/** Stored pending work for the current revision; reading never changes it. */
	pending?: { generation: number; since: number; reasons: string[]; triggers: number; taskId?: string };
	failure?: { at: number; reason: string };
}

export interface KnowledgeSummary {
	id: string;
	projectId: string;
	kind: KnowledgeKind;
	title: string;
	synopsis: string;
	revision: number;
	createdAt: number;
	updatedAt: number;
	origin: KnowledgeOrigin;
	freshness: KnowledgeFreshness;
	/** Present when listed for a mission: its stored link. */
	link?: { linkRevision: number; pinnedRevision?: number };
}
export interface KnowledgeRevisionSummary {
	revision: number;
	title: string;
	synopsis: string;
	reason?: string;
	author: KnowledgeAuthor;
	recordedAt: number;
}
export interface KnowledgeRevision extends KnowledgeRevisionSummary {
	knowledgeId: string;
	body: string;
	sources: KnowledgeSource[];
}
/** GET /api/projects/:projectId/knowledge/:id[?revision=N]. Freshness applies to that exact revision. */
export interface KnowledgeDetail {
	entry: KnowledgeSummary;
	revision: KnowledgeRevision;
	freshness: KnowledgeFreshness;
}
/**
 * GET /api/projects/:projectId/knowledge?kind=&missionId=&check=needs_check&q=&limit=&cursor=.
 * Newest first, 25 by default and 50 at most. Pages are observations, not an atomic snapshot.
 */
export interface KnowledgePage {
	entries: KnowledgeSummary[];
	more: boolean;
	cursor: string | null;
}
/** GET /api/projects/:projectId/knowledge/:id/revisions?cursor=&limit=. Newest first, no bodies. */
export interface KnowledgeRevisionPage {
	revisions: KnowledgeRevisionSummary[];
	more: boolean;
	cursor: string | null;
}
export interface KnowledgeWriteResult {
	operationId: string;
	/** True when an earlier identical operation was found instead of writing again. */
	replayed: boolean;
	entry: KnowledgeSummary;
	revision: KnowledgeRevisionSummary;
}

/** GET /api/missions/:missionId/knowledge/:id. Never linked is {linked:false, linkRevision:0}; no row is created. */
export interface MissionKnowledgeLink {
	missionId: string;
	knowledgeId: string;
	linked: boolean;
	/** Monotonic per mission and entry, including unlinks. A relink continues the counter. */
	linkRevision: number;
	/** Absent follows the current revision. */
	pinnedRevision?: number;
	updatedAt?: number;
	updatedBy?: KnowledgeAuthor;
}
/** PUT /api/missions/:missionId/knowledge/:id. DELETE takes ?expectedLinkRevision=N. */
export interface MissionKnowledgeLinkWrite {
	expectedLinkRevision: number;
	/** Pin this exact revision, or follow the current one. */
	revision?: number;
	followCurrent?: boolean;
}
