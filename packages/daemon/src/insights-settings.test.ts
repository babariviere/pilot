import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InsightsReviewDispatch } from "@pilot/protocol";
import type { InsightsAdmission } from "./insights-admission.ts";
import { insightsReviewBudget } from "./insights-defaults.ts";
import {
	initialInsightsSettings,
	insightsSourceAllowed,
	resolveInsightsSettingsModel,
	validateInsightsSettings,
} from "./insights-settings.ts";
import { MissionStore } from "./missions.ts";
import { RecurrenceCalendar } from "./schedule-recurrence.ts";

function fixture(path = ":memory:") {
	const store = new MissionStore(path);
	const mission = store.create({ title: "Synthetic backlog", projectId: "p" });
	let valid = true;
	const admission: InsightsAdmission = {
		binding: {
			schemaVersion: 1,
			grantId: randomUUID(),
			revision: 1,
			enabled: true,
			reportSessionId: randomUUID(),
			projectId: "p",
			missionId: mission.id,
			host: { hostId: "daemon", daemonId: "synthetic", lineageId: "synthetic" },
		},
		revalidate() {
			if (!valid) throw new Error("Revoked");
		},
	};
	return {
		store,
		admission,
		settings: store.insights.settings,
		revoke: () => {
			valid = false;
		},
	};
}
const settings = () => initialInsightsSettings("synthetic/exact");
const request = (): InsightsReviewDispatch => ({
	runId: randomUUID(),
	windowStart: "2026-01-01T00:00:00Z",
	windowEnd: "2026-01-08T00:00:00Z",
	bounds: settings().bounds,
	settingsRevision: 1,
});

test("settings persist across database restart, retain explicit choices and never initialize on read", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "insights-settings-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "missions.sqlite"),
		f = fixture(path);
	assert.equal(await f.settings.read(f.admission), null);
	assert.equal(await f.settings.read(f.admission), null);
	const chosen = settings();
	chosen.recurrence = { every: "week", weekday: 2, time: "09:15", timeZone: "Europe/Paris" };
	chosen.budget = { usd: 12, period: "month", enforcement: "advisory", basis: "user_choice" };
	chosen.scope.includeArchived = false;
	chosen.scope.projects = ["p"];
	const op = randomUUID(),
		payload = { expectedRevision: 0, settings: chosen };
	const saved = await f.settings.save(f.admission, op, payload, 0, chosen, "synthetic/exact");
	await f.store.close();
	const reopened = new MissionStore(path);
	t.after(() => reopened.close());
	assert.deepEqual(await reopened.insights.settings.read(f.admission), saved);
	assert.deepEqual(await reopened.insights.settings.receipt(f.admission, op, payload), saved);
	assert.equal(saved.revision, 1);
	assert.equal(insightsReviewBudget(chosen.budget).spendUsd, null);
	assert.equal(insightsReviewBudget(chosen.budget).period, "month");
	assert.match(insightsReviewBudget(chosen.budget).note, /not a hard cap, spending guarantee/);
});

test("CAS admits one writer; exact operation lookup/deduplication never repeats a committed save", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const value = settings(),
		payload = { settings: value },
		op = randomUUID();
	const writes = await Promise.allSettled([
		f.settings.save(f.admission, op, payload, 0, value, "synthetic/exact"),
		f.settings.save(f.admission, randomUUID(), payload, 0, value, "synthetic/exact"),
	]);
	assert.equal(writes.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(f.settings.current(f.admission)?.revision, 1);
	assert.deepEqual(
		await f.settings.save(f.admission, op, payload, 0, value, "synthetic/exact"),
		f.settings.current(f.admission),
	);
	await assert.rejects(f.settings.receipt(f.admission, op, { changed: true }), /identity changed/);
	assert.equal(await f.settings.receipt(f.admission, randomUUID(), payload), null);
});

test("exact grant/session/project/mission/host admission fences settings and receipts", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const value = settings(),
		op = randomUUID();
	await f.settings.save(f.admission, op, value, 0, value, "synthetic/exact");
	for (const patch of [
		{ grantId: randomUUID() },
		{ revision: 2 },
		{ host: { ...f.admission.binding.host, lineageId: "changed" } },
		{ projectId: "elsewhere" },
	]) {
		const altered = { ...f.admission, binding: { ...f.admission.binding, ...patch } };
		await assert.rejects(f.settings.read(altered));
	}
	f.revoke();
	await assert.rejects(f.settings.read(f.admission), /Revoked/);
	await assert.rejects(f.settings.receipt(f.admission, op, value), /Revoked/);
});

test("weekly recurrence reuses Paris DST gap/fold policy and refuses invalid fields", () => {
	const chosen = settings();
	const calendar = new RecurrenceCalendar(validateInsightsSettings(chosen).recurrence);
	assert.equal(new Date(calendar.next(Date.parse("2026-03-27T17:00:00Z"))).toISOString(), "2026-04-03T16:00:00.000Z");
	assert.equal(new Date(calendar.next(Date.parse("2026-10-23T16:00:00Z"))).toISOString(), "2026-10-30T17:00:00.000Z");
	chosen.recurrence = { every: "week", weekday: 7, time: "02:30", timeZone: "Europe/Paris" };
	const sunday = new RecurrenceCalendar(validateInsightsSettings(chosen).recurrence);
	assert.equal(new Date(sunday.next(Date.parse("2026-03-28T00:00:00Z"))).toISOString(), "2026-03-29T01:00:00.000Z");
	assert.equal(new Date(sunday.next(Date.parse("2026-10-24T00:00:00Z"))).toISOString(), "2026-10-25T00:30:00.000Z");
	for (const patch of [
		{ weekday: 0 },
		{ weekday: 8 },
		{ time: "24:00" },
		{ timeZone: "not/a-zone" },
		{ extra: true },
		{ every: "day" },
	])
		assert.throws(() => validateInsightsSettings({ ...chosen, recurrence: { ...chosen.recurrence, ...patch } }));
});

test("strict settings validate bounds, source exclusions, advisory periods and model availability", () => {
	const chosen = settings();
	for (const patch of [
		{ bounds: { ...chosen.bounds, inventoryPages: 0 } },
		{ bounds: { ...chosen.bounds, inventoryPages: 5 } },
		{ bounds: { ...chosen.bounds, historyPages: 1 } },
		{ bounds: { ...chosen.bounds, historyPages: 9 } },
		{ bounds: { ...chosen.bounds, entriesPerPage: 21 } },
		{ bounds: { ...chosen.bounds, entriesPerPage: 1.5 } },
		{ scope: { ...chosen.scope, host: "remote" } },
		{ scope: { ...chosen.scope, sourceAccess: "write" } },
		{ scope: { ...chosen.scope, projects: ["p", "p"] } },
		{ scope: { ...chosen.scope, excludeSessions: ["invalid"] } },
		{ budget: { ...chosen.budget, usd: Infinity } },
		{ budget: { ...chosen.budget, usd: 0 } },
		{ budget: { ...chosen.budget, period: "week" } },
		{ budget: { ...chosen.budget, enforcement: "hard" } },
		{ requestedModel: { kind: "default", value: "" } },
		{ unknown: true },
	])
		assert.throws(() => validateInsightsSettings({ ...chosen, ...patch }));
	const a = { id: "s/a", provider: "s", name: "  Terra  6.1 " },
		b = { ...a, id: "s/b" };
	assert.deepEqual(resolveInsightsSettingsModel({ kind: "name", value: "terra 6.1" }, [a]), {
		state: "available",
		id: "s/a",
	});
	assert.equal(resolveInsightsSettingsModel({ kind: "name", value: "terra 6.1" }, [a, b]).state, "ambiguous");
	assert.equal(resolveInsightsSettingsModel({ kind: "id", value: "s/missing" }, [a]).state, "unavailable");
	assert.deepEqual(resolveInsightsSettingsModel({ kind: "id", value: "s/b" }, [a, b]), {
		state: "available",
		id: "s/b",
	});
});

test("host scope excludes projects, archives and exact sessions, never grants a new host", () => {
	const chosen = settings(),
		excluded = randomUUID();
	chosen.scope.projects = ["p", "excluded"];
	chosen.scope.excludeProjects = ["excluded"];
	chosen.scope.excludeSessions = [excluded];
	chosen.scope.includeArchived = false;
	assert.equal(insightsSourceAllowed(chosen, { id: randomUUID(), projectId: "p" }), true);
	for (const source of [
		{ id: excluded, projectId: "p" },
		{ id: randomUUID(), projectId: "other" },
		{ id: randomUUID() },
		{ id: randomUUID(), projectId: "excluded" },
		{ id: randomUUID(), projectId: "p", archivedAt: 0 },
	])
		assert.equal(insightsSourceAllowed(chosen, source), false);
});

test("active/uncertain reviews reject settings writes; old occurrences never adopt a new revision", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const value = settings();
	await f.settings.save(f.admission, randomUUID(), value, 0, value, "synthetic/exact");
	assert.throws(() => f.settings.assertDispatch(f.admission), /explicit activation/);
	const run = request();
	assert.equal(await f.store.insights.reviews.reserve(f.admission, run), true);
	await assert.rejects(
		f.settings.save(f.admission, randomUUID(), value, 1, value, "synthetic/exact"),
		/active or uncertain/,
	);
	await f.store.insights.reviews.interrupt(f.admission.binding.reportSessionId, "unknown", "Synthetic lost input ACK");
	await assert.rejects(
		f.settings.save(f.admission, randomUUID(), value, 1, value, "synthetic/exact"),
		/active or uncertain/,
	);
	assert.equal(await f.store.insights.reviews.reserve(f.admission, run), false);
	assert.equal((await f.store.insights.reviews.status(f.admission, run.runId))?.state, "unknown");
	assert.equal(f.settings.current(f.admission)?.revision, 1);
});
