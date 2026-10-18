/** Bounded conversation excerpts for a separate, tool-free title completion. */
import type { EntryRecord } from "@pilot/protocol";

export const TITLE_CONTEXT_LIMIT = 24_000;
export const TITLE_OPENING_LIMIT = 4_000;
type Page = { entries: EntryRecord[]; more: boolean };

export interface ChatTitleContextOptions {
	/** Omit an exact fixed opening instruction from conversation excerpts. */
	excludeUserText?: string;
	/** Return an empty context until committed assistant text exists. */
	requireAssistant?: boolean;
}

function text(content: unknown, limit: number): string {
	if (typeof content === "string") return content.slice(0, limit);
	if (!Array.isArray(content)) return "";
	let result = "";
	for (const part of content) {
		if (part?.type !== "text" || typeof part.text !== "string") continue;
		result += `${result ? "\n" : ""}${part.text.slice(0, limit - result.length)}`;
		if (result.length >= limit) break;
	}
	return result.slice(0, limit);
}

/**
 * Read newest-first pages, including pre-compaction history, without opening an agent. Only user and assistant
 * text is kept: tool calls, tool results, thinking and images are skipped.
 */
export async function chatTitleContext(
	opening: string,
	read: (before: number, limit: number) => Promise<Page>,
	signal: AbortSignal,
	options: ChatTitleContextOptions = {},
): Promise<string> {
	const excerpts: string[] = [];
	let dialogueLeft = 17_000;
	let before = Number.MAX_SAFE_INTEGER;
	let hasAssistant = false;
	for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
		signal.throwIfAborted();
		const page = await read(before, 64);
		signal.throwIfAborted();
		for (const entry of page.entries.toReversed()) {
			// Compaction summaries and host metadata are not conversation messages.
			if (!["pi.user", "pi.message", "pi.assistant"].includes(entry.kind)) continue;
			for (const message of (entry.model ?? []).toReversed()) {
				if (message.role !== "user" && message.role !== "assistant") continue;
				if (dialogueLeft <= 0) continue;
				const body = text(message.content, Math.min(4_000, dialogueLeft));
				if (!body.trim()) continue;
				const fixedOpening = options.excludeUserText?.trim();
				const candidate = body.trim();
				if (
					message.role === "user" &&
					fixedOpening !== undefined &&
					(candidate === fixedOpening ||
						(candidate.length < fixedOpening.length && fixedOpening.startsWith(candidate)))
				)
					continue;
				if (message.role === "assistant") hasAssistant = true;
				const excerpt = `${message.role}: ${body}`.slice(0, dialogueLeft);
				excerpts.push(excerpt);
				dialogueLeft -= excerpt.length + 2;
			}
		}
		const next = Number(page.entries[0]?.id);
		if (!page.more || !page.entries.length || !Number.isSafeInteger(next) || next >= before) break;
		if (dialogueLeft <= 0) break;
		before = next;
	}
	if (options.requireAssistant && !hasAssistant) return "";
	return [
		...(opening.trim() ? [`Opening request: ${opening.slice(0, TITLE_OPENING_LIMIT)}`] : []),
		"Conversation (bounded excerpts):",
		...excerpts.reverse(),
	]
		.join("\n\n")
		.slice(0, TITLE_CONTEXT_LIMIT);
}
