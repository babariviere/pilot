import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ModelScopeConflictError, modelScopeHash, modelScopeUpdate, writeModelScope } from "./model-scope.ts";

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

test("CAS detects external scope edits but ignores unrelated edits and whitespace changes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-scope-cas-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	const expectedHash = modelScopeHash(["initial"]);
	await writeFile(path, JSON.stringify({ enabledModels: ["external"], theme: "keep" }));
	const before = await readFile(path, "utf8");
	await assert.rejects(writeModelScope(root, { enabledModels: ["new"], expectedHash }), (error: unknown) => {
		assert.ok(error instanceof ModelScopeConflictError);
		assert.deepEqual(error.conflict, { currentHash: modelScopeHash(["external"]), current: ["external"] });
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
	await writeModelScope(agent, { enabledModels: [], expectedHash: modelScopeHash(null) });
	assert.deepEqual(JSON.parse(await readFile(join(agent, "settings.json"), "utf8")), { enabledModels: [] });
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
	await assert.rejects(writeModelScope(root, { enabledModels: [], expectedHash: modelScopeHash(null) }), {
		message: "Cannot edit malformed global settings",
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
		await assert.rejects(writeModelScope(root, { enabledModels: [], expectedHash: modelScopeHash(["external"]) }), {
			code: "ELOCKED",
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
		message: "Settings write lock was lost",
	});
	assert.equal(await readFile(path, "utf8"), before);
	assert.deepEqual(await readdir(root), ["settings.json"]);
});

test("scope update validation bounds patterns and rejects missing fields and non-string values", () => {
	const hash = modelScopeHash(null);
	for (const enabledModels of [undefined, "*", [null], [""], ["\n"], ["x".repeat(513)], Array(257).fill("*")]) {
		assert.throws(() => modelScopeUpdate({ enabledModels, expectedHash: hash }));
	}
	assert.throws(() => modelScopeUpdate({ expectedHash: hash }));
	assert.throws(() => modelScopeUpdate({ enabledModels: null, expectedHash: "bad" }));
	assert.throws(() => modelScopeUpdate({ enabledModels: null, expectedHash: hash, extra: true }));
	assert.deepEqual(modelScopeUpdate({ enabledModels: ["unknown/*"], expectedHash: hash }), {
		enabledModels: ["unknown/*"],
		expectedHash: hash,
	});
});
