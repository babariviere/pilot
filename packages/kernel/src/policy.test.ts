import assert from "node:assert/strict";
import { test } from "node:test";
import { githubPosting, pilotPrompt } from "./policy.ts";

test("Pilot diagram guidance is conditional on artifact availability", () => {
	const enabled = pilotPrompt({}, true);
	assert.match(enabled, /proactively publish a diagram with the artifact tool/);
	assert.match(enabled, /without waiting for the user to request one/);
	assert.match(enabled, /Prefer simple Mermaid diagrams/);
	assert.match(enabled, /short explanation/);
	assert.match(enabled, /skip diagrams for trivial answers/);
	assert.match(enabled, /text only/);
	assert.match(enabled, /preview is optional verification, never a prerequisite/);
	assert.match(enabled, /Do not ask the user to install a browser/);
	for (const prompt of [pilotPrompt({}), pilotPrompt({}, false)])
		assert.doesNotMatch(prompt, /artifact|diagram|Mermaid|preview/);
});

test("Ask permits proactive session-local diagrams and sandboxed previews without repository mutation", () => {
	const prompt = pilotPrompt({ ask: { source: "/source" } }, true);
	assert.match(prompt, /proactively publish/);
	assert.match(prompt, /Prefer simple Mermaid/);
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

test("prompt describes the workspace and delivery", () => {
	const prompt = pilotPrompt({
		workspace: { source: "/src/app", base: "origin/main", upstream: "git@x:o/r", jj: true },
	});
	assert.match(prompt, /private clone of \/src\/app/);
	assert.match(prompt, /initially detached with no task branch or bookmark/);
	assert.match(prompt, /Choose or create a descriptive branch or bookmark/);
	assert.match(prompt, /Do not use a `pilot\/` prefix for new names/);
	assert.match(prompt, /jj git push --bookmark <name>/);
	assert.match(prompt, /gh pr create/);
	assert.match(pilotPrompt({}), /Never post on GitHub/);
});

test("new Git branches and jj bookmarks require conventional task prefixes", () => {
	for (const jj of [false, true]) {
		const prompt = pilotPrompt({ workspace: { source: "/src/app", base: "origin/main", jj } });
		assert.match(prompt, /New names must use `<type>\/<short-description>`/);
		assert.match(prompt, /conventional prefix matching the task/);
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
		assert.doesNotMatch(prompt, /Never push the default branch|gh pr create|Choose or create a descriptive/);
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
