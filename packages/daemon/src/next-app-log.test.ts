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
import type { DiagnosticLogRequest } from "@pilot/kernel";
import { DiagnosticLogReader } from "./diagnostic-logs.ts";
import { nativeAppLogLine } from "./native-app-log.ts";
import { nextAppLogLine } from "./next-app-log.ts";

const now = 1793361600;
const host = {
	hostId: "daemon",
	daemonId: "01234567-89ab-4cde-8fab-0123456789ab",
	lineageId: "abcdef01-2345-4678-9abc-0123456789ab",
};
export const nextRow = {
	schema: 2,
	epoch: 0,
	host,
	build: { version: "1.99.0", desktop_source_sha256: "a".repeat(64) },
	run: "12345678-1234-4678-9abc-123456789abc",
	seconds: now,
	operation: "deliveryRequest",
	request: 2,
	stage: "execute",
	outcome: "refused",
	response_received: false,
	status: 503,
	elapsed_ms: 120,
	loss: { dropped: 3, storage_errors: 1 },
};

test("Next v2 closed producer contract is separate from Swift and never proves delivery", () => {
	assert.match(nextAppLogLine(JSON.stringify(nextRow), host, now * 1000).text!, /refused/);
	assert.equal(nativeAppLogLine(JSON.stringify(nextRow), host, now * 1000), undefined);
	const success = nextAppLogLine(
		JSON.stringify({ ...nextRow, outcome: null, response_received: true, status: 200 }),
		host,
		now * 1000,
	);
	assert.match(success.text!, /response_received/);
	assert.doesNotMatch(success.text!, /accepted|delivered|durable/);
	for (const patch of [
		{ schema: 3 },
		{ text: "password=canary" },
		{ sessionId: host.daemonId },
		{ build: { ...nextRow.build, version: "1..2" } },
		{ build: { ...nextRow.build, desktop_source_sha256: "Z".repeat(64) } },
		{ run: "private" },
		{ request: -1 },
		{ elapsed_ms: Number.MAX_SAFE_INTEGER + 1 },
		{ status: 600 },
		{ outcome: "private" },
		{ stage: "private" },
		{ loss: { dropped: 1, storage_errors: 0, body: "private" } },
		{ host: { ...host, path: "private" } },
	])
		assert.equal(
			nextAppLogLine(JSON.stringify({ ...nextRow, ...patch }), host, now * 1000).text,
			undefined,
			JSON.stringify(patch),
		);
	for (const raw of ["null", "{", "x".repeat(4097), JSON.stringify(nextRow).replace('"request":2', '"request":2.0')])
		assert.equal(nextAppLogLine(raw, host, now * 1000).text, undefined);
	for (const [patch, omission] of [
		[{ schema: undefined }, "legacy"],
		[{ host: null }, "unbound"],
		[{ host: { ...host, lineageId: host.daemonId } }, "identity"],
		[{ seconds: now - 7 * 86400 - 1 }, "expired"],
		[{ seconds: now + 1 }, "future"],
	] as const)
		assert.equal(nextAppLogLine(JSON.stringify({ ...nextRow, ...patch }), host, now * 1000).omission, omission);
	assert.equal(nextAppLogLine(JSON.stringify(nextRow), host, now * 1000, now).omission, "cleared");
	assert.equal(
		nextAppLogLine(JSON.stringify({ ...nextRow, seconds: now + 100 }), host, (now + 200) * 1000, 1).omission,
		"cleared",
		"pre-clear future-clock rows never reappear when time catches up",
	);
	assert.ok(
		nextAppLogLine(JSON.stringify({ ...nextRow, epoch: 1 }), host, now * 1000, 1).text,
		"same-second post-clear rows remain readable",
	);
});

test("fixed Next slots search/excerpt, omission accounting, settings, rotation and unsafe sources", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "next-app-logs-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	const root = join(home, "diagnostics");
	await mkdir(root, { mode: 0o700 });
	const paths = [0, 1, 2].map((n) => join(root, `events-${n}.jsonl`));
	const write = (path: string, rows: unknown[]) =>
		writeFile(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
	await write(paths[0]!, [{ ...nextRow, host: null }, { ...nextRow, text: "secret-canary" }, nextRow]);
	await write(paths[1]!, [{ ...nextRow, stage: "lookup" }]);
	await write(paths[2]!, [{ ...nextRow, seconds: now - 8 * 86400 }]);
	await writeFile(join(root, "capture.lock"), "secret-lock");
	await writeFile(join(root, "reviewed.json"), "secret-export");
	let control: { localDiagnostics: boolean; epoch: number } | undefined = {
		localDiagnostics: true,
		epoch: 0,
	};
	const reader = new DiagnosticLogReader({
		home,
		nextAppRoot: root,
		nextAppControl: () => control,
		platform: "darwin",
		now: () => new Date(now * 1000),
	});
	const call = (request: DiagnosticLogRequest, allowed = true) =>
		reader.call(host, undefined, true, request, undefined, allowed);
	const inventory = await call({ action: "inventory" });
	assert.equal(inventory.sources?.find((s) => s.id === "next_app")?.availableFiles, 3);
	const page = (await call({ action: "search", source: "next_app", limit: 40 })).page!;
	assert.equal(page.records.length, 2);
	assert.deepEqual(page.omissions, { unbound: 1, invalid: 1, expired: 1 });
	assert.equal(page.truncated, true);
	assert.match(page.reason!, /not.*delivery|not.*acceptance/i);
	assert.ok(page.scannedBytes <= 128 * 1024);
	assert.ok(page.encodedBytes <= 64 * 1024);
	assert.doesNotMatch(JSON.stringify(page), /secret|capture.lock|reviewed.json/);
	const ref = page.records[0]!.ref;
	assert.equal((await call({ action: "excerpt", ref })).excerpt?.status, "ok");
	assert.equal((await call({ action: "search", source: "next_app", q: "lookup" })).page?.records.length, 1);
	assert.equal((await call({ action: "search", source: "app" })).page?.records.length, 0);
	assert.equal((await call({ action: "search", source: "next_app" }, false)).page?.status, "unavailable");
	control = undefined;
	assert.equal((await call({ action: "search", source: "next_app" })).page?.status, "unavailable");
	control = { localDiagnostics: false, epoch: 0 };
	assert.equal((await call({ action: "search", source: "next_app" })).page?.status, "disabled");
	control = { localDiagnostics: true, epoch: now };
	assert.equal((await call({ action: "search", source: "next_app" })).page?.records.length, 0);
	control.epoch = 0;
	const search = reader["search"].bind(reader);
	reader["search"] = async (...args) => {
		const result = await search(...args);
		control = { localDiagnostics: false, epoch: now };
		return result;
	};
	const raced = await call({ action: "search", source: "next_app" });
	assert.equal(raced.page?.status, "disabled");
	assert.deepEqual(raced.page?.records, [], "disable after disk read withholds already-formatted rows");
	reader["search"] = search;
	control = { localDiagnostics: true, epoch: 0 };
	await rename(paths[0]!, join(root, "old"));
	await write(paths[0]!, [nextRow]);
	assert.equal((await call({ action: "excerpt", ref })).excerpt?.status, "stale_ref");
	for (const path of paths) await rm(path);
	assert.equal((await call({ action: "search", source: "next_app" })).page?.status, "unavailable");
	const sentinel = join(home, "sentinel");
	await write(sentinel, [nextRow]);
	await symlink(sentinel, paths[0]!);
	assert.equal((await call({ action: "search", source: "next_app" })).page?.status, "unavailable");
	await rm(paths[0]!);
	await link(sentinel, paths[0]!);
	assert.equal((await call({ action: "search", source: "next_app" })).page?.status, "unavailable");
	await rm(paths[0]!);
	await writeFile(paths[0]!, "x".repeat(65537), { mode: 0o600 });
	assert.equal((await call({ action: "search", source: "next_app" })).page?.status, "unavailable");
	await write(paths[0]!, [nextRow]);
	await chmod(paths[0]!, 0o644);
	assert.equal((await call({ action: "search", source: "next_app" })).page?.status, "unavailable");
	await chmod(paths[0]!, 0o600);
	const handle = await open(paths[0]!);
	const prototype = Object.getPrototypeOf(handle);
	const original = prototype.stat;
	const mocked = t.mock.method(prototype, "stat", async function (this: typeof handle, options: unknown) {
		const stat = await original.call(this, options);
		stat.uid = typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1;
		return stat;
	});
	assert.equal((await call({ action: "search", source: "next_app" })).page?.status, "unavailable", "foreign owner");
	mocked.mock.restore();
	await handle.close();
	await chmod(root, 0o755);
	assert.equal((await call({ action: "search", source: "next_app" })).page?.status, "unavailable");
	assert.equal(await readFile(sentinel, "utf8"), `${JSON.stringify(nextRow)}\n`, "reader never mutates writer files");
});
