import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { test } from "node:test";
import type { ToolHooks } from "@earendil-works/pi-durable";
import {
	githubPosting,
	type MissionContext,
	missionLeak,
	missionPrompt,
	pilotPrompt,
	withPilotPolicy,
} from "./policy.ts";

const mission: MissionContext = {
	id: "m1",
	title: "API v2 redesign",
	goal: "Replace REST v1",
	status: "active",
	coordinator: "user",
	tasks: [{ number: 2, title: "Auth endpoints", status: "in_progress" }],
	decisions: ["IDs are opaque strings"],
};

test("mission prompt explains the shared state, the chat's tasks, decisions and the deliverable rule", () => {
	const prompt = missionPrompt(mission);
	assert.match(prompt, /part of the mission "API v2 redesign", whose goal is: Replace REST v1/);
	assert.match(prompt, /mission\(\{action: "get"\}\)/);
	assert.match(prompt, /The user coordinates this mission/);
	assert.match(prompt, /#2 Auth endpoints \(in progress\)/);
	assert.match(prompt, /Decisions \(binding, they override the brief\): IDs are opaque strings/);
	assert.match(prompt, /without mentioning the mission/);
	assert.match(prompt, /Linear issue IDs are fine/);
	assert.match(missionPrompt({ ...mission, coordinator: "self" }), /You coordinate this mission/);
	assert.match(
		missionPrompt({ ...mission, coordinator: "self" }),
		/cheaper models for small tasks.*strongest allowed model for hard ones/,
	);
	assert.doesNotMatch(prompt, /cheaper models/);
	assert.match(missionPrompt({ ...mission, status: "done" }), /This mission is done/);
});

test("coordinator actions are named only for the coordinator and detailed in the tool, not the prompt", () => {
	for (const coordinator of ["self", "other", "user"] as const) {
		const prompt = missionPrompt({ ...mission, coordinator });
		assert.equal(
			prompt.includes("coordinator actions (delete, group, task order, start, send, status)"),
			coordinator === "self",
		);
		assert.match(prompt, /dropped when no longer needed/);
		// Per-action recipes live in the mission tool description, which is only loaded when the tool is used.
		assert.doesNotMatch(prompt, /mission\(\{action: "(?:delete|group|start|send|status)"/);
	}
});

test("multi-task guidance claims requested tasks, orders work, maintains statuses and separates PRs", () => {
	for (const coordinator of ["self", "other", "user"] as const) {
		const prompt = missionPrompt({ ...mission, coordinator, tasks: [] });
		assert.match(prompt, /claim them together \(ids such as \["1-5"\]\)/);
		assert.match(prompt, /one at a time in dependency order/);
		assert.match(prompt, /report skipped claims and unfinished dependencies instead of working past them/);
		assert.match(
			prompt,
			/in_progress while working, blocked with a comment saying why, in_review once a pull request is open/,
		);
		assert.match(prompt, /Open one pull request per task/);
		assert.match(prompt, /link it to the task with the link action and taskId/);
		assert.match(prompt, /Never rewrite or push another chat's branches/);
		assert.match(prompt, /post a handoff with log before stopping with unfinished work/);
	}
});

test("the coordinator prompt allows chat starts only on request", () => {
	const prompt = missionPrompt({ ...mission, coordinator: "self" });
	assert.match(prompt, /Start chats only when the user asks/);
	assert.match(prompt, /Autopilot is not enabled/);
	for (const coordinator of ["other", "user"] as const)
		assert.doesNotMatch(missionPrompt({ ...mission, coordinator }), /Start chats/);
});

test("stack guidance uses existing PR URLs, preserves sibling work and explains detected fallback", () => {
	for (const available of [true, false, undefined]) {
		const prompt = missionPrompt(mission, available);
		assert.match(prompt, /base your own bookmark on the dependency's head/);
		assert.match(prompt, /possibly another chat's/);
		assert.match(prompt, /--base <dependency-head> --head <own-head>/);
		if (available === false) {
			assert.match(prompt, /github\/gh-stack is unavailable: keep plain chained PRs and do not install it/);
			assert.doesNotMatch(prompt, /gh stack link/);
			continue;
		}
		assert.match(prompt, /gh stack link <bottom-pr-url> … <top-pr-url>/);
		assert.match(prompt, /Pass existing PR URLs, not branch names/);
		assert.match(prompt, /keep the existing stack order and members/);
		assert.match(prompt, /use only link and view/);
		assert.match(prompt, /If the repository rejects stacks, keep the plain chained PRs/);
		assert.match(prompt, available ? /github\/gh-stack is installed/ : /If gh extension list shows github\/gh-stack/);
	}
});

test("deliverable guard blocks mission references in commits, bookmarks and pull requests only", () => {
	assert.ok(missionLeak({ command: 'gh pr create --title "API v2 redesign: auth"' }, mission));
	assert.ok(missionLeak({ command: 'jj describe -m "feat: auth (mission task #2)"' }, mission));
	assert.ok(missionLeak({ command: 'git commit -m "Part of this mission"' }, mission));
	assert.ok(
		missionLeak({ code: "await tools.bash({command: \"gh pr create --body 'Coordinator chat asked'\"})" }, mission),
	);
	assert.equal(
		missionLeak({ command: 'gh pr create --title "feat: auth endpoints" --body "Fixes ENG-12"' }, mission),
		undefined,
	);
	assert.equal(
		missionLeak({ command: "rg 'API v2 redesign' docs" }, mission),
		undefined,
		"reads are not deliverables",
	);
	assert.equal(missionLeak({ command: 'gh pr create --title "API v2 redesign"' }, undefined), undefined);
	assert.equal(
		missionLeak({ command: 'jj describe -m "feat(missions): add mission tool"' }, mission),
		undefined,
		"describing work on a missions feature itself is allowed",
	);
});

test("Pilot diagram guidance is conditional on artifact availability", () => {
	const enabled = pilotPrompt({}, true);
	assert.match(enabled, /publish one with the artifact tool without being asked/);
	assert.match(enabled, /simple Mermaid diagram/);
	assert.match(enabled, /short explanation/);
	assert.match(enabled, /Skip it for simple answers/);
	assert.match(enabled, /text only/);
	assert.match(enabled, /Artifact preview is optional\. If it is unavailable or fails, publish without it/);
	for (const prompt of [pilotPrompt({}), pilotPrompt({}, false)])
		assert.doesNotMatch(prompt, /artifact|diagram|Mermaid|preview/);
});

test("Build prompts define completion; Ask prompts do not", () => {
	const build = pilotPrompt({});
	assert.match(build, /finish with a working change/);
	assert.match(build, /without pausing for review after a first pass/);
	assert.match(build, /Ask only when a decision would materially change scope/);
	assert.doesNotMatch(pilotPrompt({ ask: { source: "/source" } }), /finish with a working change/);
});

test("Ask permits proactive session-local diagrams and sandboxed previews without repository mutation", () => {
	const prompt = pilotPrompt({ ask: { source: "/source" } }, true);
	assert.match(prompt, /without being asked/);
	assert.match(prompt, /simple Mermaid diagram/);
	assert.match(prompt, /Creating, updating and previewing host-owned session-local artifacts is allowed/);
	assert.match(prompt, /installed sandboxed renderers/);
	assert.match(prompt, /artifacts do not modify the repository/);
	assert.match(prompt, /Do not write repository files/);
});

test("blocks GitHub posting in commands and codemode scripts", () => {
	assert.ok(githubPosting({ command: 'gh pr comment 12 --body "done"' }));
	assert.ok(githubPosting({ command: "gh pr review 12 --approve" }));
	assert.ok(githubPosting({ command: "gh pr merge 12 --squash" }));
	assert.ok(githubPosting({ code: 'await tools.bash({command:"gh issue comment 3 -b hi"})' }));
	assert.ok(githubPosting({ command: "gh api repos/o/r/issues/3/comments -f body=hi" }));
	assert.ok(githubPosting({ command: "gh api -X POST repos/o/r/pulls/3/reviews" }));
	assert.ok(githubPosting({ code: "await tools.mcp__github__add_issue_comment({body: 'x'})" }));
});

test("allows reading, pushing and opening pull requests", () => {
	assert.equal(githubPosting({ command: "gh pr view 12 --comments" }), undefined);
	assert.equal(githubPosting({ command: "gh api repos/o/r/pulls/3/comments" }), undefined);
	assert.equal(githubPosting({ command: "gh pr create --fill --draft" }), undefined);
	assert.equal(githubPosting({ command: "git push -u origin fix-test" }), undefined);
	assert.equal(githubPosting({ command: "gh run view 42 --log-failed" }), undefined);
});

test("blocks stack merging and branch-rewriting commands, including in codemode", () => {
	for (const subcommand of ["merge", "submit", "push", "sync", "rebase", "modify", "unstack"]) {
		const command = `gh stack ${subcommand} 12`;
		assert.ok(githubPosting({ command }), command);
		assert.ok(githubPosting({ code: `await tools.bash({ command: ${JSON.stringify(command)} })` }), command);
	}
});

test("allows linking, viewing and checking out stacks", () => {
	for (const command of ["gh stack link 12 13", "gh stack view 12 --json", "gh stack checkout 12"]) {
		assert.equal(githubPosting({ command }), undefined, command);
		assert.equal(githubPosting({ code: `await tools.bash({ command: ${JSON.stringify(command)} })` }), undefined);
	}
});

const policy = withPilotPolicy(
	{ name: "test" },
	{},
	() => false,
	() => mission,
);

test("the base prompt is rendered after turn preparation with the current commit", async () => {
	const workspace = { source: "/source", base: "old", jj: true, shared: { repository: "/shared", name: "lead" } };
	const extension = withPilotPolicy(
		{ name: "test" },
		{ workspace },
		() => false,
		() => undefined,
		async () => {
			workspace.base = "current";
		},
	);
	const prompt = await extension.sections![0]!.render(undefined as never, BACKGROUND_CONTEXT);
	assert.match(prompt!, /starts on base `current`/);
	assert.doesNotMatch(prompt!, /base `old`/);
});
const beforeTool = (policy.hooks![0]!.handlers as Pick<ToolHooks, "beforeTool">).beforeTool;
function checkTool(name: string, args: Parameters<ToolHooks["beforeTool"]>[0]["arguments"]) {
	return beforeTool(
		{ type: "toolCall", id: "policy-test", name, arguments: args },
		undefined as never,
		undefined as never,
	);
}

test("content-only calls may mention forbidden commands and internal deliverable names", async () => {
	for (const content of ["gh pr merge 12; gh stack push", 'gh pr create --title "API v2 redesign"']) {
		for (const [name, args] of [
			["mission", { action: "brief", markdown: content }],
			["mission", { action: "task", title: content, body: content }],
			["artifact", { action: "create", title: content, source: content }],
			["write", { path: "README.md", content }],
			["edit", { path: "README.md", oldText: content, newText: content }],
			["applyPatch", { patch: content }],
			["todo", { action: "append", body: content }],
			["read", { path: content }],
		] as const) {
			assert.equal(await checkTool(name, args), undefined, name);
		}
	}
});

test("shell, codemode and job starts still block posting and leaking deliverable names", async () => {
	for (const command of [
		"gh pr merge 12 --squash",
		"gh stack merge 12",
		"gh stack push",
		'gh pr create --title "API v2 redesign"',
	]) {
		for (const [name, args] of [
			["bash", { command }],
			["powershell", { command }],
			["codemode", { code: `await tools.bash({ command: ${JSON.stringify(command)} })` }],
			["codemode", { code: `await tools.jobs({ action: "start", command: ${JSON.stringify(command)} })` }],
			["jobs", { action: "start", command }],
			["shell", { command }],
			["mcp__ssh__execute_command", { command }],
		] as const) {
			assert.ok((await checkTool(name, args))?.block, `${name}: ${command}`);
		}
	}
});

test("only executable fields are checked in command tools", async () => {
	const mention = 'gh pr merge 12; gh pr create --title "API v2 redesign"';
	for (const action of ["status", "wait", "stop"]) {
		assert.equal(await checkTool("jobs", { action, command: mention, name: mention }), undefined, action);
	}
	assert.equal(await checkTool("jobs", { action: "start", command: "npm test", name: mention }), undefined);
	assert.equal(await checkTool("bash", { command: "npm test", cwd: mention }), undefined);
	assert.equal(await checkTool("codemode", { code: "text(1)", description: mention }), undefined);
});

test("direct GitHub write tools remain blocked, while read tools may mention commands", async () => {
	assert.ok((await checkTool("mcp__github__add_issue_comment", { body: "Update" }))?.block);
	assert.equal(await checkTool("mcp__github__search_issues", { query: "gh pr merge" }), undefined);
});

test("prompt describes the workspace and delivery", () => {
	const prompt = pilotPrompt({
		workspace: { source: "/src/app", base: "origin/main", upstream: "git@x:o/r", jj: true },
	});
	assert.match(prompt, /private clone of \/src\/app/);
	assert.match(prompt, /initially detached with no task branch or bookmark/);
	assert.match(prompt, /Name a new branch or bookmark/);
	assert.match(prompt, /not `pilot\/`/);
	assert.match(prompt, /jj git push --bookmark <name>/);
	assert.match(prompt, /gh pr create/);
	assert.match(pilotPrompt({}), /Pilot does not post on GitHub/);
});

test("prompt tells the agent when archive maintenance reset its workspace", () => {
	const workspace = { source: "/src/app", base: "origin/main", jj: true };
	assert.doesNotMatch(pilotPrompt({ workspace }), /While this chat was archived/);
	const restored = pilotPrompt({ workspace, workspaceReset: { at: 1, changeId: "kxyz", commitId: "abc123" } });
	assert.match(restored, /recreated it from the saved jj change `kxyz` \(commit `abc123`\)/);
	assert.match(restored, /Reinstall or rebuild/);
	assert.match(
		pilotPrompt({ workspace, workspaceReset: { at: 1 } }),
		/deleted ignored dependency and build directories/,
	);
	assert.doesNotMatch(
		pilotPrompt({ ask: { source: "/src/app" }, workspace, workspaceReset: { at: 1 } }),
		/While this chat was archived/,
	);
});

test("new Git branches and jj bookmarks require conventional task prefixes", () => {
	for (const jj of [false, true]) {
		const prompt = pilotPrompt({ workspace: { source: "/src/app", base: "origin/main", jj } });
		assert.match(prompt, /Name a new branch or bookmark `<type>\/<short-description>`/);
		assert.match(prompt, /conventional type that matches the task/);
		for (const type of [
			"feat",
			"fix",
			"docs",
			"refactor",
			"test",
			"build",
			"ci",
			"perf",
			"style",
			"chore",
			"revert",
		]) {
			assert.ok(prompt.includes(`\`${type}/\``), `missing ${type}/ prefix for ${jj ? "jj" : "Git"}`);
		}
		assert.match(prompt, /`fix\/branch-prefix-policy`/);
	}
});

test("shared jj workspaces isolate checkout edits but not repository history or bookmarks", () => {
	for (const requirePullRequest of [true, false]) {
		const prompt = pilotPrompt({
			workspace: {
				source: "/src/app",
				base: "exact-base-commit",
				baseBranch: "trunk",
				jj: true,
				shared: { repository: "/pilot/repositories/app", name: "session-123" },
			},
			requirePullRequest,
		});
		assert.match(prompt, /shared jj workspace `session-123` in \/pilot\/repositories\/app/);
		assert.match(prompt, /working-copy change starts on base `exact-base-commit` \(branch `trunk`\)/);
		assert.match(prompt, /own checkout and its uncommitted changes are unaffected by your workspace edits/);
		assert.match(prompt, /bookmarks and history are shared with sibling sessions/);
		assert.match(prompt, /keep rebases, rewrites and pushes to this task's own changes and bookmark/);
		assert.match(prompt, /Repository-wide operations \(`jj undo`, `jj op restore`/);
		assert.match(prompt, /broad rebases, `jj git push --all`/);
		assert.match(prompt, /would change other sessions' work/);
		assert.doesNotMatch(
			prompt,
			/is a private clone|initially detached|The clone|git switch|nothing you do here touches it/,
		);
		if (requirePullRequest) {
			assert.match(prompt, /Work on one task bookmark/);
			assert.match(prompt, /push it alone with `jj git push --bookmark <name>`/);
			assert.match(prompt, /Name a new branch or bookmark `<type>\/<short-description>`/);
			assert.match(prompt, /Never push the default branch/);
		} else {
			assert.match(prompt, /does not require a pull request/);
			assert.match(prompt, /directly to the remote's default branch/);
			assert.match(prompt, /Identify the remote's current default branch/);
			assert.match(prompt, /Fetch and reconcile concurrent upstream changes before pushing/);
			assert.match(prompt, /Never force-push or overwrite others' commits/);
			assert.match(prompt, /jj bookmark track <default-branch>@origin/);
			assert.match(prompt, /move only that default-branch bookmark to your own completed, verified change/);
			assert.match(prompt, /jj git push --bookmark <default-branch>/);
			assert.doesNotMatch(prompt, /gh pr create|Work on one task bookmark|Never push the default branch/);
		}
		assert.doesNotMatch(prompt, /explicitly requested|user explicitly requests/);
	}
});

test("shared workspace optional base branch and existing task bookmark remain accurate", () => {
	const prompt = pilotPrompt({
		workspace: {
			source: "/src/app",
			base: "exact-base-commit",
			branch: "existing-head",
			jj: true,
			shared: { repository: "/pilot/repositories/app", name: "session-123" },
		},
	});
	assert.match(prompt, /starts on base `exact-base-commit`, with task bookmark `existing-head`/);
	assert.match(prompt, /Keep an existing branch or bookmark name/);
	assert.doesNotMatch(prompt, /undefined|no task bookmark yet|initially detached/);
});

test("Ask does not inherit shared jj mutation guidance", () => {
	const prompt = pilotPrompt({
		ask: { source: "/src/app" },
		workspace: {
			source: "/src/app",
			base: "base",
			jj: true,
			shared: { repository: "/pilot/repositories/app", name: "session-123" },
		},
	});
	assert.match(prompt, /Ask mode, read-only/);
	assert.doesNotMatch(prompt, /shared jj workspace|jj bookmark|jj git push|working-copy change/);
});

test("existing Git and jj PR heads keep their names even without conventional prefixes", () => {
	for (const jj of [false, true]) {
		const prompt = pilotPrompt({
			workspace: { source: "/src/app", base: "origin/main", branch: "legacy-pr-head", jj },
		});
		assert.match(prompt, /branch\/bookmark `legacy-pr-head`/);
		assert.match(prompt, /Keep an existing branch or bookmark name, including a PR head/);
		assert.match(prompt, /even if it does not follow this convention/);
		assert.match(prompt, jj ? /If a new bookmark is needed/ : /If a new branch is needed/);
		assert.doesNotMatch(prompt, /initially detached/);
	}
});

test("Git delivery uses the agent-chosen branch, including on restored sessions", () => {
	const context = { source: "/src/app", base: "origin/main", jj: false };
	const detached = pilotPrompt({ workspace: context });
	assert.match(detached, /initially detached/);
	assert.match(detached, /git switch -c <name>/);
	assert.match(detached, /git push -u origin <name>/);
	assert.doesNotMatch(detached, /undefined/);
	const restored = pilotPrompt({ workspace: { ...context, branch: "fix-flaky-reopen" } });
	assert.match(restored, /branch\/bookmark `fix-flaky-reopen`/);
	assert.doesNotMatch(restored, /initially detached/);
});

test("prompt does not require model-reported session status", () => {
	assert.doesNotMatch(pilotPrompt({}), /pilot_report_status|needs_input|report the task outcome/);
});

test("opting out of PR delivery permits safe default-branch pushes for Git and jj clones", () => {
	for (const jj of [false, true]) {
		const prompt = pilotPrompt({
			workspace: { source: "/src/chezmoi", base: "origin/trunk", jj },
			requirePullRequest: false,
		});
		assert.match(prompt, /does not require a pull request/);
		assert.match(prompt, /directly to the remote's default branch/);
		assert.match(prompt, /Never force-push or overwrite others' commits/);
		assert.match(prompt, /branch protection or a conflict/);
		assert.match(prompt, jj ? /jj git push --bookmark <default-branch>/ : /git push origin <default-branch>/);
		if (jj) assert.match(prompt, /jj bookmark track <default-branch>@origin/);
		assert.doesNotMatch(prompt, /Never push the default branch|gh pr create|Name a new branch or bookmark/);
	}
});

test("explicit project delivery policy also applies without a private workspace", () => {
	assert.match(pilotPrompt({ requirePullRequest: false }), /does not require a pull request/);
	assert.match(pilotPrompt({ requirePullRequest: true }), /gh pr create/);
	assert.match(pilotPrompt({ requirePullRequest: true }), /Never push the default branch/);
	assert.doesNotMatch(pilotPrompt({}), /gh pr create/);
});

test("Ask overrides Build delivery policy and requires an explicit new Build handoff", () => {
	for (const requirePullRequest of [true, false]) {
		const prompt = pilotPrompt({
			ask: { source: "/original", branch: "topic", gitDir: "/private/objects.git", commit: "a".repeat(40) },
			workspace: { source: "/clone-source", base: "origin/main", jj: false },
			requirePullRequest,
		});
		assert.match(prompt, /Ask mode, read-only/);
		assert.match(prompt, /Source: "\/original"/);
		assert.match(prompt, /pinned commit/);
		assert.match(prompt, /explicit new Build session handoff/);
		assert.doesNotMatch(
			prompt,
			/Choose or create|git switch|gh pr create|git push|private clone|does not require a pull request/,
		);
	}
	assert.match(pilotPrompt({ ask: { source: "/source" } }), /current checkout, including its uncommitted changes/);
});
