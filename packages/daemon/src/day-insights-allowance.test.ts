import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import type { FundingQuote } from "@pilot/protocol";
import { DAY_INSIGHTS_ALLOWANCE_SCHEMA, DayInsightsAllowance } from "./day-insights-allowance.ts";

test("both allowances reserve atomically, uncertainty survives restart, exact usage settles once", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "day-insights-allowance-")),
		file = join(root, "ledger.sqlite");
	let db = new DatabaseSync(file);
	db.exec(DAY_INSIGHTS_ALLOWANCE_SCHEMA);
	t.after(async () => {
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	const adapter = {
		one: (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params),
		all: (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params),
		run: (sql: string, ...params: SQLInputValue[]) => {
			db.prepare(sql).run(...params);
		},
		transaction: <T>(work: () => T): T => {
			db.exec("BEGIN IMMEDIATE");
			try {
				const v = work();
				db.exec("COMMIT");
				return v;
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},
		durable: async () => {},
	};
	let ledger = new DayInsightsAllowance(adapter);
	const quote: FundingQuote = {
		provider: "synthetic",
		model: "faux",
		inputTokens: 10,
		outputTokens: 10,
		rate: { input: 500000, output: 1000000, cacheRead: 0, cacheWrite: 1000000 },
	};
	const limits = { perReportMicros: 30, monthlyMicros: 50, basis: "catalog_estimate" as const },
		now = Date.parse("2026-11-30T23:59:00Z"),
		guard = () => {};
	await assert.rejects(
		ledger.reserve(
			"cache-workspace",
			"cache-run",
			"cache-before-dispatch",
			{
				...quote,
				rate: { input: 1000000, output: 1000000, cacheRead: 0, cacheWrite: 1000000 },
			},
			{ ...limits, perReportMicros: 20 },
			now,
			guard,
		),
		/report_allowance_hold/,
	);
	assert.equal(
		db.prepare("SELECT 1 FROM day_insights_allowance WHERE request_id='cache-before-dispatch'").get(),
		undefined,
	);
	await ledger.reserve("workspace", "report1", "request1", quote, limits, now, guard);
	await ledger.reserve("workspace", "report1", "request1", quote, limits, now, guard);
	await assert.rejects(
		ledger.reserve("workspace", "report1", "request2", quote, limits, now, guard),
		/report_allowance_hold/,
	);
	assert.equal(db.prepare("SELECT COUNT(*) n FROM day_insights_allowance").get()!.n, 1);
	db.close();
	db = new DatabaseSync(file);
	ledger = new DayInsightsAllowance(adapter);
	await ledger.reserve("workspace", "report2", "request2", quote, limits, now, guard);
	await assert.rejects(
		ledger.reserve("workspace", "report3", "request3", quote, limits, now, guard),
		/monthly_allowance_hold/,
	);
	assert.equal(db.prepare("SELECT SUM(charged) n FROM day_insights_allowance WHERE usage IS NULL").get()!.n, 40);
	const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 };
	await ledger.settle("workspace", "report1", "request1", usage, guard);
	await ledger.settle("workspace", "report1", "request1", usage, guard);
	await assert.rejects(
		ledger.settle("workspace", "report1", "request1", { ...usage, input: 6 }, guard),
		/receipt_changed/,
	);
	await ledger.reserve("workspace", "report3", "request3", quote, limits, now, guard);
	await assert.rejects(
		ledger.reserve(
			"workspace",
			"report4",
			"unpriced",
			{ ...quote, rate: { ...quote.rate, input: 0 } },
			limits,
			now,
			guard,
		),
		/price_unavailable/,
	);
	await ledger.reserve("workspace", "report4", "nextmonth", quote, limits, Date.parse("2026-12-01T00:00:00Z"), guard);
	await assert.rejects(
		ledger.settle("workspace", "report2", "request2", { ...usage, output: 1000 }, guard),
		/reserved_bound/,
	);
	assert.equal(
		db.prepare("SELECT charged FROM day_insights_allowance WHERE request_id='request2'").get()!.charged,
		20,
	);
});
