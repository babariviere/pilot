import assert from "node:assert/strict";
import { test } from "node:test";
import type { SavedLinearRead } from "@pilot/protocol";
import type { SavedLinearRead as DayWire } from "../../../apps/day/linearContract.ts";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { SourceSignInRequired } from "./source-tool-rules.ts";

// Day imports the canonical Node-free leaf, not protocol/index's SDK graph.
const wire: (v: SavedLinearRead) => DayWire = (v) => v;
const canonical: (v: DayWire) => SavedLinearRead = (v) => v;

test("saved Linear HTTP read is passive, scoped, complete and keeps exact links and personal cycle summary", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const url = `${f.root}/api/projects/${f.project.id}/saved-linear`;
	const read = async () => {
		const r = await fetch(url, { headers: { "x-pilot-github-capability": f.capability } });
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("cache-control"), "no-store");
		return canonical(wire((await r.json()) as SavedLinearRead));
	};
	const denied = await fetch(url);
	assert.equal(denied.status, 403);
	await denied.arrayBuffer();
	const write = await fetch(url, { method: "POST" });
	assert.equal(write.status, 405);
	await write.arrayBuffer();
	const initial = await read();
	assert.equal(initial.configurationCurrent, false, "rows without a source checkpoint are not qualified");
	assert.deepEqual(initial.items, []);
	assert.equal(initial.source.status, "idle");
	let polls = 0;
	let mode: "issues" | "error" | "sign-in" | "empty" = "issues";
	const cycle = {
		id: "cycle-current",
		name: "Current",
		number: 12,
		startsAt: "2026-11-09T00:00:00Z",
		endsAt: "2026-11-23T00:00:00Z",
		progress: 0.5,
		total: 2,
		done: 1,
		inProgress: 1,
		todo: 0,
	};
	f.tracking.register("linear", async () => {
		polls++;
		if (mode === "sign-in") throw new SourceSignInRequired();
		if (mode === "error") throw new Error("Synthetic read failure");
		if (mode === "empty")
			return {
				items: [],
				activeIds: [],
				linear: {
					cycleStatus: "no_active_cycle",
					statusMessage: "Showing your open issues.",
				},
			};
		return {
			items: Array.from({ length: 102 }, (_, i) => ({
				externalId: `saved-${i}`,
				title: "Same title, never merge",
				url: `https://example.invalid/${i}`,
				status: i === 0 ? "Done" : "Todo",
				metadata: { identifier: `ENG-${i}`, statusType: i === 0 ? "completed" : "unstarted", cycleId: cycle.id },
				updatedAt: 1000 - i,
			})),
			activeIds: Array.from({ length: 102 }, (_, i) => `saved-${i}`),
			linear: { cycleStatus: "current", currentCycle: cycle },
		};
	});
	await f.tracking.poll(`${f.project.id}:linear`);
	const first = (await f.items.list({ projectId: f.project.id, kind: "linear" })).items[0]!;
	await f.items.patch(first.id, { missionId: "mission-A", sessionId: "chat-A" });
	await f.items.patch(first.id, { missionId: "mission-B", sessionId: "chat-B" });
	const page = await read();
	assert.equal(page.scope, "saved-own-issues");
	assert.equal(page.configurationCurrent, true);
	assert.equal(page.projectId, f.project.id);
	assert.equal(page.total, 102);
	assert.equal(page.items.length, 100);
	assert.equal(page.limit, 100);
	assert.equal(page.complete, false);
	assert.equal(page.more, 2);
	assert.deepEqual(page.source.linear, { cycleStatus: "current", currentCycle: cycle });
	assert.ok(page.source.lastPolledAt);
	assert.equal(page.items[0]!.status, "Done", "completed and linked rows are readable, unlike intake");
	assert.deepEqual(page.items[0]!.missionIds, ["mission-A", "mission-B"]);
	assert.deepEqual(page.items[0]!.sessionIds, ["chat-A", "chat-B"]);
	assert.equal(page.items[0]!.missionId, "mission-B");
	assert.equal(page.items[0]!.sessionId, "chat-B");
	assert.equal(page.items[1]!.missionId, undefined, "a matching title is not an association");
	assert.ok(page.items.every((i) => i.projectId === f.project.id));
	assert.equal(
		(
			await (
				await fetch(`${f.root}/api/projects/${f.project.id}/intake`, {
					headers: { "x-pilot-github-capability": f.capability },
				})
			).json()
		).sources[1].total,
		101,
	);
	assert.deepEqual(await read(), page);
	assert.equal(polls, 1, "reads never poll");
	assert.deepEqual(f.stats(), { external: 0, sessions: 0 });
	// A failed source refresh keeps the last successful saved cycle and timestamp, with explicit trouble.
	mode = "error";
	await f.tracking.poll(`${f.project.id}:linear`);
	const error = await read();
	assert.equal(error.source.status, "error");
	assert.equal(error.source.error, "Couldn't read Linear.");
	assert.deepEqual(error.source.linear, page.source.linear);
	mode = "sign-in";
	await f.tracking.poll(`${f.project.id}:linear`);
	const failed = await read();
	assert.equal(failed.source.status, "sign_in_required");
	assert.ok(failed.source.error);
	assert.equal(failed.source.lastPolledAt, page.source.lastPolledAt);
	assert.deepEqual(failed.source.linear, page.source.linear);
	assert.equal(failed.total, 102);
	await f.projects.update(f.project.id, { tracking: { linearTeam: "REPLACED", slackChannels: [] } });
	const stale = await read();
	assert.equal(stale.configurationCurrent, false);
	assert.deepEqual(stale.items, []);
	assert.equal(stale.total, 0);
	assert.equal(stale.complete, true);
	assert.equal(stale.more, 0);
	assert.equal(stale.source.linear, undefined);
	assert.equal(stale.source.lastPolledAt, undefined);
	assert.notEqual(stale.contextDigest, page.contextDigest);
	// No active cycle is an observed source result, not a synthetic list of cycles.
	mode = "empty";
	await f.tracking.poll(`${f.project.id}:linear`);
	const empty = await read();
	assert.equal(empty.configurationCurrent, true);
	assert.deepEqual(empty.items, []);
	assert.equal(empty.complete, true);
	assert.equal(empty.source.linear?.cycleStatus, "no_active_cycle");
	await f.projects.update(f.project.id, { tracking: { slackChannels: [] } });
	assert.equal((await read()).source.status, "not_configured");
});

test("saved Linear refuses a project or source checkpoint changed during its worker read", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	f.tracking.register("linear", async () => ({ items: [] }));
	await f.tracking.poll(`${f.project.id}:linear`);
	const original = f.items.list.bind(f.items);
	f.items.list = async (q) => {
		const page = await original(q);
		await f.projects.update(f.project.id, { name: "Changed during read" });
		return page;
	};
	await assert.rejects(f.tracking.savedLinear(f.project.id), /changed/);
	f.items.list = async (q) => {
		const page = await original(q);
		await f.items.commit(f.project.id, "linear", [], { configKey: "changed", lastPolledAt: 2 });
		return page;
	};
	await assert.rejects(f.tracking.savedLinear(f.project.id), /changed/);
	assert.deepEqual(f.stats(), { external: 0, sessions: 0 });
});
