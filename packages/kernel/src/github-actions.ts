/** Execution-time attribution. Never retain shell source, output, headers or bodies. */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { defineDoc, type Extension } from "@earendil-works/pi-durable";
import type { GitHubAction } from "@pilot/protocol";
import { commandArguments } from "./policy.ts";
import { createdPullRequest } from "./pull-request-provenance.ts";

export const GITHUB_ACTION_LIMIT = 200;
export const GitHubActionsDoc = defineDoc<{ actions: GitHubAction[] }>({
	kind: "pilot.github-actions",
	version: 1,
	scope: "session",
	initial: () => ({ actions: [] }),
});
export function appendGitHubAction(state: { actions: GitHubAction[] }, action: GitHubAction): boolean {
	if (state.actions.some((item) => item.id === action.id)) return false;
	state.actions.push(action);
	state.actions.splice(0, Math.max(0, state.actions.length - GITHUB_ACTION_LIMIT));
	return true;
}

/** Quotes stay arguments, not commands. Never interpret dynamic values as targets. */
function commands(source: string): string[][] {
	const result: string[][] = [[]];
	let word = "",
		quote = "",
		escaped = false;
	let comment = false;
	const flush = () => {
		if (word) result.at(-1)!.push(word);
		word = "";
	};
	for (const c of source) {
		if (comment) {
			if (c === "\n") {
				comment = false;
				flush();
				if (result.at(-1)!.length) result.push([]);
			}
		} else if (escaped) {
			word += c;
			escaped = false;
		} else if (c === "\\" && quote !== "'") escaped = true;
		else if (quote) {
			if (c === quote) quote = "";
			else word += c;
		} else if (c === "'" || c === '"') quote = c;
		else if (c === "#" && !word) comment = true;
		else if (/[;&|\n]/.test(c)) {
			flush();
			if (result.at(-1)!.length) result.push([]);
		} else if (/\s/.test(c)) flush();
		else word += c;
	}
	flush();
	return result.filter((c) => c.length);
}
function branch(value: string | undefined): string | undefined {
	return value &&
		value.length <= 120 &&
		/^(?:refs\/heads\/)?[a-zA-Z0-9][\w./-]*$/.test(value) &&
		!/(?:gh[pousr]_|github_pat_|token|secret|password)/i.test(value)
		? value
		: undefined;
}
function options(words: string[]): { flags: Map<string, string>; positional: string[]; fields: string[] } {
	const values = new Set([
		"--body",
		"-b",
		"--body-file",
		"-F",
		"--title",
		"-t",
		"--repo",
		"-R",
		"--head",
		"-H",
		"--base",
		"-B",
		"--field",
		"-f",
		"--raw-field",
		"--input",
		"--method",
		"-X",
		"--header",
		"--label",
		"-l",
		"--assignee",
		"-a",
		"--reviewer",
		"-r",
		"--milestone",
		"-m",
		"--project",
		"-p",
		"--bookmark",
		"--hostname",
		"--push-option",
		"-o",
		"--receive-pack",
		"--exec",
	]);
	const flags = new Map<string, string>();
	const fields: string[] = [];
	const set = (key: string, value: string) => {
		flags.set(key, value);
		if (["--field", "--raw-field", "-f", "-F"].includes(key)) fields.push(value);
	};
	const positional: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i]!;
		if (word === "--") {
			positional.push(...words.slice(i + 1));
			break;
		}
		if (!word.startsWith("-")) {
			positional.push(word);
			continue;
		}
		const equal = word.indexOf("=");
		if (word.startsWith("--") && equal > 0) {
			set(word.slice(0, equal), word.slice(equal + 1));
		} else if (values.has(word)) {
			set(word, words[++i] ?? "");
		} else if (/^-[^-].+/.test(word) && values.has(word.slice(0, 2))) {
			set(word.slice(0, 2), word.slice(2));
		} else flags.set(word, "");
	}
	return { flags, positional, fields };
}
type Summary = Pick<GitHubAction, "summary" | "target" | "description">;
export function githubCommandSummaries(
	name: string,
	args: Record<string, unknown>,
): { summaries: Summary[]; single: boolean } {
	// Source is policy input, not evidence. Actual nested results supply evidence.
	if (name === "codemode") return { summaries: [], single: false };
	const source = commandArguments(name, args);
	if (typeof source !== "string") return { summaries: [], single: false };
	const parts = commands(source);
	const summaries: Summary[] = [];
	for (const original of parts) {
		const words = [...original];
		if (words[0] === "env") words.shift();
		while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
		if (words[0] === "command") words.shift();
		if (/^\/[\w/.-]+\/(?:git|gh|jj)$/.test(words[0] ?? "")) words[0] = words[0]!.split("/").at(-1)!;
		while (
			(words[0] === "git" && ["-C", "-c"].includes(words[1] ?? "")) ||
			(words[0] === "gh" && ["-R", "--repo", "--hostname"].includes(words[1] ?? ""))
		)
			words.splice(1, 2);
		const start = words[0] === "git" || (words[0] === "gh" && words[1] === "api") ? 2 : 3;
		const { flags, positional, fields: fieldValues } = options(words.slice(start));
		const flag = (long: string, short?: string) => flags.get(long) ?? (short ? flags.get(short) : undefined);
		if (flags.has("--help") || flags.has("-h") || flags.has("--dry-run")) continue;
		let summary: string | undefined,
			description = "",
			target: string | undefined;
		if (
			(words[0] === "git" && words[1] === "push") ||
			(words[0] === "jj" && words[1] === "git" && words[2] === "push")
		) {
			if (flags.has("-n")) continue;
			summary = words[0] === "jj" ? "jj git push" : "git push";
			const bookmark = flag("--bookmark", "-b");
			const value = bookmark ?? (words[0] === "git" ? positional[1]?.split(":").at(-1) : undefined);
			target = branch(value);
			description = target ? `pushed branch ${target}` : "pushed branches";
		} else if (
			words[0] === "gh" &&
			words[1] === "pr" &&
			["create", "ready", "edit", "reopen"].includes(words[2] ?? "")
		) {
			const action = words[2]!;
			summary = `gh pr ${action}`;
			const pr = positional[0]?.match(/^(?:[1-9]\d*|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*))$/);
			const number = pr ? (pr[1] ?? pr[0]) : undefined;
			const head = branch(flag("--head", "-H")) ?? (action !== "create" ? branch(positional[0]) : undefined);
			target = number ? `PR #${number}` : head ? `branch ${head}` : undefined;
			const label = number ? `PR #${number}` : head && action !== "create" ? `PR for branch ${head}` : "a PR";
			description =
				action === "ready"
					? `marked ${label} ${flags.has("--undo") ? "draft" : "ready"}`
					: action === "create"
						? `created ${label}${head ? ` from ${head}` : ""}`
						: `${action === "edit" ? "edited" : "reopened"} ${label}`;
		} else if (words[0] === "gh" && words[1] === "api") {
			const method = flag("--method", "-X")?.toUpperCase();
			const fields = ["--field", "--raw-field", "-f", "-F", "--input"].some((key) => flags.has(key));
			const query = fieldValues.find((value) => /^query=/.test(value));
			const mutation = positional[0] === "graphql" && query !== undefined && /\bmutation\b/.test(query);
			if (positional[0] === "graphql" && query !== undefined && !mutation) continue;
			if (!(mutation || (method ? method !== "GET" && method !== "HEAD" : fields))) continue;
			summary = `gh api ${mutation ? "mutation" : ["POST", "PATCH", "PUT", "DELETE"].includes(method ?? "") ? method : "write"}`;
			const pr = positional
				.find((w) => /^\/?repos\/[\w.-]+\/[\w.-]+\/pulls\/[1-9]\d*(?:\/|$)/.test(w))
				?.match(/\/pulls\/([1-9]\d*)/);
			target = pr ? `PR #${pr[1]}` : undefined;
			description = `updated GitHub${target ? ` (${target})` : ""}`;
		}
		if (summary) summaries.push({ summary, description, ...(target ? { target } : {}) });
		if (summaries.length > GITHUB_ACTION_LIMIT) summaries.shift();
	}
	return { summaries, single: parts.length === 1 && !/[;&|\n`$()<>]/.test(source.trim()) };
}
export function actionText(action: GitHubAction): string {
	const outcome =
		action.exitCode === 0
			? ""
			: action.exitCode === null
				? " (exit status unknown)"
				: ` (failed, exit ${action.exitCode})`;
	const description = action.exitCode === 0 ? action.description : `attempted: ${action.description}`;
	return `${description}${outcome} · ${action.summary} · ${new Date(action.at).toISOString()}`;
}
type Result = { isError?: boolean; structuredContent?: unknown; content?: readonly { type: string; text?: string }[] };
export function githubActions(record: (action: GitHubAction) => Promise<void>): {
	native: ExtensionFactory;
	prepare(extension: Extension): Extension;
} {
	const active = new Map<string, { error?: unknown }>();
	const observe = async (id: string, name: string, args: Record<string, unknown>, result: Result) => {
		const { summaries, single } = githubCommandSummaries(name, args);
		const code = (result.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
		const exitCode = single && typeof code === "number" && Number.isSafeInteger(code) ? code : null;
		for (const [index, initial] of summaries.entries()) {
			let summary = initial;
			if (single && exitCode === 0 && initial.summary === "gh pr create") {
				const url = createdPullRequest({ ...result, toolName: name, input: args });
				const number = url?.match(/\/pull\/([1-9]\d*)$/)?.[1];
				if (number) summary = { ...initial, target: `PR #${number}`, description: `created PR #${number}` };
			}
			if (single && exitCode === 0 && initial.summary.startsWith("gh pr ") && !initial.target) {
				const output = (result.structuredContent as { output?: unknown } | undefined)?.output;
				const text =
					typeof output === "string"
						? output
						: (result.content
								?.filter((part) => part.type === "text")
								.map((part) => part.text ?? "")
								.join("\n") ?? "");
				// Parse only standard CLI confirmation shapes. Never store output or arbitrary URL data.
				const numbers = [
					...text.matchAll(
						/(?:^|\n)https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*)\/?(?:\r?\n|$)|Pull request [\w.-]+\/[\w.-]+#([1-9]\d*) is marked as (?:ready for review|draft)/g,
					),
				].map((match) => match[1] ?? match[2]);
				if (numbers.length === 1)
					summary = {
						...initial,
						target: `PR #${numbers[0]}`,
						description: initial.description.replace("a PR", `PR #${numbers[0]}`),
					};
			}
			await record({
				id: `${id}:${index}`,
				...summary,
				at: Date.now(),
				exitCode,
			});
		}
	};
	return {
		native: (pi) => {
			pi.on("tool_result", async (event) => {
				if (!event.parentToolCallId) return;
				const root = [...active].find(([id]) => event.toolCallId.startsWith(`${id}/`))?.[1];
				if (!root) return;
				try {
					await observe(event.toolCallId, event.toolName, event.input as Record<string, unknown>, event);
				} catch (error) {
					root.error = error;
					throw error;
				}
			});
		},
		prepare: (extension) => ({
			...extension,
			tools: extension.tools?.map((tool) => ({
				...tool,
				execute: async (args, api, context) => {
					const root: { error?: unknown } = {};
					active.set(api.callId, root);
					let result: Awaited<ReturnType<typeof tool.execute>>;
					try {
						result = await tool.execute(args, api, context);
					} catch (error) {
						await observe(api.callId, tool.name, args as Record<string, unknown>, { isError: true });
						throw error;
					} finally {
						active.delete(api.callId);
					}
					if (root.error !== undefined) throw root.error;
					const details = result.details as { __piNativeAdapter?: { structuredContent?: unknown } } | undefined;
					await observe(api.callId, tool.name, args as Record<string, unknown>, {
						...result,
						structuredContent: details?.__piNativeAdapter?.structuredContent,
					});
					return result;
				},
			})),
		}),
	};
}
