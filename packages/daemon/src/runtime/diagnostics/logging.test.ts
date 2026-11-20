import assert from "node:assert/strict";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { test } from "node:test";
import { daemonLogTail, timestampConsole } from "./logging.ts";

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

test("current-process diagnostic log ring is redacted before retention and bounded by bytes and records", () => {
	const discard = (..._args: unknown[]) => {};
	const logger = { log: discard, info: discard, warn: discard, error: discard, debug: discard };
	timestampConsole(logger, () => new Date("2026-01-01T12:00:00.000Z"));
	logger.log("old-marker");
	for (let i = 0; i < 600; i++) logger.log(`record ${i} ${"ordinary words ".repeat(30)}`);
	logger.warn("Authorization: Bearer ring-secret");
	logger.error("-----BEGIN PRIVATE KEY-----\nshort-secret\n-----END PRIVATE KEY-----");
	const snapshot = daemonLogTail();
	assert.ok(Buffer.byteLength(snapshot.text) <= 64 * 1024);
	assert.ok(snapshot.text.split("\n").length <= 513);
	assert.equal(snapshot.truncated, true);
	assert.doesNotMatch(snapshot.text, /old-marker|ring-secret|short-secret/);
	assert.match(snapshot.text, /REDACTED/);
});
