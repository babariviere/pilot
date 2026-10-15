import type { TrackingJson } from "@pilot/protocol";
import { SlackFormatChanged, type SlackPage, slackTimestamp } from "./slack-format.ts";

export interface SlackIdentity {
	id: string;
	username: string;
}

/** Keep only stable matching fields, never contact/profile information. Detailed format carries the ID. */
export function parseSlackIdentity(value: TrackingJson): SlackIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.result !== "string")
		throw new SlackFormatChanged("profile fields");
	const id = /^User ID: ([UW][A-Z0-9]{1,39})\s*$/m.exec(value.result)?.[1];
	const username = /^Username: @?([a-z0-9._-]{1,80})\s*$/im.exec(value.result)?.[1];
	if (!id || !username) throw new SlackFormatChanged("profile identity");
	return { id, username };
}

/** Raw Slack markup and MCP-rendered handles. Broadcast mentions can never match. */
export function mentionsMe(text: string, me: SlackIdentity, groups: string[]): boolean {
	if (new RegExp(`<@${me.id}(?:\\|[^<>\\n]+)?>`).test(text)) return true;
	const handles = [me.username, ...groups].filter((handle) => !/^(here|channel|everyone)$/i.test(handle));
	return handles.some((handle) => {
		const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`<!subteam\\^[A-Z0-9]+\\|@?${escaped}>|(?:^|[^\\w@./-])@${escaped}(?![\\w.-])`, "i").test(text);
	});
}

/** Dedicated Slack searches' detailed wire format. Reply permalinks identify the parent through thread_ts.
 * Search text is only qualification evidence, never classifier context or the tracked item's identity. */
export function parseSlackMentions(value: TrackingJson, channel: string, name: string, limit: number): SlackPage {
	const fail = (reason: string): never => {
		throw new SlackFormatChanged(reason);
	};
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof value.results !== "string" ||
		typeof value.pagination_info !== "string" ||
		Buffer.byteLength(value.results) > 512 * 1024
	)
		return fail("search fields");
	const text = value.results.replace(/\r\n/g, "\n");
	if (!text.startsWith("# Search Results for:")) return fail("search header");
	const pagination = value.pagination_info.trim().replace(/\\n$/, "");
	const next = /^For the next page of results use cursor `([^`\s]{1,96})`$/.exec(pagination)?.[1];
	if (!next && pagination !== "End of results - No more pages available.") return fail("search pagination");
	const parts = text.split(/^### (?:Result|Message) \d+ of \d+[ \t]*$/m);
	if (parts.length === 1) {
		if (!/\nNo results found\.\s*$/.test(text) || next) return fail("search results");
		return { channel, name, messages: [] };
	}
	if (parts.length - 1 > limit) return fail("search result count");
	const messages = parts.slice(1).map((part) => {
		const fields =
			/^\s*Channel: #([^\n]+) \(ID: ([CG][A-Z0-9]{1,199})\)\nFrom: [^\n]+\nTime: [^\n]+\nMessage_ts: (\d{1,12}\.\d{6})\nPermalink: (https:\/\/[^\s]+)\nText:([\s\S]*)$/.exec(
				part,
			);
		if (!fields) return fail("search message fields");
		const [, foundName, foundChannel, ts, permalink, body] = fields;
		if (/^[CDG][A-Z0-9]+$/.test(channel) ? foundChannel !== channel : foundName !== channel.replace(/^#/, ""))
			return fail("search channel mismatch");
		let url: URL;
		try {
			url = new URL(permalink!);
		} catch {
			return fail("search permalink");
		}
		if (
			!/^(?:[a-z0-9-]+\.)?slack\.com$/.test(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== `/archives/${foundChannel}/p${ts!.replace(".", "")}`
		)
			return fail("search permalink");
		const threadTs = url.searchParams.get("thread_ts") ?? ts;
		if (!slackTimestamp(threadTs)) return fail("search parent timestamp");
		return { ts: ts!, threadTs, text: body!.trim(), replies: 0 };
	});
	// The scope was validated on every result. Names are display-only.
	const first = /^\s*Channel: #([^\n]+) \(ID: ([CG][A-Z0-9]{1,199})\)/.exec(parts[1]!);
	return { channel: first![2]!, name: first![1]!, messages, ...(next ? { next } : {}) };
}
