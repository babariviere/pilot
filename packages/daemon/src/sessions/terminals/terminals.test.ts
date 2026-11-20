import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPty, TerminalManager } from "./terminals.ts";

function collector() {
	let output = "";
	let exit: number | undefined;
	return {
		listener: {
			data: (data: string) => {
				output += data;
			},
			exit: (code: number) => {
				exit = code;
			},
		},
		get output() {
			return output;
		},
		get exit() {
			return exit;
		},
	};
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test("runs a shell, replays scrollback to late clients and reports exit", async () => {
	const manager = new TerminalManager(() => ({ file: "/bin/sh", args: [] }));
	try {
		const first = collector();
		const detach = manager.attach("s1", "/tmp", 80, 24, first.listener);
		assert.equal(manager.isRunning("s1"), true);
		assert.equal(manager.isRunning("missing"), false);
		manager.write("s1", "echo pilot-$((40+2))\r");
		await until(() => first.output.includes("pilot-42"));
		detach();
		assert.equal(manager.isRunning("s1"), true, "detached shells still prevent workspace cleanup");

		// A client attaching later (say, after an app restart) sees earlier output.
		const second = collector();
		manager.attach("s1", "/tmp", 100, 30, second.listener);
		assert.ok(second.output.includes("pilot-42"));

		manager.write("s1", "exit 3\r");
		await until(() => second.exit !== undefined);
		assert.equal(second.exit, 3);
		assert.equal(manager.isRunning("s1"), false);

		// Restart replaces the exited shell.
		const third = collector();
		manager.attach("s1", "/tmp", 80, 24, third.listener, true);
		manager.write("s1", "echo again\r");
		await until(() => third.output.includes("again"));
		assert.equal(third.exit, undefined);
	} finally {
		await manager.shutdown();
	}
});

test("closed and restarted shells remain live for cleanup guards until they actually exit", async () => {
	const manager = new TerminalManager(() => ({ file: "/bin/sh", args: [] }));
	try {
		const first = collector();
		manager.attach("s1", "/tmp", 80, 24, first.listener);
		manager.write("s1", "trap '' HUP; echo guard-$((40+2))\r");
		await until(() => first.output.includes("guard-42\r\n"));
		manager.close("s1");
		assert.equal(manager.isRunning("s1"), true, "close is a signal, not evidence of process exit");
		const second = collector();
		manager.attach("s1", "/tmp", 80, 24, second.listener);
		manager.write("s1", "exit\r");
		await until(() => second.exit !== undefined);
		assert.equal(
			manager.isRunning("s1"),
			first.exit === undefined,
			"the earlier shell remains tracked for its actual lifetime, including during forced shutdown",
		);
		await until(() => first.exit !== undefined);
		assert.equal(manager.isRunning("s1"), false);
	} finally {
		await manager.shutdown();
	}
});

test("workspace cwd is passed literally; reconnect/lost restart reply preserves the same instance", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pilot workspace '$() ; "));
	const manager = new TerminalManager(() => ({ file: "/bin/sh", args: [] }));
	try {
		const request = { bootId: manager.bootId, requestId: randomUUID() };
		const first = collector();
		const detach = manager.attach("s", cwd, 80, 24, first.listener, true, request);
		const id = manager.currentId("s")!;
		manager.write("s", "printf '__cwd__%s__end__\\n' \"$PWD\"\r", id);
		await until(() => first.output.includes(`__cwd__${cwd}__end__`));
		detach();
		const second = collector();
		const detachAgain = manager.attach("s", cwd, 80, 24, second.listener, true, request);
		assert.equal(manager.currentId("s"), id, "lost restart reply cannot restart twice");
		assert.ok(second.output.includes(`__cwd__${cwd}__end__`));
		detachAgain();
		for (let i = 0; i < 600; i++)
			manager.attach("s", cwd, 80, 24, collector().listener, false, {
				bootId: manager.bootId,
				requestId: randomUUID(),
				terminalId: id,
			})();
		for (let i = 0; i < 511; i++)
			manager.attach("s", cwd, 80, 24, collector().listener, false, {
				bootId: manager.bootId,
				requestId: randomUUID(),
			})();
		assert.throws(
			() =>
				manager.attach("s", cwd, 80, 24, collector().listener, true, {
					bootId: manager.bootId,
					requestId: randomUUID(),
				}),
			/request capacity/,
		);
		assert.equal(manager.currentId("s"), id, "receipt capacity refusal must happen before retiring the old shell");
		assert.throws(
			() =>
				manager.attach("s", cwd, 80, 24, collector().listener, false, {
					bootId: randomUUID(),
					requestId: randomUUID(),
				}),
			/daemon restarted/,
		);
		const release = manager.freezeAdmissions();
		assert.throws(() => manager.attach("s", cwd, 80, 24, collector().listener, true), /frozen/);
		assert.equal(manager.currentId("s"), id, "refused restart never kills the old shell");
		manager.attach("s", cwd, 80, 24, collector().listener, false, request)();
		assert.throws(() => manager.attach("new", cwd, 80, 24, collector().listener), /frozen/);
		manager.close("s", id);
		assert.equal(manager.blockers().length, 1, "close is not exit proof");
		await until(() => !manager.isRunning("s"));
		release();
		manager.attach("s", cwd, 80, 24, collector().listener, true)();
		assert.throws(() => manager.write("s", "stale input", id), /replaced/);
		assert.throws(() => manager.close("s", id), /replaced/);
	} finally {
		await manager.shutdown();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("native adapter validation failure remains tracked until the spawned PTY really exits", async (t) => {
	const pty = loadPty(),
		spawn = pty.spawn.bind(pty);
	const spawned = t.mock.method(pty, "spawn", (...args: Parameters<typeof pty.spawn>) => {
		const created = spawn(...args);
		(created as unknown as { _writeStream: { _writeQueue: unknown[] } })._writeStream._writeQueue.push({
			buffer: "invalid",
			offset: 0,
		});
		return created;
	});
	const manager = new TerminalManager(() => ({ file: "/bin/sh", args: [] }));
	try {
		const request = { bootId: manager.bootId, requestId: randomUUID() };
		assert.throws(() => manager.attach("broken", "/tmp", 80, 24, collector().listener, true, request), /adapter/);
		assert.throws(() => manager.attach("broken", "/tmp", 80, 24, collector().listener, true, request), /adapter/);
		assert.equal(spawned.mock.calls.length, 1, "failed adapter initialization does not repeat under the same key");
		assert.equal(manager.isRunning("broken"), true);
		assert.equal(manager.blockers().length, 1);
		await until(() => !manager.isRunning("broken"));
		assert.equal(manager.blockers().length, 0);
	} finally {
		await manager.shutdown();
	}
});

test("a lost restart acknowledgment reuses its receipt even with the original expected shell ID", async () => {
	const manager = new TerminalManager(() => ({ file: "/bin/sh", args: [] }));
	try {
		manager.attach("s", "/tmp", 80, 24, collector().listener)();
		const old = manager.currentId("s")!;
		const restart = { bootId: manager.bootId, requestId: randomUUID(), terminalId: old };
		manager.attach("s", "/tmp", 80, 24, collector().listener, true, restart)();
		const replacement = manager.currentId("s");
		assert.notEqual(replacement, old);
		manager.attach("s", "/tmp", 80, 24, collector().listener, true, restart)();
		assert.equal(manager.currentId("s"), replacement);
		assert.throws(
			() => manager.attach("s", "/tmp", 80, 24, collector().listener, true, { ...restart, requestId: randomUUID() }),
			/replaced/,
		);
		assert.equal(manager.currentId("s"), replacement);
	} finally {
		await manager.shutdown();
	}
});

test("live PTYs and listeners are bounded without retiring a shell on capacity refusal", async () => {
	const manager = new TerminalManager(() => ({ file: "/bin/sh", args: [] }));
	try {
		const detaches: (() => void)[] = [];
		for (let i = 0; i < 16; i++) detaches.push(manager.attach(`s${i}`, "/tmp", 80, 24, collector().listener));
		const original = manager.currentId("s0");
		assert.equal(manager.blockers().length, 16);
		assert.throws(() => manager.attach("overflow", "/tmp", 80, 24, collector().listener), /capacity/);
		assert.throws(() => manager.attach("s0", "/tmp", 80, 24, collector().listener, true), /capacity/);
		assert.equal(manager.currentId("s0"), original);
		for (let i = 0; i < 3; i++) detaches.push(manager.attach("s0", "/tmp", 80, 24, collector().listener));
		assert.throws(() => manager.attach("s0", "/tmp", 80, 24, collector().listener), /attachment capacity/);
		for (const detach of detaches) detach();
		assert.equal(manager.blockers().length, 16, "detaching every viewer does not release live PTYs");
	} finally {
		await manager.shutdown();
	}
});
