import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CredentialClient } from "@pilot/kernel/credential-client";
import { CredentialChannel } from "@pilot/kernel/credential-rpc";
import lockfile from "proper-lockfile";
import { CredentialBroker } from "./credential-broker.ts";

const value = (access: string) => ({
	type: "oauth",
	access,
	refresh: "synthetic-refresh",
	expires: Date.now() + 3600_000,
});
async function fixture(t: TestContext) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pilot-setup-fence-")));
	const broker = new CredentialBroker(dir);
	await broker.start();
	const endpoint = broker.grant(true, { namespace: "pi", key: "anthropic" });
	const adminEndpoint = broker.grant(true),
		reader = new CredentialClient(broker.grant());
	const old = new CredentialChannel(endpoint),
		admin = new CredentialChannel(adminEndpoint);
	t.after(async () => {
		old.close();
		admin.close();
		await reader.close();
		await broker.close();
		await rm(dir, { recursive: true, force: true });
	});
	const journal = async () => JSON.parse(await readFile(join(dir, ".pilot-credential-journal.json"), "utf8"));
	return { dir, broker, endpoint, adminEndpoint, old, admin, reader, journal };
}
async function until(check: () => Promise<boolean>) {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Fence was not observed");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("setup capability is key/namespace scoped, bounded metadata only, and cancellation rejects delayed commit", async (t) => {
	const f = await fixture(t);
	await f.admin.request({ op: "begin", namespace: "pi", key: "openai", mode: "login" });
	await f.admin.request({
		op: "commit",
		namespace: "pi",
		key: "openai",
		changed: true,
		value: value("unrelated-private"),
	});
	await assert.rejects(f.old.request({ op: "read", namespace: "pi", key: "openai" }), /unauthorized/);
	await assert.rejects(
		f.old.request({ op: "begin", namespace: "mcp", key: "mcp__slack|https://fixture.test/", mode: "login" }),
		/unauthorized/,
	);
	assert.deepEqual(await f.old.request({ op: "list", namespace: "pi" }), []);
	assert.deepEqual(await f.old.request({ op: "statuses", namespace: "pi" }), []);
	await f.old.request({ op: "begin", namespace: "pi", key: "anthropic", mode: "login" });
	const generation = (await f.journal())["pi:anthropic"].generation;
	await f.broker.cancelSetup(f.endpoint);
	assert.equal((await f.journal())["pi:anthropic"].generation, generation + 1);
	await assert.rejects(
		f.old.request({
			op: "commit",
			namespace: "pi",
			key: "anthropic",
			changed: true,
			value: value("delayed-private-access"),
		}),
		/stale|unavailable|unauthorized/,
	);
	assert.deepEqual(await f.reader.request({ op: "status", namespace: "pi", key: "anthropic" }), {
		state: "reauthentication_required",
	});
	assert.equal(JSON.parse(await readFile(join(f.dir, "auth.json"), "utf8")).anthropic, undefined);
	const inventory = await f.reader.request({ op: "statuses", namespace: "pi" });
	assert.equal(JSON.stringify(inventory).includes("unrelated-private"), false);
	assert.ok(
		(inventory as Array<{ providerId: string; state: string }>).some(
			(entry) => entry.providerId === "anthropic" && entry.state === "reauthentication_required",
		),
	);
});

test("cancelling an old helper cannot fence a newer external explicit login generation", async (t) => {
	const f = await fixture(t);
	await f.old.request({ op: "begin", namespace: "pi", key: "anthropic", mode: "login" });
	const generation = (await f.journal())["pi:anthropic"].generation;
	const begun = f.admin.request({ op: "begin", namespace: "pi", key: "anthropic", mode: "login" });
	await until(async () => (await f.journal())["pi:anthropic"].generation > generation);
	await f.broker.cancelSetup(f.endpoint);
	await begun;
	assert.equal((await f.journal())["pi:anthropic"].generation, generation + 1);
	await f.admin.request({
		op: "commit",
		namespace: "pi",
		key: "anthropic",
		changed: true,
		value: value("new-external-private"),
	});
	assert.equal(
		((await f.reader.request({ op: "read", namespace: "pi", key: "anthropic" })) as { access: string }).access,
		"new-external-private",
	);
	assert.deepEqual(await f.reader.request({ op: "status", namespace: "pi", key: "anthropic" }), {
		state: "configured",
	});
});

test("cancelling an older helper preserves a racing external logout tombstone", async (t) => {
	const f = await fixture(t);
	await f.old.request({ op: "begin", namespace: "pi", key: "anthropic", mode: "login" });
	const generation = (await f.journal())["pi:anthropic"].generation;
	const deleted = f.admin.request({ op: "delete", namespace: "pi", key: "anthropic" });
	await until(async () => (await f.journal())["pi:anthropic"].generation > generation);
	await f.broker.cancelSetup(f.endpoint);
	await deleted;
	const state = (await f.journal())["pi:anthropic"];
	assert.equal(state.generation, generation + 1);
	assert.equal(state.revoked, true);
	assert.deepEqual(await f.reader.request({ op: "status", namespace: "pi", key: "anthropic" }), { state: "missing" });
});

test("cancellation after a newer external login completed leaves that credential usable without false reauthentication", async (t) => {
	const f = await fixture(t);
	await f.old.request({ op: "begin", namespace: "pi", key: "anthropic", mode: "login" });
	f.old.close(); // Lost old helper leaves uncertainty; a fresh explicit login supersedes it.
	await f.admin.request({ op: "begin", namespace: "pi", key: "anthropic", mode: "login" });
	await f.admin.request({
		op: "commit",
		namespace: "pi",
		key: "anthropic",
		changed: true,
		value: value("new-canonical-private"),
	});
	assert.deepEqual(await f.broker.cancelSetup(f.endpoint), { reauthenticationRequired: false });
	assert.equal(
		((await f.reader.request({ op: "read", namespace: "pi", key: "anthropic" })) as { access: string }).access,
		"new-canonical-private",
	);
	assert.deepEqual(await f.reader.request({ op: "status", namespace: "pi", key: "anthropic" }), {
		state: "configured",
	});
});

test("cancel before a blocked begin cannot claim a fresh generation after capability revocation", async (t) => {
	const f = await fixture(t);
	const release = await lockfile.lock(join(f.dir, ".pilot-credential-journal.json"), { realpath: false });
	const begin = f.old
		.request({ op: "begin", namespace: "pi", key: "anthropic", mode: "login" })
		.catch((error) => error);
	const cancellation = f.broker.cancelSetup(f.endpoint);
	await release();
	await cancellation;
	assert.ok((await begin) instanceof Error);
	assert.deepEqual(await f.journal(), {});
	assert.deepEqual(await f.reader.request({ op: "status", namespace: "pi", key: "anthropic" }), { state: "missing" });
});

test("commit already persisted under the journal lock is quarantined when cancellation linearizes afterwards", async (t) => {
	const f = await fixture(t);
	await f.old.request({ op: "begin", namespace: "pi", key: "anthropic", mode: "login" });
	// Hold the real journal lock after the commit callback persisted, but before it can release
	// and acknowledge the commit. This deterministically exercises cancellation during persistence.
	type Mutex = { mutex<T>(path: string, fn: () => Promise<T>): Promise<T> };
	const seam = f.broker as unknown as Mutex,
		original = seam.mutex.bind(f.broker);
	let enteredResolve!: () => void, releaseResolve!: () => void;
	const entered = new Promise<void>((resolve) => {
		enteredResolve = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseResolve = resolve;
	});
	let intercept = true;
	t.mock.method(
		seam,
		"mutex",
		async <T>(path: string, fn: () => Promise<T>): Promise<T> =>
			original(path, async () => {
				const result = await fn();
				if (intercept && path.endsWith(".pilot-credential-journal.json")) {
					intercept = false;
					enteredResolve();
					await release;
				}
				return result;
			}),
	);
	const committed = f.old
		.request({ op: "commit", namespace: "pi", key: "anthropic", changed: true, value: value("persisted-private") })
		.catch((error) => error);
	await entered;
	assert.equal(JSON.parse(await readFile(join(f.dir, "auth.json"), "utf8")).anthropic.access, "persisted-private");
	const cancellation = f.broker.cancelSetup(f.endpoint);
	releaseResolve();
	await Promise.all([committed, cancellation]);
	assert.equal(await f.reader.request({ op: "read", namespace: "pi", key: "anthropic" }), undefined);
	assert.deepEqual(await f.reader.request({ op: "status", namespace: "pi", key: "anthropic" }), {
		state: "reauthentication_required",
	});
});
