import assert from "node:assert/strict";
import { test } from "node:test";
import type { DayInsightsAction, DayInsightsSettings } from "@pilot/protocol";
import { DayInsights } from "./day-insights.ts";
import { dayInsightsSourceAllowed, validateDayInsightsSettings } from "./day-insights-policy.ts";
import { Conflict } from "../../runtime/contracts/errors.ts";
import { InsightsJournal } from "../../insights/migration/insights-journal.ts";
import { payloadHash } from "../../transport/operations/operation-journal.ts";
import { createDayInsightsFixture, seedDayInsightsTracking, startDayInsightsFixture } from "./testing/day-insights.ts";

test("passive review freezes submitted configuration; Save is optional and Apply stays manual", async (t) => {
	const f = await createDayInsightsFixture();
	t.after(f.close);
	assert.equal((await f.service.status()).revision, 0);
	assert.equal(f.catalogCalls(), 0);
	const preview = await f.service.preflight({
		action: "apply",
		expectedRevision: 0,
		projectId: f.project.id,
		settings: f.settings,
	});
	assert.equal(preview.state, "ready");
	assert.ok(preview.payload);
	assert.equal((await f.service.status()).revision, 0);
	const op = f.operation(preview.payload);
	const receipt = await f.run(op);
	assert.equal(receipt.state, "accepted");
	assert.deepEqual((await f.service.status()).effective, f.settings);
	assert.deepEqual((await f.service.status()).draft, f.settings);
	const calls = f.catalogCalls();
	f.setCatalog([]);
	assert.deepEqual(await f.run(op), receipt);
	assert.equal(f.catalogCalls(), calls);
	assert.equal((await f.service.status()).executionSupported, false);
	assert.equal((await f.service.status()).remaining.monthlyMicros, null);
});

test("saved-only scheduled draft cannot turn initial Apply into an automatic report", async (t) => {
	const f = await createDayInsightsFixture();
	t.after(f.close);
	const weekly = { ...f.settings, weekly: { day: 1, time: "09:30", timezone: "Europe/Paris" } };
	const review = await f.service.preflight({
		action: "save",
		expectedRevision: 0,
		projectId: f.project.id,
		settings: weekly,
	});
	assert.ok(review.payload);
	assert.equal((await f.run(f.operation(review.payload))).state, "accepted");
	assert.equal((await f.service.status()).effective, null);
	assert.equal(
		(await f.service.preflight({ action: "apply", expectedRevision: 1, projectId: f.project.id, settings: weekly }))
			.reason,
		"day_insights_initial_apply_must_be_manual",
	);
	assert.equal(
		(
			await f.service.preflight({
				action: "apply",
				expectedRevision: 1,
				projectId: f.project.id,
				settings: f.settings,
			})
		).state,
		"ready",
	);
});

test("preflight identifies retained legacy execution but never exposes unlisted error text", async (t) => {
	const f = await createDayInsightsFixture();
	t.after(f.close);
	const journal = new InsightsJournal(f.journal);
	const service = new DayInsights({
		home: f.home,
		host: f.host,
		admissionEpoch: "synthetic-day-epoch",
		projects: f.projects,
		models: f.models,
		store: f.store.dayInsights,
		workspace: f.store.insightsWorkspace,
		runtime: {
			nextAt: () => null,
			preview: async () => (await journal.freshDayExecutionGuard([]))(),
			execute: async () => assert.fail("Review must not execute"),
		},
	});
	for (const [index, kind] of (["insights-create", "insights-revoke"] as const).entries()) {
		const payload = "{}";
		const receipt = await f.journal.execute(
			{
				schemaVersion: 1,
				operationId: `synthetic-legacy-${index}`,
				producerId: "synthetic-legacy",
				sequence: index + 1,
				origin: f.host,
				destination: f.host,
				kind,
				targetId: `synthetic-retired-report-${index}`,
				payload,
				payloadHash: payloadHash(payload),
			},
			async () => ({ fixture: true }),
		);
		assert.equal(receipt.state, "accepted");
	}
	const request = { action: "apply", expectedRevision: 0, projectId: f.project.id, settings: f.settings };
	assert.deepEqual(await service.preflight(request), {
		schemaVersion: 1,
		state: "blocked",
		reason: "legacy_execution_not_proven_quiescent",
		payload: null,
	});
	t.mock.method(f.models, "list", async () => {
		throw new Conflict("legacy_unlisted_backend_detail /synthetic/private.json");
	});
	assert.deepEqual(await service.preflight(request), {
		schemaVersion: 1,
		state: "blocked",
		reason: "day_insights_unavailable",
		payload: null,
	});
	assert.equal((await service.status()).revision, 0);
	assert.equal((await service.status()).owner, null);
});

test("lost configuration ACK recovers only the exact receipt without another catalog lookup", async (t) => {
	const f = await createDayInsightsFixture();
	t.after(f.close);
	const preview = await f.service.preflight({
		action: "apply",
		expectedRevision: 0,
		projectId: f.project.id,
		settings: f.settings,
	});
	assert.ok(preview.payload);
	const op = f.operation(preview.payload);
	const configure = f.store.dayInsights.configure;
	const fault = t.mock.method(f.store.dayInsights, "configure", async (...args: Parameters<typeof configure>) => {
		await configure.apply(f.store.dayInsights, args);
		throw new Error("Synthetic ACK loss after committed transaction");
	});
	assert.equal((await f.run(op)).state, "pending");
	fault.mock.restore();
	const calls = f.catalogCalls();
	f.setCatalog([]);
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal(f.catalogCalls(), calls);
	assert.equal((await f.service.status()).revision, 1);
});

test("concurrent exact submitted settings use CAS, not a later saved draft", async (t) => {
	const f = await createDayInsightsFixture();
	t.after(f.close);
	const saved = await f.service.preflight({
		action: "save",
		expectedRevision: 0,
		projectId: f.project.id,
		settings: f.settings,
	});
	assert.ok(saved.payload);
	await f.run(f.operation(saved.payload));
	const submitted = { ...f.settings, allowance: { ...f.settings.allowance, perReportMicros: 2000000 } };
	const first = await f.service.preflight({
		action: "apply",
		expectedRevision: 1,
		projectId: f.project.id,
		settings: submitted,
	});
	const second = await f.service.preflight({
		action: "apply",
		expectedRevision: 1,
		projectId: f.project.id,
		settings: f.settings,
	});
	assert.ok(first.payload);
	assert.ok(second.payload);
	const results = await Promise.all([f.run(f.operation(first.payload)), f.run(f.operation(second.payload))]);
	assert.equal(results.filter((r) => r.state === "accepted").length, 1);
	assert.equal(results.filter((r) => r.state === "rejected").length, 1);
	assert.deepEqual((await f.service.status()).effective, submitted);
	assert.deepEqual((await f.service.status()).draft, submitted);
});

test("Apply preserves Pause; unsupported execution and stale frozen reviews refuse", async (t) => {
	const f = await createDayInsightsFixture();
	t.after(f.close);
	const submit = async (action: DayInsightsAction, settings: DayInsightsSettings | null) => {
		const p = await f.service.preflight({
			action,
			expectedRevision: (await f.service.status()).revision,
			projectId: f.project.id,
			settings,
		});
		assert.ok(p.payload, p.reason ?? "no payload");
		return f.run(f.operation(p.payload));
	};
	await submit("apply", f.settings);
	await submit("pause", null);
	await submit("apply", f.settings);
	assert.equal((await f.service.status()).paused, true);
	for (const action of ["run", "resume"])
		assert.equal(
			(await f.service.preflight({ action, expectedRevision: 3, projectId: f.project.id, settings: null })).reason,
			"day_insights_execution_adapter_unavailable",
		);
	const p = await f.service.preflight({
		action: "save",
		expectedRevision: 3,
		projectId: f.project.id,
		settings: f.settings,
	});
	assert.ok(p.payload);
	const op = f.operation(p.payload);
	await submit("save", f.settings);
	assert.equal((await f.run(op)).state, "rejected");
});

test("source eligibility is archive-time based, with chosen projects and exclusions", async (t) => {
	const f = await createDayInsightsFixture();
	t.after(f.close);
	const now = Date.parse("2026-11-01T12:00:00Z"),
		s = f.settings;
	const source = { id: "chat", projectId: f.project.id };
	assert.equal(dayInsightsSourceAllowed(s, source, now), true);
	assert.equal(dayInsightsSourceAllowed(s, { ...source, archivedAt: now - 86400000 }, now), true);
	assert.equal(dayInsightsSourceAllowed(s, { ...source, archivedAt: now - 86400001 }, now), false);
	assert.equal(dayInsightsSourceAllowed(s, { ...source, archivedAt: "unknown" }, now), false);
	assert.equal(dayInsightsSourceAllowed(s, { ...source, archivedAt: now + 1 }, now), false);
	assert.equal(dayInsightsSourceAllowed(s, { ...source, projectId: "foreign" }, now), false);
	assert.equal(
		dayInsightsSourceAllowed({ ...s, source: { ...s.source, excludeSessions: [source.id] } }, source, now),
		false,
	);
	assert.throws(() => validateDayInsightsSettings({ ...s, extra: true }), /invalid_fields/);
	assert.throws(
		() => validateDayInsightsSettings({ ...s, weekly: { day: 8, time: "99:00", timezone: "local" } }),
		/invalid_weekly/,
	);
});

test("native HTTP Day reads/reviews/receipts are exact, no-store, authenticated and inert", async (t) => {
	const f = await startDayInsightsFixture();
	t.after(f.close);
	const headers = { "content-type": "application/json", "x-pilot-github-capability": f.nativeToken };
	const get = (path: string) => fetch(`${f.url}/api/${path}`, { headers });
	const post = (path: string, body: unknown) =>
		fetch(`${f.url}/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
	assert.equal((await (await get("hello")).json()).capabilities.dayInsights, 1);
	assert.notEqual((await fetch(`${f.url}/api/insights/day`)).status, 200);
	const response = await get("insights/day");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal((await response.json()).revision, 0);
	assert.equal((await get("insights/day/preflight")).status, 405);
	assert.equal((await get("insights/day?projectId=forged")).status, 400);
	const review = await (
		await post("insights/day/preflight", {
			action: "apply",
			expectedRevision: 0,
			projectId: f.project.id,
			settings: f.settings,
		})
	).json();
	assert.equal(review.state, "ready");
	const op = f.operation(review.payload);
	assert.equal((await (await post("operations", op)).json()).state, "accepted");
	assert.equal((await (await post("operations/receipt", op)).json()).state, "accepted");
	assert.notEqual(
		(
			await fetch(`${f.url}/api/operations/receipt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(op),
			})
		).status,
		200,
	);
	const legacy = await (await get("insights/day/legacy")).json();
	assert.equal(legacy.state, "available");
	assert.deepEqual(legacy.items, []);
	assert.equal((await get("insights/day/legacy?cursor=x&cursor=y")).status, 400);
	assert.equal(f.starts(), 0);
	assert.equal(f.sessions.list().length, 0);
});

test("connected tracking fixture keeps partial evidence and native-only shipped verification", async (t) => {
	const f = await createDayInsightsFixture();
	t.after(f.close);
	const seeded = await seedDayInsightsTracking(f);
	assert.equal((await seeded.workspace.page("report", 0)).items.length, 1);
	assert.equal((await seeded.workspace.item("finding", seeded.findingKey)).lifecycle, "proposed");
	const lifecycle = async (lifecycle: string, expectedRevision: number) => {
		const raw = JSON.stringify({
			schemaVersion: 2,
			owner: seeded.owner,
			key: seeded.findingKey,
			expectedRevision,
			lifecycle,
		});
		const op = {
			...f.operation({
				schemaVersion: 1,
				admissionEpoch: "fixture",
				owner: seeded.owner,
				action: "pause",
				expectedRevision: 1,
				settings: null,
				disclosure: "day-insights-v1",
			}),
			kind: "insights-workspace-lifecycle",
			payload: raw,
			payloadHash: (await import("../../transport/operations/operation-journal.ts")).payloadHash(raw),
		};
		return f.journal.execute(op, (op) => seeded.workspace.admit(op));
	};
	assert.equal((await lifecycle("verified", 1)).state, "rejected");
	assert.equal((await lifecycle("shipped", 1)).state, "accepted");
	assert.equal((await lifecycle("verified", 2)).state, "accepted");
	assert.equal((await seeded.workspace.item("finding", seeded.findingKey)).lifecycle, "verified");
});
