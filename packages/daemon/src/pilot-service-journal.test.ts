import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { DiagnosticLogReader } from "./diagnostic-logs.ts";
import {
	expectedPilotService,
	JOURNAL_BYTES,
	JOURNAL_TIMEOUT_MS,
	matchesPilotService,
	PilotServiceJournal,
	runPilotJournal,
} from "./pilot-service-journal.ts";

const uid = 1000,
	home = "/home/fixture",
	root = "/home/fixture/runtime";
const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pilotd.service\n";
const stamp = "2026-10-20T12:00:00.000Z";
function row(message: string, extra = {}) {
	return JSON.stringify({
		_UID: String(uid),
		_SYSTEMD_USER_UNIT: "pilotd.service",
		__REALTIME_TIMESTAMP: String(Date.parse(stamp) * 1000),
		MESSAGE: message,
		...extra,
	});
}

function childFixture(act: (out: PassThrough, err: PassThrough, close: (code: number) => void) => void) {
	let killed = 0;
	const commands: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
	const launch = ((file: string, args: readonly string[], options: unknown) => {
		commands.push({ file, args, options });
		const child = new EventEmitter() as ReturnType<typeof spawn>;
		const stdout = new PassThrough(),
			stderr = new PassThrough();
		Object.assign(child, {
			stdout,
			stderr,
			kill: () => {
				killed++;
				queueMicrotask(() => child.emit("close", null));
				return true;
			},
		});
		queueMicrotask(() => act(stdout, stderr, (code) => child.emit("close", code)));
		return child;
	}) as typeof spawn;
	return {
		launch,
		commands,
		get killed() {
			return killed;
		},
	};
}

test("service ownership matches installed renderer and exact user's Pilot cgroup, never other units", async () => {
	const renderer = await import(new URL("../../../scripts/linux/service.mjs", import.meta.url).href);
	for (const runtime of [root, `${root} % $ " odd`])
		assert.equal(expectedPilotService(runtime, home), renderer.serviceUnit(runtime, home));
	const unit = expectedPilotService(root, home);
	assert.equal(matchesPilotService(unit, cgroup, root, home, uid), true);
	for (const [text, group, owner] of [
		[unit.replace("StandardOutput=journal", "StandardOutput=null"), cgroup, uid],
		[unit, cgroup.replace("pilotd.service", "unrelated.service"), uid],
		[unit, cgroup, 2000],
		[unit, cgroup, 0],
		[`${unit}ExecStart=/bin/unrelated\n`, cgroup, uid],
	] as const)
		assert.equal(matchesPilotService(text, group, root, home, owner), false);
});

test("journal invocation is fixed, private-user/service filtered, sanitized and bounded", async () => {
	const f = childFixture((out, _err, close) => {
		out.write(
			[
				row("Error: retained restart"),
				row("password=private-canary"),
				row("payload: private-prompt"),
				row("unrelated-canary", { _SYSTEMD_USER_UNIT: "ssh.service" }),
				row("foreign-canary", { _UID: "2000" }),
				"malformed",
				"",
			].join("\n"),
		);
		close(0);
	});
	const result = await runPilotJournal(uid, home, undefined, f.launch);
	assert.equal(result.available, true);
	assert.match(result.text, /retained restart/);
	assert.doesNotMatch(result.text, /private-canary|private-prompt|unrelated-canary|foreign-canary/);
	assert.equal(result.truncated, true);
	assert.deepEqual(f.commands[0]?.args, [
		"--user",
		"--no-pager",
		"--output=json",
		"--output-fields=MESSAGE,_UID,_SYSTEMD_USER_UNIT,__REALTIME_TIMESTAMP",
		"--reverse",
		"--lines=256",
		"--since=-7days",
		"_UID=1000",
		"_SYSTEMD_USER_UNIT=pilotd.service",
	]);
	assert.equal(f.commands[0]?.file, "/usr/bin/journalctl");
	assert.equal((f.commands[0]!.options as { shell: boolean }).shell, false);
	assert.deepEqual(Object.keys((f.commands[0]!.options as { env: object }).env).sort(), [
		"HOME",
		"LANG",
		"LC_ALL",
		"PATH",
		"XDG_RUNTIME_DIR",
	]);
});

test("journal overflow, permissions, deadline and cancellation kill/settle owned reader without leakage", async () => {
	const overflow = childFixture((out) => out.write(Buffer.alloc(JOURNAL_BYTES + 1)));
	assert.equal((await runPilotJournal(uid, home, undefined, overflow.launch)).available, false);
	assert.equal(overflow.killed, 1);
	const denied = childFixture((_out, err, close) => {
		err.write("Permission denied private-path");
		close(1);
	});
	assert.deepEqual(await runPilotJournal(uid, home, undefined, denied.launch), {
		available: false,
		text: "",
		truncated: false,
		reason: "inaccessible",
	});
	const timeout = childFixture(() => {});
	const start = Date.now();
	assert.equal((await runPilotJournal(uid, home, undefined, timeout.launch)).available, false);
	assert.ok(Date.now() - start >= JOURNAL_TIMEOUT_MS - 50);
	assert.equal(timeout.killed, 1);
	const controller = new AbortController();
	const cancel = childFixture(() => controller.abort());
	await assert.rejects(runPilotJournal(uid, home, controller.signal, cancel.launch), /cancelled/);
	assert.equal(cancel.killed, 1);
	const before = childFixture(() => {});
	await assert.rejects(runPilotJournal(uid, home, controller.signal, before.launch), /cancelled/);
	assert.equal(before.commands.length, 0);
});

test("owned journal snapshots preserve paging across restarts, expire honestly and fall back without worker claims", async () => {
	let now = Date.parse(stamp),
		calls = 0;
	let owned = true;
	const journal = new PilotServiceJournal({
		home,
		root,
		dataHome: `${home}/.local/share/pilot`,
		uid,
		platform: "linux",
		now: () => now,
		owns: async () => owned,
		run: async () => {
			calls++;
			return { available: true, text: `[${stamp}] restart ${calls}\n[${stamp}] worker failure\n`, truncated: true };
		},
	});
	const reader = new DiagnosticLogReader({
		home: "/nonexistent-fixture",
		platform: "linux",
		serviceJournal: (signal) => journal.read(signal),
		daemonTail: () => ({ text: "ring-only\n", available: true, truncated: false }),
	});
	const host = { hostId: "daemon", daemonId: "one", lineageId: "two" };
	await reader.call(host, undefined, false, { action: "inventory" });
	assert.equal(calls, 0);
	const inventory = await reader.call(host, undefined, true, { action: "inventory" });
	assert.equal(inventory.sources?.find((s) => s.id === "kernel_worker")?.retention, "os_managed");
	const first = await reader.call(host, undefined, true, { action: "search", source: "daemon", limit: 1 });
	const second = await reader.call(host, undefined, true, {
		action: "search",
		source: "daemon",
		limit: 1,
		cursor: first.page!.nextCursor,
	});
	assert.match(second.page!.records[0]!.text, /restart 1/);
	assert.equal(calls, 1);
	now += 60_001;
	const stale = await reader.call(host, undefined, true, { action: "excerpt", ref: first.page!.records[0]!.ref });
	assert.equal(stale.excerpt?.status, "stale_ref");
	owned = false;
	now += 60_001;
	const fallback = await reader.call(host, undefined, true, { action: "inventory" });
	assert.equal(fallback.sources?.find((s) => s.id === "daemon")?.retention, "current_process");
	assert.equal(fallback.sources?.find((s) => s.id === "kernel_worker")?.availability, "unavailable");
	await assert.rejects(
		reader.call(host, undefined, true, { action: "search", source: "daemon", unit: "ssh.service" } as never),
		/Invalid/,
	);
	let unsupportedCalls = 0;
	const unsupported = new PilotServiceJournal({
		home,
		root,
		dataHome: home,
		platform: "darwin",
		run: async () => {
			unsupportedCalls++;
			throw new Error();
		},
	});
	assert.equal((await unsupported.read()).available, false);
	assert.equal(unsupportedCalls, 0);
});
