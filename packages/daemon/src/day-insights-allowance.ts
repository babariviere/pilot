/** Dedicated AND allowances. Never reads or changes background-work funding or its switch. */
import type { DayInsightsSettings, FundingQuote, FundingRate, FundingTokens } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { InsightsWorkspaceDb } from "./insights-workspace-store.ts";
import { canonicalJSON } from "./operation-journal.ts";

export const DAY_INSIGHTS_ALLOWANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS day_insights_allowance (
 request_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
 month TEXT NOT NULL, quote TEXT NOT NULL, maximum INTEGER NOT NULL,
 charged INTEGER NOT NULL, usage TEXT
);
CREATE INDEX IF NOT EXISTS day_insights_allowance_month ON day_insights_allowance(workspace_id,month);
CREATE INDEX IF NOT EXISTS day_insights_allowance_run ON day_insights_allowance(workspace_id,run_id);
`;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function rates(q: FundingQuote): FundingRate {
	if (
		!q ||
		!q.provider ||
		!q.model ||
		!integer(q.inputTokens) ||
		q.inputTokens < 1 ||
		!integer(q.outputTokens) ||
		q.outputTokens < 1 ||
		!q.rate ||
		(q.tiers && q.tiers.length > 32)
	)
		throw new Conflict("day_insights_price_or_bound_unavailable");
	const all = [
		q.rate,
		...(q.tiers ?? []).map((t) => {
			if (!integer(t.inputTokensAbove)) throw new Conflict("day_insights_catalog_tier_unavailable");
			return t.rate;
		}),
	];
	for (const r of all)
		if (!r || ![r.input, r.output, r.cacheRead, r.cacheWrite].every(integer) || !r.input || !r.output)
			throw new Conflict("day_insights_catalog_price_unavailable");
	return {
		input: Math.max(...all.map((r) => r.input)),
		output: Math.max(...all.map((r) => r.output)),
		cacheRead: Math.max(...all.map((r) => r.cacheRead)),
		cacheWrite: Math.max(...all.map((r) => r.cacheWrite)),
	};
}
function priced(rate: FundingRate, tokens: FundingRate): number {
	if (![tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite].every(integer))
		throw new Conflict("day_insights_usage_unavailable");
	const sum = ["input", "output", "cacheRead", "cacheWrite"].reduce(
		(n, k) => n + BigInt(rate[k as keyof FundingRate]) * BigInt(tokens[k as keyof FundingRate]),
		0n,
	);
	const amount = (sum + 999999n) / 1000000n;
	if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Conflict("day_insights_price_overflow");
	return Number(amount);
}
export class DayInsightsAllowance {
	private readonly db: InsightsWorkspaceDb;
	constructor(db: InsightsWorkspaceDb) {
		this.db = db;
	}
	private totals(workspace: string, run: string, month: string) {
		const total = (column: "run_id" | "month", value: string) => {
			const rows = this.db.all(
				`SELECT charged,usage FROM day_insights_allowance WHERE workspace_id=? AND ${column}=?`,
				workspace,
				value,
			);
			return rows.reduce((sum, r) => {
				const next = sum + Number(r.charged);
				if (!Number.isSafeInteger(next)) throw new Conflict("day_insights_allowance_overflow");
				return next;
			}, 0);
		};
		return { report: total("run_id", run), month: total("month", month) };
	}
	async remaining(workspace: string, run: string, limits: DayInsightsSettings["allowance"], now: number) {
		const month = new Date(now).toISOString().slice(0, 7);
		const select = () => {
			const used = this.totals(workspace, run, month);
			const uncertain = this.db
				.all(
					"SELECT charged FROM day_insights_allowance WHERE workspace_id=? AND month=? AND usage IS NULL",
					workspace,
					month,
				)
				.reduce((sum, r) => sum + Number(r.charged), 0);
			if (!Number.isSafeInteger(uncertain)) throw new Conflict("day_insights_allowance_overflow");
			return {
				perReportMicros: Math.max(0, limits.perReportMicros - used.report),
				monthlyMicros: Math.max(0, limits.monthlyMicros - used.month),
				uncertainMicros: uncertain,
			};
		};
		const before = select();
		await this.db.durable();
		if (canonicalJSON(before) !== canonicalJSON(select()))
			throw new Conflict("day_insights_allowance_changed_during_read");
		return before;
	}
	/** Quote is canonical host catalog metadata, never a worker-supplied cost or USD estimate. */
	async reserve(
		workspace: string,
		run: string,
		requestId: string,
		quote: FundingQuote,
		limits: DayInsightsSettings["allowance"],
		now: number,
		guard: () => void,
	) {
		if (
			![workspace, run, requestId].every((s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(s)) ||
			limits.basis !== "catalog_estimate" ||
			![limits.perReportMicros, limits.monthlyMicros].every((n) => integer(n) && n > 0) ||
			!Number.isFinite(now)
		)
			throw new Conflict("day_insights_invalid_allowance_request");
		const rate = rates(quote);
		// The SDK prices one-hour cache creation at twice input, not the short cache-write rate.
		if (!Number.isSafeInteger(rate.input * 2)) throw new Conflict("day_insights_price_overflow");
		const maximum = priced(
			{ ...rate, input: Math.max(rate.input * 2, rate.cacheRead, rate.cacheWrite) },
			{ input: quote.inputTokens, output: quote.outputTokens, cacheRead: 0, cacheWrite: 0 },
		);
		const month = new Date(now).toISOString().slice(0, 7),
			raw = canonicalJSON(quote);
		this.db.transaction(() => {
			guard();
			const prior = this.db.one("SELECT * FROM day_insights_allowance WHERE request_id=?", requestId);
			if (prior) {
				if (
					prior.workspace_id !== workspace ||
					prior.run_id !== run ||
					prior.quote !== raw ||
					prior.month !== month
				)
					throw new Conflict("day_insights_reservation_identity_changed");
				return;
			}
			if (Number(this.db.one("SELECT COUNT(*) n FROM day_insights_allowance")!.n) >= 4096)
				throw new Conflict("day_insights_allowance_capacity");
			const used = this.totals(workspace, run, month);
			if (maximum > limits.perReportMicros - used.report) throw new Conflict("day_insights_report_allowance_hold");
			if (maximum > limits.monthlyMicros - used.month) throw new Conflict("day_insights_monthly_allowance_hold");
			this.db.run(
				"INSERT INTO day_insights_allowance VALUES (?,?,?,?,?,?,?,NULL)",
				requestId,
				workspace,
				run,
				month,
				raw,
				maximum,
				maximum,
			);
		});
		await this.db.durable();
		guard();
	}
	/** Unknown/error/aborted usage must not call this. Their full reservation remains charged. */
	async settle(workspace: string, run: string, requestId: string, usage: FundingTokens, guard: () => void) {
		const raw = canonicalJSON(usage);
		this.db.transaction(() => {
			guard();
			const row = this.db.one("SELECT * FROM day_insights_allowance WHERE request_id=?", requestId);
			if (!row || row.workspace_id !== workspace || row.run_id !== run)
				throw new Conflict("day_insights_reservation_missing");
			if (row.usage !== null) {
				if (row.usage !== raw) throw new Conflict("day_insights_usage_receipt_changed");
				return;
			}
			const quote = JSON.parse(String(row.quote)) as FundingQuote;
			const long = usage.cacheWrite1h ?? 0;
			if (
				!integer(long) ||
				!integer(usage.cacheWrite) ||
				long > usage.cacheWrite ||
				!integer(usage.input + usage.cacheRead + usage.cacheWrite) ||
				usage.input + usage.cacheRead + usage.cacheWrite > quote.inputTokens ||
				usage.output > quote.outputTokens
			)
				throw new Conflict("day_insights_usage_exceeds_reserved_bound");
			const charged = priced(rates(quote), {
				...usage,
				input: usage.input + long * 2,
				cacheWrite: usage.cacheWrite - long,
			});
			if (charged > Number(row.maximum)) throw new Conflict("day_insights_usage_exceeds_reserved_bound");
			this.db.run("UPDATE day_insights_allowance SET charged=?,usage=? WHERE request_id=?", charged, raw, requestId);
		});
		await this.db.durable();
		guard();
	}
}
