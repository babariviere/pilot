import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	DiagnosticContextResponse,
	DiagnosticHistoryPage,
	InsightsHistoryRequest,
	InsightsReviewDispatch,
	InsightsReviewRecord,
} from "@pilot/protocol";
import { diagnosticContextResponse } from "./diagnostic-context.ts";
import type { InsightsAdmission } from "./insights-admission.ts";
import { INSIGHTS_INITIAL_DEFAULTS } from "./insights-defaults.ts";
import { MissionStore } from "./missions.ts";

const host = { hostId: "local", daemonId: "synthetic", lineageId: "synthetic" };
const windowStart = "2026-01-01T00:00:00.000Z",
	windowEnd = "2026-01-08T00:00:00.000Z";
const dispatch = (): InsightsReviewDispatch => ({
	runId: randomUUID(),
	windowStart,
	windowEnd,
	bounds: { inventoryPages: 1, historyPages: 2, entriesPerPage: 2 },
});
const record = (): InsightsReviewRecord => ({
	status: "completed",
	windowStart,
	windowEnd,
	markdown:
		"Observed synthetic correction. Inference: friction. Proposal: investigate a deterministic check; no approval. Baseline and repository state unknown; artifacts uninspected.",
	checkpoints: [],
	findingKeys: [],
	gaps: ["Synthetic evidence only."],
});

function fixture(t: TestContext, file = ":memory:") {
	const store = new MissionStore(file);
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await store.close();
	};
	t.after(close);
	const mission = store.create({ title: "Synthetic review backlog", projectId: "p" });
	let valid = true;
	const admission: InsightsAdmission = {
		binding: Object.freeze({
			schemaVersion: 1,
			grantId: randomUUID(),
			revision: 1,
			enabled: true,
			reportSessionId: randomUUID(),
			projectId: "p",
			missionId: mission.id,
			host: Object.freeze(host),
		}),
		revalidate() {
			if (!valid) throw new Error("Revoked");
		},
	};
	return {
		store,
		close,
		admission,
		reviews: store.insights.reviews,
		revoke() {
			valid = false;
		},
	};
}
function history(
	id: string,
	ids: number[],
	before?: number,
	options: { stream?: string; more?: boolean; next?: number; excerpt?: string } = {},
) {
	const page: DiagnosticHistoryPage = {
		schemaVersion: 1,
		target: { sessionId: id, chatUrl: `pilot://chat/${id}`, host },
		collectedAt: windowEnd,
		source: {
			availability: "available",
			freshness: "fresh",
			...(options.stream === "unknown" ? {} : { streamId: options.stream ?? "conversation:synthetic" }),
		},
		entries: ids.map((entryId) => ({
			entryId,
			ref: `diagnostic-history:v1:${id}:${entryId}`,
			kind: "pi.user",
			excerpt: options.excerpt ?? `Correction ${entryId}`,
			originalBytes: 20,
			truncated: false,
		})),
		pagination: {
			...(before === undefined ? {} : { before }),
			...(options.next === undefined ? {} : { nextBefore: options.next }),
			more: options.more ?? false,
			returned: ids.length,
			limit: 4,
			scannedEntries: Math.max(ids.length, 1),
			maxScannedEntries: 200,
			encodedBytes: 100,
			maxBytes: 65536,
			perEntryMaxBytes: 8192,
			truncatedEntries: 0,
		},
	};
	return diagnosticContextResponse(host, page, {
		scanned: page.pagination.scannedEntries,
		more: page.pagination.more,
		...(options.next === undefined ? {} : { before: options.next }),
	});
}
function reader(
	ids: string[],
	log: InsightsHistoryRequest[],
	page: (id: string, before?: number) => DiagnosticContextResponse = (id, before) => history(id, [1], before),
) {
	return async (request: InsightsHistoryRequest) => {
		log.push(request);
		if (request.action === "chats") {
			const start = request.after ? ids.indexOf(request.after) + 1 : 0;
			const chats = ids.slice(start, start + (request.limit ?? 4));
			const more = start + chats.length < ids.length;
			return diagnosticContextResponse(
				host,
				{ chats: chats.map((id) => ({ id, projectId: "foreign", archivedAt: 100 })) },
				{ scanned: chats.length, more, ...(more ? { after: chats.at(-1)! } : {}) },
			);
		}
		return page(request.sessionId!, request.before);
	};
}
async function consume(f: ReturnType<typeof fixture>) {
	const parts: unknown[] = [];
	let cursor: number | null = 0;
	do {
		const result = (await f.store.insights.call(f.admission, { action: "review_context", cursor })) as {
			nextCursor: number | null;
			evidence: unknown;
		};
		assert.ok(Buffer.byteLength(JSON.stringify(result)) < 65536);
		parts.push(result.evidence);
		cursor = result.nextCursor;
	} while (cursor !== null);
	return parts;
}
async function finish(f: ReturnType<typeof fixture>, request: InsightsReviewDispatch) {
	await consume(f);
	const input = {
		action: "save_report",
		key: request.runId,
		operationId: randomUUID(),
		expectedRevision: 0,
		record: { ...record(), windowStart: request.windowStart, windowEnd: request.windowEnd },
	};
	const receipt = await f.store.insights.call(f.admission, input);
	assert.deepEqual(
		await f.store.insights.call(f.admission, input),
		receipt,
		"lost ACK lookup/retry cannot consume twice",
	);
	return input;
}

test("initial weekly sample bounds cross-project archives and exposes advisory unknown costs", async (t) => {
	const f = fixture(t),
		calls: InsightsHistoryRequest[] = [];
	const ids = Array.from({ length: 9 }, () => randomUUID());
	const request = { ...dispatch(), bounds: { ...INSIGHTS_INITIAL_DEFAULTS.bounds } };
	assert.deepEqual(calls, [], "import/construction does not discover or read sources");
	assert.equal(await f.reviews.status(f.admission, request.runId), null);
	assert.deepEqual(calls, [], "status never prepares a review");
	await f.reviews.reserve(f.admission, request);
	assert.deepEqual(calls, [], "reservation alone reads no source");
	await f.reviews.prepare(
		f.admission,
		request,
		reader(ids, calls, (id, before) => history(id, [1, 2, 3, 4], before)),
	);
	assert.deepEqual(calls, [
		{ action: "chats", limit: 4 },
		{ action: "history", sessionId: ids[0], limit: 4 },
		{ action: "history", sessionId: ids[1], limit: 4 },
	]);
	const context = (await f.store.insights.call(f.admission, { action: "review_context" })) as {
		budget: { usd: number; period: string; enforcement: string; spendUsd: null; pricing: string; note: string };
		evidence: { projectId: string };
		gaps: string[];
	};
	assert.equal(context.evidence.projectId, "foreign");
	assert.equal(context.budget.usd, 5);
	assert.equal(context.budget.period, "report");
	assert.equal(context.budget.enforcement, "advisory");
	assert.equal(context.budget.pricing, "unknown");
	assert.equal(context.budget.spendUsd, null);
	assert.match(context.budget.note, /not a hard cap or approved spend/);
	assert.match(context.gaps.join(" "), /not comprehensive coverage/);
	assert.match(context.gaps.join(" "), /Inventory has further pages/);
	await finish(f, request);
});

test("weekly sources carry exclusive cursors through boundary probes and store reopen", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "insights-reviews-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "missions.sqlite");
	const f = fixture(t, file);
	const id = randomUUID(),
		calls: InsightsHistoryRequest[] = [];
	const read = reader([id], calls, (id, before) =>
		before === undefined
			? history(id, [9, 10], before, { more: true, next: 9 })
			: before === 10
				? history(id, [9], before, { more: true, next: 9 })
				: history(id, [7, 8], before, { more: true, next: 7 }),
	);
	const first = dispatch();
	assert.equal(await f.reviews.reserve(f.admission, first), true);
	assert.equal(await f.reviews.reserve(f.admission, first), false);
	await assert.rejects(f.reviews.reserve(f.admission, dispatch()), /already active/);
	await f.reviews.prepare(f.admission, first, read);
	const mismatched = {
		action: "save_report",
		key: randomUUID(),
		operationId: randomUUID(),
		expectedRevision: 0,
		record: record(),
	};
	await assert.rejects(f.store.insights.call(f.admission, mismatched), /Report key must match/);
	assert.deepEqual(
		await f.store.insights.call(f.admission, { action: "receipt", operationId: mismatched.operationId }),
		{ state: "unknown" },
		"a refused mismatched run never commits a report or receipt",
	);
	await assert.rejects(
		f.store.insights.call(f.admission, {
			action: "save_report",
			key: first.runId,
			operationId: randomUUID(),
			expectedRevision: 0,
			record: record(),
		}),
		/Read all/,
	);
	await consume(f);
	await assert.rejects(
		f.store.insights.call(f.admission, {
			...mismatched,
			key: first.runId,
			record: { ...record(), windowEnd: "2026-01-09T00:00:00.000Z" },
		}),
		/Report window does not match/,
	);
	const saved = await finish(f, first);
	assert.equal((await f.reviews.status(f.admission, first.runId))?.state, "partial");
	const report = (await f.store.insights.call(f.admission, { action: "get", kind: "report", key: first.runId })) as {
		payload: InsightsReviewRecord;
	};
	assert.equal(report.payload.status, "partial", "model completed claim cannot certify coverage");
	assert.equal(report.payload.checkpoints[0]!.before, 9);
	assert.match(report.payload.markdown, /Coverage limits \(host\)/);
	await assert.rejects(
		f.store.insights.call(f.admission, { ...saved, expectedRevision: 1, operationId: randomUUID() }),
		/terminal/,
	);
	await f.close();
	const reopened = new MissionStore(file);
	t.after(() => reopened.close());
	const second = dispatch();
	second.windowStart = windowEnd;
	second.windowEnd = "2026-01-15T00:00:00.000Z";
	assert.equal(await reopened.insights.reviews.reserve(f.admission, second), true);
	await reopened.insights.reviews.prepare(f.admission, second, read);
	assert.deepEqual(
		calls.filter((r) => r.action === "history").map((r) => r.before),
		[undefined, 10, 9],
		"resume below the saved exclusive cursor, not head",
	);
	await finish({ ...f, store: reopened, reviews: reopened.insights.reviews }, second);
	assert.equal((await reopened.insights.reviews.status(f.admission, first.runId))?.state, "partial");
});

test("empty scan-only pages retain continuation; unknown streams and partial pages do not erase it", async (t) => {
	const f = fixture(t),
		id = randomUUID(),
		calls: InsightsHistoryRequest[] = [];
	let stage = 0;
	const read = reader([id], calls, (id, before) => {
		if (stage === 0) return history(id, [], before, { more: true, next: 50 });
		if (stage === 1) return history(id, [], before, { stream: "unknown", more: true, next: 40 });
		if (stage === 2)
			return {
				...history(id, [49], before, { more: true, next: 49 }),
				status: "partial",
				page: { ...history(id, [], before).page, truncated: true },
			};
		return history(id, [48, 49], before);
	});
	for (stage = 0; stage < 4; stage++) {
		const run = dispatch();
		await f.reviews.reserve(f.admission, run);
		await f.reviews.prepare(f.admission, run, read);
		await finish(f, run);
	}
	assert.deepEqual(
		calls.filter((r) => r.action === "history").map((r) => r.before),
		[undefined, 50, 50, 50],
	);
});

test("changed boundary resets with a gap; interruption never consumes a prepared cursor", async (t) => {
	const f = fixture(t),
		id = randomUUID(),
		calls: InsightsHistoryRequest[] = [];
	let changed = false;
	const read = reader([id], calls, (id, before) =>
		before === undefined
			? history(id, [9, 10], before, { more: true, next: 9 })
			: history(id, [9], before, { more: true, next: 9, excerpt: changed ? "Changed boundary" : "Correction 9" }),
	);
	const abandoned = dispatch();
	await f.reviews.reserve(f.admission, abandoned);
	await f.reviews.prepare(f.admission, abandoned, read);
	await f.reviews.interrupt(f.admission.binding.reportSessionId, "interrupted", "Synthetic failure");
	const first = dispatch();
	await f.reviews.reserve(f.admission, first);
	await f.reviews.prepare(f.admission, first, read);
	await finish(f, first);
	assert.deepEqual(
		calls.filter((r) => r.action === "history").map((r) => r.before),
		[undefined, undefined],
	);
	changed = true;
	const second = dispatch();
	await f.reviews.reserve(f.admission, second);
	await f.reviews.prepare(f.admission, second, read);
	const context = await f.store.insights.call(f.admission, { action: "review_context" });
	assert.match(JSON.stringify(context), /Changed\/unknown stream or boundary/);
	await finish(f, second);
	const third = dispatch();
	await f.reviews.reserve(f.admission, third);
	await f.reviews.prepare(f.admission, third, read);
	assert.deepEqual(
		calls.filter((r) => r.action === "history").map((r) => r.before),
		[undefined, undefined, 10, undefined],
	);
});

test("inventory carryover and unavailable sources rotate without dropping unvisited chats", async (t) => {
	const f = fixture(t),
		ids = Array.from({ length: 9 }, () => randomUUID()),
		calls: InsightsHistoryRequest[] = [];
	const read = reader(ids, calls, () => ({ ...diagnosticContextResponse(host, null), status: "unavailable" }));
	for (let i = 0; i < 5; i++) {
		const run = dispatch();
		await f.reviews.reserve(f.admission, run);
		await f.reviews.prepare(f.admission, run, read);
		await finish(f, run);
	}
	assert.deepEqual(
		calls
			.filter((r) => r.action === "chats")
			.slice(0, 3)
			.map((r) => r.after),
		[undefined, ids[3], ids[7]],
	);
	assert.deepEqual([...new Set(calls.filter((r) => r.action === "history").map((r) => r.sessionId))], ids);
});

test("Stop, revoked admissions and restart keep unfinished windows terminal and never replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "insights-restart-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "missions.sqlite"),
		f = fixture(t, file),
		run = dispatch();
	await f.reviews.reserve(f.admission, run);
	await f.reviews.interrupt(f.admission.binding.reportSessionId, "cancelled", "Stopped");
	assert.equal(await f.reviews.reserve(f.admission, run), false);
	await assert.rejects(f.reviews.prepare(f.admission, run, reader([], [])), /terminal/);
	const pending = dispatch();
	await f.reviews.reserve(f.admission, pending);
	await f.close();
	const reopened = new MissionStore(file);
	t.after(() => reopened.close());
	assert.equal((await reopened.insights.reviews.status(f.admission, run.runId))?.state, "cancelled");
	assert.equal((await reopened.insights.reviews.status(f.admission, pending.runId))?.state, "interrupted");
	assert.equal(await reopened.insights.reviews.reserve(f.admission, pending), false);
	const next = dispatch();
	await reopened.insights.reviews.reserve(f.admission, next);
	await reopened.insights.reviews.prepare(f.admission, next, reader([], []));
	const context = (await reopened.insights.call(f.admission, { action: "review_context" })) as {
		unresolvedRuns: { count: number };
	};
	assert.equal(context.unresolvedRuns.count, 2);
	f.revoke();
	await assert.rejects(reopened.insights.reviews.status(f.admission, next.runId), /Revoked/);
});

test("normalized pattern identities prevent repeated findings under new UUIDs across reports", async (t) => {
	const f = fixture(t),
		run = dispatch();
	await f.reviews.reserve(f.admission, run);
	await f.reviews.prepare(f.admission, run, reader([], []));
	const input = {
		action: "propose",
		key: randomUUID(),
		operationId: randomUUID(),
		expectedRevision: 0,
		patternKey: "foreign / Repeated Search",
		draft: {
			title: "Repeated searches",
			priority: "high",
			observation: "Observed synthetic repeated search",
			uncertainty: "Usage/pricing and repository baseline unknown",
			proposedChange: "Propose deterministic indexing check",
			expectedBenefit: "Fewer retries; retain safety checks; later compare successful-task effort",
			targets: [{ projectId: "foreign", label: "Workflow" }],
			implementationLinks: [],
			cost: {
				baseline: "unknown",
				assumptions: "Synthetic counts, no known prices",
				estimate: "unknown",
				qualityRisks: "Retain quality and safety",
				laterResult: "unknown",
			},
		},
		evidence: [],
	};
	await f.store.insights.call(f.admission, input);
	const prior = (await f.store.insights.call(f.admission, { action: "get", kind: "finding", key: input.key })) as {
		patternKey: string;
	};
	assert.equal(prior.patternKey, "foreign / repeated search", "future runs can recover the immutable label");
	await finish(f, run);
	const next = dispatch();
	await f.reviews.reserve(f.admission, next);
	await f.reviews.prepare(f.admission, next, reader([], []));
	await assert.rejects(
		f.store.insights.call(f.admission, {
			...input,
			key: randomUUID(),
			operationId: randomUUID(),
			patternKey: " foreign / repeated   search ",
		}),
		new RegExp(input.key),
	);
	await f.store.insights.call(f.admission, {
		...input,
		action: "amend",
		expectedRevision: 1,
		operationId: randomUUID(),
	});
	const findings = (await f.store.insights.call(f.admission, { action: "list", kind: "finding" })) as {
		items: Array<{ lifecycle: string }>;
	};
	assert.equal(findings.items.length, 1);
	assert.equal(findings.items[0]!.lifecycle, "proposed");
});

test("bounded context excerpts stay below the response ceiling; invalid receipts cannot advance", async (t) => {
	const f = fixture(t),
		ids = [randomUUID(), randomUUID()],
		run = dispatch();
	await f.reviews.reserve(f.admission, run);
	await f.reviews.prepare(
		f.admission,
		run,
		reader(ids, [], (id, before) => history(id, [1, 2, 3, 4], before, { excerpt: "x".repeat(8000) })),
	);
	assert.equal((await consume(f)).length, 8);
	await finish(f, run);
	const invalid = dispatch();
	await f.reviews.reserve(f.admission, invalid);
	await assert.rejects(
		f.reviews.prepare(
			f.admission,
			invalid,
			reader(ids, [], (id, before) => history(id, [3, 2], before)),
		),
		/Invalid history entry/,
	);
	await assert.rejects(
		f.reviews.reserve(f.admission, { ...dispatch(), bounds: { ...run.bounds, historyPages: 999 } }),
		/Invalid bounded/,
	);
});
