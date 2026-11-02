/** Offscreen synthetic storage comparison. Never opens the user's usage database. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageAnalyticsQuery, UsageHistoryPage } from "@pilot/protocol";
import { UsageHistoryDisk } from "./usage-history-disk.ts";
import { parseUsageObservation, USAGE_DAY_MS, USAGE_MAX_ROWS } from "./usage-history-validation.ts";

const count = Number(process.argv[2] ?? 50_000);
assert.ok(Number.isInteger(count) && count > 0 && count <= USAGE_MAX_ROWS);
const fixture: UsageHistoryPage = JSON.parse(
	await readFile(new URL("../../protocol/fixtures/usage-history.json", import.meta.url), "utf8"),
);
const now = fixture.rows[0]!.observedAt;
const query: UsageAnalyticsQuery = {
	version: 1,
	view: "buckets",
	from: now - 30 * USAGE_DAY_MS,
	to: now + 1,
	bucketMs: USAGE_DAY_MS,
};
const home = await mkdtemp(join(tmpdir(), "usage-compaction-bench-"));
const file = join(home, "usage.sqlite");
let disk = new UsageHistoryDisk(file, now);
function measure() {
	const times: number[] = [];
	for (let i = 0; i < 12; i++) {
		const start = performance.now();
		disk.analytics(query, now);
		times.push(performance.now() - start);
	}
	times.sort((a, b) => a - b);
	return { medianMs: times[6], p95Ms: times[11] };
}
try {
	const original = parseUsageObservation({ ...fixture.rows[0]!, generation: disk.status().generation });
	// A text seed at the new row limit can exceed even the increased byte cap.
	const legacyCount = Math.min(count, 100_000);
	// Seed canonical v1 text directly in one transaction, avoiding per-row fsync during setup.
	disk.db.exec("BEGIN IMMEDIATE");
	const insert = disk.db.prepare("INSERT INTO usage_rows VALUES(?,?,?,?,?,?,?,?,?)");
	for (let i = 0; i < legacyCount; i++) {
		const row = { ...original, operationId: `bench:${i}`, completedAt: now - i * 10_000 };
		insert.run(
			row.sourceId,
			row.operationId,
			row.revision,
			row.kind,
			row.scope,
			row.completedAt,
			row.completedAt,
			row.attribution?.chatId ?? null,
			JSON.stringify(row),
		);
	}
	disk.db.prepare("UPDATE usage_meta SET rows=?").run(legacyCount);
	disk.db.exec("PRAGMA user_version=1; COMMIT");
	const before = { bytes: (await stat(file)).size, queries: measure() };
	const status = disk.status();
	const totals = disk.analytics(query, now);
	const pageQuery = { kind: "request" as const, from: query.from, to: query.to };
	const page = disk.page(pageQuery, now);
	disk.close();
	const start = performance.now();
	disk = new UsageHistoryDisk(file, now);
	const migrationMs = performance.now() - start;
	const after = { bytes: (await stat(file)).size, queries: measure() };
	assert.deepEqual(disk.status(), status);
	assert.deepEqual(disk.analytics(query, now), totals);
	assert.deepEqual(disk.page(pageQuery, now), page);
	assert.equal(disk.put({ ...original, operationId: "bench:0", completedAt: now }, now), "duplicate");
	assert.ok(after.bytes < before.bytes);
	let capacity:
		| {
				records: number;
				byteCapReached: boolean;
				bytes: number;
				queries: ReturnType<typeof measure>;
		  }
		| undefined;
	if (count > legacyCount) {
		const binaryInsert = disk.db.prepare("INSERT INTO usage_rows VALUES(?,?,?,?,?,?,?,?,jsonb(?))");
		let retained = legacyCount;
		let byteCapReached = false;
		for (let start = legacyCount; start < count; start += 1000) {
			disk.db.exec("BEGIN IMMEDIATE");
			const end = Math.min(count, start + 1000);
			try {
				for (let i = start; i < end; i++) {
					const row = { ...original, operationId: `bench:${i}`, completedAt: now - i * 10_000 };
					binaryInsert.run(
						row.sourceId,
						row.operationId,
						row.revision,
						row.kind,
						row.scope,
						row.completedAt,
						row.completedAt,
						row.attribution?.chatId ?? null,
						JSON.stringify(row),
					);
				}
				disk.db.prepare("UPDATE usage_meta SET rows=?").run(end);
				disk.db.exec("COMMIT");
				retained = end;
			} catch (error) {
				if (disk.db.isTransaction) disk.db.exec("ROLLBACK");
				if ((error as { errcode?: number }).errcode !== 13) throw error;
				byteCapReached = true;
				break;
			}
		}
		assert.equal(disk.analytics(query, now).total.records, retained);
		assert.equal(disk.status().retainedRows, retained);
		capacity = { records: retained, byteCapReached, bytes: (await stat(file)).size, queries: measure() };
	}
	console.log(
		JSON.stringify(
			{ legacyCount, before, after, migrationMs, savedPercent: 100 * (1 - after.bytes / before.bytes), capacity },
			null,
			2,
		),
	);
} finally {
	disk.close();
	await rm(home, { recursive: true, force: true });
}
