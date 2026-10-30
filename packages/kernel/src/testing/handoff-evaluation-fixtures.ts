/** Synthetic originals only. No live chats, account responses or generated handoffs. */
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";

export type HandoffProbe = {
	id: string;
	question: string;
	expected: string;
	sources: number[];
	/** Literal presence is a diagnostic, never a correctness grade. */
	terms: string[];
};
export type HandoffScenario = {
	id: string;
	stages: { entries: EntryRecord[]; probes: HandoffProbe[] }[];
};

function scenario(id: string) {
	const result: HandoffScenario = { id, stages: [] };
	let nextId = 1;
	let segment: EntryRecord[] = [];
	const probes = new Map<string, HandoffProbe>();
	function entry(kind: string, model: Message[], data?: unknown) {
		const source = nextId++;
		segment.push({
			id: source as EntryId,
			conversationId: 0 as never,
			kind,
			model,
			...(data === undefined ? {} : { data }),
		} as EntryRecord);
		return source;
	}
	return {
		result,
		user: (text: string) => entry("pi.user", [{ role: "user", content: text, timestamp: nextId }]),
		say: (text: string) => entry("pi.assistant", [fauxAssistantMessage(text, { timestamp: nextId })]),
		question(text: string) {
			return entry("pilot.question", [], { question: text, options: [] });
		},
		tool(name: string, args: Parameters<typeof fauxToolCall>[1], output: string, isError = false) {
			const callId = `call-${nextId}`;
			entry("pi.assistant", [
				fauxAssistantMessage([fauxToolCall(name, args, { id: callId })], {
					timestamp: nextId,
					stopReason: "toolUse",
				}),
			]);
			return entry("pi.tool-result", [
				{
					role: "toolResult",
					toolCallId: callId,
					toolName: name,
					content: [{ type: "text", text: output }],
					isError,
					timestamp: nextId,
				},
			]);
		},
		probe(id: string, question: string, expected: string, sources: number[], terms: string[]) {
			probes.set(id, { id, question, expected, sources, terms });
		},
		cut() {
			// Distractors are deliberately semantically empty, not additional requirements.
			for (let n = 0; n < 8; n++)
				entry("pi.assistant", [fauxAssistantMessage(`Inspecting fixture module ${n}.`, { timestamp: nextId })]);
			result.stages.push({ entries: segment, probes: [...probes.values()] });
			segment = [];
		},
	};
}

function billing(): HandoffScenario {
	const s = scenario("billing-export");
	const goal = s.user("Add tenant scoping to the billing export. Keep the CSV column order unchanged. Do not push.");
	s.probe(
		"format",
		"What output compatibility requirement remains?",
		"CSV column order stays unchanged.",
		[goal],
		["CSV", "column order"],
	);
	s.probe("push", "May this work be pushed?", "No push is authorized.", [goal], ["do not push"]);
	const region = s.user("Use region eu-west-1 for the fixtures.");
	s.probe("region", "Which fixture region is current?", "eu-west-1", [region], ["eu-west-1"]);
	s.tool("read", { path: "packages/billing/src/export.ts" }, "export function exportRows() { /* synthetic */ }");
	const failed = s.tool(
		"bash",
		{ command: "node --test billing.test.ts" },
		"tests 8\npass 7\nfail 1\nAssertionError: archived tenant leaked",
		true,
	);
	s.probe(
		"checks",
		"Has billing.test.ts passed?",
		"No. Eight tests ran, one failed.",
		[failed],
		["billing.test.ts", "fail"],
	);
	s.cut();
	const correction = s.user("Correction: use us-east-2, not eu-west-1. Skip archived tenants.");
	s.probe(
		"region",
		"Which fixture region is current?",
		"us-east-2 supersedes eu-west-1.",
		[correction],
		["us-east-2"],
	);
	s.probe(
		"archived",
		"Should archived tenants be exported?",
		"No, skip archived tenants.",
		[correction],
		["archived"],
	);
	s.tool(
		"applyPatch",
		{ patch: "*** Begin Patch\n*** Update File: packages/billing/src/export.ts\n@@\n-old\n+new\n*** End Patch" },
		"Updated packages/billing/src/export.ts",
	);
	s.tool("bash", { command: "node --test unrelated.test.ts" }, "tests 3\npass 3\nfail 0");
	s.say("A different test file passed. The billing failure still needs a rerun.");
	s.cut();
	const hypothesis = s.say(
		"Rejected filtering after serialization: it changes the column order for empty exports. Filter tenants before serialization instead.",
	);
	s.probe(
		"approach",
		"Which approach was rejected, and why?",
		"Post-serialization filtering changes empty-export column order; filter before serialization.",
		[hypothesis],
		["serialization", "empty"],
	);
	const passed = s.tool("bash", { command: "node --test billing.test.ts" }, "tests 8\npass 8\nfail 0");
	s.probe(
		"checks",
		"Has billing.test.ts passed now?",
		"Yes, the same command passed all eight tests.",
		[passed],
		["billing.test.ts", "pass"],
	);
	s.cut();
	const next = s.user(
		"Next, add an empty-export regression test. Keep the earlier compatibility and push restrictions.",
	);
	s.probe(
		"next",
		"What is the next unfinished step?",
		"Add an empty-export regression test.",
		[next],
		["empty-export", "regression"],
	);
	s.cut();
	return s.result;
}

function recovery(): HandoffScenario {
	const s = scenario("delivery-recovery");
	const goal = s.user(
		"Investigate delivery recovery. Never replay an action whose acknowledgement was lost. Do not change production.",
	);
	s.probe(
		"replay",
		"May an uncertain action be replayed?",
		"No, a lost acknowledgement remains uncertain.",
		[goal],
		["replay", "lost"],
	);
	const lost = s.tool(
		"bash",
		{ command: "fixture-client submit --operation op-47" },
		"Connection closed before acknowledgement; outcome unknown",
		true,
	);
	s.probe(
		"outcome",
		"Did operation op-47 succeed?",
		"Unknown, acknowledgement was lost.",
		[lost],
		["op-47", "unknown"],
	);
	s.cut();
	const status = s.tool(
		"bash",
		{ command: "fixture-client status op-47" },
		"GET reports state=done; this endpoint does not return a durable receipt",
	);
	s.probe(
		"outcome",
		"Does the status GET establish acknowledged delivery?",
		"No. The outcome remains unknown without the exact durable acknowledgement.",
		[goal, lost, status],
		["unknown", "acknowledgement"],
	);
	const why = s.say(
		"A status read is not an acknowledgement. The proposed retry button would duplicate a non-idempotent external action, so it was rejected.",
	);
	s.probe(
		"why",
		"Why was the retry button rejected?",
		"It could duplicate a non-idempotent external action.",
		[why],
		["duplicate", "non-idempotent"],
	);
	s.cut();
	const launched = s.tool(
		"jobs",
		{ action: "start", command: "node --test recovery.test.ts" },
		'{"id":"fixture-job","state":"running"}',
	);
	s.probe(
		"job",
		"Has recovery.test.ts passed?",
		"Unknown, the background job was only launched.",
		[launched],
		["recovery.test.ts", "running"],
	);
	s.cut();
	const next = s.user("Report the unknown outcome and inspect the fixture journal. Do not resubmit op-47.");
	s.probe(
		"next",
		"What should happen next?",
		"Inspect the fixture journal and report uncertainty; do not resubmit.",
		[next],
		["journal", "op-47"],
	);
	s.cut();
	return s.result;
}

function composer(): HandoffScenario {
	const s = scenario("composer-focus");
	const goal = s.user(
		"Fix attachment removal in the native composer. Preserve the draft, keyboard focus and IME preedit. Do not redesign the composer.",
	);
	s.probe(
		"editing",
		"Which editing state must survive?",
		"The draft, keyboard focus and IME preedit.",
		[goal],
		["draft", "focus", "IME"],
	);
	const behavior = s.user(
		"Reveal the discard cross on hover, with a contrasting background. Keep keyboard-focus access.",
	);
	s.probe(
		"control",
		"How must the discard control behave?",
		"Hover-revealed, contrasting background, also accessible through keyboard focus.",
		[behavior],
		["hover", "background", "keyboard"],
	);
	s.cut();
	const rejected = s.say(
		"Rejected rebuilding the whole input entity on removal: that discards marked text and the editing selection. Update attachment state independently.",
	);
	s.probe(
		"approach",
		"Why not rebuild the input entity?",
		"It loses marked text and selection. Update attachment state independently.",
		[rejected],
		["marked text", "selection"],
	);
	s.tool(
		"applyPatch",
		{ patch: "*** Begin Patch\n*** Update File: apps/desktop/src/composer.rs\n@@\n-old\n+new\n*** End Patch" },
		"Updated composer.rs",
	);
	s.cut();
	const evidence = s.say(
		"The static mock shows the cross is legible. Native keyboard navigation and OS IME behavior remain unverified.",
	);
	s.probe(
		"evidence",
		"Does the static mock prove native editing works?",
		"No. Native keyboard and OS IME behavior remain unverified.",
		[evidence],
		["unverified", "IME"],
	);
	s.cut();
	const next = s.user(
		"Next, verify keyboard removal without losing the draft. Do not claim OS IME acceptance from a synthetic test.",
	);
	s.probe(
		"next",
		"What is next, and what must not be claimed?",
		"Verify keyboard removal and draft retention; synthetic tests do not prove OS IME acceptance.",
		[next],
		["keyboard", "draft", "IME"],
	);
	const question = s.question("Should keyboard removal keep the attachment preview open?");
	s.probe(
		"pending",
		"Has the preview behavior question been answered?",
		"No, preserve it as an unanswered question, not an implementation decision.",
		[question],
		["preview", "unanswered"],
	);
	s.cut();
	return s.result;
}

export function handoffScenarios(): HandoffScenario[] {
	return [billing(), recovery(), composer()];
}
