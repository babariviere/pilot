import assert from "node:assert/strict";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DiagnosticLogRequest } from "@pilot/protocol";
import { dayAppBinding, dayAppLogLine } from "./day-app-log.ts";
import { DiagnosticLogReader } from "./diagnostic-logs.ts";

const now = 1793361600;
const host = {
	hostId: "daemon",
	daemonId: "01234567-89ab-4cde-8fab-0123456789ab",
	lineageId: "abcdef01-2345-4678-9abc-0123456789ab",
};
const dayRow = {
	schemaVersion: 1,
	epoch: 0,
	binding: dayAppBinding(host),
	at: new Date(now * 1000).toISOString(),
	pid: 123,
	event: "connection.lost",
	generation: 4,
	protocol: 1,
	wasConnected: true,
	update: false,
	error: "Offline",
};
test("Day closed schema rejects payloads, unsafe numbers, identities and obsolete epochs", () => {
	assert.ok(dayAppLogLine(JSON.stringify(dayRow), host, now * 1000, 0).text);
	for (const patch of [
		{ schemaVersion: 2 },
		{ text: "secret" },
		{ event: "secret" },
		{ error: "secret" },
		{ pid: 4294967296 },
		{ generation: true },
		{ protocol: -1 },
		{ wasConnected: 1 },
		{ update: "secret" },
		{ epoch: null },
		{ binding: "bad" },
		{ generation: Number.MAX_SAFE_INTEGER + 1 },
		{ at: "2026-02-30T00:00:00.000Z" },
	]) {
		assert.equal(dayAppLogLine(JSON.stringify({ ...dayRow, ...patch }), host, now * 1000, 0).text, undefined);
	}
	for (const raw of ["{", "null", "x".repeat(4097), JSON.stringify(dayRow).replace('"pid":123', '"pid":123.0')]) {
		assert.equal(dayAppLogLine(raw, host, now * 1000, 0).text, undefined);
	}
	assert.equal(
		dayAppLogLine(JSON.stringify(dayRow), { ...host, lineageId: "foreign" }, now * 1000, 0).omission,
		"identity",
	);
	assert.equal(dayAppLogLine(JSON.stringify(dayRow), host, now * 1000, 1).omission, "cleared");
	assert.equal(dayAppLogLine(JSON.stringify(dayRow), host, (now - 1) * 1000, 0).omission, "future");
	assert.equal(dayAppLogLine(JSON.stringify(dayRow), host, (now + 8 * 86400) * 1000, 0).omission, "expired");
});
test("fixed Day slots search/excerpt, omission accounting, settings, rotation and unsafe sources", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "day-app-logs-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	const root = join(home, "diagnostics");
	await mkdir(root, { mode: 0o700 });
	const paths = [0, 1, 2, 3].map((n) => join(root, n === 0 ? "day.log" : `day.log.${n}`));
	const write = (path: string, rows: unknown[]) =>
		writeFile(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
	await write(paths[0]!, [{ ...dayRow, binding: "a".repeat(64) }, { ...dayRow, text: "secret-canary" }, dayRow]);
	await write(paths[1]!, [{ ...dayRow, event: "read.failed" }]);
	await write(paths[2]!, [{ ...dayRow, at: new Date((now - 8 * 86400) * 1000).toISOString() }]);
	await writeFile(paths[3]!, "", { mode: 0o600 });
	await writeFile(join(root, "capture.lock"), "secret-lock");
	await writeFile(join(root, "reviewed.json"), "secret-export");
	let control: { localDiagnostics: boolean; epoch: number } | undefined = {
		localDiagnostics: true,
		epoch: 0,
	};
	const reader = new DiagnosticLogReader({
		home,
		dayAppRoot: root,
		nextAppControl: () => control,
		platform: "darwin",
		now: () => new Date(now * 1000),
	});
	const call = (request: DiagnosticLogRequest, allowed = true) =>
		reader.call(host, undefined, true, request, undefined, allowed);
	const inventory = await call({ action: "inventory" });
	assert.equal(inventory.sources?.find((s) => s.id === "day_app")?.availableFiles, 4);
	const page = (await call({ action: "search", source: "day_app", limit: 40 })).page!;
	assert.equal(page.records.length, 2);
	assert.deepEqual(page.omissions, { identity: 1, invalid: 1, expired: 1 });
	assert.equal(page.truncated, true);
	assert.match(page.reason!, /not.*delivery|not.*acceptance/i);
	assert.ok(page.scannedBytes <= 128 * 1024);
	assert.ok(page.encodedBytes <= 64 * 1024);
	assert.doesNotMatch(JSON.stringify(page), /secret|capture.lock|reviewed.json/);
	const ref = page.records[0]!.ref;
	assert.equal((await call({ action: "excerpt", ref })).excerpt?.status, "ok");
	const excerpt = reader["excerpt"].bind(reader);
	reader["excerpt"] = async (...args) => {
		const result = await excerpt(...args);
		control = { localDiagnostics: true, epoch: 1 };
		return result;
	};
	assert.equal((await call({ action: "excerpt", ref })).excerpt?.status, "unavailable");
	reader["excerpt"] = excerpt;
	control = { localDiagnostics: true, epoch: 0 };
	assert.equal((await call({ action: "search", source: "day_app", q: "read.failed" })).page?.records.length, 1);
	assert.equal((await call({ action: "search", source: "app" })).page?.records.length, 0);
	assert.equal((await call({ action: "search", source: "day_app" }, false)).page?.status, "unavailable");
	control = undefined;
	assert.equal((await call({ action: "search", source: "day_app" })).page?.status, "unavailable");
	control = { localDiagnostics: false, epoch: 0 };
	assert.equal((await call({ action: "search", source: "day_app" })).page?.status, "disabled");
	control = { localDiagnostics: true, epoch: now };
	assert.equal((await call({ action: "search", source: "day_app" })).page?.records.length, 0);
	control.epoch = 0;
	const search = reader["search"].bind(reader);
	reader["search"] = async (...args) => {
		const result = await search(...args);
		control = { localDiagnostics: false, epoch: now };
		return result;
	};
	const raced = await call({ action: "search", source: "day_app" });
	assert.equal(raced.page?.status, "disabled");
	assert.deepEqual(raced.page?.records, [], "disable after disk read withholds already-formatted rows");
	reader["search"] = search;
	control = { localDiagnostics: true, epoch: 0 };
	await rename(paths[0]!, join(root, "old"));
	await write(paths[0]!, [dayRow]);
	assert.equal((await call({ action: "excerpt", ref })).excerpt?.status, "stale_ref");
	for (const path of paths) await rm(path);
	assert.equal((await call({ action: "search", source: "day_app" })).page?.status, "unavailable");
	const sentinel = join(home, "sentinel");
	await write(sentinel, [dayRow]);
	await symlink(sentinel, paths[0]!);
	assert.equal((await call({ action: "search", source: "day_app" })).page?.status, "unavailable");
	await rm(paths[0]!);
	await link(sentinel, paths[0]!);
	assert.equal((await call({ action: "search", source: "day_app" })).page?.status, "unavailable");
	await rm(paths[0]!);
	await writeFile(paths[0]!, "x".repeat(1048577), { mode: 0o600 });
	assert.equal((await call({ action: "search", source: "day_app" })).page?.status, "unavailable");
	const rowBytes = Buffer.from(`${JSON.stringify(dayRow)}\n`);
	await writeFile(
		paths[0]!,
		Buffer.concat([Buffer.alloc(1048576 - rowBytes.length - 1, 0x20), Buffer.from("\n"), rowBytes]),
		{ mode: 0o600 },
	);
	const bounded = (await call({ action: "search", source: "day_app" })).page!;
	assert.equal(bounded.status, "ok", "a 1 MiB private slot remains readable");
	assert.equal(bounded.records.length, 1);
	assert.ok(bounded.scannedBytes <= 128 * 1024);
	assert.ok(bounded.encodedBytes <= 64 * 1024);
	assert.equal(bounded.truncated, true);
	await write(paths[0]!, [dayRow]);
	await chmod(paths[0]!, 0o644);
	assert.equal((await call({ action: "search", source: "day_app" })).page?.status, "unavailable");
	await chmod(paths[0]!, 0o600);
	const handle = await open(paths[0]!);
	const prototype = Object.getPrototypeOf(handle);
	const original = prototype.stat;
	const mocked = t.mock.method(prototype, "stat", async function (this: typeof handle, options: unknown) {
		const stat = await original.call(this, options);
		stat.uid = typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1;
		return stat;
	});
	assert.equal((await call({ action: "search", source: "day_app" })).page?.status, "unavailable", "foreign owner");
	mocked.mock.restore();
	await handle.close();
	await chmod(root, 0o755);
	assert.equal((await call({ action: "search", source: "day_app" })).page?.status, "unavailable");
	assert.equal(await readFile(sentinel, "utf8"), `${JSON.stringify(dayRow)}\n`, "reader never mutates writer files");
});
