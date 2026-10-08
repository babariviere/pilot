import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalManager } from "./terminals.ts";

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
