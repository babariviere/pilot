import assert from "node:assert/strict";
import { test } from "node:test";
import { changesRefs } from "./ref-activity.ts";

test("branch, bookmark and push commands hint a PR recheck, other commands do not", () => {
	for (const command of [
		"jj bookmark create feat/x -r @",
		"jj b c feat/x",
		"jj bookmark set feat/x -r @-",
		"jj git push --bookmark feat/x",
		"jj commit -m x && jj git push -b feat/x",
		"git push -u origin feat/x",
		"git checkout -b feat/x",
		"git switch -c feat/x",
		"git branch feat/x",
		"gh pr create --fill",
		"cd repo; gh pr ready 12",
	])
		assert.equal(changesRefs("bash", { command }), true, command);
	for (const command of ["jj log", "jj st", "git status", "git branch", "git log --branches", "echo pushed", "npm test"])
		assert.equal(changesRefs("bash", { command }), false, command);
	assert.equal(changesRefs("read", { command: "git push" }), false);
	assert.equal(changesRefs("bash", {}), false);
});

