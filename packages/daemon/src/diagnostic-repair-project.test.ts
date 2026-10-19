import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	DiagnosticRepairProjectStore,
	diagnosticRepairTitle,
	PILOT_REPAIR_ORIGIN,
} from "./diagnostic-repair-project.ts";
import { ProjectStore } from "./projects.ts";

const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-repair-binding-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	let origin = "git@github.com:babariviere/pilot.git";
	let beforeRead: (() => Promise<void>) | undefined;
	const projects = new ProjectStore(join(root, "home"), async (_bin, args) => {
		assert.deepEqual(args, ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"]);
		await beforeRead?.();
		return origin;
	});
	await projects.load();
	await mkdir(join(root, "source"));
	const project = await projects.create({ path: join(root, "source"), name: "Not an authority" });
	const store = new DiagnosticRepairProjectStore(join(root, "home"), projects, host);
	const setup = { expectedRevision: 0, host, projectId: project.id, path: project.path, origin: PILOT_REPAIR_ORIGIN };
	return {
		root,
		projects,
		project,
		store,
		setup,
		setOrigin: (value: string) => {
			origin = value;
		},
		beforeRead: (value: typeof beforeRead) => {
			beforeRead = value;
		},
	};
}

test("explicit repair binding persists privately, ignores names and never selects another clone", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await f.store.status(), { state: "missing", revision: 0 });
	const configured = await f.store.configure(f.setup);
	assert.equal(configured.state, "available");
	const pinned = configured.binding!;
	assert.equal((await stat(f.store.file)).mode & 0o777, 0o600);
	await f.projects.update(f.project.id, { name: "Renamed" });
	await mkdir(join(f.root, "clone"));
	const clone = await f.projects.create({ path: join(f.root, "clone"), name: "Pilot" });
	const reopened = new DiagnosticRepairProjectStore(join(f.root, "home"), f.projects, host);
	assert.deepEqual((await reopened.status()).binding, pinned);
	await f.projects.remove(f.project.id);
	assert.equal((await reopened.status()).reason, "project_missing");
	await assert.rejects(
		reopened.withBinding(pinned, async () => "never"),
		/unavailable/,
	);
	assert.notEqual((await reopened.status()).binding?.projectId, clone.id);
});

test("repair binding rejects display-name guesses, forks, unresolved origins and forged pins", async (t) => {
	const f = await fixture(t);
	for (const origin of [
		"https://github.com/fork/pilot",
		"git@work:owner/pilot",
		"",
		"https://github.com/babariviere/other",
	]) {
		f.setOrigin(origin);
		await assert.rejects(f.store.configure(f.setup), /verified Pilot/);
	}
	f.setOrigin("https://github.com/babariviere/pilot.git");
	await assert.rejects(f.store.configure({ ...f.setup, path: f.root }), /verified Pilot/);
	await assert.rejects(
		f.store.configure({ ...f.setup, host: { ...host, lineageId: "replacement" } }),
		/verified Pilot/,
	);
	const configured = await f.store.configure(f.setup);
	await assert.rejects(
		f.store.withBinding({ ...configured.binding, path: f.root }, async () => 1),
		/binding changed/,
	);
	await assert.rejects(
		f.store.withBinding({ ...configured.binding, host: { ...host, hostId: "alias" } }, async () => 1),
		/binding changed/,
	);
	await assert.rejects(f.store.configure(f.setup), /configuration changed/);
});

test("origin, registered path, symlink and lineage replacement disable a saved repair binding", async (t) => {
	const f = await fixture(t);
	const pin = (await f.store.configure(f.setup)).binding!;
	f.setOrigin("https://github.com/fork/pilot");
	assert.equal((await f.store.status()).reason, "origin_changed");
	await assert.rejects(
		f.store.withBinding(pin, async () => 1),
		/unavailable/,
	);
	f.setOrigin("https://github.com/babariviere/pilot");
	await mkdir(join(f.root, "replacement"));
	await f.projects.update(f.project.id, { path: join(f.root, "replacement") });
	assert.equal((await f.store.status()).reason, "path_changed");
	await f.projects.update(f.project.id, { path: f.project.path });
	await rm(f.project.path, { recursive: true });
	await symlink(join(f.root, "replacement"), f.project.path);
	assert.equal((await f.store.status()).reason, "path_changed");
	const other = new DiagnosticRepairProjectStore(join(f.root, "home"), f.projects, { ...host, lineageId: "new" });
	assert.equal((await other.status()).reason, "identity_changed");
});

test("unknown, corrupt and oversized repair configuration stays unavailable and is never reset", async (t) => {
	for (const contents of ["{", '{"schemaVersion":99}', "x".repeat(9000)]) {
		const f = await fixture(t);
		await writeFile(f.store.file, contents);
		assert.deepEqual(await f.store.status(), { state: "invalid", revision: 0, reason: "storage" });
		await assert.rejects(f.store.configure(f.setup), /preserved, not reset/);
		assert.equal(await readFile(f.store.file, "utf8"), contents);
	}
});

test("repair admission fences configuration changes and rechecks origins after awaited preparation", async (t) => {
	const f = await fixture(t);
	const pin = (await f.store.configure(f.setup)).binding!;
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const admission = f.store.withBinding(pin, async () => {
		enter();
		await released;
		return "committed";
	});
	await entered;
	let changed = false;
	const replacement = f.store.configure({ ...f.setup, expectedRevision: 1 }).then((value) => {
		changed = true;
		return value;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(changed, false, "setup cannot retarget an admission during its commit fence");
	release();
	assert.equal(await admission, "committed");
	const next = (await replacement).binding!;
	assert.notEqual(next.id, pin.id);
	assert.equal(next.revision, 2);
	await assert.rejects(
		f.store.withBinding(pin, async () => 1),
		/binding changed/,
	);
	await f.store.withBinding(next, async () => {
		f.setOrigin("https://github.com/fork/pilot");
		await assert.rejects(f.store.validateCurrent(next), /changed during preparation/);
	});
});

test("repair titles differ by issue, remain bounded and reject controls, bidi and credentials", () => {
	assert.equal(
		diagnosticRepairTitle(undefined, "## Sidebar selection persists\nFurther details"),
		"Sidebar selection persists",
	);
	assert.notEqual(
		diagnosticRepairTitle(undefined, "Reconnect stalled"),
		diagnosticRepairTitle(undefined, "Sidebar selection persists"),
	);
	assert.ok(diagnosticRepairTitle(undefined, "").length > 0);
	assert.ok(diagnosticRepairTitle(undefined, "😀".repeat(300)).length <= 160);
	for (const title of ["", "a\nb", "a\u202eb", "a\u0000b", "x".repeat(161), "token=private", "Bearer private"]) {
		assert.throws(() => diagnosticRepairTitle(title, "Finding"), /title/i);
	}
	assert.ok(!diagnosticRepairTitle(undefined, "token=private").includes("private"));
});
