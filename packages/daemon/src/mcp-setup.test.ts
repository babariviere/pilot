import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { McpSetupError, McpSetupStore } from "./mcp-setup.ts";

async function fixture(t: TestContext, options: ConstructorParameters<typeof McpSetupStore>[1] = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pilot-mcp-setup-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return { directory, store: new McpSetupStore(directory, { path: directory, ...options }) };
}
const entry = (name = "example") => ({ name, config: { url: "https://example.test/mcp" } });

test("MCP setup publishes privately, reads back exactly, and resolves lost acknowledgments without writes", async (t) => {
	const { directory, store } = await fixture(t);
	const before = await store.read();
	assert.equal(before.exists, false);
	const input = { expectedRevision: before.revision, entries: [entry()] };
	const after = await store.apply(input);
	assert.equal(after.exists, true);
	assert.deepEqual(after.entries, [entry()]);
	assert.equal(after.writeMode, "additive");
	const path = join(directory, "mcp.json"),
		metadata = await stat(path);
	assert.equal(metadata.mode & 0o777, 0o600);
	assert.deepEqual(await store.apply(input), after);
	assert.equal((await stat(path)).ino, metadata.ino);
	assert.deepEqual(await readdir(directory), ["mcp.json"]);
});

test("MCP setup adds to existing config and preserves unsupported entries, headers and unknown root values locally", async (t) => {
	const { directory, store } = await fixture(t);
	const original =
		'{"future": {"order":2,"auth":"private-root-value"}, "mcpServers": {"other":{"url":"https://example.test/mcp","headers":{"Authorization":"private-token"}}}}\n';
	await writeFile(join(directory, "mcp.json"), original);
	const snapshot = await store.read();
	assert.ok(snapshot.entries[0]?.blocked);
	assert.equal(JSON.stringify(snapshot).includes("private-"), false);
	const after = await store.apply({ expectedRevision: snapshot.revision, entries: [entry()] });
	assert.deepEqual(
		after.entries.find((row) => row.name === "example"),
		entry(),
	);
	assert.equal(JSON.stringify(after).includes("private-"), false);
	const expected = JSON.parse(original);
	expected.mcpServers.example = entry().config;
	assert.deepEqual(JSON.parse(await readFile(join(directory, "mcp.json"), "utf8")), expected);
	assert.equal((await stat(join(directory, "mcp.json"))).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(directory), ["mcp.json"]);
});

test("MCP setup refuses same-name replacements and namespace aliases atomically, even in mixed batches", async (t) => {
	const { directory, store } = await fixture(t);
	for (const name of ["same-name", "same_name"]) {
		const original = JSON.stringify({
			mcpServers: { [name]: { url: "https://other.test/mcp", future: "private-value" } },
		});
		await writeFile(join(directory, "mcp.json"), original);
		const before = await store.read();
		await assert.rejects(
			store.apply({ expectedRevision: before.revision, entries: [entry("missing"), entry("same-name")] }),
			(error: unknown) => error instanceof McpSetupError && error.code === "mcp_setup_name_conflict",
		);
		assert.equal(await readFile(join(directory, "mcp.json"), "utf8"), original);
	}
});

test("MCP setup rechecks target edits and replacements after preparing bytes, without overwriting them", async (t) => {
	let path = "";
	const external = '{"mcpServers":{"external":{"command":"private-command"}}}';
	const { directory, store } = await fixture(t, {
		beforeCommit: async () => {
			await writeFile(path, external);
		},
	});
	path = join(directory, "mcp.json");
	await writeFile(path, '{"mcpServers":{}}');
	const before = await store.read();
	await assert.rejects(
		store.apply({ expectedRevision: before.revision, entries: [entry()] }),
		(error: unknown) => error instanceof McpSetupError && error.status === 409,
	);
	assert.equal(await readFile(path, "utf8"), external);
	assert.deepEqual(await readdir(directory), ["mcp.json"]);
});

type SdkConfig = {
	addMcpServerConfig(path: string, name: string, config: { url: string }): boolean;
	updateMcpServerConfig(path: string, name: string, patch: { enabled: boolean }): void;
	removeMcpServerConfig(path: string, name: string): boolean;
};
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const configEditors: SdkConfig[] = [
	await import(new URL("./extensions/mcp/config.js", sdk).href),
	// The published CLI has its own compiled copy. Test its actual public editing functions too.
	await import(new URL("./bundle/chunks/chunk-INGZIYBC.js", sdk).href),
];

test("MCP and SDK writes preserve untouched numeric literals without rounding or null conversion", async (t) => {
	const { directory, store } = await fixture(t);
	const path = join(directory, "mcp.json");
	await writeFile(
		path,
		'{"large":9007199254740993,"exponent":1e309,"mcpServers":{"other":{"future":9007199254740993}}}',
	);
	const before = await store.read();
	await store.apply({ expectedRevision: before.revision, entries: [entry()] });
	for (const editor of configEditors) {
		editor.updateMcpServerConfig(path, "example", { enabled: false });
		const saved = await readFile(path, "utf8");
		assert.match(saved, /"large": 9007199254740993/);
		assert.match(saved, /"exponent": 1e309/);
		assert.match(saved, /"future": 9007199254740993/);
	}
});

test("SDK and bundled CLI writes accept a UTF-8 BOM like Pi readers", async (t) => {
	const { directory } = await fixture(t);
	const path = join(directory, "mcp.json");
	for (const [index, editor] of configEditors.entries()) {
		await writeFile(path, `\uFEFF${JSON.stringify({ mcpServers: { original: entry().config } })}`);
		assert.equal(editor.addMcpServerConfig(path, `added${index}`, entry().config), false);
		const saved = await readFile(path, "utf8");
		assert.equal(saved.startsWith("\uFEFF"), false);
		assert.deepEqual(Object.keys(JSON.parse(saved).mcpServers), ["original", `added${index}`]);
	}
});

test("SDK and bundled CLI add, remove and update share the native lock, including directory aliases", async (t) => {
	const { directory } = await fixture(t);
	await mkdir(join(directory, "real"));
	await symlink(join(directory, "real"), join(directory, "alias"));
	const path = join(directory, "real", "mcp.json");
	await writeFile(
		path,
		JSON.stringify({ future: { private: "kept-local" }, mcpServers: { original: entry().config } }),
	);
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const store = new McpSetupStore(join(directory, "alias"), {
		beforeCommit: async () => {
			entered();
			await gate;
		},
	});
	const snapshot = await store.read();
	const pending = store.apply({ expectedRevision: snapshot.revision, entries: [entry("native")] });
	try {
		await ready;
		for (const editor of configEditors) {
			for (const target of [path, join(directory, "alias", "mcp.json")]) {
				for (const edit of [
					() => editor.addMcpServerConfig(target, "cli", entry().config),
					() => editor.updateMcpServerConfig(target, "original", { enabled: false }),
					() => editor.removeMcpServerConfig(target, "original"),
				])
					assert.throws(edit, (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOCKED");
			}
		}
	} finally {
		release();
	}
	await pending;
	for (const [index, editor] of configEditors.entries()) {
		editor.addMcpServerConfig(path, `cli${index}`, entry().config);
		editor.updateMcpServerConfig(path, `cli${index}`, { enabled: false });
		assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers[`cli${index}`].enabled, false);
		assert.equal(editor.removeMcpServerConfig(path, `cli${index}`), true);
	}
	const saved = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(Object.keys(saved.mcpServers), ["original", "native"]);
	assert.deepEqual(saved.future, { private: "kept-local" });
	await assert.rejects(store.apply({ expectedRevision: snapshot.revision, entries: [entry("late")] }), McpSetupError);
	assert.deepEqual(await readdir(join(directory, "real")), ["mcp.json"]);
});

test("SDK writer failures release the lock and never truncate a config; symlinks and hard links are refused", async (t) => {
	const { directory, store } = await fixture(t);
	const path = join(directory, "mcp.json");
	const original = '{"mcpServers":{"example":{"url":"https://example.test/mcp"}}}';
	await writeFile(path, original);
	const { editMcpConfigSync } = await import(new URL("./extensions/mcp/config-writer.js", sdk).href);
	assert.throws(() =>
		editMcpConfigSync(path, () => {
			throw new Error("fixture interruption");
		}),
	);
	assert.equal(await readFile(path, "utf8"), original);
	assert.deepEqual(await readdir(directory), ["mcp.json"]);
	const alias = join(directory, "alias");
	await link(path, alias);
	await assert.rejects(store.read(), McpSetupError);
	for (const editor of configEditors) assert.throws(() => editor.addMcpServerConfig(path, "new", entry().config));
	assert.equal(await readFile(path, "utf8"), original);
});

test("MCP setup atomically refuses a concurrent external creator, including after the final review", async (t) => {
	let path = "";
	const external = '{"mcpServers":{"external":{"command":"private-command"}}}';
	const { directory, store } = await fixture(t, {
		beforeCommit: async () => {
			await writeFile(path, external);
		},
	});
	path = join(directory, "mcp.json");
	const before = await store.read();
	await assert.rejects(
		store.apply({ expectedRevision: before.revision, entries: [entry()] }),
		(error: unknown) => error instanceof McpSetupError && error.status === 409,
	);
	assert.equal(await readFile(path, "utf8"), external);
	assert.deepEqual(await readdir(directory), ["mcp.json"]);
});

test("MCP setup validates stdio dependency on the target without executing or installing anything", async (t) => {
	const { directory, store } = await fixture(t);
	const before = await store.read();
	const input = {
		expectedRevision: before.revision,
		entries: [{ name: "stdio", config: { command: "fixture-mcp" } }],
	};
	await assert.rejects(
		store.apply(input),
		(error: unknown) => error instanceof McpSetupError && error.code === "mcp_setup_dependency_missing",
	);
	assert.equal((await store.read()).exists, false);
	const command = join(directory, "fixture-mcp");
	await writeFile(command, "must never be executed");
	await chmod(command, 0o700);
	const after = await store.apply(input);
	assert.equal(after.entries[0]?.dependencyAvailable, true);
});

test("MCP setup rejects unsafe payloads, namespace aliases, stale reviews, corrupt and symlinked files", async (t) => {
	const { directory, store } = await fixture(t);
	const before = await store.read();
	for (const entries of [
		[{ name: "example", config: { url: "https://example.test/mcp", env: { TOKEN: "private-token" } } }],
		[entry("same-name"), entry("same_name")],
		[{ name: "example", config: { command: "/Users/private/bin/server" } }],
	])
		await assert.rejects(store.apply({ expectedRevision: before.revision, entries }), McpSetupError);
	await assert.rejects(store.apply({ expectedRevision: "a".repeat(64), entries: [entry()] }), McpSetupError);
	const auth = join(directory, "mcp-auth.json"),
		path = join(directory, "mcp.json");
	await writeFile(auth, '{"private-token":"must-not-be-read"}');
	await symlink(auth, path);
	await assert.rejects(store.read(), McpSetupError);
	await rm(path);
	await writeFile(path, "invalid-private-configuration");
	await assert.rejects(store.read(), McpSetupError);
	assert.equal(await readFile(path, "utf8"), "invalid-private-configuration");
});

test("MCP setup concurrent native first-writers preserve exactly one reviewed set", async (t) => {
	const { directory, store } = await fixture(t);
	const peer = new McpSetupStore(directory),
		before = await store.read();
	const results = await Promise.allSettled([
		store.apply({ expectedRevision: before.revision, entries: [entry("first")] }),
		peer.apply({ expectedRevision: before.revision, entries: [entry("second")] }),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal((await store.read()).entries.length, 1);
});
