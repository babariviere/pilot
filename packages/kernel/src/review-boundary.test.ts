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
		["evidence"],
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
		"evidence_list",
		"evidence_read",
		"evidence_search",
	])
		await assert.rejects(boundary.execute(name, {}), /denied/);
	assert.equal(calls, 0);
	await boundary.execute("evidence", { action: "list" });
	assert.equal(calls, 1);
	for (const args of [
		{ blobId: "blob", path: "/etc/passwd" },
		{ blobId: "../escape" },
		{ blobId: "blob", manifestId: "other" },
		{ blobId: "blob", limit: 50_177 },
		JSON.parse('{"blobId":"blob","__proto__":{}}'),
	])
		await assert.rejects(boundary.execute("evidence", { action: "read", ...args }), /denied/);
	await boundary.execute("evidence", { action: "read", blobId: "blob", offset: 0, limit: 10 });
	assert.equal(calls, 2);
	assert.throws(() => {
		(boundary.tools as unknown as string[]).push("bash");
	}, TypeError);
	boundary.close();
	await assert.rejects(boundary.execute("evidence", { action: "list" }), /denied/);
});

test("evidence routes actions with bounded defaults and literal search", async () => {
	const calls: unknown[] = [];
	const boundary = new RestrictedReviewBoundary({
		list: async (cursor, limit) => {
			calls.push(["list", cursor, limit]);
			return { entries: [] };
		},
		read: async (blobId, offset, limit) => {
			calls.push(["read", blobId, offset, limit]);
			return { text: "evidence" };
		},
		search: async (blobId, query, offset) => {
			calls.push(["search", blobId, query, offset]);
			return { matches: [] };
		},
	});
	try {
		await boundary.execute("evidence", { action: "list" });
		await boundary.execute("evidence", { action: "list", cursor: 4, limit: 1 });
		await boundary.execute("evidence", { action: "read", blobId: "blob" });
		await boundary.execute("evidence", { action: "read", blobId: "blob", offset: 10, limit: 20 });
		await boundary.execute("evidence", { action: "search", blobId: "blob", query: ".*" });
		await boundary.execute("evidence", { action: "search", blobId: "blob", query: "needle", offset: 10 });
		assert.deepEqual(calls, [
			["list", 0, 20],
			["list", 4, 1],
			["read", "blob", 0, 49 * 1024],
			["read", "blob", 10, 20],
			["search", "blob", ".*", 0],
			["search", "blob", "needle", 10],
		]);
		assert.ok(Object.isFrozen(boundary.tools[0]));
		assert.ok(Object.isFrozen(boundary.tools[0]!.parameters));
	} finally {
		boundary.close();
	}
});

test("evidence rejects missing or unknown actions and action-specific argument leakage", async () => {
	const denied = async () => assert.fail("invalid evidence call reached port");
	const boundary = new RestrictedReviewBoundary({ list: denied, read: denied, search: denied });
	try {
		for (const args of [
			null,
			[],
			{},
			{ action: "write" },
			{ action: { toString: () => "list" } },
			{ action: "list", blobId: "blob" },
			{ action: "list", cursor: -1 },
			{ action: "list", limit: 51 },
			{ action: "read", blobId: "blob", query: "needle" },
			{ action: "read", blobId: "blob", offset: 0.5 },
			{ action: "search", blobId: "blob", limit: 1, query: "needle" },
			{ action: "search", blobId: "blob" },
			{ action: "search", blobId: "blob", query: "" },
			{ action: "search", blobId: "blob", query: "x".repeat(257) },
			{ action: "search", blobId: "blob", query: "\u0000" },
			Object.assign(Object.create({ action: "list" }), { cursor: 0 }),
		])
			await assert.rejects(boundary.execute("evidence", args), /denied/);
	} finally {
		boundary.close();
	}
});

test("evidence lifetime attempt budget is shared across actions", async () => {
	let calls = 0;
	const port = async () => {
		calls++;
		return {};
	};
	const boundary = new RestrictedReviewBoundary({ list: port, read: port, search: port });
	try {
		for (let n = 0; n < 256; n++) {
			const action = ["list", "read", "search"][n % 3];
			await boundary.execute("evidence", {
				action,
				...(action !== "list" ? { blobId: "blob" } : {}),
				...(action === "search" ? { query: "needle" } : {}),
			});
		}
		for (const action of ["list", "read", "search"])
			await assert.rejects(
				boundary.execute("evidence", {
					action,
					...(action !== "list" ? { blobId: "blob" } : {}),
					...(action === "search" ? { query: "needle" } : {}),
				}),
				/denied/,
			);
		assert.equal(calls, 256);
	} finally {
		boundary.close();
	}
});

test("bounds persist across turns; cancellation does not open extra I/O slots", async () => {
	let release!: (value: unknown) => void;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const boundary = new RestrictedReviewBoundary({ list: () => pending, read: async () => "", search: async () => "" });
	const cancel = new AbortController();
	const reads = Array.from({ length: 3 }, () => boundary.execute("evidence", { action: "list" }, cancel.signal));
	await assert.rejects(boundary.execute("evidence", { action: "list" }), /denied/);
	cancel.abort();
	for (const read of reads) await assert.rejects(read, /denied/);
	await assert.rejects(boundary.execute("evidence", { action: "list" }), /denied/);
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
	await assert.rejects(boundary.execute("evidence", { action: "list" }), /denied/);
	boundary.close();
});
