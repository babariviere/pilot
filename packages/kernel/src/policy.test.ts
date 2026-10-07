import assert from "node:assert/strict";
import { test } from "node:test";
import { reportStatus } from "./attention.ts";
import { githubPosting, pilotPrompt } from "./policy.ts";

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
	assert.match(prompt, /Do not use a `pilot\/` prefix/);
	assert.match(prompt, /jj git push --bookmark <name>/);
	assert.match(prompt, /gh pr create/);
	assert.match(pilotPrompt({}), /Never post on GitHub/);
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

test("status guidance distinguishes completed work from an unfinished discussion", () => {
	for (const guidance of [pilotPrompt({}), reportStatus.description]) {
		assert.match(guidance, /Use done only when the requested work is complete/);
		assert.match(guidance, /ongoing design discussion awaiting a decision or permission to implement/);
		assert.match(guidance, /Do not mark an unfinished task done/);
		assert.match(guidance, /fully answered standalone question can be done/);
		assert.match(guidance, /optional offers after completed work are not blockers/);
		assert.match(guidance, /actual question in your final response/);
	}
});
