import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativeDiagnosticsStore, parseNativeDiagnostics } from "./native-diagnostics.ts";

const crash = {
	ref: "diagnostic:v1:native:0123456789abcdef01234567",
	source: "os",
	at: "2026-10-17T08:00:00.000Z",
	kind: "native.crash",
	reason: "process_exit",
	windowMs: 86_400_000,
	releaseRelation: "current",
} as const;
const hang = {
	ref: "diagnostic:v1:native:89abcdef0123456789abcdef",
	source: "os",
	at: "2026-10-17T08:01:00.000Z",
	kind: "native.hang",
	reason: "unresponsive",
	windowMs: 86_400_000,
	releaseRelation: "other_or_unknown",
	durationMs: 5_000,
} as const;
const setup = {
	ref: "diagnostic:v1:setup:abcdef0123456789abcdef01",
	attemptRef: "diagnostic:v1:setup-attempt:0123456789abcdef01234567",
	sequence: 3,
	source: "app",
	at: "2026-10-17T08:02:00.000Z",
	kind: "devbox.setup",
	stage: "ssh_transport",
	outcome: "failed",
	reason: "ssh_timeout",
} as const;

test("native diagnostic batches accept only the closed content-free schema", () => {
	assert.deepEqual(parseNativeDiagnostics({ schemaVersion: 1, evidence: [crash, hang], dropped: 2 }).evidence, [
		crash,
		hang,
	]);
	assert.deepEqual(parseNativeDiagnostics({ schemaVersion: 1, evidence: [setup], dropped: 0 }).evidence, [setup]);
	for (const value of [
		{ schemaVersion: 1, evidence: [{ ...crash, path: "/private/source" }], dropped: 0 },
		{ schemaVersion: 1, evidence: [{ ...crash, stack: "secret stack" }], dropped: 0 },
		{ schemaVersion: 1, evidence: [{ ...hang, durationMs: Number.POSITIVE_INFINITY }], dropped: 0 },
		{ schemaVersion: 1, evidence: [{ ...hang, reason: "raw watchdog reason" }], dropped: 0 },
		{ schemaVersion: 1, evidence: [crash, crash], dropped: 0 },
		{ schemaVersion: 1, evidence: [{ ...setup, alias: "private-box" }], dropped: 0 },
		{ schemaVersion: 1, evidence: [{ ...setup, outcome: "succeeded" }], dropped: 0 },
		{ schemaVersion: 1, evidence: [{ ...setup, reason: "raw ssh output" }], dropped: 0 },
		{ schemaVersion: 1, evidence: [{ ...setup, attemptRef: "private-box" }], dropped: 0 },
		{ schemaVersion: 1, evidence: [{ ...setup, sequence: 32 }], dropped: 0 },
		{
			schemaVersion: 1,
			evidence: [setup, { ...setup, ref: "diagnostic:v1:setup:abcdef0123456789abcdef02" }],
			dropped: 0,
		},
	])
		assert.throws(() => parseNativeDiagnostics(value));
});

test("native diagnostic replacement is private, bounded and respects disabled collection", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-diagnostics-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new NativeDiagnosticsStore(home);
	await store.replace({ schemaVersion: 1, evidence: [crash, hang], dropped: 0 });
	assert.equal((await stat(store.file)).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(await readFile(store.file, "utf8")).evidence, [crash, hang]);
	store.setEnabled(false);
	await store.replace({ schemaVersion: 1, evidence: [], dropped: 0 });
	assert.equal(JSON.parse(await readFile(store.file, "utf8")).evidence.length, 2);
	await store.clear();
	await assert.rejects(readFile(store.file));
});

test("a rejected replacement never overwrites retained native evidence", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-diagnostics-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new NativeDiagnosticsStore(home);
	await writeFile(store.file, JSON.stringify({ schemaVersion: 1, evidence: [crash], dropped: 0 }));
	await assert.rejects(store.replace({ schemaVersion: 1, evidence: [{ ...crash, message: "private" }], dropped: 0 }));
	assert.deepEqual(JSON.parse(await readFile(store.file, "utf8")).evidence, [crash]);
});
