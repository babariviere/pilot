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
/** Characters of a Slack thread pilotd keeps locally for search. Never returned to clients. */
export const SLACK_SEARCH_CHARS = 8000;
const METADATA = /^(Thread|Reactions|Files): /;
const THREAD = /^Thread: (\d+) repl(?:y|ies)(?: \(latest: [^\n]+\))?[ \t]*$/;
/** First line of an attachment block: bot attachments, forwarded messages and app notifications (for example a
 * GitHub pull request posted by an app). */
const ATTACHMENT = /^(?:Attachment: |(?:Forwarded message|App notification) from [^\n]+$)/;
export function slackTimestamp(value: unknown): value is string {
	return typeof value === "string" && TS.test(value);
}

/** A Slack message link (Copy link): https://<workspace>.slack.com/archives/<channel>/p<16 digits>, with
 * thread_ts for a reply. threadTs is the thread's parent, which is what triage tracks. */
export function parseSlackMessageLink(value: unknown): { channel: string; ts: string; threadTs: string } | undefined {
	if (typeof value !== "string" || value.length > 2000) return undefined;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:" || (host !== "slack.com" && !host.endsWith(".slack.com"))) return undefined;
	const path = /^\/archives\/([CDG][A-Z0-9]{1,199})\/p(\d{10,12})(\d{6})\/?$/.exec(url.pathname);
	if (!path) return undefined;
	const ts = `${path[2]}.${path[3]}`;
	const thread = url.searchParams.get("thread_ts");
	return { channel: path[1]!, ts, threadTs: thread && TS.test(thread) ? thread : ts };
}

/** Messages end with known metadata lines (Thread, Reactions, Files) in any order, at most once each.
 * Attachment blocks ("Attachment: …", "Forwarded message from …", "App notification from …") follow them; those
 * are message content and stay in the text. Returns undefined for a malformed Thread line. */
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
	let attachments = lines.findIndex((line) => ATTACHMENT.test(line));
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

/** Only the parent of a thread read, for the triage inspector. Replies, if any were returned, are ignored, so the
 * reply limit and pagination do not matter here. The author is the display name, without email or user ID. */
export function parseSlackThreadParent(value: TrackingJson, parentTs: string): { author?: string; text: string } {
	const fail = (reason: string) => {
		throw new SlackFormatChanged(reason);
	};
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof value.messages !== "string" ||
		Buffer.byteLength(value.messages) > 512 * 1024
	)
		return fail("thread fields missing or too large");
	const text = value.messages.replace(/\r\n/g, "\n").trim();
	const parent =
		/^=== THREAD PARENT MESSAGE ===[ \t]*\n([\s\S]*?)(?:\n=== THREAD REPLIES \(\d+ total\) ===[ \t]*(?:\n[\s\S]*)?)?$/.exec(
			text,
		)?.[1];
	if (parent === undefined) return fail("thread header");
	const message = /^\s*From: ([^\n]+)\nTime: [^\n]+\nMessage TS: (\d{1,12}\.\d{6})\n([\s\S]*)$/.exec(parent);
	if (!message) return fail("thread message fields");
	if (message[2] !== parentTs) return fail("thread parent timestamp");
	const body = splitMetadata(message[3]!, false)!.text;
	if (/^Message TS:|^Thread:|^=== |^--- Reply /m.test(body)) return fail("framing inside a thread message");
	const author = plainText(
		message[1]!
			.replace(/\s*\([A-Z0-9]{1,40}\)\s*$/, "")
			.replace(/\s*<[^<>\n]*>\s*$/, "")
			.trim(),
	)
		.replace(/\s+/g, " ")
		.slice(0, 80)
		.trim();
	return { ...(author ? { author } : {}), text: body };
}
export interface SlackReply {
	ts: string;
	/** Slack user or bot ID from the From line, when present. */
	userId?: string;
	/** Display name, without email or ID. */
	author?: string;
	text: string;
}

/** Replies of a thread read with `oldest`, which still returns the parent first. The server writes "No thread
 * messsages" (sic) when no reply is newer. more: another page follows. */
export function parseSlackThreadReplies(
	value: TrackingJson,
	parentTs: string,
	limit: number,
): { replies: SlackReply[]; more: boolean } {
	const fail = (reason: string): never => {
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
	const parseMessage = (part: string): SlackReply => {
		const message = /^\s*From: ([^\n]+)\nTime: [^\n]+\nMessage TS: (\d{1,12}\.\d{6})\n([\s\S]*)$/.exec(part);
		if (!message) return fail("thread message fields");
		const body = splitMetadata(message[3]!, false)!.text;
		if (/^Message TS:|^Thread:|^=== |^--- Reply /m.test(body)) return fail("framing inside a thread message");
		const from = message[1]!;
		const userId = /\(([UWB][A-Z0-9]{1,40})\)\s*$/.exec(from)?.[1];
		const author = plainText(
			from
				.replace(/\s*\([A-Z0-9]{1,40}\)\s*$/, "")
				.replace(/\s*<[^<>\n]*>\s*$/, "")
				.trim(),
		)
			.replace(/\s+/g, " ")
			.slice(0, 80)
			.trim();
		return { ts: message[2]!, ...(userId ? { userId } : {}), ...(author ? { author } : {}), text: body };
	};
	const empty = /^=== THREAD PARENT MESSAGE ===[ \t]*\n([\s\S]*?)\n+No thread mess?sages\.?$/.exec(text);
	if (empty) {
		if (parseMessage(empty[1]!).ts !== parentTs) fail("thread parent timestamp");
		return { replies: [], more: false };
	}
	const header =
		/^=== THREAD PARENT MESSAGE ===[ \t]*\n([\s\S]*?)\n=== THREAD REPLIES \((\d+) total\) ===[ \t]*\n?([\s\S]*)$/.exec(
			text,
		);
	if (!header) return fail("thread header");
	if (parseMessage(header[1]!).ts !== parentTs) fail("thread parent timestamp");
	const count = Number(header[2]);
	if (!Number.isSafeInteger(count) || count > limit) return fail("reply count");
	const parts = header[3]!.split(/^--- Reply (\d+) of (\d+) ---[ \t]*$/m);
	if (parts[0]?.trim() || parts.length !== count * 3 + 1) return fail("reply framing");
	const replies: SlackReply[] = [];
	for (let i = 0; i < count; i++) {
		if (Number(parts[i * 3 + 1]) !== i + 1 || Number(parts[i * 3 + 2]) !== count) return fail("reply numbering");
		replies.push(parseMessage(parts[i * 3 + 3]!));
	}
	return { replies, more: parsePagination(value.pagination_info, true) !== undefined };
}

// Control and format characters that hide or reorder text (bidi overrides, zero-width spaces). Joiners stay for emoji.
const HIDDEN =
	/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
function plainText(text: string): string {
	return text.replace(/\t/g, " ").replace(HIDDEN, "");
}

/** Message text for display: Slack link markup reduced to its label, hidden characters removed, blank runs
 * collapsed, and at most maxLines lines and maxChars characters, cut at a word where possible. */
export function slackExcerptText(
	text: string,
	maxChars: number,
	maxLines: number,
): { text: string; truncated: boolean } {
	let plain = plainText(text.replace(/\r\n?/g, "\n"))
		.replace(/<!(here|channel|everyone)(?:\|[^<>\n]*)?>/g, "@$1")
		.replace(/<([#@])[A-Z0-9]{1,40}\|([^<>\n]{1,200})>/g, "$1$2")
		.replace(/<(?:https?:|mailto:)[^<>|\s]{1,2000}\|([^<>\n]{1,500})>/g, "$1")
		.replace(/<((?:https?:|mailto:)[^<>|\s]{1,2000})>/g, "$1")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	let truncated = false;
	const lines = plain.split("\n");
	if (lines.length > maxLines) {
		plain = lines.slice(0, maxLines).join("\n").trimEnd();
		truncated = true;
	}
	if (plain.length > maxChars) {
		let cut = plain.slice(0, maxChars);
		// Do not split a UTF-16 surrogate pair, and prefer ending at a word.
		if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
		const space = cut.search(/\s\S*$/);
		plain = (space > maxChars * 0.8 ? cut.slice(0, space) : cut).trimEnd();
		truncated = true;
	}
	return { text: truncated ? `${plain}…` : plain, truncated };
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
