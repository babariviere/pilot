/** Read-only lookups for the project settings pickers. Responses are parsed strictly and bounded. */
import type { LinearTeamOption, SlackChannelOption, TrackingJson } from "@pilot/protocol";

export type LookupCall = (tool: string, args: Record<string, unknown>) => Promise<TrackingJson>;
export class LookupFormatChanged extends Error {
	constructor() {
		super("The source returned an unexpected format.");
	}
}
const TEAM_LIMIT = 250;
const SEARCH_LIMIT = 20;
const MY_CHANNELS_LIMIT = 100;

/** Teams in my Linear workspace. A query narrows the list on the server. */
export async function lookupLinearTeams(
	call: LookupCall,
	query?: string,
): Promise<{ items: LinearTeamOption[]; more: boolean }> {
	const response = await call("teams", { limit: TEAM_LIMIT, ...(query ? { query } : {}) });
	if (!response || typeof response !== "object" || Array.isArray(response) || !Array.isArray(response.teams))
		throw new LookupFormatChanged();
	if (response.teams.length > TEAM_LIMIT) throw new LookupFormatChanged();
	const items = response.teams.map((value): LinearTeamOption => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new LookupFormatChanged();
		const id = text(value.id, 200),
			name = text(value.name, 200),
			key = text(value.key, 50);
		const parentId = typeof value.parentId === "string" && value.parentId ? text(value.parentId, 200) : undefined;
		return { id, name, key, ...(parentId ? { parentId } : {}) };
	});
	items.sort((a, b) => a.name.localeCompare(b.name));
	return { items, more: response.hasNextPage === true };
}

/** Public and private channels matching a query, or the channels I'm in when the query is empty. */
export async function lookupSlackChannels(
	call: LookupCall,
	query?: string,
): Promise<{ items: SlackChannelOption[]; more: boolean }> {
	const words = (query ?? "")
		.split(/\s+/)
		.map((word) => word.replace(/^#/, "").replace(/["]/g, ""))
		.filter(Boolean)
		.slice(0, 5);
	if (!words.length) return parseMyChannels(await call("myChannels", myChannelsArgs()));
	return parseSearch(
		await call("searchChannels", {
			keywords: words,
			natural_language_query: "",
			channel_types: "public_channel,private_channel",
			include_archived: false,
			limit: SEARCH_LIMIT,
			response_format: "concise",
		}),
	);
}
function myChannelsArgs() {
	return { types: "public_channel,private_channel", exclude_archived: true, limit: MY_CHANNELS_LIMIT };
}

/** Concise search: "1. #name (C0123) - public_channel - ...". */
export function parseSearch(value: TrackingJson): { items: SlackChannelOption[]; more: boolean } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new LookupFormatChanged();
	const { results, pagination_info: pagination } = value;
	if (typeof results !== "string" || Buffer.byteLength(results) > 256 * 1024) throw new LookupFormatChanged();
	if (/^No results found\.?$/m.test(results)) return { items: [], more: false };
	const header = /^## Channels \((\d+) results?\)$/m.exec(results);
	if (!header) throw new LookupFormatChanged();
	const items: SlackChannelOption[] = [];
	for (const line of results.split("\n")) {
		const match = /^\d+\. #([^\s()]{1,200}) \(([CG][A-Z0-9]{2,30})\) - (public_channel|private_channel)\b/.exec(line);
		if (match) items.push({ id: match[2]!, name: match[1]!, private: match[3] === "private_channel" });
	}
	if (!items.length || items.length > SEARCH_LIMIT) throw new LookupFormatChanged();
	return { items: dedupe(items), more: typeof pagination === "string" && /cursor/i.test(pagination) };
}

/** Full format: "### #name" followed by "- **ID:** C0123" and "- **Type:** Public Channel". */
export function parseMyChannels(value: TrackingJson): { items: SlackChannelOption[]; more: boolean } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new LookupFormatChanged();
	const { result } = value;
	if (typeof result !== "string" || Buffer.byteLength(result) > 512 * 1024) throw new LookupFormatChanged();
	if (/^You are not a member of any channels/m.test(result)) return { items: [], more: false };
	if (!/^## My Channels\b/m.test(result)) throw new LookupFormatChanged();
	const items: SlackChannelOption[] = [];
	for (const block of result.split(/^### /m).slice(1)) {
		const name = /^#([^\s()]{1,200})\s*$/m.exec(block.split("\n")[0] ?? "")?.[1];
		const id = /^- \*\*ID:\*\* ([CG][A-Z0-9]{2,30})\s*$/m.exec(block)?.[1];
		const type = /^- \*\*Type:\*\* (Public|Private) Channel\s*$/m.exec(block)?.[1];
		if (!name || !id || !type) throw new LookupFormatChanged();
		items.push({ id, name, private: type === "Private" });
	}
	if (items.length > MY_CHANNELS_LIMIT) throw new LookupFormatChanged();
	items.sort((a, b) => a.name.localeCompare(b.name));
	return { items: dedupe(items), more: /more results available/i.test(result) };
}
function dedupe(items: SlackChannelOption[]): SlackChannelOption[] {
	const seen = new Set<string>();
	return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
}
function text(value: TrackingJson | undefined, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new LookupFormatChanged();
	return value;
}
