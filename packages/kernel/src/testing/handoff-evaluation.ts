/** Offline comparison plumbing. No model client, credentials, live session access or runtime hooks. */
import { createHash } from "node:crypto";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createDigestState, foldEntry, renderDigest, validateDigest } from "../context-digest.ts";
import { HANDOFF_INSTRUCTIONS, HANDOFF_OUTPUT_BYTES } from "../handoff-prompt.ts";
import { MAX_REDACT_CHARS, neutralizeUntrusted, redactHistoryText } from "../history-privacy.ts";
import { type HandoffScenario, handoffScenarios } from "./handoff-evaluation-fixtures.ts";

export const HANDOFF_EVALUATION = {
	version: 1,
	outputBytes: HANDOFF_OUTPUT_BYTES,
	checklistTokens: 1_500,
	inputTokens: 24_000,
} as const;
export type HandoffArm = "handoff" | "handoff-with-facts";
const arms: HandoffArm[] = ["handoff", "handoff-with-facts"];

export { HANDOFF_INSTRUCTIONS };

export type HandoffRequest = {
	requestId: string;
	scenario: string;
	stage: number;
	arm: HandoffArm;
	system: string;
	prompt: string;
	outputBytes: number;
	estimatedInputTokens: number;
};
export type HandoffResponse = { requestId: string; handoff: string; model: string; effort: string };

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function quote(text: string): string {
	if (text.length > MAX_REDACT_CHARS)
		throw new Error("Evaluation entry exceeds the redaction budget; no silent clipping");
	return neutralizeUntrusted(redactHistoryText(text));
}

/** JSON quoting preserves message boundaries; it is not a hostile-content isolation guarantee. */
export function sourceTranscript(entries: readonly EntryRecord[]): string {
	return JSON.stringify(
		entries.map((entry) => ({
			source: `#${entry.id}`,
			kind: entry.kind,
			...(entry.data === undefined ? {} : { data: quote(JSON.stringify(entry.data)) }),
			messages: (entry.model ?? []).map((message) => {
				if (message.role === "user")
					return {
						role: message.role,
						text:
							typeof message.content === "string"
								? quote(message.content)
								: quote(JSON.stringify(message.content)),
					};
				if (message.role === "assistant")
					return {
						role: message.role,
						content: message.content.map((block) => {
							if (block.type === "text") return { type: "text", text: quote(block.text) };
							if (block.type === "toolCall")
								return {
									type: "toolCall",
									callId: block.id,
									name: block.name,
									arguments: quote(JSON.stringify(block.arguments)),
								};
							return { type: "omitted-reasoning" };
						}),
					};
				if (message.role === "toolResult")
					return {
						role: message.role,
						callId: message.toolCallId,
						tool: message.toolName,
						isError: message.isError,
						text: quote(JSON.stringify(message.content)),
					};
				return { role: message.role, text: "System entry omitted" };
			}),
		})),
		null,
		2,
	);
}

/** Reuse the real extractor, excluding free-form assistant reports and rolling transcript duplication. */
export function sourceChecklist(entries: readonly EntryRecord[]): string {
	const state = createDigestState();
	for (const entry of entries) foldEntry(state, entry);
	state.report = undefined;
	state.brief = [];
	const firstKept = Number(entries.at(-1)!.id) + 1;
	const options = { budgetTokens: HANDOFF_EVALUATION.checklistTokens, firstKept, recall: false };
	const checklist = renderDigest(state, options);
	if (!validateDigest(checklist, options).ok) throw new Error("Synthetic checklist failed digest validation");
	return checklist;
}

export function handoffRequest(
	scenario: HandoffScenario,
	stage: number,
	arm: HandoffArm,
	previous: string,
): HandoffRequest {
	const segment = scenario.stages[stage]!;
	const originals = scenario.stages.slice(0, stage + 1).flatMap((item) => item.entries);
	const input = {
		previousHandoff: previous,
		newOriginalEntries: JSON.parse(sourceTranscript(segment.entries)) as unknown,
		...(arm === "handoff-with-facts" ? { historicalChecklist: sourceChecklist(originals) } : {}),
	};
	const prompt = JSON.stringify(input, null, 2);
	const estimatedInputTokens = estimateTextTokens(HANDOFF_INSTRUCTIONS + prompt);
	if (estimatedInputTokens > HANDOFF_EVALUATION.inputTokens)
		throw new Error("Evaluation input exceeds the shared budget");
	const identity = {
		policy: HANDOFF_EVALUATION,
		system: HANDOFF_INSTRUCTIONS,
		scenario: scenario.id,
		stage,
		arm,
		prompt,
	};
	return {
		requestId: hash(identity),
		scenario: scenario.id,
		stage: stage + 1,
		arm,
		system: HANDOFF_INSTRUCTIONS,
		prompt,
		outputBytes: HANDOFF_EVALUATION.outputBytes,
		estimatedInputTokens,
	};
}

export function parseHandoffResponses(input: unknown): HandoffResponse[] {
	if (
		!input ||
		typeof input !== "object" ||
		!("version" in input) ||
		input.version !== 1 ||
		!("responses" in input) ||
		!Array.isArray(input.responses)
	)
		throw new Error("Expected {version:1,responses:[{requestId,handoff,model,effort}]}");
	const ids = new Set<string>();
	return input.responses.map((row: unknown) => {
		if (
			!row ||
			typeof row !== "object" ||
			!("requestId" in row) ||
			typeof row.requestId !== "string" ||
			!/^[a-f0-9]{64}$/.test(row.requestId) ||
			!("handoff" in row) ||
			typeof row.handoff !== "string" ||
			!("model" in row) ||
			typeof row.model !== "string" ||
			!row.model.trim() ||
			!("effort" in row) ||
			typeof row.effort !== "string" ||
			!row.effort.trim()
		)
			throw new Error("Invalid handoff response fields");
		if (ids.has(row.requestId)) throw new Error("Duplicate handoff response");
		ids.add(row.requestId);
		if (!row.handoff.trim() || Buffer.byteLength(row.handoff) > HANDOFF_EVALUATION.outputBytes)
			throw new Error("Handoff must be nonempty and fit the shared UTF-8 output budget; never silently clipped");
		if (quote(row.handoff) !== row.handoff) throw new Error("Handoff contains credentials or unsafe framing");
		return { requestId: row.requestId, handoff: row.handoff, model: row.model, effort: row.effort };
	});
}

/** Recompute requests from originals and accepted predecessor outputs. No stage can consume future originals. */
export function compareHandoffs(responses: HandoffResponse[], scenarios = handoffScenarios(), smoke = false) {
	const supplied = parseHandoffResponses({ version: 1, responses });
	if (smoke && supplied.length) throw new Error("Scripted smoke checks cannot consume model responses");
	const answers = new Map(supplied.map((response) => [response.requestId, response]));
	const used = new Set<string>();
	const ready = new Set<string>();
	const pending: HandoffRequest[] = [];
	const measurements: {
		requestId: string;
		arm: HandoffArm;
		scenario: string;
		stage: number;
		model: string;
		effort: string;
		estimatedInputTokens: number;
		outputBytes: number;
		literalDiagnostics: { probe: string; allTermsPresent: boolean; allSourceRefsPresent: boolean }[];
	}[] = [];
	const review: {
		candidate: string;
		scenario: string;
		stage: number;
		handoff: string;
		originals: unknown;
		probes: HandoffScenario["stages"][number]["probes"];
	}[] = [];
	for (const scenario of scenarios) {
		const predecessors = new Map<HandoffArm, string>();
		for (let stage = 0; stage < scenario.stages.length; stage++) {
			const pair = arms.map((arm) => handoffRequest(scenario, stage, arm, predecessors.get(arm) ?? ""));
			for (const request of pair) ready.add(request.requestId);
			const pairAnswers = pair.map((request) =>
				smoke
					? {
							requestId: request.requestId,
							handoff: "Synthetic plumbing check only. No model generated this handoff.",
							model: "scripted-smoke",
							effort: "none",
						}
					: answers.get(request.requestId),
			);
			for (let i = 0; i < pair.length; i++) if (!pairAnswers[i]) pending.push(pair[i]!);
			// Paired barrier: do not expose either successor until both arms completed the same boundary.
			if (pairAnswers.some((answer) => !answer)) break;
			if (pairAnswers[0]!.model !== pairAnswers[1]!.model || pairAnswers[0]!.effort !== pairAnswers[1]!.effort)
				throw new Error("Paired handoffs must use identical model and effort settings");
			for (let i = 0; i < pair.length; i++) {
				const request = pair[i]!;
				const response = pairAnswers[i]!;
				used.add(request.requestId);
				predecessors.set(request.arm, response.handoff);
				const probes = scenario.stages[stage]!.probes;
				measurements.push({
					requestId: request.requestId,
					arm: request.arm,
					scenario: scenario.id,
					stage: stage + 1,
					model: response.model,
					effort: response.effort,
					estimatedInputTokens: request.estimatedInputTokens,
					outputBytes: Buffer.byteLength(response.handoff),
					literalDiagnostics: probes.map((probe) => ({
						probe: probe.id,
						allTermsPresent: probe.terms.every((term) =>
							response.handoff.toLowerCase().includes(term.toLowerCase()),
						),
						allSourceRefsPresent: probe.sources.every((source) =>
							new RegExp(`#${source}\\b`).test(response.handoff),
						),
					})),
				});
				review.push({
					candidate: request.requestId,
					scenario: scenario.id,
					stage: stage + 1,
					handoff: response.handoff,
					originals: JSON.parse(
						sourceTranscript(scenario.stages.slice(0, stage + 1).flatMap((item) => item.entries)),
					) as unknown,
					probes,
				});
			}
		}
	}
	// A response at a pending paired boundary is valid, but not consumed until its partner arrives.
	for (const response of supplied) {
		if (!used.has(response.requestId) && !ready.has(response.requestId))
			throw new Error("Unknown or stale response: regenerate requests from the same predecessors and fixtures");
	}
	return {
		version: 1,
		mode: smoke ? "scripted-smoke" : "offline-replay",
		status: pending.length ? "awaiting-handoffs" : "awaiting-semantic-review",
		qualityConclusion: "None. Literal matches do not establish correctness, continuation quality, or cost savings.",
		policy: HANDOFF_EVALUATION,
		fixtureHash: hash(scenarios),
		pending,
		measurements,
		// Sorting by opaque identity removes arm ordering. Keep measurements/mapping out of a blinded review.
		review: review.sort((a, b) => a.candidate.localeCompare(b.candidate)),
	};
}
