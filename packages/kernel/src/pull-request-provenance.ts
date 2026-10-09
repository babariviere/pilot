/** Agent-only PR provenance. Never infer creation from transcript text or codemode source. */
import type { ExtensionFactory, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { defineDoc, type Extension } from "@earendil-works/pi-durable";

export const PullRequestsDoc = defineDoc<{ urls: string[] }>({
	kind: "pilot.pull-requests",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ urls: [] }),
});

const SHELL_CONTROL = new Set([
	"exec",
	"exit",
	"return",
	"eval",
	"source",
	".",
	"trap",
	"break",
	"continue",
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"function",
	"{",
	"}",
]);

/** Prefixes must be ordinary commands, not shell controls which could skip the final creation with exit zero. */
function ordinaryCommand(words: string[]): boolean {
	let index = 0;
	while (words[index] && /^[A-Za-z_]\w*=/.test(words[index]!)) index++;
	while (words[index] === "!" || words[index] === "command" || words[index] === "builtin") {
		index++;
		while (words[index]?.startsWith("-")) index++;
	}
	return words[index] !== undefined && !SHELL_CONTROL.has(words[index]!);
}

function helpOrDryRun(word: string): boolean {
	if (/^--(?:help|dry-run)(?:=|$)/.test(word)) return true;
	if (!/^-[^-]/.test(word)) return false;
	// Cobra accepts bundled booleans and shorthand assignments (-fh, -h=true).
	// A value-taking shorthand consumes the rest of its token, so -tTitle is not help.
	for (const flag of word.slice(1).split("=")[0]!) {
		if (flag === "h") return true;
		if ("tbBHarlmpR".includes(flag)) return false;
	}
	return false;
}

/** Conservative shell recognition: ordinary prefixes, then a final gh creation whose exit status is authoritative. */
export function createsPullRequest(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const script = command.trim();
	const commands: string[][] = [[]];
	let word = "";
	let quote = "";
	let escaped = false;
	const flush = () => {
		if (word) commands.at(-1)!.push(word);
		word = "";
	};
	for (let i = 0; i < script.length; i++) {
		const c = script[i]!;
		if (escaped) {
			word += c;
			escaped = false;
		} else if (c === "\\" && quote !== "'") escaped = true;
		else if (quote) {
			if (quote === '"' && (c === "`" || (c === "$" && script[i + 1] === "("))) return false;
			if (c === quote) quote = "";
			else word += c;
		} else if (c === "'" || c === '"') quote = c;
		else if (c === "&" && script[i + 1] === "&") {
			flush();
			commands.push([]);
			i++;
		} else if (c === ";" || c === "\n" || c === "\r") {
			flush();
			// Blank lines and CRLF do not introduce empty commands, unlike a doubled semicolon.
			if (commands.at(-1)!.length) commands.push([]);
			else if (c === ";") return false;
		} else if (/[|&<>`$()#]/.test(c)) return false;
		else if (/\s/.test(c)) flush();
		else word += c;
	}
	if (quote || escaped) return false;
	flush();
	const final = commands.pop()!;
	return (
		commands.every(ordinaryCommand) &&
		final[0] === "gh" &&
		final[1] === "pr" &&
		final[2] === "create" &&
		!final.slice(3).some(helpOrDryRun)
	);
}

type Result = {
	toolName: string;
	input: unknown;
	isError?: boolean;
	content?: readonly { type: string; text?: string }[];
	structuredContent?: unknown;
};

/** A successful creation call must return its one bare HTTPS pull URL, not an arbitrary mentioned link. */
export function createdPullRequest(result: Result): string | undefined {
	if (result.toolName !== "bash" || result.isError) return undefined;
	const input = result.input as { command?: unknown } | undefined;
	if (!createsPullRequest(input?.command)) return undefined;
	const structured = result.structuredContent as { exit_code?: number; output?: string } | undefined;
	if (structured?.exit_code !== undefined && structured.exit_code !== 0) return undefined;
	const output =
		structured?.output ??
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	if (typeof output !== "string") return undefined;
	const urls = (typeof structured?.output === "string" ? output.split(/\r?\n/) : [output])
		.map((line) => line.trim())
		.filter((line) => /^https:\/\/[a-z\d.-]+\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/i.test(line));
	return urls.length === 1 ? urls[0]!.replace(/\/$/, "") : undefined;
}

/** Native nested results are observed at execution time, even if codemode discards them or later fails. */
export function pullRequestProvenance(record: (url: string) => Promise<void>): {
	native: ExtensionFactory;
	prepare(extension: Extension): Extension;
} {
	const active = new Map<string, { error?: unknown }>();
	const observe = async (event: ToolResultEvent) => {
		if (!event.parentToolCallId) return;
		const root = [...active].find(([id]) => event.toolCallId.startsWith(`${id}/`))?.[1];
		if (!root) return;
		const url = createdPullRequest(event);
		if (url) {
			try {
				await record(url);
			} catch (error) {
				// SDK notification handlers report and swallow failures. Fail the outer durable call too,
				// rather than silently losing provenance for a successful external side effect.
				root.error = error;
				throw error;
			}
		}
	};
	return {
		native: (pi) => {
			pi.on("tool_result", observe);
		},
		prepare: (extension) => ({
			...extension,
			tools: extension.tools?.map((tool) => ({
				...tool,
				execute: async (args, api, context) => {
					const root: { error?: unknown } = {};
					active.set(api.callId, root);
					try {
						const result = await tool.execute(args, api, context);
						if (root.error !== undefined) throw root.error;
						// NativeAdapter retains structured tool output in its durable metadata envelope.
						const details = result.details as { __piNativeAdapter?: { structuredContent?: unknown } } | undefined;
						const url = createdPullRequest({
							...result,
							toolName: tool.name,
							input: args,
							structuredContent: details?.__piNativeAdapter?.structuredContent,
						});
						if (url) await record(url);
						return result;
					} finally {
						active.delete(api.callId);
					}
				},
			})),
		}),
	};
}
