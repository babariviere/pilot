import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DiagnosticLogReader } from "./diagnostic-logs.ts";
import { nativeAppLogLine } from "./native-app-log.ts";

const now = Date.parse("2026-10-20T12:00:00.000Z");
const host = { hostId: "daemon", daemonId: "fixture-daemon", lineageId: "fixture-lineage" };
const row = {
	schemaVersion: 1,
	at: new Date(now).toISOString(),
	host,
	event: "transport_failed",
	errorDomain: "NSURLErrorDomain",
	errorCode: -1001,
};

test("native producer-reader probe canonicalizes fixture-owned temporary aliases without weakening reader paths", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "native-log-bridge-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const producer = join(root, "Producer");
	await mkdir(producer, { mode: 0o700 });
	const alias = join(root, "temporary-alias");
	await symlink(producer, alias);
	await writeFile(join(producer, "app.jsonl"), `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`, {
		mode: 0o600,
	});
	const result = await promisify(execFile)(
		process.execPath,
		[fileURLToPath(new URL("./native-app-log.fixture.ts", import.meta.url)), alias],
		{ timeout: 5000, maxBuffer: 16 * 1024 },
	);
	assert.match(result.stdout, /producer-reader-ok/);
});

test("native app closed schema rejects identity, payload, malformed, expiry and oversized records", () => {
	assert.match(nativeAppLogLine(JSON.stringify(row), host, now)!, /-1001/);
	for (const value of [
		{ ...row, host: { ...host, lineageId: "other" } },
		{ ...row, payload: "private" },
		{ ...row, errorDomain: "password=private" },
		{ ...row, event: "private" },
		{ ...row, at: new Date(now - 8 * 86400_000).toISOString() },
		{ ...row, errorCode: Infinity },
		{ ...row, errorCode: "private" },
		{ ...row, at: new Date(now + 1).toISOString() },
	])
		assert.equal(nativeAppLogLine(JSON.stringify(value), host, now), undefined);
	for (const raw of ["{", "x".repeat(2049), "null"]) assert.equal(nativeAppLogLine(raw, host, now), undefined);
});

test("private retained app source integrates search/excerpt, rotation, identity, controls and unsafe-file limits", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "native-app-logs-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "App");
	await mkdir(directory, { mode: 0o700 });
	const appLog = join(directory, "app.jsonl");
	const write = (path: string, text: string) => writeFile(path, text, { mode: 0o600 });
	await write(appLog, `${JSON.stringify(row)}\n${JSON.stringify({ ...row, payload: "private-canary" })}\n`);
	await write(`${appLog}.1`, `${JSON.stringify({ ...row, event: "repair_archive_failed" })}\n`);
	const reader = new DiagnosticLogReader({ home: root, appLog, platform: "darwin", now: () => new Date(now) });
	const call = (enabled = true) =>
		reader.call(host, undefined, enabled, { action: "search", source: "app", limit: 1 });
	const page = await call();
	assert.equal(page.page?.records.length, 1);
	assert.doesNotMatch(JSON.stringify(page), /private-canary/);
	const next = await reader.call(host, undefined, true, {
		action: "search",
		source: "app",
		limit: 1,
		cursor: page.page!.nextCursor,
	});
	assert.match(next.page!.records[0]!.text, /repair_archive_failed/);
	const excerpt = await reader.call(host, undefined, true, { action: "excerpt", ref: page.page!.records[0]!.ref });
	assert.equal(excerpt.excerpt?.status, "ok");
	assert.doesNotMatch(JSON.stringify(excerpt), /private-canary/);
	assert.equal((await call(false)).page?.status, "disabled");
	const other = await reader.call({ ...host, lineageId: "other" }, undefined, true, {
		action: "search",
		source: "app",
	});
	assert.equal(other.page?.records.length, 0);
	await rm(`${appLog}.1`);
	await rm(appLog);
	assert.equal((await call()).page?.status, "unavailable");
	await symlink(join(root, "unrelated"), appLog);
	assert.equal((await call()).page?.status, "unavailable");
	await rm(appLog);
	await write(appLog, "x".repeat(256 * 1024 + 1));
	assert.equal((await call()).page?.status, "unavailable");
	await rm(appLog);
	await write(appLog, `${JSON.stringify(row)}\n`);
	await chmod(directory, 0o755);
	assert.equal((await call()).page?.status, "unavailable");
});
