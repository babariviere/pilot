import type { TrackingJson } from "@pilot/protocol";

/** Only our own plain message is surfaced, never raw MCP text or transport errors. The reason is a fixed
 * label for the daemon log, never message content. */
export class SlackFormatChanged extends Error {
	readonly reason: string;
	constructor(reason = "unexpected format") {
		super("Couldn't read some Slack messages.");
		this.reason = reason;
	}
}
export interface SlackMessage {
	ts: string;
	threadTs: string;
	text: string;
	replies: number;
}
export interface SlackPage {
	channel: string;
	name: string;
	messages: SlackMessage[];
	next?: string;
}
const TS = /^\d{1,12}\.\d{6}$/;
const METADATA = /^(Thread|Reactions|Files): /;
const THREAD = /^Thread: (\d+) repl(?:y|ies)(?: \(latest: [^\n]+\))?[ \t]*$/;
export function slackTimestamp(value: unknown): value is string {
	return typeof value === "string" && TS.test(value);
}

/** Messages end with known metadata lines (Thread, Reactions, Files) in any order, at most once each.
 * Bot attachments follow them as "Attachment: …" blocks; those are message content and stay in the text.
 * Returns undefined for a malformed Thread line. */
function splitMetadata(body: string, thread: boolean): { text: string; replies: number } | undefined {
	const lines = body.split("\n");
	const seen = new Set<string>();
	let replies = 0,
		malformed = false;
	// Strip a trailing metadata run in [from, to) and return its start.
	const strip = (from: number, to: number) => {
		let start = to;
		while (start > from) {
			const line = lines[start - 1]!;
			if (!line.trim()) {
				start--;
				continue;
			}
			const key = METADATA.exec(line)?.[1];
			if (!key || seen.has(key) || (key === "Thread" && !thread)) break;
			if (key === "Thread") {
				const match = THREAD.exec(line);
				if (!match) malformed = true;
				replies = Number(match?.[1] ?? 0);
			}
			seen.add(key);
			start--;
		}
		return start;
	};
	let attachments = lines.findIndex((line) => line.startsWith("Attachment: "));
	if (attachments < 0) attachments = lines.length;
	const tail = strip(attachments, lines.length);
	const head = strip(0, attachments);
	if (malformed || !Number.isSafeInteger(replies)) return undefined;
	return { text: [...lines.slice(0, head), ...lines.slice(attachments, tail)].join("\n").trim(), replies };
}

/** Deliberately narrow formatted-text contract. Never silently turn unknown formats into an empty page. */
export function parseSlackPage(value: TrackingJson, limit: number): SlackPage {
	const fail = (reason: string) => {
		throw new SlackFormatChanged(reason);
	};
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail("history is not an object");
	const { messages, pagination_info: pagination } = value;
	if (typeof messages !== "string" || typeof pagination !== "string" || Buffer.byteLength(messages) > 512 * 1024)
		return fail("history fields missing or too large");
	const lines = messages.replace(/\r\n/g, "\n").split("\n");
	const header = /^Channel: #([^\n]+) \(([CDG][A-Z0-9]{1,199})\)$/.exec(lines.shift() ?? "");
	if (!header) return fail("channel header");
	const [, name, channel] = header;
	const text = lines.join("\n").trim();
	const parts = text.split(/^=== Message from [^\n]+ ===\s*$/m);
	if (parts[0]?.trim()) return fail("text before the first message");
	const parsed: SlackMessage[] = [];
	for (const part of parts.slice(1)) {
		const match = /^\s*Message TS: (\d{1,12}\.\d{6})\n([\s\S]*)$/.exec(part);
		if (!match) return fail("message timestamp");
		const message = splitMetadata(match[2], true);
		if (!message) return fail("thread line");
		// Body text resembling framing is ambiguous. Fail closed instead of guessing identities.
		if (/^Message TS:|^Thread:|^=== /m.test(message.text)) return fail("framing inside a message");
		parsed.push({ ts: match[1], threadTs: match[1], ...message });
	}
	if (parsed.length > limit) return fail("more messages than requested");
	if (new Set(parsed.map((message) => message.ts)).size !== parsed.length) return fail("repeated message timestamp");
	const next = parsePagination(pagination, false);
	if (next && !parsed.length) return fail("cursor on an empty page");
	// A message with no text and no replies (for example, only a file) has nothing to classify.
	const kept = parsed.filter((message) => message.text || message.replies);
	return { channel, name, messages: kept, ...(next ? { next } : {}) };
}

/** Thread reads have a different format from history, and omit the channel header entirely. */
export function parseSlackThread(
	value: TrackingJson,
	parentTs: string,
	limit: number,
): { messages: SlackMessage[]; next?: string } {
	const fail = (reason: string) => {
		throw new SlackFormatChanged(reason);
	};
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof value.messages !== "string" ||
		typeof value.pagination_info !== "string" ||
		Buffer.byteLength(value.messages) > 512 * 1024
	)
		return fail("thread fields missing or too large");
	const text = value.messages.replace(/\r\n/g, "\n").trim();
	const header =
		/^=== THREAD PARENT MESSAGE ===[ \t]*\n([\s\S]*?)\n=== THREAD REPLIES \((\d+) total\) ===[ \t]*\n?([\s\S]*)$/.exec(
			text,
		);
	if (!header) return fail("thread header");
	const count = Number(header[2]);
	if (!Number.isSafeInteger(count) || count > limit) return fail("reply count");
	const parseMessage = (part: string): SlackMessage => {
		const message = /^\s*From: [^\n]+\nTime: [^\n]+\nMessage TS: (\d{1,12}\.\d{6})\n([\s\S]*)$/.exec(part);
		if (!message) return fail("thread message fields");
		// Replies carry Reactions and Files lines too, but never a Thread line. Text may be empty (file only).
		const body = splitMetadata(message[2], false)!.text;
		if (/^Message TS:|^Thread:|^=== |^--- Reply /m.test(body)) return fail("framing inside a thread message");
		return { ts: message[1], threadTs: parentTs, text: body, replies: count };
	};
	const parent = parseMessage(header[1]);
	if (parent.ts !== parentTs) return fail("thread parent timestamp");
	const replies = header[3].split(/^--- Reply (\d+) of (\d+) ---[ \t]*$/m);
	if (replies[0]?.trim() || replies.length !== count * 3 + 1) return fail("reply framing");
	const messages = [parent];
	for (let i = 0; i < count; i++) {
		if (Number(replies[i * 3 + 1]) !== i + 1 || Number(replies[i * 3 + 2]) !== count) return fail("reply numbering");
		messages.push(parseMessage(replies[i * 3 + 3]!));
	}
	if (new Set(messages.map((message) => message.ts)).size !== messages.length)
		return fail("repeated message timestamp");
	const next = parsePagination(value.pagination_info, true);
	return { messages, ...(next ? { next } : {}) };
}
function parsePagination(text: string, thread: boolean): string | undefined {
	const scope = thread ? "in this thread" : "available";
	if (text.trim() === `There are no more messages ${scope}.`) return undefined;
	const next = new RegExp(
		`^There are more messages ${scope}\\. To view the next page, use cursor: \x60([^\x60\\s]{1,96})\x60$`,
	).exec(text.trim())?.[1];
	if (!next) throw new SlackFormatChanged("pagination");
	return next;
}
