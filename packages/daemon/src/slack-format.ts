import type { TrackingJson } from "@pilot/protocol";

/** Only our own diagnostic is surfaced, never raw MCP text or transport errors. */
export class SlackFormatChanged extends Error {
	constructor() {
		super("Slack response format changed. Update the Slack source parser before retrying.");
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
export function slackTimestamp(value: unknown): value is string {
	return typeof value === "string" && TS.test(value);
}

/** Deliberately narrow formatted-text contract. Never silently turn unknown formats into an empty page. */
export function parseSlackPage(value: TrackingJson, limit: number): SlackPage {
	const fail = () => {
		throw new SlackFormatChanged();
	};
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
	const { messages, pagination_info: pagination } = value;
	if (typeof messages !== "string" || typeof pagination !== "string" || Buffer.byteLength(messages) > 512 * 1024)
		return fail();
	const lines = messages.replace(/\r\n/g, "\n").split("\n");
	const header = /^Channel: #([^\n]+) \(([CDG][A-Z0-9]{1,199})\)$/.exec(lines.shift() ?? "");
	if (!header) return fail();
	const [, name, channel] = header;
	const text = lines.join("\n").trim();
	const parts = text.split(/^=== Message from [^\n]+ ===\s*$/m);
	if (parts[0]?.trim()) return fail();
	const parsed: SlackMessage[] = [];
	for (const part of parts.slice(1)) {
		const match = /^\s*Message TS: (\d{1,12}\.\d{6})\n([\s\S]*)$/.exec(part);
		if (!match) return fail();
		let body = match[2].trim(),
			replies = 0;
		const thread = /(?:^|\n)Thread: (\d+) replies(?: \(latest: [^\n]+\))?\s*$/.exec(body);
		if (thread) {
			replies = Number(thread[1]);
			body = body.slice(0, thread.index).trim();
		}
		// Body text resembling framing is ambiguous. Fail closed instead of guessing identities.
		if (!body || /^Message TS:|^Thread:|^=== /m.test(body) || !Number.isSafeInteger(replies)) return fail();
		parsed.push({ ts: match[1], threadTs: match[1], text: body, replies });
	}
	if (parsed.length > limit || new Set(parsed.map((message) => message.ts)).size !== parsed.length) return fail();
	const next = parsePagination(pagination, false);
	if (next && !parsed.length) return fail();
	return { channel, name, messages: parsed, ...(next ? { next } : {}) };
}

/** Thread reads have a different format from history, and omit the channel header entirely. */
export function parseSlackThread(
	value: TrackingJson,
	parentTs: string,
	limit: number,
): { messages: SlackMessage[]; next?: string } {
	const fail = () => {
		throw new SlackFormatChanged();
	};
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof value.messages !== "string" ||
		typeof value.pagination_info !== "string" ||
		Buffer.byteLength(value.messages) > 512 * 1024
	)
		return fail();
	const text = value.messages.replace(/\r\n/g, "\n").trim();
	const header =
		/^=== THREAD PARENT MESSAGE ===\n([\s\S]*?)\n=== THREAD REPLIES \((\d+) total\) ===\n?([\s\S]*)$/.exec(text);
	if (!header) return fail();
	const count = Number(header[2]);
	if (!Number.isSafeInteger(count) || count > limit) return fail();
	const parseMessage = (part: string): SlackMessage => {
		const message = /^\s*From: [^\n]+\nTime: [^\n]+\nMessage TS: (\d{1,12}\.\d{6})\n([\s\S]*)$/.exec(part);
		if (!message || !message[2].trim() || /^Message TS:|^=== |^--- Reply /m.test(message[2])) return fail();
		return { ts: message[1], threadTs: parentTs, text: message[2].trim(), replies: count };
	};
	const parent = parseMessage(header[1]);
	if (parent.ts !== parentTs) return fail();
	const replies = header[3].split(/^--- Reply (\d+) of (\d+) ---[ \t]*$/m);
	if (replies[0]?.trim() || replies.length !== count * 3 + 1) return fail();
	const messages = [parent];
	for (let i = 0; i < count; i++) {
		if (Number(replies[i * 3 + 1]) !== i + 1 || Number(replies[i * 3 + 2]) !== count) return fail();
		messages.push(parseMessage(replies[i * 3 + 3]!));
	}
	if (new Set(messages.map((message) => message.ts)).size !== messages.length) return fail();
	const next = parsePagination(value.pagination_info, true);
	return { messages, ...(next ? { next } : {}) };
}
function parsePagination(text: string, thread: boolean): string | undefined {
	const scope = thread ? "in this thread" : "available";
	if (text.trim() === `There are no more messages ${scope}.`) return undefined;
	const next = new RegExp(
		`^There are more messages ${scope}\\. To view the next page, use cursor: \x60([^\x60\\s]{1,96})\x60$`,
	).exec(text.trim())?.[1];
	if (!next) throw new SlackFormatChanged();
	return next;
}
