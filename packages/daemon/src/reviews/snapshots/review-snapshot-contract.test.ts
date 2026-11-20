import assert from "node:assert/strict";
import { test } from "node:test";
import { captureRequest, type ReviewCaptureRequest, reviewPath } from "./review-snapshot-contract.ts";

const request: ReviewCaptureRequest = {
	requestId: "operation-a",
	repositoryId: "a".repeat(64),
	changeId: "k".repeat(32),
	operationId: "b".repeat(128),
	base: { changeId: "l".repeat(32), commitId: "c".repeat(40) },
	head: { changeId: "k".repeat(32), commitId: "d".repeat(40) },
	scope: { kind: "layer" },
	source: "committed",
};

test("capture identity is normalized and independent of caller key order", () => {
	const reversed = Object.fromEntries(Object.entries(request).reverse());
	reversed.base = { commitId: request.base.commitId, changeId: request.base.changeId };
	assert.equal(JSON.stringify(captureRequest(reversed)), JSON.stringify(captureRequest(request)));
	const copy = captureRequest(request);
	copy.head.commitId = "e".repeat(40);
	assert.equal(request.head.commitId, "d".repeat(40));
});

test("capture rejects abbreviations, revision expressions, cross-change heads and host path fields", () => {
	for (const input of [
		null,
		{},
		{ ...request, repositoryId: "../repo" },
		{ ...request, operationId: "@" },
		{ ...request, base: { ...request.base, commitId: "main" } },
		{ ...request, head: request.base },
		{ ...request, repositoryPath: "/etc" },
		{ ...request, head: { ...request.head, path: "/etc" } },
		{ ...request, requestId: "x".repeat(129) },
		{ ...request, source: "HEAD" },
	]) {
		assert.throws(() => captureRequest(input));
	}
});

test("only exact parent-layer or explicit-ancestor stack comparison scopes are admitted", () => {
	assert.deepEqual(captureRequest({ ...request, scope: { kind: "stack" } }).scope, { kind: "stack" });
	for (const scope of [
		null,
		{},
		{ kind: "line" },
		{ kind: "lines", ranges: [] },
		{ kind: "layer", paths: ["a.txt"] },
		{ kind: "stack", mergeBase: true },
	]) {
		assert.throws(() => captureRequest({ ...request, scope }));
	}
});

test("source paths are safe logical keys, not host paths or metadata escapes", () => {
	for (const path of [
		"",
		"/etc/passwd",
		"../a",
		"a/../b",
		"a//b",
		"a/./b",
		"a\\b",
		"a\0b",
		"a\nb",
		"a:b",
		".Git/config",
		".jj/repo",
		"x".repeat(401),
		Array(66).fill("a").join("/"),
	]) {
		assert.throws(() => reviewPath(path));
	}
	for (const path of ["src/a.ts", "a file.txt", "résumé.txt", "--option", "[x].txt"]) reviewPath(path);
});
