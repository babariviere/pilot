// Saved artifacts of the window's project and of one of its missions, read
// only when their page opens. Rows name an exact saved revision; reading one
// shows its source as text or hands it to the app's isolated preview. Native
// picks the project and checks the chat belongs to it on every read.
// Nothing here opens, runs, saves, sends or records anything.
import { signal } from "nsh";
import { call, type Refusal } from "./bridge";
import type { SavedArtifactKind } from "./deliveryArtifactContract";
import { glide } from "./ui";

/** One saved revision as inert text, or why it is not shown. */
export type SavedArtifact = {
	version: 1;
	reference: { sourceSessionId: string; artifactId: string; revision: number };
	metadata: { title: string; kind: SavedArtifactKind };
	rendering: "unsupported";
	content:
		| { state: "text"; source: string; containerSha256: string; containerBytes: number }
		| { state: "image"; source: string; containerSha256: string; containerBytes: number }
		| { state: "unavailable"; reason: string };
};

/** An artifact a chat saved, and where it came from. A null revision cannot be read here. */
export type ArtifactRow = {
	sessionId: string;
	artifactId: string;
	title: string;
	kind: SavedArtifactKind;
	revision: number | null;
	/** Mission links only: whether the link names its revision, or the current one was read. */
	pinned?: boolean;
	taskId?: string | null;
	taskTitle?: string | null;
	updatedAt: number;
	/** A reported screen: this row is its After, and its Before (null for a new screen) is folded in. */
	pair?: ScreenPairRow | null;
};

/** One capture of a reported screen at its pinned revision. */
export type ScreenCaptureRow = { artifactId: string; revision: number; title: string };
export type ScreenPairRow = { before: ScreenCaptureRow | null; after: ScreenCaptureRow };

export type ArtifactList = { rows: ArtifactRow[]; more: boolean };

export type ListResult = { ok: true; list: ArtifactList } | { ok: false; message: string };
export type ReadResult = { status: "shown"; artifact: SavedArtifact } | { status: "refused"; message: string };

/** The project's and its missions' saved artifacts. The connected window has one. */
export interface ArtifactSource {
	/** The project's artifacts newest first, or the mission's links. Passive. */
	list(missionId?: string): Promise<ListResult>;
	/** One exact saved revision of `row`, once, for one press or one page open. Passive. */
	read(row: ArtifactRow): Promise<ReadResult>;
}

/** What one row shows: its saved source as text, or its preview. */
export type Shown = {
	title: string;
	kind: string;
	pin: { revision: number };
	state: "reading" | "shown" | "refused";
	preview?: boolean;
	artifact: SavedArtifact | null;
	message: string;
};

/** How many previews one page keeps open. Opening another closes the oldest. */
export const MAX_PREVIEWS = 4;

/** The formats this client can inspect or preview. */
export function isSavedArtifactKind(value: unknown): value is SavedArtifactKind {
	return value === "image" || value === "nsh";
}
const REASONS = new Set(["missing", "oversize", "redacted", "unsupported", "invalid"]);

function captureOf(x: unknown): ScreenCaptureRow | null {
	const c = x as ScreenCaptureRow | null;
	if (!c || typeof c !== "object") return null;
	if (typeof c.artifactId !== "string" || typeof c.title !== "string") return null;
	if (!Number.isSafeInteger(c.revision) || c.revision < 1) return null;
	return { artifactId: c.artifactId, revision: c.revision, title: c.title };
}

/** A row's screen pair, or null. A pair that is off makes the row invalid rather than a plain image. */
function pairOf(x: unknown, row: { artifactId: string; revision: number | null }): ScreenPairRow | null | undefined {
	if (x === undefined || x === null) return null;
	const p = x as { before?: unknown; after?: unknown };
	const after = captureOf(p.after);
	const before = p.before === null ? null : captureOf(p.before);
	if (!after || (before === null && p.before !== null)) return undefined;
	if (after.artifactId !== row.artifactId || after.revision !== row.revision) return undefined;
	return { before, after };
}

/** The row that reads a pair's Before capture. */
export function beforeRow(row: ArtifactRow): ArtifactRow | null {
	const b = row.pair?.before;
	return b ? { ...row, artifactId: b.artifactId, revision: b.revision, title: b.title, pair: null } : null;
}

function rowOf(x: unknown): ArtifactRow | null {
	const r = x as ArtifactRow;
	if (!r || typeof r !== "object") return null;
	if (typeof r.sessionId !== "string" || typeof r.artifactId !== "string" || typeof r.title !== "string") return null;
	if (!isSavedArtifactKind(r.kind) || (r.revision !== null && !Number.isSafeInteger(r.revision))) return null;
	const pair = pairOf(r.pair, r);
	if (pair === undefined || (pair && r.kind !== "image")) return null;
	return {
		sessionId: r.sessionId,
		artifactId: r.artifactId,
		title: r.title,
		kind: r.kind,
		revision: r.revision,
		pinned: r.pinned === true,
		taskId: typeof r.taskId === "string" ? r.taskId : null,
		taskTitle: typeof r.taskTitle === "string" ? r.taskTitle : null,
		updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
		pair,
	};
}

/** The reply, when it is exactly the inert answer for `row`'s revision. Anything else is not shown. */
export function savedOf(x: unknown, row: ArtifactRow): SavedArtifact | null {
	const a = x as SavedArtifact | null;
	if (!a || typeof a !== "object" || a.version !== 1 || a.rendering !== "unsupported") return null;
	const ref = a.reference;
	if (
		!ref ||
		ref.sourceSessionId !== row.sessionId ||
		ref.artifactId !== row.artifactId ||
		ref.revision !== row.revision ||
		!isSavedArtifactKind(a.metadata?.kind) ||
		a.metadata.kind !== row.kind ||
		typeof a.metadata.title !== "string"
	)
		return null;
	const c = a.content;
	if (c?.state === "text" && row.kind === "nsh" && typeof c.source === "string") return a;
	if (c?.state === "image" && row.kind === "image" && validImageSource(c.source)) return a;
	if (c?.state === "unavailable" && REASONS.has(c.reason)) return a;
	return null;
}

/** Inline raster bytes only. Never let a saved image become a URL or a path. */
export function validImageSource(source: unknown): source is string {
	return (
		typeof source === "string" &&
		source.length <= 1024 * 1024 &&
		/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(source)
	);
}

function listMessage(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Pilot again to see it.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot list saved artifacts here.";
		default:
			return "Pilot could not read the saved artifacts.";
	}
}

/** Why a saved revision is not shown, in one calm sentence. */
export function readRefused(refusal: Refusal): ReadResult {
	const r = (message: string): ReadResult => ({ status: "refused", message });
	switch (refusal) {
		case "stale":
			return r("This artifact changed or left this project while Pilot read it. Nothing is shown.");
		case "busy":
		case "closed":
			return r("Pilot is closing. Nothing is shown.");
		case "offline":
			return r("Pilot could not reach its service. Nothing is shown.");
		case "identity":
			return r("The Pilot service changed. Open Pilot again. Nothing is shown.");
		case "invalid":
			return r("Pilot's service answered in a way this app does not understand. Nothing is shown.");
		case "lost":
		case "unknown":
			return r("Pilot did not hear back. Nothing is shown, and nothing changed.");
		default:
			return r("Pilot cannot show this saved revision here. Its chat may no longer be in this project.");
	}
}

/** The connected window's reads: two exact native methods, no other channel. */
export class ConnectedArtifacts implements ArtifactSource {
	readonly #window: string;
	constructor(window: string) {
		this.#window = window;
	}
	async list(missionId?: string): Promise<ListResult> {
		const reply = await call<{ rows?: unknown; more?: unknown }>(
			this.#window,
			"day.artifacts.read",
			missionId ? { missionId } : {},
		);
		if (!reply.ok) return { ok: false, message: listMessage(reply.refusal) };
		const raw = reply.snapshot?.rows;
		const rows = Array.isArray(raw) ? raw.map(rowOf) : null;
		if (!rows || rows.some((r) => !r)) return { ok: false, message: listMessage("invalid") };
		return { ok: true, list: { rows: rows as ArtifactRow[], more: reply.snapshot.more === true } };
	}
	async read(row: ArtifactRow): Promise<ReadResult> {
		if (row.revision === null) return readRefused("unavailable");
		const reply = await call<SavedArtifact>(this.#window, "day.artifacts.source", {
			sourceSessionId: row.sessionId,
			artifactId: row.artifactId,
			revision: row.revision,
		});
		if (!reply.ok) return readRefused(reply.refusal);
		const saved = savedOf(reply.snapshot, row);
		return saved ? { status: "shown", artifact: saved } : readRefused("invalid");
	}
}

/** Whether the project's Artifacts page is open over Today. */
export const artifactsOpen = signal(false);

/** Opens the project's Artifacts page. Opening it only reads. */
export function openArtifacts() {
	glide();
	artifactsOpen.set(true);
}

/** Back to Today. */
export function closeArtifacts() {
	artifactsOpen.set(false);
}
