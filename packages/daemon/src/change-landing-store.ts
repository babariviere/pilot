/** Append-only passive observations in missions.sqlite, not another delivery/approval store. */
import type { SQLInputValue } from "node:sqlite";
import type { ChangeLandingRecord, ChangeLandingResult, ReviewDispositionTarget } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { targetKey } from "./human-review-store.ts";

export const CHANGE_LANDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS change_landing_observations (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, observation_id TEXT NOT NULL UNIQUE,
 target_digest TEXT NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_landing_target ON change_landing_observations(target_digest,sequence);
CREATE INDEX IF NOT EXISTS change_landing_status ON change_landing_observations(target_digest,json_extract(record,'$.result.status'),sequence);
`;
interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	all(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue>[];
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	durable(): Promise<void>;
}
const parse = (row: Record<string, SQLInputValue> | undefined): ChangeLandingRecord | undefined =>
	row ? { ...JSON.parse(String(row.record)), sequence: Number(row.sequence) } : undefined;
export class ChangeLandingStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	lookup(id: string, target: ReviewDispositionTarget) {
		const record = parse(
			this.port.one("SELECT sequence,record FROM change_landing_observations WHERE observation_id=?", id),
		);
		if (record && targetKey(record.target) !== targetKey(target))
			throw new Conflict("Landing observation identity changed");
		return record;
	}
	append(id: string, target: ReviewDispositionTarget, result: ChangeLandingResult, revalidate: () => void) {
		return this.port.transaction(() => {
			revalidate();
			const prior = this.lookup(id, target);
			if (prior) return prior;
			this.port.run(
				"INSERT INTO change_landing_observations(observation_id,target_digest,record) VALUES(?,?,?)",
				id,
				targetKey(target),
				JSON.stringify({ observationId: id, target, result, recordedAt: Date.now() }),
			);
			return this.lookup(id, target)!;
		});
	}
	latest(target: ReviewDispositionTarget) {
		return (
			parse(
				this.port.one(
					"SELECT sequence,record FROM change_landing_observations WHERE target_digest=? ORDER BY sequence DESC LIMIT 1",
					targetKey(target),
				),
			) ?? null
		);
	}
	latestObserved(target: ReviewDispositionTarget) {
		return (
			parse(
				this.port.one(
					"SELECT sequence,record FROM change_landing_observations WHERE target_digest=? AND json_extract(record,'$.result.status')='observed' ORDER BY sequence DESC LIMIT 1",
					targetKey(target),
				),
			) ?? null
		);
	}
	history(target: ReviewDispositionTarget, after = 0) {
		const records = this.port
			.all(
				"SELECT sequence,record FROM change_landing_observations WHERE target_digest=? AND sequence>? ORDER BY sequence LIMIT 21",
				targetKey(target),
				after,
			)
			.map((r) => parse(r)!);
		return { records: records.slice(0, 20), next: records.length > 20 ? records[19]!.sequence : null };
	}
	durable() {
		return this.port.durable();
	}
}
