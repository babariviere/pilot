import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { CASE_LIMIT, parseCases } from "./slack-cases.ts";
import { TrackedItemDisk } from "./tracked-items-disk.ts";
import type { TrackedItemStore } from "./tracked-items.ts";
import { TriageGroomer } from "./triage-grooming.ts";

const DAY = 86_400_000,
	now = Date.parse("2026-10-15T12:00:00Z");
function bug(id: string, age = 1, severity = "high") {
	return {
		externalId: id,
		title: `Export failure ${id}`,
		url: `https://example.test/${id}`,
		status: "open",
		updatedAt: now - age * DAY,
		metadata: { type: "bug", severity, label: "Exports", confidence: 0.9 },
	};
}
function assign(disk: TrackedItemDisk) {
	const input = disk.cases.input("p", now);
	disk.cases.save(
		"p",
		input,
		[
			{
				caseId: null,
				name: "Export failures",
				description: "Exports fail to complete.",
				itemIds: input.items.map((_, i) => String(i)),
			},
		],
		now,
	);
	return disk.cases.list("p", now).cases[0]!;
}

test("stable common cases aggregate bounded summaries and user overrides, filter items and retain names", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.commit("p", "slack", [bug("a"), bug("b", 20, "critical"), bug("c", 35)]);
		disk.commit("other", "slack", [bug("foreign")]);
		const first = assign(disk);
		assert.equal(first.count, 2);
		assert.equal(first.severityMix.high, 1);
		assert.equal(first.severityMix.critical, 1);
		assert.equal(first.trend, "steady");
		assert.equal(first.label, "Exports");
		assert.equal(first.firstSeen, now - 20 * DAY);
		assert.equal(disk.list({ projectId: "p", caseId: first.id }).total, 2);
		assert.equal(disk.list({ projectId: "other", caseId: first.id }).total, 0);
		disk.cases.edit("p", first.id, { action: "rename", name: "Export timeouts" }, now);
		disk.commit("p", "slack", [bug("new", 0)]);
		const input = disk.cases.input("p", now);
		disk.cases.save(
			"p",
			input,
			[
				{
					caseId: first.id,
					name: "Untrusted replacement",
					description: "Exports time out.",
					itemIds: input.items.map((_, i) => String(i)),
				},
			],
			now,
		);
		const next = disk.cases.list("p", now).cases[0]!;
		assert.equal(next.id, first.id);
		assert.equal(next.name, "Export timeouts");
		assert.equal(next.count, 3);
		assert.equal(next.trend, "rising");
		assert.equal(next.firstSeen, first.firstSeen);
		const items = disk.list({ projectId: "p", caseId: first.id }).items;
		disk.patch(items[0]!.id, { slack: { severity: "low", label: null } });
		assert.equal(disk.cases.list("p", now).cases[0]!.severityMix.low, 1);
		assert.ok(disk.preview("p", "slack").commonCases?.length);
		assert.throws(() => disk.cases.edit("other", first.id, { action: "rename", name: "Wrong project" }, now));
	} finally {
		disk.close();
	}
});

test("strict case output rejects invalid/foreign memberships and duplicate tokens, and fences stale runs", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.commit("p", "slack", [bug("a"), bug("b")]);
		const first = assign(disk);
		const input = disk.cases.input("p", now);
		const group = { caseId: first.id, name: "Exports", description: "Failures", itemIds: ["0", "1"] };
		for (const value of [
			[{ ...group, caseId: null }],
			[{ ...group, caseId: "foreign" }],
			[{ ...group, itemIds: ["0", "0"] }],
			[{ ...group, itemIds: ["0"] }],
			[{ ...group, itemIds: ["0", "999"] }],
			[{ ...group, name: "x\ny" }],
			[{ ...group, tool: "start" }],
			{},
		])
			assert.throws(() => parseCases(value, input));
		disk.cases.edit("p", first.id, { action: "rename", name: "Manual name" }, now);
		assert.equal(disk.cases.save("p", input, [group], now), false);
		assert.equal(disk.cases.list("p", now).cases[0]!.name, "Manual name");
	} finally {
		disk.close();
	}
});

test("rename, merge and split are local corrections; emptied cases retire after 30 days", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.commit("p", "slack", [bug("a"), bug("b"), bug("c")]);
		const first = assign(disk);
		const itemId = disk.list({ projectId: "p", caseId: first.id }).items[0]!.id;
		disk.cases.edit("p", first.id, { action: "split", name: "Export uploads", itemIds: [itemId] }, now);
		let cases = disk.cases.list("p", now).cases;
		assert.equal(cases.length, 2);
		const second = cases.find((c) => c.id !== first.id)!;
		disk.cases.edit("p", second.id, { action: "merge", targetId: first.id }, now);
		cases = disk.cases.list("p", now).cases;
		assert.equal(cases.length, 1);
		assert.equal(cases[0]!.count, 3);
		assert.deepEqual(
			disk.triage.corrections("p", "slack").map((c) => (c.values.caseEdit as { action: string }).action),
			["merge", "split"],
		);
		const later = now + 31 * DAY,
			input = disk.cases.input("p", later);
		assert.equal(input.items.length, 0);
		assert.equal(disk.cases.save("p", input, [], later), true);
		assert.equal(disk.cases.input("p", later).cases.length, 0);
		assert.equal(disk.require(itemId).caseId, undefined);
	} finally {
		disk.close();
	}
});

test("case grouping extends the same grooming completion without learning rules from bug summaries", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
	const disk = new TrackedItemDisk(":memory:");
	t.after(() => disk.close());
	disk.commit("p", "slack", [bug("a")]);
	const items = {
		onChange: () => () => {},
		triageInput: async (id: string, kind: "slack" | "linear") => disk.triage.input(id, kind),
		caseInput: async (id: string, at: number) => disk.cases.input(id, at),
		saveCases: async (...args: Parameters<typeof disk.cases.save>) => disk.cases.save(...args),
		saveGuide: async (...args: Parameters<typeof disk.triage.save>) => disk.triage.save(...args),
	} as unknown as TrackedItemStore;
	let calls = 0;
	const projects = {
		list: () => [{ id: "p", path: "/invented" }],
		require: () => ({ id: "p", path: "/invented" }),
		onChange: () => () => {},
	};
	const groomer = new TriageGroomer(projects as never, items, async (_cwd, prompt, schema) => {
		calls++;
		assert.match(prompt, /Export failure a/);
		assert.doesNotMatch(prompt, /untrustedSlackThread|channel|threadTs/);
		assert.deepEqual(schema.required, ["rules", "cases"]);
		return JSON.stringify({
			rules: ["This must not enter the guide without corrections."],
			cases: [{ caseId: null, name: "Exports", description: "Export failures", itemIds: ["0"] }],
		});
	});
	t.mock.timers.tick(2000);
	for (let i = 0; i < 20; i++) await Promise.resolve();
	assert.equal(calls, 1);
	assert.equal(disk.cases.list("p", now).cases[0]!.count, 1);
	assert.equal(disk.triage.guide("p", "slack").text, "");
	await groomer.stop();
});

test("large recent history is bounded and indexed off the daemon loop", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		for (let page = 0; page < 20; page++)
			disk.commit(
				"p",
				"slack",
				Array.from({ length: 500 }, (_, i) => bug(String(page * 500 + i), i % 29)),
			);
		const before = performance.now();
		const input = disk.cases.input("p", now);
		const elapsed = performance.now() - before;
		assert.equal(input.items.length, CASE_LIMIT);
		assert.equal(input.truncated, true);
		assert.ok(elapsed < 1000, `bounded worker query took ${elapsed}ms`);
		console.log(
			`10,000-row case snapshot: ${elapsed.toFixed(2)}ms, ${Buffer.byteLength(JSON.stringify(input))} bytes`,
		);
		const measure = (fn: () => unknown) => {
			const start = performance.now();
			for (let i = 0; i < 100; i++) fn();
			return (performance.now() - start) / 100;
		};
		const baseline = measure(() => disk.list({ projectId: "p", kind: "slack", limit: 5 }));
		const after = measure(() => disk.preview("p", "slack"));
		console.log(
			`10,000-row preview baseline ${baseline.toFixed(2)}ms, with cases ${after.toFixed(2)}ms (worker-only, 100 reads)`,
		);
	} finally {
		disk.close();
	}
});
