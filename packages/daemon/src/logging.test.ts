import assert from "node:assert/strict";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { test } from "node:test";
import { timestampConsole } from "./logging.ts";

test("daemon logs timestamp every line, preserve formatting and route warnings to stderr", () => {
	const out: string[] = [];
	const err: string[] = [];
	const stream = (lines: string[]) =>
		new Writable({
			write(chunk, _encoding, done) {
				lines.push(chunk.toString());
				done();
			},
		});
	const logger = new Console({ stdout: stream(out), stderr: stream(err), colorMode: false });
	let now = new Date("2026-01-01T12:00:00.000Z");
	timestampConsole(logger, () => now);
	logger.log("pilotd: %s %d", "ready", 2);
	logger.info("second\nline");
	logger.debug({ ok: true });
	now = new Date("2026-01-01T12:01:00.000Z");
	logger.warn("warning");
	logger.error(new Error("failure"));
	assert.deepEqual(out, [
		"[2026-01-01T12:00:00.000Z] pilotd: ready 2\n",
		"[2026-01-01T12:00:00.000Z] second\n[2026-01-01T12:00:00.000Z] line\n",
		"[2026-01-01T12:00:00.000Z] { ok: true }\n",
	]);
	assert.equal(err[0], "[2026-01-01T12:01:00.000Z] warning\n");
	assert.match(err[1]!, /^\[2026-01-01T12:01:00.000Z\] Error: failure\n/);
	assert.ok(
		err[1]!
			.trimEnd()
			.split("\n")
			.every((line) => line.startsWith("[2026-01-01T12:01:00.000Z] ")),
	);
});
