import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type UntrackedFile, UntrackedStats } from "./untracked-stats.ts";

const file = (path: string, binary: UntrackedFile["binary"] = "auto"): UntrackedFile => ({
	path,
	binary,
	bigFileThreshold: 512 * 1024 * 1024,
});

test("reader streams large files, skips binaries, and reuses unchanged metadata", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pilot-untracked-stats-"));
	const reader = new UntrackedStats();
	t.after(async () => {
		await reader.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	const text = `${"line\n".repeat(100_000)}last`;
	writeFileSync(join(cwd, "text"), text);
	writeFileSync(join(cwd, "binary"), Buffer.alloc(1024 * 1024));
	writeFileSync(join(cwd, "empty"), "");
	const files = [file("text"), file("binary"), file("empty")];
	assert.deepEqual(await reader.read(cwd, files), [
		{ additions: 100_001, deletions: 0 },
		{ additions: 0, deletions: 0 },
		{ additions: 0, deletions: 0 },
	]);
	const scanned = reader.bytesRead;
	assert.equal(scanned, Buffer.byteLength(text) + 64 * 1024, "binary inspection stops after its first buffer");
	await reader.read(cwd, files);
	assert.equal(reader.bytesRead, scanned, "unchanged polls only stat cached files");
	writeFileSync(join(cwd, "replacement"), "one\ntwo");
	renameSync(join(cwd, "replacement"), join(cwd, "text"));
	assert.deepEqual(await reader.read(cwd, [file("text")]), [{ additions: 2, deletions: 0 }]);
	assert.ok(reader.bytesRead > scanned);
	writeFileSync(join(cwd, "text"), "one\n");
	assert.deepEqual(await reader.read(cwd, [file("text")]), [{ additions: 1, deletions: 0 }]);
	await assert.rejects(reader.read(cwd, [file("missing")]), /ENOENT/);
	assert.deepEqual(
		await reader.read(cwd, [file("empty")]),
		[{ additions: 0, deletions: 0 }],
		"read errors do not poison the worker",
	);
});

test("reader preserves symlink text, binary overrides and the Git binary detection boundary", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pilot-untracked-modes-"));
	const reader = new UntrackedStats();
	t.after(async () => {
		await reader.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	symlinkSync("missing\nexternal-target", join(cwd, "link"));
	writeFileSync(join(cwd, "nul"), Buffer.from([97, 0, 10, 98]));
	writeFileSync(join(cwd, "late-nul"), `${"a".repeat(8000)}\0\nlast`);
	assert.deepEqual(
		await reader.read(cwd, [file("link", "binary"), file("nul"), file("nul", "text"), file("late-nul")]),
		[
			{ additions: 2, deletions: 0 },
			{ additions: 0, deletions: 0 },
			{ additions: 2, deletions: 0 },
			{ additions: 2, deletions: 0 },
		],
	);
	assert.deepEqual(await reader.read(cwd, [{ ...file("late-nul"), bigFileThreshold: 100 }]), [
		{ additions: 0, deletions: 0 },
	]);
});

test("reader bounds queued requests and releases/reopens its lifetime", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pilot-untracked-lifetime-"));
	const reader = new UntrackedStats(10);
	t.after(async () => {
		await reader.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	writeFileSync(join(cwd, "text"), "one\n");
	const requests = Array.from({ length: 16 }, () => reader.read(cwd, [file("text")]));
	await assert.rejects(reader.read(cwd, [file("text")]), /busy/);
	await Promise.all(requests);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const before = reader.bytesRead;
	await reader.read(cwd, [file("text")]);
	assert.equal(reader.bytesRead, before + 4, "idle reclamation releases cached files along with the worker");
	const pending = reader.read(cwd, [file("text")]);
	const rejected = assert.rejects(pending, /closed/);
	await reader.close();
	await rejected;
});
