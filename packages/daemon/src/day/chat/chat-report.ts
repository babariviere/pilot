/** A job chat's report: what it answered, how it knows, its limits and the next step for the user. */
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatReport } from "@pilot/protocol";

/** How a standalone chat was started without the user typing to it. Only these chats get the chat_report tool. */
export type ChatJob = "slack" | "linear" | "schedule";

export const CHAT_REPORT_FILE = "chat-report.json";

/**
 * Limits keep one report readable on the result page and small on disk.
 * - answer: 8,000 characters, about two pages. The page shows it whole; longer material belongs in links or
 *   artifacts. Half the 16,000 characters kept of a final reply, because a report is a summary of that reply.
 * - howItKnows, limits, nextStep: 2,000 characters each, a long paragraph. They support the answer.
 * - links: 10, each URL 2,000 characters (common browser and server URL limits) and title 200.
 * A report is replaced on each call, so it never grows past one report.
 */
export const CHAT_REPORT_LIMITS = { answer: 8_000, field: 2_000, links: 10, url: 2_000, title: 200 } as const;

const FIELDS = ["howItKnows", "limits", "nextStep"] as const;

function text(value: unknown, name: string, limit: number, why: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`chat_report ${name} must be text`);
	const trimmed = value.trim();
	const length = [...trimmed].length;
	if (length > limit)
		throw new Error(
			`chat_report ${name} has ${length.toLocaleString("en-US")} characters; the limit is ${limit.toLocaleString("en-US")} (${why}). Shorten it.`,
		);
	return trimmed || undefined;
}

/** Checks a chat_report call. Refusals name the field, its size and its limit. */
export function parseChatReport(args: Record<string, unknown>, at: number): ChatReport {
	const answer = text(
		args.answer,
		"answer",
		CHAT_REPORT_LIMITS.answer,
		"about two pages; put longer material in links or artifacts",
	);
	if (!answer) throw new Error("chat_report needs an answer");
	const report: ChatReport = { answer, at };
	for (const name of FIELDS) {
		const value = text(args[name], name, CHAT_REPORT_LIMITS.field, "one long paragraph");
		if (value) report[name] = value;
	}
	if (args.links !== undefined && args.links !== null) {
		if (!Array.isArray(args.links)) throw new Error("chat_report links must be a list");
		if (args.links.length > CHAT_REPORT_LIMITS.links)
			throw new Error(
				`chat_report has ${args.links.length} links; the limit is ${CHAT_REPORT_LIMITS.links}. Keep the ones the user needs.`,
			);
		const links: NonNullable<ChatReport["links"]> = [];
		for (const link of args.links) {
			if (!link || typeof link !== "object") throw new Error("chat_report links must be {url, title?}");
			const { url: rawUrl, title: rawTitle } = link as Record<string, unknown>;
			const url = text(rawUrl, "link url", CHAT_REPORT_LIMITS.url, "common URL limits");
			if (!url || !/^(https?|pilot):\/\/\S+$/i.test(url))
				throw new Error(`chat_report link url must start with https://, http:// or pilot://: ${String(rawUrl)}`);
			const title = text(rawTitle, "link title", CHAT_REPORT_LIMITS.title, "one line");
			links.push(title ? { url, title } : { url });
		}
		if (links.length) report.links = links;
	}
	return report;
}

/** Saves the chat's report, replacing the earlier one. */
export async function saveChatReport(dir: string, report: ChatReport): Promise<void> {
	const file = join(dir, CHAT_REPORT_FILE);
	const temp = `${file}.${randomUUID()}.tmp`;
	await writeFile(temp, `${JSON.stringify(report)}\n`, { mode: 0o600 });
	await rename(temp, file);
}

/** The chat's saved report, or undefined when it has none or the file is unreadable. */
export async function readChatReport(dir: string): Promise<ChatReport | undefined> {
	try {
		const value = JSON.parse(await readFile(join(dir, CHAT_REPORT_FILE), "utf8")) as Record<string, unknown>;
		const at = value.at;
		return typeof at === "number" && Number.isSafeInteger(at) ? parseChatReport(value, at) : undefined;
	} catch {
		return undefined;
	}
}
