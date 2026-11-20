import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { nativeIntakeFixture } from "../../day/intake/native-intake.fixture.ts";
import { payloadHash } from "../../transport/operations/operation-journal.ts";
import { TrackedItemDisk } from "../tracking/tracked-items-disk.ts";
import { readSlackReports, editSlackReport } from "./slack-reports-disk.ts";

test("manual group names and membership survive corrections and the rolling suggestion window", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		const now = Date.now();
		disk.commit(
			"p",
			"slack",
			["a", "b"].map((id) => ({
				externalId: id,
				title: id,
				url: "https://example.test",
				status: "open",
				metadata: { type: "bug" },
				updatedAt: now,
			})),
		);
		const input = disk.cases.input("p", now);
		disk.cases.save(
			"p",
			input,
			[{ caseId: null, name: "Suggested name", description: "Exports fail", itemIds: ["0", "1"] }],
			now,
		);
		const before = readSlackReports(disk, "p");
		const group = before.groups[0]!;
		editSlackReport(disk, "p", before.digest, "group", {
			caseId: group.id,
			edit: { action: "rename", name: "Manual exports" },
		});
		assert.throws(
			() =>
				editSlackReport(disk, "p", before.digest, "group", {
					caseId: group.id,
					edit: { action: "rename", name: "Stale" },
				}),
			/Reports changed/,
		);
		disk.cases.retire("p", now + 31 * 86_400_000);
		const after = readSlackReports(disk, "p");
		assert.equal(after.groups[0]?.name, "Manual exports");
		assert.equal(
			after.items.every((i) => i.caseId === group.id),
			true,
		);
		disk.cases.edit(
			"p",
			group.id,
			{ action: "split", name: "Separate export", itemIds: [after.items[0]!.id] },
			now + 31 * 86_400_000,
		);
		const split = readSlackReports(disk, "p");
		assert.equal(
			split.groups.some((g) => g.name === "Separate export"),
			true,
		);
		assert.equal(new Set(split.items.map((i) => i.caseId)).size, 2);
	} finally {
		disk.close();
	}
});

test("older report pages remain reachable and edits fence the shown page", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.commit(
			"p",
			"slack",
			Array.from({ length: 201 }, (_, n) => ({
				externalId: String(n),
				title: `Report ${n}`,
				url: "https://example.test",
				status: "open",
				metadata: { type: "bug" },
				updatedAt: n + 1,
			})),
		);
		const first = readSlackReports(disk, "p");
		const next = readSlackReports(disk, "p", 100);
		const last = readSlackReports(disk, "p", 200);
		assert.equal(first.more, true);
		assert.equal(next.items.length, 100);
		assert.equal(last.more, false);
		assert.equal(last.items.length, 1);
		assert.equal(new Set([...first.items, ...next.items, ...last.items].map((i) => i.id)).size, 201);
		assert.throws(
			() =>
				editSlackReport(disk, "p", next.digest, "report", { itemId: next.items[0]!.id, patch: { status: "done" } }),
			/Reports changed/,
		);
		editSlackReport(disk, "p", next.digest, "report", {
			offset: 100,
			itemId: next.items[0]!.id,
			patch: { status: "done" },
		});
		assert.equal(disk.require(next.items[0]!.id).slack?.status, "done");
	} finally {
		disk.close();
	}
});

test("separate detail corrections keep earlier explicit fields and do not change groups or completion", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.commit("p", "slack", [
			{
				externalId: "report",
				title: "Export fails",
				url: "https://example.test",
				status: "open",
				metadata: { type: "bug" },
				updatedAt: Date.now(),
			},
		]);
		const item = readSlackReports(disk, "p").items[0]!;
		const client = { value: "Northwind", evidence: "Northwind reported an export error" };
		const reporter = { value: "Alex", evidence: "Alex reported it" };
		disk.patch(item.id, { slack: { details: { client } } });
		disk.patch(item.id, { slack: { details: { reporter } } });
		assert.deepEqual(disk.require(item.id).slack?.overrides.details, { client, reporter });
		assert.equal(disk.require(item.id).slack?.status, "open");
		assert.deepEqual(disk.triage.corrections("p", "slack")[0]!.values.details, { client, reporter });
	} finally {
		disk.close();
	}
});

test("native Slack reports are passive, fenced and explicitly tackled without starting work", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	await f.items.commit(f.project.id, "slack", [
		{
			externalId: "C123/1794900000.000001",
			title: "Export fails",
			url: "https://example.slack.com/archives/C123/p1794900000000001",
			status: "open",
			metadata: { type: "bug", author: "Maya" },
			updatedAt: Date.now(),
		},
	]);
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const read = async () => (await fetch(`${f.root}/api/slack-controls?projectId=${f.project.id}`, { headers })).json();
	const before = await read();
	assert.equal(before.reports.items.length, 1);
	assert.equal(before.reports.items[0].metadata.author, "Maya");
	const post = async (digest: string, patch: unknown) => {
		const payload = JSON.stringify({
			purpose: "slack-controls",
			projectId: f.project.id,
			binding: before.binding,
			action: "report",
			value: { digest, itemId: before.reports.items[0].id, patch },
		});
		return (
			await fetch(`${f.root}/api/operations`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					schemaVersion: 1,
					operationId: randomUUID(),
					producerId: randomUUID(),
					sequence: 1,
					origin: { ...f.host, hostId: "local" },
					destination: f.host,
					kind: "slack-controls",
					targetId: f.project.id,
					payload,
					payloadHash: payloadHash(payload),
					bindingId: before.binding,
					bindingGeneration: 1,
				}),
			})
		).json();
	};
	assert.equal((await post(before.reports.digest, { status: "done" })).state, "accepted");
	assert.equal((await read()).reports.items[0].slack.status, "done");
	assert.equal((await post(before.reports.digest, { status: "open" })).state, "rejected");
	const next = await read();
	assert.equal((await post(next.reports.digest, { status: "open" })).state, "accepted");
	assert.equal(f.stats().sessions, 0);
	assert.equal(f.stats().external, 0);
});
