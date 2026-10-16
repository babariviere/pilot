/** A fresh request projection, not a second model loop or a rewrite of Harness history. */
import type { Context, JsonValue } from "@earendil-works/chord";
import { contentText, getCurrentTools, type Message } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Extension,
	GenerationTask,
	type Harness,
	hook,
	LiveDoc,
	type Storage,
} from "@earendil-works/pi-durable";
import { CONTROL_SYSTEM_PROMPT, type ControlContextLine, controlBlocks } from "./control-context.ts";

export type ControlCall = (
	action: "record" | "prepare" | "zoom" | "date",
	args: Record<string, JsonValue>,
) => Promise<JsonValue>;
const JournalDoc = defineDoc<{ through: number; anchor: number; lines: ControlContextLine[] }>({
	kind: "pilot.control-turn",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ through: 0, anchor: 0, lines: [] }),
});
function log(entry: EntryRecord): Array<Record<string, JsonValue>> {
	const out: Array<Record<string, JsonValue>> = [];
	for (const [i, message] of (entry.model ?? []).entries()) {
		const key = `entry:${entry.id}:${i}`;
		if (message.role === "user")
			out.push({
				key,
				kind: entry.data && typeof entry.data === "object" && "event" in entry.data ? "event" : "user",
				text: contentText(message.content),
				at: message.timestamp,
			});
		if (message.role === "toolResult")
			out.push({ key, kind: "echo", text: contentText(message.content), at: message.timestamp });
		if (message.role === "assistant")
			for (const [j, block] of message.content.entries()) {
				if (block.type === "text")
					out.push({ key: `${key}:${j}`, kind: "assistant", text: block.text, at: message.timestamp });
				if (block.type === "toolCall")
					out.push({
						key: `${key}:${j}`,
						kind: "tool",
						text: "",
						name: block.name,
						input: block.arguments as JsonValue,
						at: message.timestamp,
					});
			}
	}
	return out;
}
export class ControlTurn {
	private readonly call: ControlCall;
	private readonly host: () => Harness;
	private readonly storage: Storage;
	private readonly conversationId: () => ConversationId;
	private serial: Promise<unknown> = Promise.resolve();
	constructor(call: ControlCall, host: () => Harness, storage: Storage, conversationId: () => ConversationId) {
		this.call = call;
		this.host = host;
		this.storage = storage;
		this.conversationId = conversationId;
	}
	/** Incremental committed-entry drain. A storage cursor advances only after idempotent log admission. */
	record(context: Context, max?: number): Promise<void> {
		const work = this.serial.then(async () => {
			const harness = this.host(),
				id = this.conversationId();
			for (;;) {
				const journal = await harness.snapshot(JournalDoc, id, context);
				const page = await this.storage.scanEntries(
					{
						conversationId: id,
						minEntryId: ((journal?.through ?? 0) + 1) as EntryId,
						...(max !== undefined ? { maxEntryId: max as EntryId } : {}),
						order: "ascending",
					},
					32,
					undefined,
					context,
				);
				if (!page.items.length) return;
				for (const entry of page.items) {
					for (const message of log(entry)) await this.call("record", { message });
					await harness.commit(async (tx) => {
						const state = await tx.doc(JournalDoc, id);
						state.through = Math.max(state.through, Number(entry.id));
					}, context);
				}
			}
		});
		this.serial = work.catch(() => {});
		return work;
	}
	prepare(extension: Extension, cache: (block?: string) => void): Extension {
		return {
			...extension,
			hooks: [
				...(extension.hooks ?? []),
				hook(GenerationTask, {
					beforeRequest: async (request, _api, context) => {
						const harness = this.host(),
							id = this.conversationId(),
							live = await harness.snapshot(LiveDoc, id, context);
						const first = live?.run?.inputs[0];
						const submission = first ? await this.storage.submission(first, context) : undefined;
						if (!submission?.entry) throw new Error("Control turn requires a committed input");
						const anchor = Number(submission.entry);
						await this.record(context, anchor - 1);
						let state = await harness.snapshot(JournalDoc, id, context);
						const result = (await this.call("prepare", {
							key: String(anchor),
							requestId: submission.requestId ?? "",
							tools: JSON.parse(JSON.stringify(getCurrentTools(request.messages))) as JsonValue,
						})) as { lines: ControlContextLine[] };
						if (state?.anchor !== anchor) {
							await harness.commit(async (tx) => {
								const state = await tx.doc(JournalDoc, id);
								state.anchor = anchor;
								state.lines = result.lines;
							}, context);
							state = await harness.snapshot(JournalDoc, id, context);
						}
						await this.record(context);
						const page = await this.storage.scanEntries(
							{ conversationId: id, minEntryId: anchor as EntryId, order: "ascending" },
							4096,
							undefined,
							context,
						);
						if (page.next !== undefined) throw new Error("Control turn exceeds 4096 entries; start a new turn");
						const messages = page.items
							.flatMap((entry) => entry.model ?? [])
							.filter((message) => message.role !== "system");
						const { blocks, lastWhole } = controlBlocks(state?.lines ?? []);
						cache(lastWhole ?? "");
						return {
							messages: [
								{
									role: "system",
									content: CONTROL_SYSTEM_PROMPT,
									toolsAdded: getCurrentTools(request.messages),
									timestamp: 0,
								},
								{ role: "user", content: blocks.map((text) => ({ type: "text", text })), timestamp: 0 },
								...messages,
							] as Message[],
						};
					},
				}),
			],
		};
	}
}
