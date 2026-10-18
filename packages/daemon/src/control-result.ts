import type { SessionManager } from "./sessions.ts";

/** One bounded cold page, no worker start/subscription. Never include thoughts or tool instructions. */
export async function controlResultTail(sessions: Pick<SessionManager, "history">, sessionId: string) {
	const page = await sessions.history(sessionId, Number.MAX_SAFE_INTEGER, 12);
	let text = "";
	let clipped = false;
	for (const entry of page.entries)
		for (const message of entry.model ?? []) {
			if (message.role !== "assistant") continue;
			const parts =
				typeof message.content === "string"
					? [message.content]
					: message.content.filter((block) => block.type === "text").map((block) => block.text);
			let content = "",
				messageClipped = false;
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i]!;
				messageClipped ||= content.length + part.length + (i ? 1 : 0) > 4000;
				content = `${content}${i ? "\n" : ""}${part.slice(-4000)}`.slice(-4000);
			}
			if (content) {
				text = content;
				clipped = messageClipped;
			}
		}
	// Byte bounded, including multi-byte text, before quoting as a single untrusted JSON value.
	const bytes = Buffer.from(text);
	let start = Math.max(0, bytes.length - 2000);
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	const tail = bytes.subarray(start).toString("utf8");
	return { untrusted: true, sessionId, text: tail, truncated: page.more || clipped || bytes.length > 2000 };
}
