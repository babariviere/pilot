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
	checkpointWhen: () => false,
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

/** Flags whose successful exit is not a creation: help, dry runs, and --web (no PR URL is printed). */
function noCreationProof(word: string): boolean {
	if (/^--(?:help|dry-run|web)(?:=|$)/.test(word)) return true;
	if (!/^-[^-]/.test(word)) return false;
	// Cobra accepts bundled booleans and shorthand assignments (-fh, -h=true).
	// A value-taking shorthand consumes the rest of its token, so -tTitle is not help.
	for (const flag of word.slice(1).split("=")[0]!) {
		if (flag === "h" || flag === "w") return true;
		if ("tbBHarlmpR".includes(flag)) return false;
	}
	return false;
}

/** Substitutions which only write their arguments or a file to stdout, so they cannot add output lines. */
const INERT_SUBSTITUTIONS = new Set(["printf", "echo", "cat"]);

/**
 * A `$(...)` starting at `start` (just after the opening parenthesis) that is one simple inert command, such
 * as `--body "$(printf '%s\n' ...)"`. Returns the index of its closing parenthesis, or -1. Redirections,
 * operators and nested substitutions are rejected, so it cannot print a URL to the tool output or change
 * the outer command's exit status.
 */
function inertSubstitution(script: string, start: number): number {
	const words: string[] = [];
	let word = "";
	let quoted = false;
	let quote = "";
	let escaped = false;
	const flush = () => {
		if (word || quoted) words.push(word);
		word = "";
		quoted = false;
	};
	for (let i = start; i < script.length; i++) {
		const c = script[i]!;
		if (escaped) {
			word += c;
			escaped = false;
		} else if (c === "\\" && quote !== "'") escaped = true;
		else if (quote) {
			if (quote === '"' && (c === "`" || (c === "$" && script[i + 1] === "("))) return -1;
			if (c === quote) quote = "";
			else word += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			quoted = true;
		} else if (c === ")") {
			flush();
			return words[0] !== undefined && INERT_SUBSTITUTIONS.has(words[0]) ? i : -1;
		} else if (/[|&;<>`$(#\n\r]/.test(c)) return -1;
		else if (/\s/.test(c)) flush();
		else word += c;
	}
	return -1;
}

/** An assignment such as GH_REPO=owner/repo before a command. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** Output filters a final pipe may pass the PR URL through. Only with pipefail, so gh's exit status still counts. */
function outputFilter(words: string[]): boolean {
	const [name, ...args] = words;
	if (name === "cat") return args.length === 0;
	if (name !== "tail" && name !== "head") return false;
	for (let i = 0; i < args.length; i++) {
		if (/^-n?\d+$/.test(args[i]!)) continue;
		if (args[i] === "-n" && /^\d+$/.test(args[i + 1] ?? "")) {
			i++;
			continue;
		}
		return false;
	}
	return true;
}

/** Pipefail after a top-level set command such as set -o pipefail, set -euo pipefail or set +o pipefail. */
function pipefailAfter(words: string[], enabled: boolean): boolean {
	let index = 0;
	while (words[index] && ASSIGNMENT.test(words[index]!)) index++;
	if (words[index] !== "set") return enabled;
	for (let i = index + 1; i < words.length; i++)
		if (/^[-+][A-Za-z]*o$/.test(words[i]!) && words[i + 1] === "pipefail") enabled = words[i++]![0] === "-";
	return enabled;
}

type ShellCommand = { words: string[]; pipes: string[][]; heredoc: boolean };

/**
 * Conservative shell recognition: ordinary prefixes, then a final gh creation whose exit status is authoritative.
 * The final command may read its body from a heredoc, merge or drop stderr, and, after set -o pipefail, pipe its
 * output through tail, head or cat.
 */
export function createsPullRequest(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const script = command.trim();
	const commands: ShellCommand[] = [{ words: [], pipes: [], heredoc: false }];
	const segment = () => {
		const current = commands.at(-1)!;
		return current.pipes.at(-1) ?? current.words;
	};
	let word = "";
	let quotedWord = false;
	let quote = "";
	let escaped = false;
	let heredoc: { delimiter: string; strip: boolean; literal: boolean } | undefined;
	const flush = () => {
		if (word) segment().push(word);
		word = "";
		quotedWord = false;
	};
	for (let i = 0; i < script.length; i++) {
		const c = script[i]!;
		if (escaped) {
			word += c;
			escaped = false;
		} else if (c === "\\" && quote !== "'") escaped = true;
		else if (quote) {
			if (quote === '"' && c === "$" && script[i + 1] === "(") {
				const end = inertSubstitution(script, i + 2);
				if (end < 0) return false;
				// The substituted text is an argument value; only its presence matters here.
				word += "$()";
				i = end;
			} else if (quote === '"' && c === "`") return false;
			else if (c === quote) quote = "";
			else word += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			quotedWord = true;
		} else if (c === "&" && script[i + 1] === "&") {
			flush();
			if (heredoc) return false;
			commands.push({ words: [], pipes: [], heredoc: false });
			i++;
		} else if (c === ";" || c === "\n" || c === "\r") {
			flush();
			if (c === "\n" && heredoc) {
				// The body is gh's stdin, never its output. Unquoted delimiters expand the body, so it must be plain text.
				let start = i + 1;
				let found = false;
				while (start <= script.length) {
					const newline = script.indexOf("\n", start);
					const end = newline < 0 ? script.length : newline;
					let line = script.slice(start, end).replace(/\r$/, "");
					if (heredoc.strip) line = line.replace(/^\t+/, "");
					if (line === heredoc.delimiter) {
						if (!heredoc.literal && /[$`\\]/.test(script.slice(i + 1, start))) return false;
						i = end;
						found = true;
						break;
					}
					if (newline < 0) break;
					start = newline + 1;
				}
				if (!found) return false;
				heredoc = undefined;
				// A terminator on the last line ends the script, not just the command.
				if (i >= script.length) break;
			} else if (c === ";" && heredoc) return false;
			// Blank lines and CRLF do not introduce empty commands, unlike a doubled semicolon.
			const current = commands.at(-1)!;
			if (current.pipes.at(-1)?.length === 0) return false;
			if (current.words.length) commands.push({ words: [], pipes: [], heredoc: false });
			else if (c === ";") return false;
		} else if (c === "|") {
			if (script[i + 1] === "|" || script[i + 1] === "&") return false;
			flush();
			if (!segment().length) return false;
			commands.at(-1)!.pipes.push([]);
		} else if (c === ">" && word === "2" && !quotedWord) {
			// Only 2>&1 and 2>/dev/null: the exit status and stdout stay gh's.
			const redirect = script.slice(i + 1).match(/^(?:&1|[ \t]*\/dev\/null)(?=[\s;&|]|$)/);
			if (!redirect) return false;
			word = "";
			i += redirect[0].length;
		} else if (c === "<" && script[i + 1] === "<" && script[i + 2] !== "<") {
			flush();
			if (heredoc) return false;
			let j = i + 2;
			const strip = script[j] === "-";
			if (strip) j++;
			while (script[j] === " " || script[j] === "\t") j++;
			let delimiter: string;
			let literal = false;
			if (script[j] === "'" || script[j] === '"') {
				const close = script.indexOf(script[j]!, j + 1);
				if (close < 0) return false;
				delimiter = script.slice(j + 1, close);
				literal = true;
				j = close + 1;
			} else delimiter = script.slice(j).match(/^[A-Za-z_][\w-]*/)?.[0] ?? "";
			if (!literal) j += delimiter.length;
			if (!delimiter || (j < script.length && !/\s/.test(script[j]!))) return false;
			heredoc = { delimiter, strip, literal };
			commands.at(-1)!.heredoc = true;
			i = j - 1;
		} else if (/[|&<>`$()#]/.test(c)) return false;
		else if (/\s/.test(c)) flush();
		else word += c;
	}
	if (quote || escaped || heredoc) return false;
	flush();
	const final = commands.pop()!;
	let pipefail = false;
	for (const prefix of commands) {
		if (prefix.heredoc || ![prefix.words, ...prefix.pipes].every(ordinaryCommand)) return false;
		// A set inside a pipeline runs in a subshell and changes nothing.
		if (!prefix.pipes.length) pipefail = pipefailAfter(prefix.words, pipefail);
	}
	if (final.pipes.length && (!pipefail || !final.pipes.every(outputFilter))) return false;
	let index = 0;
	while (final.words[index] && ASSIGNMENT.test(final.words[index]!)) index++;
	const words = final.words.slice(index);
	return (
		words[0] === "gh" &&
		words[1] === "pr" &&
		(words[2] === "create" || words[2] === "new") &&
		!words.slice(3).some(noCreationProof)
	);
}

/**
 * A gh PR creation the strict check cannot confirm, such as one whose output is piped without pipefail. The
 * daemon then attaches only a new PR on the chat's own branch created around this time.
 */
export function attemptsPullRequest(command: unknown): boolean {
	return (
		typeof command === "string" &&
		/(?:^|[\s;&|(])gh[ \t]+pr[ \t]+(?:create|new)(?=[\s;&|)]|$)/.test(command) &&
		!/\s(?:--help|-h|--dry-run)(?=[\s=]|$)/.test(command)
	);
}

type Result = {
	toolName: string;
	input: unknown;
	isError?: boolean;
	content?: readonly { type: string; text?: string }[];
	structuredContent?: unknown;
};

function outputPullRequestUrls(result: Result, splitText = false): string[] {
	const structured = result.structuredContent as { exit_code?: number; output?: string } | undefined;
	const output =
		structured?.output ??
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	if (typeof output !== "string") return [];
	return (splitText || typeof structured?.output === "string" ? output.split(/\r?\n/) : [output])
		.map((line) => line.trim())
		.filter((line) => /^https:\/\/[a-z\d.-]+\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/i.test(line));
}

/** A successful creation call must return its one bare HTTPS pull URL, not an arbitrary mentioned link. */
export function createdPullRequest(result: Result): string | undefined {
	if (result.toolName !== "bash" || result.isError) return undefined;
	const input = result.input as { command?: unknown } | undefined;
	if (!createsPullRequest(input?.command)) return undefined;
	const structured = result.structuredContent as { exit_code?: number } | undefined;
	if (structured?.exit_code !== undefined && structured.exit_code !== 0) return undefined;
	const urls = outputPullRequestUrls(result);
	return urls.length === 1 ? urls[0]!.replace(/\/$/, "") : undefined;
}

/** A confirmed creation, or an attempt requiring the daemon's branch/time/ownership reconciliation. */
export function pullRequestCreation(result: Result): { url: string } | { attempted: true } | undefined {
	const url = createdPullRequest(result);
	if (url) return { url };
	if (result.toolName !== "bash" || !attemptsPullRequest((result.input as { command?: unknown } | undefined)?.command))
		return undefined;
	const exitCode = (result.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
	// A later shell command can fail after gh created the PR. Its bare URL warrants reconciliation,
	// never direct ownership: output alone cannot prove which command produced it.
	if ((result.isError || (exitCode !== undefined && exitCode !== 0)) && !outputPullRequestUrls(result, true).length)
		return undefined;
	return { attempted: true };
}

/** Native nested results are observed at execution time, even if codemode discards them or later fails. */
export function pullRequestProvenance(
	record: (url: string) => Promise<void>,
	attempted: () => void = () => {},
): {
	native: ExtensionFactory;
	prepare(extension: Extension): Extension;
} {
	const active = new Map<string, { error?: unknown }>();
	const settle = async (creation: ReturnType<typeof pullRequestCreation>) => {
		if (creation && "url" in creation) await record(creation.url);
		else if (creation) attempted();
	};
	const observe = async (event: ToolResultEvent) => {
		if (!event.parentToolCallId) return;
		const root = [...active].find(([id]) => event.toolCallId.startsWith(`${id}/`))?.[1];
		if (!root) return;
		try {
			await settle(pullRequestCreation(event));
		} catch (error) {
			// SDK notification handlers report and swallow failures. Fail the outer durable call too,
			// rather than silently losing provenance for a successful external side effect.
			root.error = error;
			throw error;
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
						await settle(
							pullRequestCreation({
								...result,
								toolName: tool.name,
								input: args,
								structuredContent: details?.__piNativeAdapter?.structuredContent,
							}),
						);
						return result;
					} finally {
						active.delete(api.callId);
					}
				},
			})),
		}),
	};
}
