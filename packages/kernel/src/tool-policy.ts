/** Command policy shared by the Harness, nested native calls and child agents. No runtime SDK imports. */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface ExecutionPermission {
	authorizationId: string;
	level: "investigate" | "implement" | "publish" | "merge";
}

/** Invalid inherited authority must fail closed rather than silently restoring unrestricted Build. */
export function inheritedExecutionPermission(value: string | undefined): ExecutionPermission | undefined {
	if (value === undefined) return undefined;
	const parsed = JSON.parse(value) as ExecutionPermission;
	if (
		!parsed ||
		typeof parsed.authorizationId !== "string" ||
		!parsed.authorizationId ||
		!["investigate", "implement", "publish", "merge"].includes(parsed.level)
	)
		throw new Error("Invalid inherited execution permission");
	return { authorizationId: parsed.authorizationId, level: parsed.level };
}

/** Backup policy gates, not an OS/network sandbox for arbitrary programs run by a trusted Build agent. */
export function executionPermissionBlock(
	permission: ExecutionPermission | undefined,
	name: string,
	args: Record<string, unknown>,
): string | undefined {
	if (!permission) return undefined;
	const commands = commandArguments(name, args);
	const executable = strings(name === "codemode" ? strings(commands).flatMap(nestedShellCommands) : commands).join(
		"\n",
	);
	if (permission.level === "investigate") {
		if (executable || !INVESTIGATE_TOOLS.has(name))
			return "Pilot policy: investigate permission is Ask/read-only. Start a separately authorized Build chat for implementation.";
		return undefined;
	}
	// Removing the publication tier does not authorize destructive GitHub administration.
	if (
		permission.level === "implement" &&
		(/\bgh\s+(?:repo|release|cache|secret|variable|gist|label|ruleset|ssh-key|gpg-key)\s+delete\b/.test(executable) ||
			(/\bgh\s+api\b/.test(executable) && /\s(?:-X|--method)[\s=]*DELETE\b/i.test(` ${executable}`)) ||
			(/\bgh\s+api\b/.test(executable) &&
				/\bmutation\b/.test(executable) &&
				/\bdelete[A-Z]\w*\b/.test(executable)) ||
			/\bmcp__github\w*__\w*delete\w*/i.test(name))
	)
		return "Pilot policy: destructive GitHub actions are outside Build PR delivery. Do not delete repositories, branches or other remote resources.";
	return undefined;
}

const INVESTIGATE_TOOLS = new Set([
	"codemode",
	"read",
	"find",
	"grep",
	"code_search",
	"code_symbols",
	"ls",
	"web",
	"artifact",
	"ask_user",
	"mission",
	"history_recall",
]);
/** Runs for actual nested tool calls too, including dynamically constructed codemode arguments. */
export function nativeToolPolicy(permission?: ExecutionPermission): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", (event) => {
			const posting = githubPosting([event.toolName, commandArguments(event.toolName, event.input)]);
			const reason = posting
				? `Pilot policy: agents do not ${posting} on GitHub. Report it in your final answer instead.`
				: executionPermissionBlock(permission, event.toolName, event.input);
			if (reason) return { block: true, reason };
		});
	};
}

/** Commands that would post on GitHub. Reads (`gh pr view`, `gh api …/comments` without a write) stay allowed. */
const POSTING: Array<{ pattern: RegExp; what: string }> = [
	{ pattern: /\bgh\s+(?:pr|issue)\s+(?:comment|review)\b/, what: "comment or review" },
	{ pattern: /\bgh\s+pr\s+(?:merge|close)\b/, what: "merge or close a pull request" },
	{ pattern: /\bgh\s+stack\s+merge\b/, what: "merge a pull request stack" },
	{
		pattern: /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest)\b/,
		what: "merge a pull request through GraphQL",
	},
	{
		pattern: /\bgh\s+stack\s+(?:submit|push|sync|rebase|modify|unstack)\b/,
		what: "push or rewrite branches through gh stack",
	},
	{ pattern: /\bgh\s+issue\s+(?:close|create)\b/, what: "create or close an issue" },
	{ pattern: /\bmcp__github\w*__\w*(?:comment|review|merge)\w*/i, what: "comment, review or merge" },
];
const API_WRITE = /\s(?:-X|--method)[\s=]*(?:POST|PATCH|PUT|DELETE)\b|\s-[fF]\s|\s--(?:raw-)?field\b|\s--input\b/i;
const API_POSTING_PATH = /\/(?:comments|reviews|replies|merge)\b|\/pulls\/\d+\/reviews|\/issues\/\d+\/comments/;
const REACTION_PATH = /\/(?:pulls|issues)\/comments\/\d+\/reactions(?=[\s"'?]|$)/g;
const API_FIELD = /\s(?:-[fF]|--(?:raw-)?field)[\s=]/g;

/** A +1 reaction on a comment acknowledges a fix. It is the one GitHub write agents may make. */
function thumbsUpReaction(command: string): boolean {
	return (
		/\/(?:pulls|issues)\/comments\/\d+\/reactions(?=[\s"'?]|$)/.test(command) &&
		!API_POSTING_PATH.test(command.replace(REACTION_PATH, "")) &&
		(` ${command}`.match(API_FIELD)?.length ?? 0) === 1 &&
		/\s(?:-[fF]|--(?:raw-)?field)[\s=]+(["']?)content=\+1\1(?=\s|$)/.test(` ${command}`) &&
		!/\s--input\b/.test(command) &&
		!/\s(?:-X|--method)[\s=]*(?!POST\b)\w+/i.test(` ${command}`)
	);
}

/** Literal shell arguments in codemode, not prose in other tool calls. Never evaluate script source. */
export function nestedShellCommands(code: string): unknown[] {
	const literals = new Map<number, string>();
	// Mask strings and comments before looking for calls, so examples inside content stay inert.
	const masked = code.replace(
		/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
		(value, offset: number) => {
			if (value.startsWith("/")) return " ".repeat(value.length);
			// Preserve quoted argument keys, but replace literal values with an indexed placeholder.
			if (/^["'](?:action|command|cmd|script)["']$/.test(value) && /^\s*:/.test(code.slice(offset + value.length)))
				return ` ${value.slice(1, -1)} `;
			literals.set(offset, value.slice(1, -1));
			return `@${" ".repeat(value.length - 1)}`;
		},
	);
	const commands: unknown[] = [];
	for (const call of masked.matchAll(/\btools\.(\w+)\s*\(\s*\{/g)) {
		const start = call.index + call[0].length;
		let end = start;
		let depth = 1;
		for (; end < masked.length && depth; end++) {
			if (masked[end] === "{") depth++;
			if (masked[end] === "}") depth--;
		}
		const args: Record<string, unknown> = {};
		for (const field of masked.slice(start, end - 1).matchAll(/\b(action|command|cmd|script)\s*:\s*@/g)) {
			args[field[1]!] = literals.get(start + field.index + field[0].length - 1);
		}
		commands.push(commandArguments(call[1]!, args));
	}
	return commands;
}

/** Why executable text would post on GitHub, or undefined. Includes nested calls in codemode scripts. */
export function githubPosting(arguments_: unknown): string | undefined {
	const text = strings(arguments_).join("\n");
	for (const { pattern, what } of POSTING) if (pattern.test(text)) return what;
	// One `gh api` command at a time: a write flag plus a comment/review/merge endpoint.
	for (const command of text.split(/\n|;|&&|\|\|/)) {
		if (
			/\bgh\s+api\b/.test(command) &&
			API_POSTING_PATH.test(command) &&
			API_WRITE.test(` ${command}`) &&
			!thumbsUpReaction(command)
		)
			return "post through the GitHub API";
	}
	return undefined;
}

export function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.values(value).flatMap(strings);
	return [];
}

/** Select execution-bearing fields, not metadata or content-only tool arguments. */
export function commandArguments(name: string, args: Record<string, unknown>): unknown {
	// Conservatively scan script source to retain coverage of nested tool calls.
	if (name === "codemode") return args.code;
	if (name === "jobs") return args.action === "start" ? args.command : undefined;
	// Native shells and common shell-tool names (including namespaced MCP tools).
	if (/(?:^|__)(?:bash|powershell|shell|sh|exec|execute_command|run_command|terminal)$/.test(name))
		return args.command ?? args.cmd ?? args.script;
	return undefined;
}
