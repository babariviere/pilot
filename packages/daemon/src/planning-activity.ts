/** Live planning activity and a compact planning chat for the native planning page. Reads saved history and the
 * worker's in-memory run facts only. It never starts, wakes or subscribes to the coordinator. */
import type { EntryRecord, PlanningActivity, PlanningChatPage, PlanningChatRow, PlanningStep } from "@pilot/protocol";

/** At most this many UTF-8 bytes of one chat message are shown. */
export const CHAT_TEXT_BYTES = 8_000;
const TARGET_CHARS = 200;
const ACTION_CHARS = 80;

type Block = { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown; text?: unknown };
type Message = { role?: unknown; content?: unknown; timestamp?: unknown; toolCallId?: unknown; isError?: unknown };

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const messages = (entry: EntryRecord): Message[] => (entry.model ?? []) as unknown as Message[];
const blocks = (message: Message): Block[] => (Array.isArray(message.content) ? (message.content as Block[]) : []);

function oneLine(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = value.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A path relative to the chat's working directory when it is inside it. */
function shortPath(value: unknown, cwd: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return oneLine(cwd && value.startsWith(root) ? value.slice(root.length) : value, TARGET_CHARS);
}

/** The step a tool call makes, as data. Only small known arguments leave the call. */
export function planningStep(
	call: { name: string; arguments?: unknown },
	cwd: string,
	result?: { failed: boolean },
): PlanningStep {
	const args = record(call.arguments);
	const request = record(args.request);
	const action =
		args.action === "write" && typeof request.purpose === "string"
			? oneLine(request.purpose, ACTION_CHARS)
			: oneLine(args.action, ACTION_CHARS);
	const target =
		call.name === "grep"
			? oneLine(args.pattern, TARGET_CHARS)
			: (shortPath(args.path, cwd) ??
				oneLine(args.query, TARGET_CHARS) ??
				oneLine(args.url, TARGET_CHARS) ??
				oneLine(args.pattern, TARGET_CHARS));
	return {
		tool: oneLine(call.name, ACTION_CHARS) ?? "tool",
		running: result === undefined,
		failed: result?.failed === true,
		...(action ? { action } : {}),
		...(target ? { target } : {}),
	};
}

/** Saved tool results by call ID: whether each failed. */
function results(entries: readonly EntryRecord[]): Map<string, { failed: boolean }> {
	const out = new Map<string, { failed: boolean }>();
	for (const entry of entries)
		for (const message of messages(entry))
			if (message.role === "toolResult" && typeof message.toolCallId === "string")
				out.set(message.toolCallId, { failed: message.isError === true });
	return out;
}

function calls(entry: EntryRecord): { id: string; name: string; arguments?: unknown }[] {
	if (entry.kind !== "pi.assistant") return [];
	return messages(entry)
		.filter((m) => m.role === "assistant")
		.flatMap(blocks)
		.filter((b) => b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string")
		.map((b) => ({ id: b.id as string, name: b.name as string, arguments: b.arguments }));
}

/**
 * The newest step from a newest-first-readable page of history, and when anything was last saved.
 * A step whose result is saved is done; the run is then between steps.
 */
export function planningActivity(
	input: {
		sessionId: string;
		working: boolean;
		workingSince?: number;
		toolProgressAt?: number;
		cwd: string;
	},
	entries: readonly EntryRecord[],
): PlanningActivity {
	let lastStepAt = input.toolProgressAt ?? 0;
	for (const entry of entries)
		for (const message of messages(entry))
			if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp))
				lastStepAt = Math.max(lastStepAt, message.timestamp);
	let step: PlanningStep | null = null;
	if (input.working) {
		const saved = results(entries);
		// Only the current run's steps: stop at the input that started it.
		for (const entry of [...entries].sort((a, b) => Number(b.id) - Number(a.id))) {
			if (entry.kind === "pi.user" || entry.kind === "pilot.planning-input") break;
			if (entry.kind !== "pi.assistant") continue;
			const last = calls(entry).at(-1);
			if (last) step = planningStep(last, input.cwd, saved.get(last.id));
			break;
		}
	}
	return {
		sessionId: input.sessionId,
		working: input.working,
		workingSince: input.working ? (input.workingSince ?? null) : null,
		lastStepAt: lastStepAt > 0 ? lastStepAt : null,
		step,
	};
}

function limited(text: string): { text: string; shortened: boolean } {
	const bytes = Buffer.from(text);
	if (bytes.length <= CHAT_TEXT_BYTES) return { text, shortened: false };
	// Cut on a character boundary: drop a partial trailing sequence.
	return {
		text: bytes
			.subarray(0, CHAT_TEXT_BYTES)
			.toString("utf8")
			.replace(/\uFFFD+$/, ""),
		shortened: true,
	};
}

function texts(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return blocks(message)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

/**
 * Compact rows for one history page, oldest first. Tool results only mark their step done or failed.
 * Only the newest page can have a running step: an older page's results may sit in a newer page.
 */
export function planningChatRows(entries: readonly EntryRecord[], cwd: string, newest: boolean): PlanningChatRow[] {
	const saved = results(entries);
	const rows: PlanningChatRow[] = [];
	for (const entry of [...entries].sort((a, b) => Number(a.id) - Number(b.id))) {
		const entryId = Number(entry.id);
		if (!Number.isSafeInteger(entryId)) continue;
		if (entry.kind === "pilot.planning-input") {
			rows.push({ key: `${entryId}`, entryId, role: "request" });
			continue;
		}
		const role = entry.kind === "pi.user" ? "user" : entry.kind === "pi.assistant" ? "assistant" : undefined;
		if (!role) continue;
		const text = messages(entry)
			.filter((m) => m.role === role)
			.map(texts)
			.filter((t) => t.trim())
			.join("\n\n");
		if (text.trim())
			rows.push({ key: `${entryId}`, entryId, role: role === "user" ? "you" : "pilot", ...limited(text) });
		calls(entry).forEach((call, index) => {
			const result = saved.get(call.id) ?? (newest ? undefined : { failed: false });
			rows.push({ key: `${entryId}.${index}`, entryId, role: "step", step: planningStep(call, cwd, result) });
		});
	}
	return rows;
}

/** One chat page from a history page. */
export function planningChatPage(
	input: { missionId: string; sessionId: string; cwd: string; newest: boolean },
	history: { entries: readonly EntryRecord[]; more: boolean },
): PlanningChatPage {
	const ids = history.entries.map((e) => Number(e.id)).filter(Number.isSafeInteger);
	const oldest = ids.length ? Math.min(...ids) : null;
	return {
		version: 1,
		missionId: input.missionId,
		sessionId: input.sessionId,
		rows: planningChatRows(history.entries, input.cwd, input.newest),
		more: history.more && oldest !== null && oldest > 1,
		nextBefore: oldest,
	};
}

/**
 * Coalesces one mission's activity notices: the first goes at once, then at most one per `intervalMs`,
 * with a trailing one so the last change is never lost.
 */
export class PlanningActivityNotices {
	private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly sentAt = new Map<string, number>();
	private readonly send: (missionId: string) => void;
	private readonly intervalMs: number;
	private readonly now: () => number;
	constructor(send: (missionId: string) => void, intervalMs = 1_000, now: () => number = Date.now) {
		this.send = send;
		this.intervalMs = intervalMs;
		this.now = now;
	}
	touch(missionId: string): void {
		if (this.waiting.has(missionId)) return;
		const wait = (this.sentAt.get(missionId) ?? Number.NEGATIVE_INFINITY) + this.intervalMs - this.now();
		if (wait <= 0) return this.fire(missionId);
		const timer = setTimeout(() => {
			this.waiting.delete(missionId);
			this.fire(missionId);
		}, wait);
		timer.unref?.();
		this.waiting.set(missionId, timer);
	}
	private fire(missionId: string): void {
		this.sentAt.set(missionId, this.now());
		// Keep only recent missions: an old entry has no effect on the next wait.
		if (this.sentAt.size > 256) for (const [id] of this.sentAt) if (id !== missionId && this.sentAt.delete(id)) break;
		this.send(missionId);
	}
	close(): void {
		for (const timer of this.waiting.values()) clearTimeout(timer);
		this.waiting.clear();
	}
}
