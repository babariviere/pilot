/* Portions adapted from pi-durable 1.4, MIT License.
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/** Bridge Durable state/commit observations to Pilot's stable wire events.
 * Translation adapted from pi-durable 1.4 (MIT, Earendil Works).
 */
import type { Context } from "@earendil-works/chord/context";
import type { Op, Path } from "@earendil-works/chord/delta";
import { NativeWatch, type WatchEnd } from "@earendil-works/chord/watch";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type AgentState,
	type CommitChange,
	type CommitPublication,
	type ConversationId,
	type ConversationView,
	type Cursor,
	type EntryRecord,
	type Harness,
	type InboxState,
	type JsonObject,
	type LiveState,
	NestedCallDoc,
	type NestedCallState,
	type NestedToolExecutionResult,
	type NestedToolSlot,
	type SubmissionRecord,
	type TaskId,
	type ToolSlot,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import type {
	BaseAgentEvent as AgentEvent,
	MessageChange,
	QueuedItem,
	SnapshotEvent,
	ToolEventCall,
} from "@pilot/protocol";
import { wireCompactionFailure, wireCompactions } from "./wire-compaction.ts";

type Block = AssistantMessage["content"][number];
/** The typed parts of a view the events read. */
type Parts = {
	live: LiveState;
	inbox: InboxState | undefined;
	agent: AgentState | undefined;
	usage: UsageState | undefined;
};

function parts(view: ConversationView): Parts {
	return {
		live: (view.docs["pi.live"] ?? {}) as LiveState,
		inbox: view.docs["pi.inbox"] as InboxState | undefined,
		agent: view.docs["pi.agent"] as AgentState | undefined,
		usage: view.docs["pi.usage"] as UsageState | undefined,
	};
}

function snapshotOf(view: ConversationView, entries: readonly EntryRecord[] = view.entries): SnapshotEvent {
	const { live, inbox, agent, usage } = parts(view);
	return {
		type: "snapshot",
		entries,
		...(live.run === undefined ? {} : { run: { inputs: live.run.inputs } }),
		...(live.generation === undefined ? {} : { generation: live.generation as SnapshotEvent["generation"] }),
		tools: live.tools ?? [],
		nestedTools: live.nestedTools ?? [],
		compactions: wireCompactions(live.compactions),
		...(live.compactionFailure === undefined
			? {}
			: { compactionFailure: wireCompactionFailure(live.compactionFailure) }),
		inbox: queued(inbox),
		agent: agent ?? AgentDoc.definition.initial(),
		usage: usage ?? UsageDoc.definition.initial(),
	};
}

function queued(inbox: InboxState | undefined): QueuedItem[] {
	return (inbox?.items ?? []).map((item) => ({ id: item.id, mode: item.mode }));
}

export interface AgentEventStream {
	readonly snapshot: SnapshotEvent;
	start(listener: (events: readonly AgentEvent[], context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
	readonly closed: Promise<WatchEnd>;
}

export async function watchEvents(
	harness: Harness,
	conversationId: ConversationId,
	context: Context,
): Promise<AgentEventStream> {
	let current: ConversationView | undefined;
	let previous: ConversationView | undefined;
	let ops: readonly Op[] = [];
	let detachCommit = () => {};
	const held = new Set<TaskId>();
	let observation: Awaited<ReturnType<Harness["observeConversation"]>> | undefined;
	let active: readonly EntryRecord[] = [];
	let initializing = true;
	let overflow = false;
	const pending: EntryRecord[] = [];
	const append = (entries: readonly EntryRecord[]) => {
		if (!entries.length) return;
		let next = [...active, ...entries];
		const head = entries.findLast((entry) => entry.head !== undefined);
		if (head) next = [head, ...next.filter((entry) => entry.head === undefined && entry.id >= head.head!)];
		active = next;
	};
	const watch = new NativeWatch<readonly AgentEvent[]>(
		[],
		() => {
			detachCommit();
			observation?.detach();
			active = [];
			current = undefined;
			previous = undefined;
			ops = [];
			held.clear();
			pending.length = 0;
		},
		() => console.warn("pilot: agent event listener failed"),
		() => [snapshotOf(current!, active)],
	);
	try {
		// The SDK window stays bounded. Only legacy active context is retained, never the
		// raw history hidden by compaction; partial deltas do not rescan that context.
		observation = await harness.observeConversation(
			conversationId,
			{
				advance(call) {
					if (call.kind !== "value") return;
					current = call.value;
					ops = call.ops;
				},
				end(end) {
					watch.end(end);
				},
			},
			context,
			{ min: 60, max: 120 },
		);
		current ??= observation.value;
		const commits = harness.observeCommits({
			advance(publication, commitContext) {
				const entries = publication.changes.flatMap((change) =>
					change.type === "entry" && change.value.conversationId === conversationId ? [change.value] : [],
				);
				if (initializing) {
					if (pending.length + entries.length > 10_000) overflow = true;
					else pending.push(...entries);
					return;
				}
				append(entries);
				const events = translate(conversationId, previous!, current!, ops, publication, held);
				previous = current!;
				ops = [];
				if (events.length) watch.advance(events, commitContext);
			},
			end(end) {
				watch.end(end);
			},
		});
		detachCommit = () => commits.detach();
		const conversation = await harness.conversation(conversationId, context);
		if (!conversation) throw new Error("Conversation is unavailable");
		active = (await conversation.context(context)).entries;
		let snapshot!: SnapshotEvent;
		await harness.commit(async (tx) => {
			context.abortSignal?.throwIfAborted();
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanTasks(
					{ conversationId, kind: "pi.generation", status: "completing" },
					100,
					cursor,
				);
				for (const task of page.items) held.add(task.id);
				cursor = page.next;
			} while (cursor);
			if (overflow) throw new Error("Conversation changed too quickly while attaching");
			const tail = active.reduce((id, entry) => Math.max(id, entry.id), 0);
			append(pending.filter((entry) => entry.id > tail));
			pending.length = 0;
			previous = current!;
			snapshot = snapshotOf(previous, active);
			ops = [];
			initializing = false;
		}, context);
		if (context.abortSignal) watch.observeAbort(context.abortSignal);
		return {
			snapshot,
			start: (listener) =>
				watch.start(async (call, ctx) => {
					if (call.kind === "value") await listener(call.value, ctx);
				}),
			stop: () => watch.stop(),
			closed: watch.closed,
		};
	} catch (error) {
		await watch.stop();
		throw error;
	}
}

type TaskChange = Extract<CommitChange, { type: "task" }>;

/** The tool result for `callId` among `entries`. */
function resultOf(entries: readonly EntryRecord[], callId: string): EntryRecord | undefined {
	return entries.find((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult" && message.toolCallId === callId;
	});
}

/** Every event one publication causes, in the order of spec §9.4. */
function translate(
	conversationId: ConversationId,
	before: ConversationView,
	after: ConversationView,
	viewOps: readonly Op[],
	publication: CommitPublication,
	held: Set<TaskId>,
): AgentEvent[] {
	const entries: EntryRecord[] = [];
	const tasks = new Map<TaskId, TaskChange["value"]>();
	const submissions: SubmissionRecord[] = [];
	// Nested results this commit stored, by nested task ID; read now, since the caller's documents may retire next.
	const nestedResults = new Map<TaskId, NestedToolExecutionResult>();
	for (const change of publication.changes) {
		if (
			change.type === "document" &&
			change.record.kind === NestedCallDoc.definition.kind &&
			change.kind === "change" &&
			change.conversationId === conversationId
		) {
			const state = change.value as NestedCallState;
			if (state.taskId !== undefined && state.result !== undefined) {
				nestedResults.set(state.taskId, state.result as unknown as NestedToolExecutionResult);
			}
		}
		if (change.type === "entry" && change.value.conversationId === conversationId) entries.push(change.value);
		if (change.type === "task" && change.value.conversationId === conversationId)
			tasks.set(change.value.id, change.value);
		if (change.type === "submission" && change.value.conversationId === conversationId) {
			submissions.push(change.value);
		}
	}
	if (viewOps.length === 0 && entries.length === 0 && tasks.size === 0 && submissions.length === 0) return [];
	// Entries are appended in ID order; submission records are published in the order the commit first touched them.
	submissions.sort((a, b) => a.id - b.id);
	const was = parts(before);
	const now = parts(after);
	const events: AgentEvent[] = [];

	// Progress: tool starts, the in-flight message, tool updates, retry and deferred state.
	const slotsBefore = new Map((was.live.tools ?? []).map((slot) => [slot.callId, slot]));
	const slots = now.live.tools ?? [];
	const nestedBefore = new Map((was.live.nestedTools ?? []).map((slot) => [slot.taskId, slot]));
	const nested = now.live.nestedTools ?? [];
	for (const slot of [...slots, ...nested]) {
		const previous = "parentCallId" in slot ? nestedBefore.get(slot.taskId) : slotsBefore.get(slot.callId);
		if (slot.status !== "running" || previous?.status === "running") continue;
		// A nested slot carries the arguments the call runs with; a model-issued call's are in its intent checkpoint.
		const checkpoint = slot.taskId === undefined ? undefined : tasks.get(slot.taskId)?.state.checkpoint;
		const args =
			"parentCallId" in slot
				? slot.arguments
				: ((checkpoint as { arguments?: JsonObject } | undefined)?.arguments ?? {});
		events.push({ type: "tool_execution_start", ...callOf(slot), args });
	}
	const partialBefore = was.live.generation?.message as AssistantMessage | undefined;
	const partial = now.live.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined && partialBefore === undefined) events.push({ type: "message_start", message: partial });
	else if (partial !== undefined && partial !== partialBefore) {
		events.push({ type: "message_update", usage: partial.usage, changes: messageChanges(viewOps, partial) });
	}
	for (const [index, slot] of slots.entries()) {
		const previous = slotsBefore.get(slot.callId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(viewOps, ["tools", index], slot, previous);
		if (update === undefined) continue;
		events.push({ type: "tool_execution_update", ...callOf(slot), ...update });
	}
	for (const [index, slot] of nested.entries()) {
		const previous = nestedBefore.get(slot.taskId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(viewOps, ["nestedTools", index], slot, previous);
		if (update === undefined) continue;
		events.push({ type: "tool_execution_update", ...callOf(slot), ...update });
	}
	const generation = now.live.generation;
	const generationBefore = was.live.generation;
	if (generation?.retry !== undefined && generationBefore?.retry === undefined) {
		const { at, error } = generation.retry;
		events.push({ type: "auto_retry_start", attempt: generation.attempt, at, errorMessage: error });
	}
	if (generationBefore?.retry !== undefined && generation?.retry === undefined) {
		events.push({ type: "auto_retry_end", attempt: generationBefore.attempt });
	}
	if (generation?.deferred !== undefined && generation.deferred.pollAt !== generationBefore?.deferred?.pollAt) {
		events.push({ type: "deferred_poll", pollAt: generation.deferred.pollAt });
	}

	// Tools that end in this commit: a slot that becomes done, one created done (a call not offered), or an unfinished
	// one that vanishes because its run ended. A done slot that vanishes ended earlier.
	const toolEnds: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
	const endTool = (slot: ToolSlot, entryId: number | undefined): void => {
		const entry = entries.find((candidate) => candidate.id === entryId);
		toolEnds.push({ type: "tool_execution_end", ...callOf(slot), ...(entry === undefined ? {} : { entry }) });
	};
	for (const previous of slotsBefore.values()) {
		if (previous.status === "done") continue;
		const slot = slots.find((candidate) => candidate.callId === previous.callId);
		if (slot?.status === "done") endTool(slot, slot.entry);
		// A slot whose run ended in this commit may have had its result appended with it, as for unstarted calls.
		else if (slot === undefined) endTool(previous, resultOf(entries, previous.callId)?.id);
	}
	for (const slot of slots) {
		if (slot.status === "done" && !slotsBefore.has(slot.callId)) endTool(slot, slot.entry);
	}
	// Nested calls that end in this commit, the same way, children before the calls that made them: the lists hold
	// parents first, so walk them backwards.
	const endNested = (slot: NestedToolSlot): void => {
		const result = nestedResults.get(slot.taskId);
		events.push({ type: "tool_execution_end", ...callOf(slot), ...(result === undefined ? {} : { result }) });
	};
	const nestedNow = new Map(nested.map((slot) => [slot.taskId, slot]));
	for (const previous of [...nestedBefore.values()].reverse()) {
		if (previous.status === "done") continue;
		const slot = nestedNow.get(previous.taskId);
		if (slot?.status === "done" || slot === undefined) endNested(slot ?? previous);
	}
	for (const slot of [...nested].reverse()) {
		if (slot.status === "done" && !nestedBefore.has(slot.taskId)) endNested(slot);
	}

	// Entries in append order; a tool's end directly precedes its result's message, as in the coding agent.
	let assistantAppended = false;
	for (const entry of entries) {
		events.push(...toolEnds.filter((end) => end.entry === entry));
		const message = entry.model?.[0];
		if (message === undefined) {
			events.push({ type: "entry_appended", entry });
			continue;
		}
		// A streamed answer already started with its first partial.
		const streamed = message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
		if (message.role === "assistant") assistantAppended = true;
		if (!streamed) events.push({ type: "message_start", message });
		events.push({ type: "message_end", entry });
	}
	// Ends without a result entry: a faulted or orphaned tool, or one whose run ended.
	events.push(...toolEnds.filter((end) => end.entry === undefined));

	// Compaction ends, task failures, then turn and run ends.
	const compactionsBefore = was.live.compactions ?? [];
	const compactions = now.live.compactions ?? [];
	const failure = now.live.compactionFailure;
	for (const { taskId, trigger: reason } of compactionsBefore) {
		if (!compactions.some((status) => status.taskId === taskId)) {
			const error = failure?.taskId === taskId ? failure.error : undefined;
			events.push({ type: "compaction_end", taskId, reason, ...(error === undefined ? {} : { error }) });
		}
	}
	// A generation's turn ends when its outcome is committed: at a `completing` hold or at terminal, whichever comes
	// first, so a successor created at the hold starts after it.
	let turnEnded = false;
	for (const task of tasks.values()) {
		const status = task.state.status;
		if (task.kind === "pi.generation" && status === "completing" && !held.has(task.id)) {
			held.add(task.id);
			turnEnded = true;
		}
		if (status !== "terminal") continue;
		if (task.kind === "pi.generation" && !held.delete(task.id)) turnEnded = true;
		const outcome = task.state.outcome;
		if (outcome.status === "faulted" || outcome.status === "orphaned") {
			const message = outcome.status === "faulted" ? outcome.error.message : outcome.reason;
			events.push({ type: "task_failed", taskId: task.id, kind: task.kind, message });
		}
	}
	if (turnEnded) events.push({ type: "turn_end" });
	const run = now.live.run;
	const runBefore = was.live.run;
	const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
	if (runBefore !== undefined && runChanged) events.push({ type: "run_end", inputs: runBefore.inputs });

	// Submissions, document state, then what began.
	for (const record of submissions) events.push({ type: "submission", record });
	if (now.inbox !== was.inbox) events.push({ type: "inbox_update", items: queued(now.inbox) });
	// A retired document reads as its initial value, as in a snapshot.
	if (now.agent !== was.agent) {
		events.push({ type: "agent_changed", agent: now.agent ?? AgentDoc.definition.initial() });
	}
	if (now.usage !== was.usage)
		events.push({ type: "usage_changed", usage: now.usage ?? UsageDoc.definition.initial() });
	for (const { taskId, trigger: reason, blocking } of compactions) {
		if (!compactionsBefore.some((status) => status.taskId === taskId)) {
			events.push({ type: "compaction_start", taskId, reason, blocking });
		}
	}
	if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });
	if (run !== undefined && run.taskId !== runBefore?.taskId && tasks.get(run.taskId)?.kind === "pi.generation") {
		events.push({ type: "turn_start" });
	}
	return events;
}

const PARTIAL_PATH = ["docs", "pi.live", "generation", "message"];

/** Translate the view operations on the in-flight message into message changes (spec §9.4). */
function messageChanges(viewOps: readonly Op[], message: AssistantMessage): MessageChange[] {
	const changes: MessageChange[] = [];
	// A block sent whole already holds every later change to it in this batch.
	const whole = new Set<number>();
	for (const op of viewOps) {
		// View operations never replace the root.
		const path = op[1] as Path;
		if (!startsWith(path, PARTIAL_PATH)) {
			// The whole message or generation was replaced.
			if (startsWith(PARTIAL_PATH, path)) return [{ type: "message", message }];
			continue;
		}
		const rest = path.slice(PARTIAL_PATH.length);
		if (rest[0] === "usage") continue;
		if (rest[0] !== "content") return [{ type: "message", message }];
		if (rest.length === 1) {
			if (op[0] !== "p" || op[3] !== 0) return [{ type: "message", message }];
			for (const [offset, block] of (op[4] as unknown as Block[]).entries()) {
				const type =
					block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start";
				changes.push({ type, contentIndex: op[2] + offset, block });
			}
			continue;
		}
		const contentIndex = rest[1] as number;
		const field = rest[2];
		if (whole.has(contentIndex)) continue;
		if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking")) {
			changes.push({ type: field === "text" ? "text_delta" : "thinking_delta", contentIndex, delta: op[2] });
		} else if (op[0] === "a" && field === "arguments") {
			changes.push({ type: "toolcall_delta", contentIndex, path: rest.slice(3), delta: op[2] });
		} else {
			whole.add(contentIndex);
			changes.push({ type: "block", contentIndex, block: message.content[contentIndex]! });
		}
	}
	return changes;
}

/** The identifying fields of a slot's tool events. */
function callOf(slot: ToolSlot | NestedToolSlot): ToolEventCall {
	return {
		toolCallId: slot.callId,
		toolName: slot.name,
		...(slot.taskId === undefined ? {} : { taskId: slot.taskId }),
		...("parentCallId" in slot ? { parentToolCallId: slot.parentCallId, parentTaskId: slot.parentTaskId } : {}),
	};
}

/** Output, details, and diagnostics changes of a running slot at `at` in `pi.live`, from the view operations on it. */
function toolUpdate(
	viewOps: readonly Op[],
	at: readonly ["tools" | "nestedTools", number],
	slot: ToolSlot | NestedToolSlot,
	previous: ToolSlot | NestedToolSlot,
): Omit<Extract<AgentEvent, { type: "tool_execution_update" }>, "type" | keyof ToolEventCall> | undefined {
	const outputPath = ["docs", "pi.live", ...at, "output"];
	let trimStart = 0;
	let append = "";
	let set = false;
	for (const op of viewOps) {
		if (!startsWith(op[1] as Path, outputPath)) continue;
		if (op[0] === "t") trimStart += op[2];
		else if (op[0] === "a") append += op[2];
		else set = true;
	}
	let output: { trimStart?: number; append?: string } | { set: string } | undefined;
	if (set || (slot.output !== previous.output && trimStart === 0 && append === ""))
		output = { set: slot.output ?? "" };
	else if (trimStart > 0 || append !== "") {
		output = { ...(trimStart > 0 ? { trimStart } : {}), ...(append === "" ? {} : { append }) };
	}
	// A safe replay clears a running slot's progress: removed details send `null`, removed diagnostics `[]`.
	const update = {
		...(output === undefined ? {} : { output }),
		...(slot.details === previous.details ? {} : { details: slot.details ?? null }),
		...(slot.diagnostics === previous.diagnostics ? {} : { diagnostics: slot.diagnostics ?? [] }),
	};
	return Object.keys(update).length === 0 ? undefined : update;
}

function startsWith(path: Path, prefix: readonly (string | number)[]): boolean {
	return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}
