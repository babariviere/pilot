import assert from "node:assert/strict";
import { test } from "node:test";
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
	assert.equal(githubPosting({ command: "git push -u origin pilot/fix" }), undefined);
	assert.equal(githubPosting({ command: "gh run view 42 --log-failed" }), undefined);
});

test("prompt describes the workspace and delivery", () => {
	const prompt = pilotPrompt({
		workspace: { source: "/src/app", branch: "pilot/fix-abc", base: "origin/main", upstream: "git@x:o/r", jj: true },
	});
	assert.match(prompt, /private clone of \/src\/app/);
	assert.match(prompt, /jj git push --bookmark pilot\/fix-abc/);
	assert.match(prompt, /gh pr create/);
	assert.match(pilotPrompt({}), /Never post on GitHub/);
});
