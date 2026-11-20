// Window-local library location and unsent words. Restoring never writes Knowledge.
import { signal } from "nsh";
import type { KnowledgeDetail, KnowledgeSource } from "../../../../packages/protocol/src/knowledge/knowledge";

export type KnowledgeEdit = {
	projectId: string;
	id: string;
	expectedRevision: number;
	title: string;
	synopsis: string;
	body: string;
	sources: KnowledgeSource[];
	reason: string;
	/** View-local edit counters, never part of the native write. */
	editVersion?: number;
	submittedVersion?: number;
	submittedHash?: string;
};

/** Payload identity only, not authority. Match the service's saved normalization. */
export function knowledgeFingerprint(d: KnowledgeEdit): string {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify([
				d.projectId,
				d.id,
				d.expectedRevision,
				d.title.trim(),
				d.synopsis.trim(),
				d.body.replace(/\r\n?/g, "\n").trim(),
				d.sources,
				d.reason.trim(),
			]),
		)
		.digest("hex");
}
export const libraryOpen = signal(false);
export const knowledgeDraft = signal<KnowledgeEdit | null>(null);

export function editKnowledge(detail: KnowledgeDetail): KnowledgeEdit {
	return {
		projectId: detail.entry.projectId,
		id: detail.entry.id,
		expectedRevision: detail.revision.revision,
		title: detail.revision.title,
		synopsis: detail.revision.synopsis,
		body: detail.revision.body,
		sources: detail.revision.sources,
		reason: "",
	};
}

export function savedKnowledge(): string {
	return JSON.stringify({ open: libraryOpen(), draft: knowledgeDraft() });
}

export function restoreKnowledge(raw: string) {
	libraryOpen.set(false);
	knowledgeDraft.set(null);
	try {
		const v = JSON.parse(raw);
		libraryOpen.set(v.open === true);
		const d = v.draft;
		if (
			d &&
			[d.projectId, d.id, d.title, d.synopsis, d.body, d.reason].every((s) => typeof s === "string") &&
			Number.isSafeInteger(d.expectedRevision) &&
			d.expectedRevision > 0 &&
			Array.isArray(d.sources)
		)
			knowledgeDraft.set(d);
	} catch {
		/* Empty or older saved windows have no library draft. */
	}
}
