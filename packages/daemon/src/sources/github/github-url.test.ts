import assert from "node:assert/strict";
import { test } from "node:test";
import { githubRepository, linkedPullRequest } from "./github-url.ts";

test("linked PR URLs keep their github.com-only policy and safe number range", () => {
	assert.deepEqual(linkedPullRequest("https://github.com/o/r/pull/1"), {
		repo: { host: "github.com", owner: "o", name: "r", identity: "github.com/o/r" },
		number: 1,
	});
	assert.equal(linkedPullRequest("https://github.com/o/r/pull/2147483647").number, 2147483647);
	// Unlike merge targets, the existing linked-target policy accepts an explicit port.
	assert.equal(linkedPullRequest("https://github.com:8443/o/r/pull/1").repo.host, "github.com");
	for (const value of [
		"https://git.example.com/o/r/pull/1",
		"http://github.com/o/r/pull/1",
		"https://user:secret@github.com/o/r/pull/1",
		"https://github.com/o/r/pull/0",
		"https://github.com/o/r/pull/2147483648",
		"https://github.com/o/r/pull/9007199254740992",
		"https://github.com/o/r/issues/1",
		"https://github.com/o/r/pull/1?x=1",
		"https://github.com/o/r/pull/1#x",
	])
		assert.throws(() => linkedPullRequest(value), Error, value);
});

test("normalizes HTTPS, SSH and enterprise origins, rejecting local paths and option-like identities", () => {
	for (const remote of [
		"https://github.com/octo/repo.git",
		"git@github.com:octo/repo.git",
		"ssh://git@github.com/octo/repo",
		"https://github.com/octo/repo/",
	])
		assert.equal(githubRepository(remote).identity, "github.com/octo/repo");
	assert.equal(
		githubRepository("ssh://git@github.example.com/team/repo.git").identity,
		"github.example.com/team/repo",
	);
	for (const remote of [
		"/local/repo",
		"file:///local/repo",
		"--repo=evil",
		"https://github.com/-owner/repo",
		"git@github.com:owner/--repo",
		"https://github.com/owner/repo?foo=bar",
		"https://github.com/owner/repo/extra",
	])
		assert.throws(() => githubRepository(remote));
});
