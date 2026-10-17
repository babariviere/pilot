import assert from "node:assert/strict";
import { test } from "node:test";
import { RestrictedReviewBoundary } from "./review-boundary.ts";

test("minimal construction denies unsafe capabilities, including follow-up attempts", async () => {
	let calls = 0;
	const port = {
		list: async () => {
			calls++;
			return { entries: [] };
		},
		read: async () => {
			calls++;
			return { text: "evidence" };
		},
		search: async () => {
			calls++;
			return { matches: [] };
		},
	};
	const boundary = new RestrictedReviewBoundary(port);
	assert.deepEqual(
		boundary.tools.map((tool) => tool.name),
		["evidence_list", "evidence_read", "evidence_search"],
	);
	for (const name of [
		"bash",
		"read",
		"web",
		"codemode",
		"mission",
		"memory",
		"jobs",
		"mcp",
		"searchTools",
		"delegate",
		"github",
		"pullRequest.create",
		"reload",
		"extensions",
		"packages",
		"hooks",
	])
		await assert.rejects(boundary.execute(name, {}), /denied/);
	assert.equal(calls, 0);
	await boundary.execute("evidence_list", {});
	assert.equal(calls, 1);
	for (const args of [
		{ blobId: "blob", path: "/etc/passwd" },
		{ blobId: "../escape" },
		{ blobId: "blob", manifestId: "other" },
		{ blobId: "blob", limit: 50_177 },
		JSON.parse('{"blobId":"blob","__proto__":{}}'),
	])
		await assert.rejects(boundary.execute("evidence_read", args), /denied/);
	await boundary.execute("evidence_read", { blobId: "blob", offset: 0, limit: 10 });
	assert.equal(calls, 2);
	assert.throws(() => {
		(boundary.tools as unknown as string[]).push("bash");
	}, TypeError);
	boundary.close();
	await assert.rejects(boundary.execute("evidence_list", {}), /denied/);
});

test("bounds persist across turns; cancellation does not open extra I/O slots", async () => {
	let release!: (value: unknown) => void;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const boundary = new RestrictedReviewBoundary({ list: () => pending, read: async () => "", search: async () => "" });
	const cancel = new AbortController();
	const reads = Array.from({ length: 3 }, () => boundary.execute("evidence_list", {}, cancel.signal));
	await assert.rejects(boundary.execute("evidence_list", {}), /denied/);
	cancel.abort();
	for (const read of reads) await assert.rejects(read, /denied/);
	await assert.rejects(boundary.execute("evidence_list", {}), /denied/);
	release({ entries: [] });
	await pending;
	await Promise.resolve();
	boundary.close();
});

test("large tool output is rejected rather than leaking an unbounded response", async () => {
	const boundary = new RestrictedReviewBoundary({
		list: async () => "x".repeat(51_201),
		read: async () => "",
		search: async () => "",
	});
	await assert.rejects(boundary.execute("evidence_list", {}), /denied/);
	boundary.close();
});
