import assert from "node:assert/strict";
import { test } from "node:test";
import { detectGhStack } from "./gh-stack.ts";
import { changesRefs } from "./ref-activity.ts";

test("worker capability detects only github/gh-stack and does not install anything", async () => {
	let calls = 0;
	assert.equal(
		await detectGhStack("/workspace", async (cwd) => {
			calls++;
			assert.equal(cwd, "/workspace");
			return "gh dash\tdlvhdr/gh-dash\tv1\ngh stack\tgithub/gh-stack\tv0.1.0\n";
		}),
		true,
	);
	assert.equal(calls, 1);
	for (const output of ["", "gh stack\tother/gh-stack\tv1", "gh stacker\tgithub/gh-stack\tv1"]) {
		assert.equal(await detectGhStack("/workspace", async () => output), false);
	}
	assert.equal(
		await detectGhStack("/workspace", async () => {
			throw new Error("missing or timed out");
		}),
		false,
	);
});

test("linking a stack requests a PR recheck, read commands do not", () => {
	assert.equal(
		changesRefs("bash", { command: "gh stack link https://github.com/o/r/pull/1 https://github.com/o/r/pull/2" }),
		true,
	);
	assert.equal(changesRefs("bash", { command: "gh stack view --json" }), false);
	assert.equal(changesRefs("bash", { command: "gh extension list" }), false);
});
