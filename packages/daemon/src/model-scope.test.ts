import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	ModelScopeConflictError,
	ModelScopeSettingsError,
	modelScopeHash,
	modelScopeUpdate,
	readModelScopeValue,
	writeModelScope,
} from "./model-scope.ts";

const lockfile = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("proper-lockfile") as {
	lock(
		path: string,
		options: { realpath: false; onCompromised?: (error: Error) => void },
	): Promise<() => Promise<void>>;
};

test("scope CAS changes only enabledModels, preserving BOM, unrelated bytes, values and file mode", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	const before =
		'\uFEFF{\r\n\t"defaultModel" : "keep", "enabledModels" : [ "old" ],\r\n "other": {"escaped": "}:,\\"", "enabledModels": ["nested"], "precise": 1234567890123456789}, "theme": "dark"\r\n}\r\n';
	await writeFile(path, before, { mode: 0o640 });
	const patterns = ["test/*:high", "absent/not-installed"];
	await writeModelScope(root, { enabledModels: patterns, expectedHash: modelScopeHash(["old"]) });
	assert.equal(await readFile(path, "utf8"), before.replace('[ "old" ]', JSON.stringify(patterns)));
	assert.equal((await stat(path)).mode & 0o777, 0o640);
	assert.deepEqual(await readdir(root), ["settings.json"]);
});

test("dangling settings symlinks are unreadable, not an absent-value retry or a replaceable file", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-dangling-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	await symlink(join(root, "missing-target.json"), path);
	await assert.rejects(readModelScopeValue(path), { message: "settings unreadable", status: 503 });
	await assert.rejects(writeModelScope(root, { enabledModels: null, expectedHash: "stale" }), { status: 503 });
	await assert.rejects(writeModelScope(root, { enabledModels: ["test/*"], expectedHash: modelScopeHash(null) }), {
		status: 503,
	});
	assert.deepEqual(await readdir(root), ["settings.json"]);
});

test("CAS detects external scope edits but ignores unrelated edits and whitespace changes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-cas-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	const expectedHash = modelScopeHash(["initial"]);
	await writeFile(path, JSON.stringify({ enabledModels: ["external"], theme: "keep" }));
	const before = await readFile(path, "utf8");
	await assert.rejects(writeModelScope(root, { enabledModels: ["new"], expectedHash }), (error: unknown) => {
		assert.ok(error instanceof ModelScopeConflictError);
		assert.deepEqual(error.conflict, {
			error: "scope_conflict",
			scopeHash: modelScopeHash(["external"]),
			enabledModels: ["external"],
		});
		return true;
	});
	assert.equal(await readFile(path, "utf8"), before);
	await writeFile(path, '{ "enabledModels": [ "initial" ], "theme": "externally-edited" }');
	await writeModelScope(root, { enabledModels: ["new"], expectedHash });
	assert.equal(JSON.parse(await readFile(path, "utf8")).theme, "externally-edited");
});

test("null removes only the global key; missing files, empty scopes, duplicate and escaped keys stay valid", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-null-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agent = join(root, "agent");
	await writeModelScope(agent, { enabledModels: null, expectedHash: modelScopeHash(null) });
	await assert.rejects(stat(join(agent, "settings.json")), { code: "ENOENT" });
	await writeModelScope(agent, { enabledModels: ["test/*"], expectedHash: modelScopeHash(null) });
	assert.deepEqual(JSON.parse(await readFile(join(agent, "settings.json"), "utf8")), { enabledModels: ["test/*"] });
	for (const text of [
		'{"enabledModels":["a"],"enabledModels":["b"],"x":true}',
		'{"x":true,"enabledModels":["a"],"enabledModels":["b"]}',
		'{"enabledModels":["a"],"enabledModels":["b"]}',
		'{"enabled\\u004dodels":["b"]}',
	]) {
		const path = join(agent, "settings.json");
		await writeFile(path, text);
		await writeModelScope(agent, { enabledModels: ["new"], expectedHash: modelScopeHash(["b"]) });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")).enabledModels, ["new"]);
		await writeModelScope(agent, { enabledModels: null, expectedHash: modelScopeHash(["new"]) });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), text.includes('"x"') ? { x: true } : {});
	}
});

test("malformed settings are not overwritten or echoed, and existing settings symlinks retain their target", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-safe-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	await writeFile(path, '{"secret": "private value", broken');
	await assert.rejects(writeModelScope(root, { enabledModels: null, expectedHash: modelScopeHash(null) }), {
		message: "settings unreadable",
		status: 422,
	});
	assert.equal(await readFile(path, "utf8"), '{"secret": "private value", broken');
	await rm(path);
	const target = join(root, "managed.json");
	await writeFile(target, '{"theme":"keep"}');
	await symlink(target, path);
	await writeModelScope(root, { enabledModels: ["test/*"], expectedHash: modelScopeHash(null) });
	assert.equal(await readFile(path, "utf8"), await readFile(target, "utf8"));
	assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { theme: "keep", enabledModels: ["test/*"] });
});

test("write lock contention yields timers, observes edits under the SDK lock, and fails closed when exhausted", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	await writeFile(path, "{}");
	let release = await lockfile.lock(path, { realpath: false });
	try {
		const pending = writeModelScope(root, { enabledModels: ["new"], expectedHash: modelScopeHash(null) });
		assert.equal(await Promise.race([pending.then(() => "write"), delay(0).then(() => "timer")]), "timer");
		await writeFile(path, '{"enabledModels":["external"]}');
		await release();
		await assert.rejects(pending, ModelScopeConflictError);
		release = await lockfile.lock(path, { realpath: false });
		await assert.rejects(writeModelScope(root, { enabledModels: null, expectedHash: modelScopeHash(["external"]) }), {
			message: "settings unreadable",
			status: 503,
		});
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabledModels: ["external"] });
	} finally {
		await release().catch(() => undefined);
	}
});

test("simultaneous CAS writes have one winner, including the first write to missing settings", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-concurrent-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const updates = await Promise.allSettled(
		["a", "b"].map((pattern) =>
			writeModelScope(root, { enabledModels: [pattern], expectedHash: modelScopeHash(null) }),
		),
	);
	assert.equal(updates.filter((entry) => entry.status === "fulfilled").length, 1);
	const rejected = updates.find((entry) => entry.status === "rejected");
	assert.ok(rejected?.reason instanceof ModelScopeConflictError);
});

test("losing the SDK write lock fails closed before atomic replacement and cleans temporary files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-compromised-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	const before = '{"enabledModels":["before"],"theme":"keep"}';
	await writeFile(path, before);
	const acquire = lockfile.lock.bind(lockfile);
	t.mock.method(lockfile, "lock", async (path: string, options: Parameters<typeof acquire>[1]) => {
		const release = await acquire(path, options);
		options.onCompromised?.(new Error("synthetic lock loss"));
		return release;
	});
	await assert.rejects(writeModelScope(root, { enabledModels: ["after"], expectedHash: modelScopeHash(["before"]) }), {
		message: "settings unreadable",
		status: 503,
	});
	assert.equal(await readFile(path, "utf8"), before);
	assert.deepEqual(await readdir(root), ["settings.json"]);
});

test("scope update validation bounds patterns and rejects missing fields and non-string values", () => {
	const hash = modelScopeHash(null);
	for (const enabledModels of [
		undefined,
		[],
		"*",
		[null],
		[""],
		["\n"],
		["x".repeat(257)],
		["é".repeat(129)],
		Array(257).fill("*"),
	]) {
		assert.throws(() => modelScopeUpdate({ enabledModels, expectedHash: hash }));
	}
	assert.throws(() => modelScopeUpdate({ expectedHash: hash }));
	assert.throws(() => modelScopeUpdate({ enabledModels: null, expectedHash: 1 }));
	assert.deepEqual(modelScopeUpdate({ enabledModels: ["é".repeat(128)], expectedHash: hash }).enabledModels, [
		"é".repeat(128),
	]);
	assert.throws(() => modelScopeUpdate({ enabledModels: null, expectedHash: hash, extra: true }));
	assert.deepEqual(modelScopeUpdate({ enabledModels: ["unknown/*"], expectedHash: hash }), {
		enabledModels: ["unknown/*"],
		expectedHash: hash,
	});
});

test("canonical hashes distinguish absent from [] and preserve array order, duplicate patterns and suffix text", () => {
	assert.equal(modelScopeHash(null), "15dbb2c4361b809a46b847b3b6c071f3c27c096057d31c45351902b79fe39efd");
	assert.equal(modelScopeHash([]), "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
	assert.equal(
		modelScopeHash(["test/*:high", "raw:model", "test/*:high"]),
		"a60d0cf0df065da33bca087f16e86cd0deb79eeae9b7d0004683aeda2fb735aa",
	);
	assert.notEqual(modelScopeHash(["a", "b"]), modelScopeHash(["b", "a"]));
});

test("lost-ack retries are value-idempotent before CAS, without rewriting files or normalizing patterns", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-retry-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	assert.deepEqual(await writeModelScope(root, { enabledModels: null, expectedHash: "stale" }), {
		changed: false,
		scopeHash: modelScopeHash(null),
	});
	await assert.rejects(stat(path), { code: "ENOENT" });
	const desired = ["test/SMALL:high", "absent/no-match", "test/SMALL:high"];
	assert.deepEqual(await writeModelScope(root, { enabledModels: desired, expectedHash: modelScopeHash(null) }), {
		changed: true,
		scopeHash: modelScopeHash(desired),
	});
	const text = await readFile(path, "utf8");
	const before = await stat(path);
	assert.deepEqual(await writeModelScope(root, { enabledModels: desired, expectedHash: modelScopeHash(null) }), {
		changed: false,
		scopeHash: modelScopeHash(desired),
	});
	assert.equal((await stat(path)).ino, before.ino);
	assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
	assert.equal(await readFile(path, "utf8"), text);
	assert.deepEqual(JSON.parse(text).enabledModels, desired);
	await assert.rejects(
		writeModelScope(root, { enabledModels: [...desired].reverse().slice(1), expectedHash: "stale" }),
		ModelScopeConflictError,
	);
});

test("raw scope reads distinguish absence from invalid settings and never broaden scope on lock exhaustion", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-read-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	assert.equal(await readModelScopeValue(path), null);
	const firstWriteLock = await lockfile.lock(path, { realpath: false });
	try {
		await assert.rejects(readModelScopeValue(path), { status: 503 });
		await assert.rejects(writeModelScope(root, { enabledModels: null, expectedHash: "stale" }), { status: 503 });
	} finally {
		await firstWriteLock();
	}
	await writeFile(path, '{"theme":"keep"}');
	assert.equal(await readModelScopeValue(path), null);
	await writeFile(path, '{"enabledModels":[]}');
	assert.deepEqual(await readModelScopeValue(path), []);
	const release = await lockfile.lock(path, { realpath: false });
	try {
		await assert.rejects(readModelScopeValue(path), { message: "settings unreadable", status: 503 });
	} finally {
		await release();
	}
	for (const value of [
		'{"secret":"private",broken',
		"null",
		"[]",
		'{"enabledModels":null}',
		'{"enabledModels":[1]}',
	]) {
		await writeFile(path, value);
		await assert.rejects(readModelScopeValue(path), ModelScopeSettingsError);
		await assert.rejects(writeModelScope(root, { enabledModels: null, expectedHash: modelScopeHash(null) }), {
			status: 422,
		});
		assert.equal(await readFile(path, "utf8"), value);
	}
});
