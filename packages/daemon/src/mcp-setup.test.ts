import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
	assert.equal(after.writeMode, "initial_only");
	const path = join(directory, "mcp.json"),
		metadata = await stat(path);
	assert.equal(metadata.mode & 0o777, 0o600);
	assert.deepEqual(await store.apply(input), after);
	assert.equal((await stat(path)).ino, metadata.ino);
	assert.deepEqual(await readdir(directory), ["mcp.json"]);
});

test("MCP setup preserves every existing byte, unsupported entry, header and unknown root field", async (t) => {
	const { directory, store } = await fixture(t);
	const original =
		'{"future": {"order":2,"auth":"private-root-value"}, "mcpServers": {"other":{"url":"https://example.test/mcp","headers":{"Authorization":"private-token"}}}}\n';
	await writeFile(join(directory, "mcp.json"), original);
	const snapshot = await store.read();
	assert.ok(snapshot.entries[0]?.blocked);
	assert.equal(JSON.stringify(snapshot).includes("private-"), false);
	await assert.rejects(
		store.apply({ expectedRevision: snapshot.revision, entries: [entry()] }),
		(error: unknown) => error instanceof McpSetupError && error.code === "mcp_setup_existing_config",
	);
	assert.equal(await readFile(join(directory, "mcp.json"), "utf8"), original);
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
