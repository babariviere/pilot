import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DiagnosticLogRequest } from "@pilot/kernel";
import { DiagnosticLogReader, sanitizeDiagnosticLogLine } from "./diagnostic-logs.ts";
import { operations } from "./event-loop-watchdog.ts";

const id = "01234567-89ab-4cde-8fab-0123456789ab";
const host = { hostId: "remote-box", daemonId: "daemon", lineageId: "lineage" } as const;
const stamp = "2026-10-18T10:00:00.000Z";

async function fixture(t: TestContext) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "diagnostic-logs-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	const target = join(home, "sessions", id);
	const durable = join(target, "durable");
	const logRoot = join(home, "logs");
	const reports = join(home, "DiagnosticReports");
	await Promise.all([
		mkdir(durable, { recursive: true }),
		mkdir(logRoot, { recursive: true }),
		mkdir(reports, { recursive: true }),
	]);
	const daemonLog = join(logRoot, "pilotd.log");
	await Promise.all([
		writeFile(
			daemonLog,
			[
				`[${stamp}] startup ok`,
				`[${stamp}] Error: provider timeout`,
				`[${stamp}] password=do-not-return`,
				`[${stamp}] {"messages":[{"role":"user","content":"private prompt"}]}`,
				`[${stamp}] literal .* marker`,
				"",
			].join("\n"),
		),
		writeFile(`${daemonLog}.1`, `[2026-10-17T10:00:00.000Z] rotated failure\n`),
		writeFile(
			join(target, "lifecycle.jsonl"),
			`${JSON.stringify({ at: Date.parse(stamp), kind: "execution.started" })}\n`,
		),
		writeFile(
			join(durable, "performance.jsonl"),
			`${JSON.stringify({ at: Date.parse(stamp), outcome: "completed" })}\n`,
		),
		writeFile(
			join(durable, "tool-activity.jsonl"),
			`${JSON.stringify({ at: Date.parse(stamp), phase: "completed" })}\n`,
		),
		writeFile(join(durable, "history.db"), "unrelated-transcript-canary\n"),
		writeFile(
			join(reports, "Pilot_2026-10-18-100000_mac.ips"),
			`Date/Time: ${stamp}\nException Type: EXC_BAD_ACCESS\n`,
		),
		writeFile(join(reports, "node_2026-10-18.crash"), "must not be catalogued\n"),
	]);
	// Redacted records use file mtime as their fallback timestamp. Keep it on the fixture clock too.
	await utimes(daemonLog, new Date(stamp), new Date(stamp));
	const reader = new DiagnosticLogReader({
		home,
		daemonLog,
		diagnosticReports: reports,
		platform: "darwin",
		now: () => new Date(stamp),
	});
	const call = (request: DiagnosticLogRequest) => reader.call(host, id, target, true, request);
	return { home, target, durable, daemonLog, reports, reader, call };
}

test("inventory exposes only the closed path-free Pilot catalogue and explicit gaps", async (t) => {
	const f = await fixture(t);
	const result = await f.call({ action: "inventory" });
	assert.equal(result.action, "inventory");
	assert.equal(result.untrusted, true);
	assert.deepEqual(result.host, host);
	assert.equal(result.targetSessionId, id);
	assert.deepEqual(
		result.sources?.map((source) => source.id),
		["app", "daemon", "kernel_worker", "native_report", "lifecycle", "request_timing", "tool_activity"],
	);
	assert.deepEqual(
		result.sources?.find((source) => source.id === "app"),
		{
			id: "app",
			scope: "host",
			availability: "unavailable",
			coverage: "Pilot does not currently retain a searchable native app text log.",
			retention: "none",
			availableFiles: 0,
			rotatedFiles: 0,
			catalogTruncated: false,
			reason: "not_recorded",
		},
	);
	assert.equal(result.sources?.find((source) => source.id === "daemon")?.availableFiles, 2);
	assert.equal(result.sources?.find((source) => source.id === "daemon")?.rotatedFiles, 1);
	assert.equal(result.sources?.find((source) => source.id === "native_report")?.availableFiles, 1);
	assert.equal(JSON.stringify(result).includes(f.home), false, "inventory never reveals roots or file names");
});

test("a bounded daemon ring is explicit partial coverage and never claims worker journal history", async (t) => {
	const f = await fixture(t);
	const reader = new DiagnosticLogReader({
		home: f.home,
		platform: "linux",
		daemonTail: () => ({ text: `[${stamp}] current daemon\n`, available: true, truncated: true }),
	});
	const inventory = await reader.call(host, id, f.target, true, { action: "inventory" });
	const daemon = inventory.sources?.find((source) => source.id === "daemon");
	assert.equal(daemon?.availability, "available");
	assert.equal(daemon?.retention, "current_process");
	assert.equal(daemon?.catalogTruncated, true);
	assert.equal(daemon?.reason, "journal_unavailable");
	const worker = inventory.sources?.find((source) => source.id === "kernel_worker");
	assert.equal(worker?.availability, "unavailable");
	assert.equal(worker?.reason, "journal_unavailable");
});

test("search is literal, bounded, sanitized and pages into retained rotations", async (t) => {
	const f = await fixture(t);
	const retainedBefore = await Promise.all([
		readFile(join(f.target, "lifecycle.jsonl"), "utf8"),
		readFile(join(f.durable, "performance.jsonl"), "utf8"),
		readFile(join(f.durable, "tool-activity.jsonl"), "utf8"),
	]);
	const errors = await f.call({ action: "search", source: "daemon", q: "error", limit: 4 });
	assert.equal(errors.page?.status, "ok");
	assert.equal(errors.page?.records.length, 1);
	assert.match(errors.page?.records[0]?.text ?? "", /provider timeout/);
	assert.ok((errors.page?.scannedBytes ?? Infinity) <= 128 * 1024);
	assert.ok((errors.page?.encodedBytes ?? Infinity) <= 64 * 1024);
	assert.ok(Buffer.byteLength(JSON.stringify(errors)) <= 64 * 1024);

	const literal = await f.call({ action: "search", source: "daemon", q: ".*", limit: 4 });
	assert.equal(literal.page?.records.length, 1, "filter text is not interpreted as a regular expression");
	assert.equal(literal.page?.records[0]?.text.includes("literal .* marker"), true);

	const newest = await f.call({ action: "search", source: "daemon", limit: 2 });
	assert.equal(newest.page?.records.length, 2);
	assert.ok(newest.page?.nextCursor);
	const older = await f.call({ action: "search", source: "daemon", limit: 40, cursor: newest.page!.nextCursor });
	assert.equal(older.page?.status, "ok");
	assert.ok(older.page?.records.some((record) => record.text.includes("rotated failure")));
	const encoded = JSON.stringify([newest, older]);
	assert.equal(encoded.includes("do-not-return"), false);
	assert.equal(encoded.includes("private prompt"), false);
	assert.match(encoded, /REDACTED|WITHHELD/);

	const future = await f.call({ action: "search", source: "daemon", since: "2026-10-19T00:00:00Z" });
	assert.deepEqual(future.page?.records, []);
	await assert.rejects(() => f.call({ action: "search", source: "daemon", since: "2026-10-18" }), /timezone/);
	for (const source of ["lifecycle", "request_timing", "tool_activity"] as const) {
		const targetPage = await f.call({ action: "search", source, limit: 40 });
		assert.equal(JSON.stringify(targetPage).includes("unrelated-transcript-canary"), false);
	}
	assert.deepEqual(
		await Promise.all([
			readFile(join(f.target, "lifecycle.jsonl"), "utf8"),
			readFile(join(f.durable, "performance.jsonl"), "utf8"),
			readFile(join(f.durable, "tool-activity.jsonl"), "utf8"),
		]),
		retainedBefore,
		"log reads do not feed back into diagnostic evidence or telemetry sources",
	);
});

test("returned refs support bounded excerpts and go stale after replacement", async (t) => {
	const f = await fixture(t);
	const result = await f.call({ action: "search", source: "daemon", q: "provider timeout" });
	const ref = result.page?.records[0]?.ref;
	assert.ok(ref);
	const forged = `${ref.slice(0, -1)}${ref.endsWith("a") ? "b" : "a"}`;
	await assert.rejects(() => f.call({ action: "excerpt", ref: forged }), /Invalid diagnostic log ref/);
	const excerpt = await f.call({ action: "excerpt", ref, before: 1, after: 1 });
	assert.equal(excerpt.excerpt?.status, "ok");
	assert.match(excerpt.excerpt?.record?.text ?? "", /provider timeout/);
	assert.equal(excerpt.excerpt?.before.length, 1);
	assert.equal(excerpt.excerpt?.after.length, 1);
	assert.ok((excerpt.excerpt?.scannedBytes ?? Infinity) <= 128 * 1024);

	await rm(f.daemonLog);
	await writeFile(f.daemonLog, `[${stamp}] replacement\n`);
	const stale = await f.call({ action: "excerpt", ref });
	assert.equal(stale.excerpt?.status, "stale_ref");
});

test("continuation follows a rotated inode but rejects an expired cursor", async (t) => {
	const f = await fixture(t);
	await rm(`${f.daemonLog}.1`);
	await writeFile(f.daemonLog, `${Array.from({ length: 8 }, (_, index) => `[${stamp}] row-${index}`).join("\n")}\n`);
	const first = await f.call({ action: "search", source: "daemon", limit: 1 });
	assert.ok(first.page?.nextCursor);
	await rename(f.daemonLog, `${f.daemonLog}.1`);
	await writeFile(f.daemonLog, `[${stamp}] new-current\n`);
	const followed = await f.call({ action: "search", source: "daemon", cursor: first.page!.nextCursor, limit: 2 });
	assert.equal(followed.page?.status, "ok");
	assert.ok(followed.page?.records.some((record) => record.text.includes("row-6")));
	await rm(`${f.daemonLog}.1`);
	const stale = await f.call({ action: "search", source: "daemon", cursor: first.page!.nextCursor });
	assert.equal(stale.page?.status, "stale_cursor");
});

test("oversized records, symlinks, missing sources and disabled target diagnostics fail closed", async (t) => {
	const f = await fixture(t);
	await writeFile(f.daemonLog, `${"x".repeat(160 * 1024)}\n[${stamp}] bounded\n`);
	const page = await f.call({ action: "search", source: "daemon", limit: 40 });
	assert.ok((page.page?.scannedBytes ?? Infinity) <= 128 * 1024);
	assert.ok((page.page?.oversizedRecords ?? 0) > 0);
	assert.equal(JSON.stringify(page).includes("x".repeat(1_000)), false);

	const outside = join(f.home, "outside.log");
	await writeFile(outside, "outside-private-data\n");
	await rm(f.daemonLog);
	await rm(`${f.daemonLog}.1`);
	await symlink(outside, f.daemonLog);
	const reader = new DiagnosticLogReader({ home: f.home, daemonLog: f.daemonLog, platform: "linux" });
	const inventory = await reader.call(host, id, f.target, true, { action: "inventory" });
	const daemon = inventory.sources?.find((source) => source.id === "daemon");
	assert.equal(daemon?.availability, "unavailable");
	assert.equal(daemon?.reason, "unsafe_source");
	assert.equal(JSON.stringify(inventory).includes("outside-private-data"), false);

	await rm(join(f.target, "lifecycle.jsonl"));
	await symlink(outside, join(f.target, "lifecycle.jsonl"));
	const unsafe = await reader.call(host, id, f.target, true, { action: "inventory" });
	assert.equal(unsafe.sources?.find((source) => source.id === "lifecycle")?.reason, "unsafe_source");
	const disabled = await reader.call(host, id, f.target, false, { action: "inventory" });
	for (const source of disabled.sources?.filter((item) => item.scope === "target") ?? [])
		assert.equal(source.availability, "disabled");

	const untouched = await readFile(outside, "utf8");
	assert.equal(untouched, "outside-private-data\n", "read attempts never mutate a source");
});

test("unknown source IDs and inaccessible catalogue files are denied without path fallback", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		() => f.call({ action: "search", source: "../../private" } as never),
		/Unknown diagnostic log source/,
	);
	await chmod(f.daemonLog, 0o000);
	t.after(() => chmod(f.daemonLog, 0o600).catch(() => undefined));
	const inventory = await f.call({ action: "inventory" });
	const daemon = inventory.sources?.find((source) => source.id === "daemon");
	if (typeof process.getuid !== "function" || process.getuid() !== 0) {
		assert.equal(daemon?.availableFiles, 1, "only the readable rotated file remains catalogued");
		assert.equal(daemon?.reason, "inaccessible");
	}
	assert.equal(JSON.stringify(inventory).includes(f.daemonLog), false);
});

test("sanitization retains useful errors while withholding credentials and conversation payloads", () => {
	assert.equal(
		sanitizeDiagnosticLogLine("Error: socket reset at worker.ts:42"),
		"Error: socket reset at worker.ts:42",
	);
	assert.equal(sanitizeDiagnosticLogLine("Authorization: Bearer canary"), "[REDACTED credential-bearing record]");
	assert.equal(
		sanitizeDiagnosticLogLine('{"tool_result":{"content":"private output"}}'),
		"[WITHHELD conversation-bearing log record]",
	);
});

test("redaction timing labels never contain record content", (t) => {
	const labels: unknown[] = [];
	t.mock.method(operations, "time", (label: string, run: () => unknown) => {
		labels.push(label);
		return run();
	});
	assert.equal(sanitizeDiagnosticLogLine("password=timing-canary"), "[REDACTED credential-bearing record]");
	assert.deepEqual(labels, ["diagnostics.redact"]);
});
