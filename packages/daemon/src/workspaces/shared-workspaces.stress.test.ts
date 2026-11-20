import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SharedWorkspaceStore } from "./shared-workspaces.ts";
import type { Runner } from "./workspaces.ts";

test("large mixed build inspection yields and uses one ignored-file listing, not per-file Git probes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-mixed-build-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "build"));
	writeFileSync(join(root, "build/.gitkeep"), "");
	const ignored: string[] = [];
	for (let index = 0; index < 12_000; index++) {
		const path = `build/output-${index}.js`;
		ignored.push(path);
		writeFileSync(join(root, path), "generated\n");
	}
	const commands: string[][] = [];
	const runner: Runner = async (file, args) => {
		assert.equal(file, "git");
		commands.push(args);
		if (args.includes("--stage")) return `100644 ${"a".repeat(40)} 0\tbuild/.gitkeep\0`;
		if (args.includes("--ignored")) return `${ignored.join("\0")}\0`;
		throw new Error("Unexpected per-file probe");
	};
	let ticks = 0;
	let last = performance.now();
	let maxGap = 0;
	const heartbeat = () => {
		const now = performance.now();
		maxGap = Math.max(maxGap, now - last);
		last = now;
		ticks++;
		pending = setImmediate(heartbeat);
	};
	let pending = setImmediate(heartbeat);
	const started = performance.now();
	try {
		const store = new SharedWorkspaceStore(root, runner);
		// biome-ignore lint/complexity/useLiteralKeys: Isolate traversal from repository setup and subprocess latency.
		assert.deepEqual(await store["inspect"](root, false), {});
		assert.equal(commands.length, 2);
		assert.ok(ticks >= 5, `Daemon callbacks get repeated turns during traversal (${ticks})`);
		t.diagnostic(
			`12,000 ignored outputs: ${(performance.now() - started).toFixed(1)}ms, max callback gap ${maxGap.toFixed(1)}ms`,
		);
	} finally {
		clearImmediate(pending);
	}
});
