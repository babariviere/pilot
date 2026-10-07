/** Pilot's rules for agents: where they work, how they deliver, and what they may not do on GitHub. */
import { hook, section, ToolTask, type Extension } from "@earendil-works/pi-durable";

export interface WorkspaceContext {
	/** The user's checkout this clone came from. */
	source: string;
	branch: string;
	base: string;
	upstream?: string;
	jj: boolean;
}

export interface PilotContext {
	workspace?: WorkspaceContext;
}

/** Commands that would post on GitHub. Reads (`gh pr view`, `gh api …/comments` without a write) stay allowed. */
const POSTING: Array<{ pattern: RegExp; what: string }> = [
	{ pattern: /\bgh\s+(?:pr|issue)\s+(?:comment|review)\b/, what: "comment or review" },
	{ pattern: /\bgh\s+pr\s+(?:merge|close)\b/, what: "merge or close a pull request" },
	{ pattern: /\bgh\s+issue\s+(?:close|create)\b/, what: "create or close an issue" },
	{ pattern: /\bmcp__github\w*__\w*(?:comment|review|merge)\w*/i, what: "comment, review or merge" },
];
const API_WRITE = /\s(?:-X|--method)[\s=]*(?:POST|PATCH|PUT|DELETE)\b|\s-[fF]\s|\s--(?:raw-)?field\b|\s--input\b/i;
const API_POSTING_PATH = /\/(?:comments|reviews|replies|merge)\b|\/pulls\/\d+\/reviews|\/issues\/\d+\/comments/;

/** Why a tool call would post on GitHub, or undefined. Scans every string argument, including codemode scripts. */
export function githubPosting(arguments_: unknown): string | undefined {
	const text = strings(arguments_).join("\n");
	for (const { pattern, what } of POSTING) if (pattern.test(text)) return what;
	// One `gh api` command at a time: a write flag plus a comment/review/merge endpoint.
	for (const command of text.split(/\n|;|&&|\|\|/)) {
		if (/\bgh\s+api\b/.test(command) && API_POSTING_PATH.test(command) && API_WRITE.test(` ${command}`))
			return "post through the GitHub API";
	}
	return undefined;
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.values(value).flatMap(strings);
	return [];
}

export function pilotPrompt(context: PilotContext): string {
	const lines = ["You are running inside Pilot as a background agent. The user reviews your work in the Pilot app."];
	const workspace = context.workspace;
	if (workspace) {
		lines.push(
			`- Your working directory is a private clone of ${workspace.source}, on branch \`${workspace.branch}\` started from \`${workspace.base}\`. Uncommitted changes in the user's own checkout are not here, and nothing you do here touches it.`,
		);
		if (workspace.jj) {
			lines.push(
				`- The clone is a colocated jj repository. Commit with jj, move the bookmark with \`jj bookmark set ${workspace.branch} -r @-\`, and push with \`jj git push --bookmark ${workspace.branch}\`.`,
			);
		} else {
			lines.push(`- Commit on \`${workspace.branch}\` and push it with \`git push -u origin ${workspace.branch}\`.`);
		}
		lines.push(
			"- When the work is ready, open a pull request with `gh pr create`. It is opened as the user. Never merge.",
		);
	}
	lines.push(
		"- Never post on GitHub: no comments, reviews or replies on pull requests or issues, and no merging or closing. Put results, questions and anything you decided not to do in your final answer instead.",
	);
	return lines.join("\n");
}

/** Adds Pilot's prompt section and GitHub policy to the native extension. */
export function withPilotPolicy(extension: Extension, context: PilotContext): Extension {
	return {
		...extension,
		sections: [...(extension.sections ?? []), section("pilot", () => pilotPrompt(context))],
		hooks: [
			...(extension.hooks ?? []),
			hook(ToolTask, {
				beforeTool: (call) => {
					const posting = githubPosting(call.arguments);
					return posting
						? {
								block: `Pilot policy: agents do not ${posting} on GitHub. Report it in your final answer instead.`,
							}
						: undefined;
				},
			}),
		],
	};
}
