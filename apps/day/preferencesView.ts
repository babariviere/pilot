// The Settings page's place and its one unsaved draft: a project's
// preferences as the user is editing them. The draft names the project and
// the revision it started from, so it is never saved to another project or
// over a newer list without the user choosing. Leaving the page, closing or
// updating keeps it (updateView.ts); only Save sends it, once.
import { signal } from "nsh";
import { glide } from "./motion";
import type { ProjectPreference, ProjectPreferences } from "./preferencesFeed";

/** Whether Settings is open over Today. */
export const settingsOpen = signal(false);

/** One preference as typed. A null ID is a new one; `key` keeps its row while typing. */
export type DraftEntry = { key: string; id: string | null; text: string };

/** Unsaved preferences: for one project, from one revision. */
export type PreferencesDraft = { projectId: string; baseRevision: number; entries: DraftEntry[] };

/** The window's unsaved preferences, or null. Kept across pages, close and update. */
export const preferencesDraft = signal<PreferencesDraft | null>(null);

/** What the last Save or Check said, or "". */
export const preferencesMessage = signal("");

/** Opens Settings. Opening it only reads. */
export function openSettings() {
	glide();
	preferencesMessage.set("");
	settingsOpen.set(true);
}

/** Back to Today. The draft stays. */
export function closeSettings() {
	settingsOpen.set(false);
}

let fresh = 0;

/** A key for a new row, unique in this window. */
export function newKey(): string {
	fresh += 1;
	return `new-${fresh}`;
}

/** A draft that starts as `p`, exactly. */
export function draftOf(p: ProjectPreferences): PreferencesDraft {
	return {
		projectId: p.projectId,
		baseRevision: p.revision,
		entries: p.entries.map((e) => ({ key: e.id, id: e.id, text: e.text })),
	};
}

/** Whether `d` says something other than `p`: different words, or another project. */
export function differs(d: PreferencesDraft, p: ProjectPreferences | null): boolean {
	if (!p || d.projectId !== p.projectId) return true;
	if (d.entries.length !== p.entries.length) return true;
	return d.entries.some((e, i) => e.text !== p.entries[i]?.text);
}

/** A project or preference ID as the native root saves it. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The draft as a saved window keeps it: "<project>\n<revision>", then one
 * "<id>\n<text>" per preference ("" for a new one's ID). Empty without a draft.
 */
export function savedPreferences(): string[] {
	const d = preferencesDraft();
	if (!d || !ID.test(d.projectId)) return [];
	return [`${d.projectId}\n${d.baseRevision}`, ...d.entries.map((e) => `${e.id ?? ""}\n${e.text}`)];
}

/** The draft a saved window kept, or null when it is not valid. Restoring sends nothing. */
export function draftFrom(lines: readonly string[]): PreferencesDraft | null {
	if (lines.length === 0) return null;
	const [head = "", ...rest] = lines;
	const at = head.indexOf("\n");
	const projectId = head.slice(0, at);
	const revision = Number(head.slice(at + 1));
	if (at <= 0 || !ID.test(projectId) || !Number.isSafeInteger(revision) || revision < 0) return null;
	const entries: DraftEntry[] = [];
	for (const line of rest) {
		const cut = line.indexOf("\n");
		if (cut < 0) return null;
		const id = line.slice(0, cut);
		if (id !== "" && !ID.test(id)) return null;
		entries.push({ key: id || newKey(), id: id || null, text: line.slice(cut + 1) });
	}
	return { projectId, baseRevision: revision, entries };
}

/** Shows a kept draft again, as unsaved text. */
export function restorePreferences(lines: readonly string[]) {
	preferencesDraft.set(draftFrom(lines));
	preferencesMessage.set("");
}

/** A local date such as "9 Nov", or "" when it cannot be read. */
export function dayOf(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	try {
		return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
	} catch {
		return "";
	}
}

/** Who recorded a preference and from what, in a few words. */
export function sourceLine(e: ProjectPreference): string {
	const when = dayOf(e.recordedAt);
	const who =
		e.author.type === "coordinator"
			? e.source.type === "mission_note"
				? "Recorded by a mission coordinator from your note"
				: "Recorded by a mission coordinator"
			: "Added by you";
	return when ? `${who} · ${when}` : who;
}

/** The words a coordinator quoted, or "". */
export function quoteOf(e: ProjectPreference): string {
	return e.source.type === "mission_note" ? e.source.quote : "";
}

/** The list's last change, in one line, or "" for a list never saved. */
export function changedLine(p: ProjectPreferences): string {
	if (p.revision === 0) return "";
	const when = dayOf(p.updatedAt);
	const who = p.author?.type === "coordinator" ? "a mission coordinator" : p.author ? "you" : "";
	if (!who) return when ? `Last changed ${when}.` : "";
	return when ? `Last changed by ${who} · ${when}.` : `Last changed by ${who}.`;
}

/** One saved revision's heading: its number, who saved it and when. */
export function revisionLine(p: ProjectPreferences): string {
	const who = p.author?.type === "coordinator" ? "a mission coordinator" : p.author ? "you" : "";
	const when = dayOf(p.updatedAt);
	return [`Revision ${p.revision}`, who ? `by ${who}` : "", when].filter(Boolean).join(" · ");
}

/** The note a revision was recorded from, or "". */
export function revisionQuote(p: ProjectPreferences): string {
	return p.source?.type === "mission_note" ? p.source.quote : "";
}
