/** Bounded conversation excerpts for a separate, tool-free title completion. */
import type { EntryRecord } from "@pilot/protocol";

export const TITLE_CONTEXT_LIMIT = 24_000;
type Page = { entries: EntryRecord[]; more: boolean };

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

/** Read newest-first pages, including pre-compaction history, without opening an agent or retaining raw tools. */
export async function chatTitleContext(
	opening: string,
	read: (before: number, limit: number) => Promise<Page>,
	signal: AbortSignal,
): Promise<string> {
	const excerpts: string[] = [];
	let dialogueLeft = 17_000;
	let toolsLeft = 2_000;
	let before = Number.MAX_SAFE_INTEGER;
	for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
		signal.throwIfAborted();
		const page = await read(before, 64);
		signal.throwIfAborted();
		for (const entry of page.entries.toReversed()) {
			// Compaction summaries and host metadata are not conversation messages.
			if (!["pi.user", "pi.message", "pi.assistant", "pi.tool-result"].includes(entry.kind)) continue;
			for (const message of (entry.model ?? []).toReversed()) {
				const tool = message.role === "toolResult";
				if (!tool && message.role !== "user" && message.role !== "assistant") continue;
				const remaining = tool ? toolsLeft : dialogueLeft;
				if (remaining <= 0) continue;
				const body = text(message.content, Math.min(tool ? 300 : 4_000, remaining));
				if (!body.trim()) continue;
				const excerpt = `${tool ? "Tool result" : message.role}: ${body}`.slice(0, remaining);
				excerpts.push(excerpt);
				if (tool) toolsLeft -= excerpt.length + 2;
				else dialogueLeft -= excerpt.length + 2;
			}
		}
		const next = Number(page.entries[0]?.id);
		if (!page.more || !page.entries.length || !Number.isSafeInteger(next) || next >= before) break;
		if (dialogueLeft <= 0 && toolsLeft <= 0) break;
		before = next;
	}
	return [`Opening request: ${opening.slice(0, 4_000)}`, "Conversation (bounded excerpts):", ...excerpts.reverse()]
		.join("\n\n")
		.slice(0, TITLE_CONTEXT_LIMIT);
}
