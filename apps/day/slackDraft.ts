// Unsent project-scoped words. Restoring never saves tracking or imports a link.
import { signal } from "nsh";
export type SlackDraft = {
	projectId: string;
	binding: string;
	channels: string;
	mentionOnly: string[];
	groups: string;
	url: string;
};
export const slackDraft = signal<SlackDraft | null>(null);
export const splitSlackNames = (text: string) => [
	...new Set(
		text
			.split(/[\s,]+/)
			.map((s) => s.trim())
			.filter(Boolean),
	),
];
/** Match the native pre-journal subset; query strings cannot hold arbitrary secrets. */
export function safeSlackLink(s: string): boolean {
	return (
		s.length <= 2000 &&
		/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[CDG][A-Z0-9]{1,199}\/p\d{16,18}\/?(?:\?(?:thread_ts=\d{1,12}\.\d{6}|cid=[CDG][A-Z0-9]{1,199})(?:&(?:thread_ts=\d{1,12}\.\d{6}|cid=[CDG][A-Z0-9]{1,199}))?)?$/.test(
			s,
		)
	);
}
export function savedSlackDraft(): string {
	const d = slackDraft();
	return d ? JSON.stringify({ ...d, url: !d.url || safeSlackLink(d.url) ? d.url : "" }) : "";
}
export function restoreSlackDraft(text: string) {
	slackDraft.set(null);
	if (!text) return;
	try {
		const d = JSON.parse(text);
		if (
			typeof d.projectId !== "string" ||
			typeof d.binding !== "string" ||
			typeof d.channels !== "string" ||
			typeof d.groups !== "string" ||
			typeof d.url !== "string" ||
			!Array.isArray(d.mentionOnly) ||
			!d.mentionOnly.every((s: unknown) => typeof s === "string")
		)
			return;
		slackDraft.set({ ...d, url: !d.url || safeSlackLink(d.url) ? d.url : "" });
	} catch {
		/* Invalid drafts never submit. */
	}
}
