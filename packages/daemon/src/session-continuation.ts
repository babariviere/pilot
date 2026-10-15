/** Provider-neutral handoff text. Never copy durable entries, model messages or compaction summaries. */
import type { AgentEvent } from "@pilot/protocol";
import { Conflict } from "./errors.ts";

/** User queue text transfers losslessly as separate input, never as a truncated handoff excerpt. */
export function continuationQueuedInputs(events: readonly AgentEvent[]) {
	return (events.findLast((event) => event.type === "queue_update")?.items ?? []).map((item) => {
		if (typeof item.content !== "string" && item.content.some((part) => part.type !== "text"))
			throw new Conflict("Send or remove queued images before continuing with another model");
		return {
			id: item.id,
			mode: item.mode,
			content:
				typeof item.content === "string"
					? item.content
					: item.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
		};
	});
}

const MAX_HANDOFF = 32_000;
const MAX_MESSAGE = 4_000;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function plainText(value: unknown): string {
	if (typeof value === "string") return value.slice(0, MAX_MESSAGE);
	if (!Array.isArray(value)) return "";
	return value
		.filter((part) => record(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => (part as { text: string }).text.slice(0, MAX_MESSAGE))
		.join("\n")
		.slice(0, MAX_MESSAGE);
}

function visibleEntries(events: readonly AgentEvent[]) {
	return events.flatMap((event) =>
		event.type === "snapshot" || event.type === "snapshot_prefix"
			? event.entries
			: event.type === "entry_appended"
				? [event.entry]
				: [],
	);
}

/** Latest visible assistant text only, never signatures, thinking or tool-result payloads. */
export function continuationAnswer(events: readonly AgentEvent[]): string | undefined {
	for (const entry of visibleEntries(events).slice(-64).reverse()) {
		if (entry.kind !== "pi.message") continue;
		for (const message of [...(entry.model ?? [])].reverse())
			if (message.role === "assistant") {
				const text = plainText(message.content);
				if (text) return text.slice(0, 1_000);
			}
	}
	return undefined;
}

export function continuationHandoff(
	chat: {
		id: string;
		title: string;
		cwd: string;
		branch?: string;
		pullRequests: string[];
		pending: string[];
		children?: { name: string; task: string; state: string; answer?: string; error?: string }[];
	},
	events: readonly AgentEvent[],
): string {
	const excerpts: string[] = [];
	let remaining = 13_000;
	const entries = visibleEntries(events);
	for (const entry of entries.slice(-64).reverse()) {
		if (entry.kind !== "pi.user" && entry.kind !== "pi.message") continue;
		for (const message of [...(entry.model ?? [])].reverse()) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = plainText(message.content);
			if (!text) continue;
			const excerpt = `${message.role === "user" ? "User" : "Assistant"}: ${text}`.slice(0, remaining);
			excerpts.unshift(excerpt);
			remaining -= excerpt.length;
			if (remaining <= 0) break;
		}
		if (remaining <= 0) break;
	}
	return [
		`Continue the work from chat ${chat.id} (${chat.title.slice(0, 200)}).`,
		"This is a fresh conversation with a plain-text handoff, not imported conversation history.",
		"The previous chat is read-only. You now own its workspace, branch, pull requests and task claims.",
		"Inspect the current files and mission state before making changes. Do not assume interrupted tools finished.",
		`Workspace: ${chat.cwd.slice(0, 1_000)}`,
		...(chat.branch ? [`Branch/bookmark: ${chat.branch.slice(0, 200)}`] : []),
		chat.pullRequests
			.slice(0, 16)
			.map((url) => `Pull request: ${url}`)
			.join("\n")
			.slice(0, 2_000),
		"",
		"Previous subagents are retired, not resumed. Reassign any unfinished tasks:",
		(chat.children ?? [])
			.slice(0, 16)
			.map((child) =>
				[
					`Subagent ${child.name.slice(0, 100)} (${child.state}): ${child.task.slice(0, 600)}`,
					child.answer ? `Latest answer: ${child.answer.slice(0, 1_000)}` : "No completed answer available.",
					...(child.error ? [`Error: ${child.error.slice(0, 300)}`] : []),
				].join("\n"),
			)
			.join("\n\n")
			.slice(0, 8_000),
		"",
		"Recent visible conversation (excerpts, possibly incomplete):",
		...excerpts,
		"",
		"Pending user requests:",
		[
			...events.flatMap((event) =>
				event.type === "queue_update" ? event.items.slice(-16).map((item) => plainText(item.content)) : [],
			),
			...chat.pending.slice(-16).map((text) => plainText(text)),
		]
			.join("\n")
			.slice(-4_000),
		"",
		"Unfinished chat todos (recreate any still needed in this chat):",
		(events.findLast((event) => event.type === "todos_update")?.items ?? [])
			.filter((item) => item.status !== "done" && item.status !== "closed")
			.slice(0, 24)
			.map((item) => `${item.status}: ${item.title.slice(0, 120)}`)
			.join("\n"),
		"",
		"Continue the user's unfinished work. Use the original chat for reference if more context is needed.",
	]
		.join("\n")
		.slice(0, MAX_HANDOFF);
}
