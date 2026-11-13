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
/** Pilot wire events. Kept stable independently of Durable's state watch API.
 * Event shapes adapted from pi-durable 1.4 (MIT, Earendil Works).
 */
import type { JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type {
	AgentState,
	CompactionFailure,
	CompactionReason,
	CompactionStatus,
	EntryRecord,
	InboxItem,
	JsonObject,
	NestedToolExecutionResult,
	NestedToolSlot,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	ToolDiagnostic,
	ToolSlot,
	UsageState,
} from "@earendil-works/pi-durable";

type Block = AssistantMessage["content"][number];
export type QueuedItem = { id: SubmissionId; mode: InboxItem["mode"] };

/** One change to the in-flight assistant message, relative to that message. */
export type MessageChange =
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string }
	| { type: "block"; contentIndex: number; block: Block }
	| { type: "message"; message: AssistantMessage };

export type SnapshotEvent = {
	type: "snapshot";
	entries: readonly EntryRecord[];
	run?: { inputs: readonly SubmissionId[] };
	/** Current generation attempt: its in-flight partial, retry backoff, or deferred poll. */
	generation?: {
		attempt: number;
		message?: AssistantMessage;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools: readonly ToolSlot[];
	/** `pi.live.nestedTools`: nested calls of running tool calls. */
	nestedTools: readonly NestedToolSlot[];
	/** `pi.live.compactions`: live compactions with their attempt and retry backoff. */
	compactions: readonly (Omit<CompactionStatus, "trigger"> & { reason: CompactionReason })[];
	/** `pi.live.compactionFailure`: the newest compaction failure since a compaction last produced a summary. */
	compactionFailure?: Omit<CompactionFailure, "trigger"> & { reason: CompactionReason };
	inbox: readonly QueuedItem[];
	/** `pi.agent`; `{}` when absent. */
	agent: AgentState;
	usage: UsageState;
};

/** Experimental agent event, shaped like the coding agent's session events (spec §9.4). */
export type AgentEvent =
	| SnapshotEvent
	| { type: "run_start"; inputs: readonly SubmissionId[] }
	| { type: "run_end"; inputs: readonly SubmissionId[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: Message }
	/** `usage` is the partial's current usage, as in the coding agent's JSON mode. */
	| { type: "message_update"; usage: Usage; changes: readonly MessageChange[] }
	| { type: "message_end"; entry: EntryRecord }
	| ({ type: "tool_execution_start"; args: JsonObject } & ToolEventCall)
	| ({
			type: "tool_execution_update";
			/** A front trim and then an append of the retained window, or its replacement. */
			output?: { trimStart?: number; append?: string } | { set: string };
			details?: JsonValue;
			diagnostics?: readonly ToolDiagnostic[];
	  } & ToolEventCall)
	/**
	 * A model-issued call ends with its result `entry`, a nested call with its `result`. Both are absent when the tool
	 * task faulted or was orphaned, or when the call's slot left `pi.live` unfinished: its run ended, or its parent
	 * settled first.
	 */
	| ({ type: "tool_execution_end"; entry?: EntryRecord; result?: NestedToolExecutionResult } & ToolEventCall)
	| { type: "inbox_update"; items: readonly QueuedItem[] }
	| { type: "submission"; record: SubmissionRecord }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "deferred_poll"; pollAt: number }
	| { type: "entry_appended"; entry: EntryRecord }
	| { type: "agent_changed"; agent: AgentState }
	| { type: "usage_changed"; usage: UsageState }
	| { type: "task_failed"; taskId: TaskId; kind: string; message: string }
	| { type: "compaction_start"; taskId: TaskId; reason: CompactionReason; blocking: boolean }
	/**
	 * The task's receipt tells whether it produced a summary; the summary entry has its own events. `error` is set when
	 * the compaction failed, faulted, or was orphaned, as in `pi.live.compactionFailure`.
	 */
	| { type: "compaction_end"; taskId: TaskId; reason: CompactionReason; error?: string };

/**
 * Which call a tool event is about. `toolCallId` is the call's ID in the transcript and in tool events: the provider's
 * ID for a model-issued call, `<parent call ID>/<key>` for a nested one. Match events by it; do not parse it. `taskId`
 * is the call's tool task, absent for a call that never got one (not offered, or not started in a sequential round).
 * A nested call also names the call that made it, by call ID and by tool task.
 */
export type ToolEventCall = {
	toolCallId: string;
	toolName: string;
	taskId?: TaskId;
	parentToolCallId?: string;
	parentTaskId?: TaskId;
};
