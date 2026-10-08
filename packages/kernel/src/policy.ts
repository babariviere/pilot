/** Pilot's rules for agents: where they work, how they deliver, and what they may not do on GitHub. */
import { type Extension, hook, section, ToolTask } from "@earendil-works/pi-durable";

export interface WorkspaceContext {
	/** The user's checkout this clone came from. */
	source: string;
	branch?: string;
	base: string;
	upstream?: string;
	jj: boolean;
}

export interface PilotContext {
	workspace?: WorkspaceContext;
	/** Project delivery policy, read when the worker starts. Omitted means PR delivery for private clones. */
	requirePullRequest?: boolean;
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

export function pilotPrompt(context: PilotContext, artifactsAvailable = false): string {
	const lines = ["You are running inside Pilot as a background agent. The user reviews your work in the Pilot app."];
	if (artifactsAvailable) {
		lines.push(
			"- When explaining architecture, workflows, relationships or complex behavior, proactively publish a diagram with the artifact tool when it makes the explanation clearer, without waiting for the user to request one. Prefer simple Mermaid diagrams in HTML artifacts using the bundled mermaid library. Accompany the diagram with a short explanation; skip diagrams for trivial answers or when the user asks for text only.",
			"- Artifact preview is optional verification, never a prerequisite for publishing. If preview is unavailable or fails, publish without it. Do not ask the user to install a browser just to create a diagram.",
		);
	}
	const workspace = context.workspace;
	const requirePullRequest = context.requirePullRequest !== false;
	if (workspace) {
		lines.push(
			`- Your working directory is a private clone of ${workspace.source}, started from \`${workspace.base}\`${workspace.branch ? `, with branch/bookmark \`${workspace.branch}\`` : ", initially detached with no task branch or bookmark"}. Uncommitted changes in the user's own checkout are not here, and nothing you do here touches it.`,
		);
		if (requirePullRequest && workspace.jj) {
			lines.push(
				"- The clone is a colocated jj repository. Use jj for version-control changes. If a new bookmark is needed, create it with `jj bookmark create <name> -r @`; after committing, move the chosen bookmark with `jj bookmark set <name> -r @-`, and push with `jj git push --bookmark <name>`.",
			);
		} else if (requirePullRequest) {
			lines.push(
				"- If a new branch is needed, create it with `git switch -c <name>`. Commit on the chosen branch and push it with `git push -u origin <name>`.",
			);
		}
	}
	if (workspace || context.requirePullRequest !== undefined) {
		if (requirePullRequest) {
			lines.push(
				"- Choose or create a descriptive branch or bookmark for this task before making changes. New names must use `<type>/<short-description>`, with a conventional prefix matching the task: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `build/`, `ci/`, `perf/`, `style/`, `chore/`, or `revert/` (for example, `fix/branch-prefix-policy`). Keep an existing branch or bookmark name, including a PR head, even if it does not follow this convention. Do not use a `pilot/` prefix for new names. Never push the default branch.",
				"- When the work is ready, open a pull request with `gh pr create`. It is opened as the user. Never merge.",
			);
		} else {
			lines.push(
				"- This project does not require a pull request. You may commit and push completed, verified work directly to the remote's default branch. Do not open a PR unless the user asks for one; a separate task branch is not required.",
				"- Identify the remote's current default branch before making changes; do not assume it is named main. Fetch and reconcile concurrent upstream changes before pushing. Never force-push or overwrite others' commits. Stop and report if branch protection or a conflict prevents safe delivery.",
			);
			if (workspace?.jj) {
				lines.push(
					"- The clone is a colocated jj repository. Use jj for version-control changes. Track the remote default-branch bookmark with `jj bookmark track <default-branch>@origin`. After committing, move that bookmark to the completed commit and push it with `jj git push --bookmark <default-branch>`.",
				);
			} else if (workspace) {
				lines.push(
					"- The clone starts detached. Check out the remote's default branch locally before committing, then push it with `git push origin <default-branch>`.",
				);
			}
		}
	}
	lines.push(
		"- Before your final response, call pilot_report_status to report the task outcome, not merely that your reply is finished. Use done only when the requested work is complete. Use needs_input when an answer, decision, approval or missing information blocks further work, including an ongoing design discussion awaiting a decision or permission to implement. Do not mark an unfinished task done just because you proposed a plan or answered one part of it. A fully answered standalone question can be done; optional offers after completed work are not blockers. Briefly explain the blocker in the reason, and put the actual question in your final response. A new user message starts work again; do not keep running while waiting for an answer.",
		"- Never post on GitHub: no comments, reviews or replies on pull requests or issues, and no merging or closing. Put results, questions and anything you decided not to do in your final answer instead.",
	);
	return lines.join("\n");
}

/** Adds Pilot's prompt section and GitHub policy to the native extension. */
export function withPilotPolicy(
	extension: Extension,
	context: PilotContext,
	artifactsAvailable: () => boolean = () => false,
): Extension {
	return {
		...extension,
		sections: [...(extension.sections ?? []), section("pilot", () => pilotPrompt(context, artifactsAvailable()))],
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
