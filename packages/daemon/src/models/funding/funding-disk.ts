/** Worker-owned funding. Never derived from erasable usage history. */
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
	FundingAccount,
	FundingOwner,
	FundingQuote,
	FundingRate,
	FundingTokens,
	FundingView,
} from "@pilot/protocol";
import { FundingRefused } from "./funding-errors.ts";

const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const identifier = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const DAY = 86_400_000;
function key(o: FundingOwner) {
	if (
		!o ||
		!["mission", "quick_fix", "background"].includes(o.kind) ||
		!identifier(o.id) ||
		(o.projectId !== undefined && !identifier(o.projectId))
	)
		throw new Error("Invalid funding owner");
	return `${o.kind}:${o.id}`;
}
function price(rate: FundingRate, tokens: FundingRate): number {
	const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
	if (!keys.every((k) => integer(rate[k]) && integer(tokens[k])) || rate.input === 0 || rate.output === 0)
		throw new Error("Catalog prices or usage unavailable");
	const n = keys.reduce((n, k) => n + BigInt(rate[k]) * BigInt(tokens[k]), 0n);
	const value = (n + 999_999n) / 1_000_000n;
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Request price overflow");
	return Number(value);
}
interface Call {
	id: string;
	account: string;
	owner: string;
	quote: string;
	amount: number;
	settled: number;
	usage: string | null;
	at: number;
	job: string;
}
interface Account {
	id: string;
	owner: string;
	amount: number;
}
export class FundingDisk {
	readonly db: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();
	constructor(file: string) {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(file);
		chmodSync(file, 0o600);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
		CREATE TABLE IF NOT EXISTS funding_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS funding_defaults (project TEXT PRIMARY KEY, mission INTEGER, quick_fix INTEGER);
		CREATE TABLE IF NOT EXISTS funding_accounts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, amount INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS funding_calls (id TEXT PRIMARY KEY, account TEXT NOT NULL, owner TEXT NOT NULL, quote TEXT NOT NULL, amount INTEGER NOT NULL, settled INTEGER NOT NULL, usage TEXT, at INTEGER NOT NULL, job TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS funding_call_account ON funding_calls(account);
		CREATE INDEX IF NOT EXISTS funding_call_unsettled ON funding_calls(account) WHERE settled=0;
		CREATE TABLE IF NOT EXISTS funding_holds (account TEXT PRIMARY KEY, maximum INTEGER NOT NULL);
		INSERT OR IGNORE INTO funding_meta VALUES ('revision',0);`);
	}
	/** Fixed SQL only. Re-preparing every request keeps native allocations until V8 collects them. */
	private prepare(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const v = fn();
			this.db.exec("COMMIT");
			return v;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}
	private revision() {
		return Number(this.prepare("SELECT value FROM funding_meta WHERE key='revision'").get()!.value);
	}
	private bump() {
		this.db.exec("UPDATE funding_meta SET value=value+1 WHERE key='revision'");
	}
	private daily() {
		return this.prepare("SELECT value FROM funding_meta WHERE key='daily'").get()?.value as number | undefined;
	}
	/** Spending limits are on unless the user turned them off. */
	enabled(): boolean {
		return !this.prepare("SELECT value FROM funding_meta WHERE key='off'").get();
	}
	setEnabled(expected: number, enabled: boolean): void {
		this.transaction(() => {
			if (this.revision() !== expected) throw new FundingRefused("Funding changed; read again");
			if (typeof enabled !== "boolean") throw new FundingRefused("Invalid funding settings");
			if (enabled) this.db.exec("DELETE FROM funding_meta WHERE key='off'");
			else this.db.exec("INSERT OR REPLACE INTO funding_meta VALUES('off',1)");
			this.bump();
		});
	}
	private background(now: number): FundingOwner {
		return { kind: "background", id: String(Math.floor(now / DAY)) };
	}
	private account(owner: FundingOwner): Account | undefined {
		return this.prepare("SELECT * FROM funding_accounts WHERE id=?").get(key(owner)) as unknown as
			| Account
			| undefined;
	}
	private summary(owner: FundingOwner): FundingAccount {
		const amount = this.account(owner)?.amount ?? (owner.kind === "background" ? (this.daily() ?? null) : null);
		const where =
			owner.kind === "background" ? "account=? OR (account LIKE 'background:%' AND settled=0)" : "account=?";
		const sums = this.prepare(
			`SELECT coalesce(sum(CASE WHEN settled=1 THEN amount ELSE 0 END),0) AS spent,coalesce(sum(CASE WHEN settled=0 THEN amount ELSE 0 END),0) AS uncertain FROM funding_calls WHERE ${where}`,
		).get(key(owner))!;
		const spentMicros = Number(sums.spent),
			uncertainMicros = Number(sums.uncertain);
		return {
			...owner,
			...(this.prepare("SELECT maximum FROM funding_holds WHERE account=?").get(key(owner))
				? {
						heldMaximumMicros: Number(
							this.prepare("SELECT maximum FROM funding_holds WHERE account=?").get(key(owner))!.maximum,
						),
					}
				: {}),
			limitMicros: amount,
			spentMicros,
			uncertainMicros,
			remainingMicros: amount === null ? null : Math.max(0, amount - spentMicros - uncertainMicros),
		};
	}
	read(projectId: string | undefined, now: number): FundingView {
		const defaults = projectId
			? this.prepare("SELECT * FROM funding_defaults WHERE project=?").get(projectId)
			: undefined;
		// Limit snapshot memory, not the durable history or exact account count.
		const where = "json_extract(owner,'$.kind')!='background' AND (? IS NULL OR json_extract(owner,'$.projectId')=?)";
		const args = [projectId ?? null, projectId ?? null];
		const rows = this.prepare(`SELECT * FROM funding_accounts WHERE ${where} ORDER BY id LIMIT 100`).all(
			...args,
		) as unknown as Account[];
		const owners = rows.map((r) => JSON.parse(r.owner) as FundingOwner);
		return {
			revision: this.revision(),
			enabled: this.enabled(),
			backgroundJobs: this.prepare(
				"SELECT job,json_extract(owner,'$.projectId') AS projectId,sum(CASE WHEN settled=1 THEN amount ELSE 0 END) AS spentMicros,sum(CASE WHEN settled=0 THEN amount ELSE 0 END) AS uncertainMicros FROM funding_calls WHERE account=? OR (account LIKE 'background:%' AND settled=0) GROUP BY job,projectId LIMIT 100",
			).all(key(this.background(now))) as unknown as NonNullable<FundingView["backgroundJobs"]>,
			missionDefaultMicros: (defaults?.mission as number) ?? null,
			quickFixDefaultMicros: (defaults?.quick_fix as number) ?? null,
			dailyMicros: this.daily() ?? null,
			resetAt: new Date((Math.floor(now / DAY) + 1) * DAY).toISOString(),
			background: this.summary(this.background(now)),
			accounts: owners.map((o) => this.summary(o)),
			accountCount: Number(
				this.prepare(`SELECT count(*) AS n FROM funding_accounts WHERE ${where}`).get(...args)!.n,
			),
		};
	}
	configure(
		projectId: string | undefined,
		expected: number,
		value: { missionDefaultMicros: number | null; quickFixDefaultMicros: number | null; dailyMicros: number | null },
	): void {
		this.transaction(() => {
			if (this.revision() !== expected) throw new FundingRefused("Funding changed; read again");
			if (
				!value ||
				Object.keys(value).sort().join() !== "dailyMicros,missionDefaultMicros,quickFixDefaultMicros" ||
				!Object.values(value).every((v) => v === null || integer(v))
			)
				throw new FundingRefused("Invalid funding settings");
			if (projectId)
				this.prepare(
					"INSERT INTO funding_defaults VALUES(?,?,?) ON CONFLICT(project) DO UPDATE SET mission=excluded.mission,quick_fix=excluded.quick_fix",
				).run(projectId, value.missionDefaultMicros, value.quickFixDefaultMicros);
			if (value.dailyMicros === null) this.db.exec("DELETE FROM funding_meta WHERE key='daily'");
			else
				this.prepare(
					"INSERT INTO funding_meta VALUES('daily',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
				).run(value.dailyMicros);
			this.bump();
		});
	}
	fund(owner: FundingOwner, expected: number, amount: number): void {
		this.transaction(() => {
			if (this.revision() !== expected || !integer(amount))
				throw new FundingRefused("Funding changed or invalid amount");
			const old = this.account(owner);
			if (old && old.owner !== JSON.stringify(owner)) throw new FundingRefused("Funding owner changed");
			if (old && amount <= old.amount)
				throw new FundingRefused("Only an explicit increase can change this allowance");
			this.prepare(
				"INSERT INTO funding_accounts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount",
			).run(key(owner), JSON.stringify(owner), amount);
			this.bump();
		});
	}
	/** Creation receipt recovery can ensure the same account, never refill or lower an existing one. */
	open(owner: FundingOwner, amount: number): void {
		this.transaction(() => {
			if (!integer(amount) || owner.kind === "background") throw new Error("Invalid initial allowance");
			const old = this.account(owner);
			if (old) {
				if (old.owner !== JSON.stringify(owner)) throw new Error("Funding owner changed");
				return;
			}
			this.prepare("INSERT INTO funding_accounts VALUES(?,?,?)").run(key(owner), JSON.stringify(owner), amount);
			this.bump();
		});
	}
	reserve(
		owner: FundingOwner,
		id: string,
		quote: FundingQuote,
		job: string,
		now: number,
	): { id: string; maximumMicros: number } {
		let refused: string | undefined;
		const result = this.transaction(() => {
			if (!identifier(id) || !identifier(job) || !integer(now)) throw new Error("Invalid funding request");
			if (owner.kind === "background") owner = { ...owner, ...this.background(now) };
			const account = this.account(owner);
			if (account && account.owner !== JSON.stringify(owner)) throw new Error("Funding owner changed");
			if (this.prepare("SELECT id FROM funding_calls WHERE id=?").get(id))
				throw new Error("Request already reserved; never replay");
			if (
				!quote ||
				!identifier(quote.provider) ||
				typeof quote.model !== "string" ||
				quote.model.length > 256 ||
				!integer(quote.inputTokens) ||
				quote.inputTokens < 1 ||
				!integer(quote.outputTokens) ||
				quote.outputTokens < 1
			)
				throw new Error("Request bounds unavailable");
			const rates = [
				quote.rate,
				...(quote.tiers?.map((t) => {
					if (!integer(t.inputTokensAbove)) throw new Error("Invalid tier");
					return t.rate;
				}) ?? []),
			];
			for (const rate of rates) price(rate, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			// Long-lived cache writes can cost twice the ordinary input rate.
			const input = Math.max(...rates.flatMap((r) => [r.input * 2, r.cacheRead, r.cacheWrite]));
			const maximumMicros = price(
				{ ...quote.rate, input, output: Math.max(...rates.map((r) => r.output)) },
				{ input: quote.inputTokens, output: quote.outputTokens, cacheRead: 0, cacheWrite: 0 },
			);
			const summary = this.summary(owner);
			if (
				this.prepare("SELECT value FROM funding_meta WHERE key=?").get(
					`overrun:${JSON.stringify([quote.provider, quote.model])}`,
				)
			)
				throw new Error("Provider bound exceeded; request adapter needs correction");
			if (summary.remainingMicros === null || maximumMicros > summary.remainingMicros) {
				this.prepare("INSERT OR REPLACE INTO funding_holds VALUES(?,?)").run(key(owner), maximumMicros);
				refused =
					summary.remainingMicros === null
						? "Set an allowance before starting this work"
						: "Allowance cannot fund this request maximum";
				return { id, maximumMicros };
			}
			this.prepare("INSERT INTO funding_calls VALUES(?,?,?,?,?,0,NULL,?,?)").run(
				id,
				key(owner),
				JSON.stringify(owner),
				JSON.stringify(quote),
				maximumMicros,
				now,
				job,
			);
			this.prepare("DELETE FROM funding_holds WHERE account=?").run(key(owner));
			return { id, maximumMicros };
		});
		if (refused) throw new Error(refused);
		return result;
	}
	settle(id: string, owner: FundingOwner, usage: FundingTokens | undefined): void {
		let overrun = false;
		this.transaction(() => {
			const call = this.prepare("SELECT * FROM funding_calls WHERE id=?").get(id) as unknown as Call | undefined;
			if (!call) throw new Error("Unknown funding request");
			const saved = JSON.parse(call.owner) as FundingOwner;
			if (
				saved.kind !== owner.kind ||
				saved.projectId !== owner.projectId ||
				(saved.kind !== "background" && saved.id !== owner.id)
			)
				throw new Error("Funding scope changed");
			if (!usage) return;
			const quote = JSON.parse(call.quote) as FundingQuote;
			const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
			let rate = quote.rate,
				threshold = -1;
			for (const tier of quote.tiers ?? [])
				if (totalInput > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
					rate = tier.rate;
					threshold = tier.inputTokensAbove;
				}
			const long = usage.cacheWrite1h ?? 0;
			if (!integer(long) || long > usage.cacheWrite) throw new Error("Invalid cache-write evidence");
			const amount = price(rate, { ...usage, input: usage.input + long * 2, cacheWrite: usage.cacheWrite - long });
			if (call.settled) {
				if (call.usage !== JSON.stringify(usage)) throw new Error("Usage evidence conflict");
				return;
			}
			if (
				usage.input + usage.cacheRead + usage.cacheWrite > quote.inputTokens ||
				usage.output > quote.outputTokens ||
				amount > call.amount
			) {
				overrun = true;
				this.prepare("INSERT OR REPLACE INTO funding_meta VALUES(?,1)").run(
					`overrun:${JSON.stringify([quote.provider, quote.model])}`,
				);
			}
			this.prepare("UPDATE funding_calls SET amount=?, settled=1, usage=? WHERE id=?").run(
				amount,
				JSON.stringify(usage),
				id,
			);
		});
		if (overrun) throw new Error("Provider exceeded its reserved bound; charge saved and affected model held");
	}
	close() {
		this.statements.clear();
		this.db.close();
	}
}
