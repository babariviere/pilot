import type { TrackedKind, TrackingJson } from "@pilot/protocol";
import { isSlackChannelId, isSlackTimestamp } from "./slack/slack-ids.ts";

/** Logical tools that change state at the provider. Source reads may never call them. */
export const SOURCE_WRITE_TOOLS: ReadonlySet<string> = new Set(["startIssue", "publishIssueWrite", "startSlack"]);

/** Fixed dedicated tools. Linear start/synchronization writes change state only; the Slack write is the start reaction. */
export function dedicatedSourceTool(kind: TrackedKind, tool: string): string | undefined {
	if (kind === "linear" && tool === "issues") return "list_issues";
	if (kind === "linear" && tool === "cycles") return "list_cycles";
	if (kind === "linear" && tool === "issue") return "get_issue";
	if (kind === "linear" && tool === "states") return "list_issue_statuses";
	if (kind === "linear" && tool === "me") return "get_user";
	if (kind === "linear" && tool === "startIssue") return "save_issue";
	if (kind === "linear" && tool === "publishIssueRead") return "get_issue";
	if (kind === "linear" && tool === "publishChildrenRead") return "list_issues";
	if (kind === "linear" && tool === "publishIssueWrite") return "save_issue";
	if (kind === "linear" && tool === "teams") return "list_teams";
	if (kind === "slack" && tool === "history") return "slack_read_channel";
	if (kind === "slack" && tool === "profile") return "slack_read_user_profile";
	if (kind === "slack" && tool === "mentionsPrivate") return "slack_search_public_and_private";
	if (kind === "slack" && tool === "thread") return "slack_read_thread";
	if (kind === "slack" && tool === "startSlack") return "slack_add_reaction";
	if (kind === "slack" && tool === "searchChannels") return "slack_search_channels";
	if (kind === "slack" && tool === "myChannels") return "slack_list_user_channels";
	return undefined;
}

/** Write capabilities cannot edit other fields or write any other reaction. */
export function validSourceArguments(tool: string, args: Record<string, unknown>): boolean {
	if (tool === "publishIssueWrite") {
		const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
		const body = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 20_000;
		const title = (v: unknown) => typeof v === "string" && !!v.trim() && [...v].length <= 200;
		const keys = Object.keys(args);
		if (!("id" in args))
			return (
				keys.length === 4 && uuid(args.team) && uuid(args.parentId) && title(args.title) && body(args.description)
			);
		if (!uuid(args.id)) return false;
		if ("blocks" in args)
			return (
				keys.length === 2 &&
				Array.isArray(args.blocks) &&
				args.blocks.length === 1 &&
				uuid(args.blocks[0]) &&
				args.blocks[0] !== args.id
			);
		const patch = args.patch as { op?: unknown; old_string?: unknown; new_string?: unknown }[] | undefined;
		return (
			keys.length === 2 &&
			Array.isArray(patch) &&
			patch.length === 1 &&
			!!patch[0] &&
			Object.keys(patch[0]).length === 3 &&
			patch[0].op === "replace" &&
			body(patch[0].old_string) &&
			body(patch[0].new_string)
		);
	}
	if (tool === "profile") return Object.keys(args).length === 1 && args.response_format === "detailed";
	if (tool === "mentionsPrivate")
		return (
			typeof args.filters === "string" &&
			/^in:(?:<#[CG][A-Z0-9]{1,199}>|[a-z0-9_-]{1,200})(?: with:<@[UW][A-Z0-9]{1,39}>)?$/i.test(args.filters) &&
			args.channel_types === "public_channel,private_channel"
		);
	if (tool === "startSlack")
		return (
			Object.keys(args).length === 3 &&
			args.emoji === "eyes" &&
			isSlackChannelId(args.channel_id) &&
			isSlackTimestamp(args.message_ts)
		);
	return (
		tool !== "startIssue" ||
		(Object.keys(args).length === 2 &&
			typeof args.id === "string" &&
			!!args.id.trim() &&
			args.id.length <= 200 &&
			typeof args.state === "string" &&
			!!args.state.trim() &&
			args.state.length <= 200)
	);
}

export class SourceSignInRequired extends Error {}
export class SourceConfigurationError extends Error {}
/** The caller or connector proved tools/call did not leave this process. */
export class SourceNotDispatched extends Error {}
export type SourceToolFailure = "access_denied" | "not_found" | "tool_error";
/** The tool itself reported an error (for example, no access to one channel). The server was reachable. */
export class SourceToolError extends Error {
	readonly category: SourceToolFailure;
	constructor(message: string, category: SourceToolFailure = "tool_error") {
		super(message);
		this.category = category;
	}
}

/** Only recognized status/code values cross the worker boundary, never provider prose. */
export function sourceToolFailure(value: unknown): SourceToolFailure {
	const object = (v: unknown): Record<string, unknown> =>
		v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	const root = object(value);
	let payload = object(root.structuredContent);
	// MCP error envelopes can carry structured codes in one JSON text block instead.
	if (!root.structuredContent && Array.isArray(root.content) && root.content.length === 1) {
		const block = object(root.content[0]);
		if (block.type === "text" && typeof block.text === "string" && block.text.length <= 8192) {
			try {
				payload = object(JSON.parse(block.text));
			} catch {
				/* Unstructured prose is not a reliable category. */
			}
		}
	}
	const data = object(root.data);
	const detail = object(payload.error ?? root.error);
	const codes = [root, payload, data, detail].flatMap((v) => [v.code, v.status, v.statusCode, v.error]);
	const normalized = codes.map((code) => (typeof code === "string" && code.length <= 100 ? code.toUpperCase() : code));
	const denied = new Set<unknown>([403, "403", "FORBIDDEN", "PERMISSION_DENIED", "ACCESS_DENIED"]);
	const missing = new Set<unknown>([404, "404", "NOT_FOUND", "ENTITY_NOT_FOUND"]);
	if (normalized.some((c) => denied.has(c))) return "access_denied";
	if (normalized.some((c) => missing.has(c))) return "not_found";
	return "tool_error";
}
export class SourceRateLimited extends Error {
	readonly retryAfterMs: number;
	constructor(retryAfterMs = 60_000) {
		super("Source rate limited");
		this.retryAfterMs = retryAfterMs;
	}
}
/** Extract only safe retry timing, never forward provider error text or credentials. */
export function sourceRateLimit(value: unknown): SourceRateLimited | undefined {
	if (!value || typeof value !== "object") return;
	const error = value as Record<string, unknown>;
	const payload = error.structuredContent as Record<string, unknown> | undefined;
	const detail =
		payload?.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : payload;
	const blocks = Array.isArray(error.content) ? error.content.slice(0, 2) : [];
	const text = [
		error.message,
		error.error,
		detail?.message,
		detail?.error,
		detail?.code,
		...blocks.map((block) => block?.text),
	]
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.slice(0, 8192))
		.join(" ")
		.slice(0, 16_384);
	if (
		![error.status, error.statusCode, error.code, detail?.status, detail?.code].some(
			(code) => code === 429 || code === "429",
		) &&
		!/rate[ _-]?limit|too many requests|\b429\b/i.test(text)
	)
		return;
	const data = error.data as Record<string, unknown> | undefined;
	const headers = error.headers as Record<string, unknown> | undefined;
	const seconds = Number(
		error.retryAfter ??
			data?.retryAfter ??
			detail?.retryAfter ??
			headers?.["retry-after"] ??
			text.match(/retry[ _-]?after["\s:=]+(\d+)/i)?.[1] ??
			60,
	);
	return new SourceRateLimited(
		Number.isFinite(seconds) ? Math.min(86_400_000, Math.max(1_000, seconds * 1000)) : 60_000,
	);
}

/** Accept structuredContent or JSON text only. Markdown fields stay text for source-specific parsing. */
export function decodeMcpResult(
	result: {
		structuredContent?: unknown;
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
	},
	tool?: string,
): TrackingJson {
	if (tool === "startSlack") return decodeSlackReaction(result);
	if (result.isError)
		throw sourceRateLimit(result) ?? new SourceToolError("MCP tool returned an error", sourceToolFailure(result));
	const value =
		result.structuredContent ??
		(() => {
			const blocks = result.content?.filter((block) => block.type === "text") ?? [];
			if (blocks.length !== 1 || typeof blocks[0]?.text !== "string")
				throw new Error("MCP tool did not return JSON");
			if (Buffer.byteLength(blocks[0].text) > 512 * 1024) throw new Error("MCP response exceeds 512 KiB");
			return JSON.parse(blocks[0].text) as unknown;
		})();
	const json = JSON.stringify(value);
	if (!json || Buffer.byteLength(json) > 512 * 1024) throw new Error("MCP response exceeds 512 KiB or is empty");
	if (
		["issue", "states", "startIssue", "publishIssueRead", "publishChildrenRead", "publishIssueWrite"].includes(
			tool ?? "",
		) &&
		value &&
		typeof value === "object" &&
		(("error" in value && !!value.error) ||
			("success" in value && value.success === false) ||
			("ok" in value && value.ok === false))
	)
		throw (
			sourceRateLimit({ structuredContent: value }) ??
			new SourceToolError("MCP tool returned an error", sourceToolFailure({ structuredContent: value }))
		);
	return JSON.parse(json) as TrackingJson;
}

/** Normalize before generic error redaction: already_reacted is success only for this fixed write.
 * No provider text (including successful responses) leaves the worker. */
function decodeSlackReaction(result: Parameters<typeof decodeMcpResult>[0]): TrackingJson {
	const text = (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	if (Buffer.byteLength(text) > 512 * 1024) throw new SourceToolError("Invalid Slack reaction response");
	let value = result.structuredContent;
	if (value === undefined) {
		try {
			value = JSON.parse(text);
		} catch {
			/* This tool can also return a plain confirmation. */
		}
	}
	if (Buffer.byteLength(JSON.stringify(value) ?? "") > 512 * 1024)
		throw new SourceToolError("Invalid Slack reaction response");
	const data =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	const error = data?.error;
	const code = error && typeof error === "object" ? (error as Record<string, unknown>).code : (error ?? data?.code);
	// Newer servers wrap the same confirmation text in result, in JSON text or structuredContent.
	const confirmation = data ? (typeof data.result === "string" ? data.result : "") : text;
	if (code === "already_reacted" || (!error && !code && slackAlreadyReacted(new Error(confirmation))))
		return { ok: true };
	if (result.isError) throw sourceRateLimit(result) ?? new SourceToolError("Couldn't add Slack reaction");
	if (error || data?.ok === false || data?.success === false)
		throw sourceRateLimit(result) ?? new SourceToolError("Couldn't add Slack reaction");
	if (data && (data.ok === true || data.success === true)) return { ok: true };
	if (
		!/\b(?:error|failed|failure|not|unable|cannot|can't|couldn't)\b/i.test(confirmation) &&
		/\b(?:added\b[^\n]*\breaction|reaction\b[^\n]*\badded)\b/i.test(confirmation)
	)
		return { ok: true };
	throw sourceRateLimit(result) ?? new SourceToolError("Couldn't add Slack reaction");
}

/** Some MCP transports throw tool errors instead of returning an isError envelope. Extract only this code. */
export function slackAlreadyReacted(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const value = error as Record<string, unknown>;
	const data = value.data && typeof value.data === "object" ? (value.data as Record<string, unknown>) : undefined;
	return (
		value.code === "already_reacted" ||
		value.error === "already_reacted" ||
		data?.error === "already_reacted" ||
		(typeof value.message === "string" && /\balready_reacted\b/.test(value.message.slice(0, 8192)))
	);
}
