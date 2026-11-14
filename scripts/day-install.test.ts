import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	digest,
	handoffArgs,
	stageApp as install,
	installedApp,
	launcher,
	install as migrate,
	preflight,
	type Selection,
} from "./day-install.ts";

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "day-install-test-")));
	const profile = join(root, "profile");
	const app = join(root, "candidate/Pilot Next.app");
	const project = join(root, "project '日本語'");
	for (const path of [profile, project, join(app, "Contents/MacOS"), join(root, "installs")])
		await mkdir(path, { recursive: true });
	await writeFile(join(app, "Contents/MacOS/pilot-desktop"), "synthetic, never executable");
	const files = {
		"daemon-id": "daemon",
		"storage-lineage": "lineage",
		"github-app-capability": JSON.stringify({ daemonId: "daemon", lineageId: "lineage", token: "a".repeat(64) }),
		"state.sqlite": "opaque database bytes",
		"state.sqlite-wal": "live WAL bytes",
		"drafts.json": "unsent 👩‍💻 日本語",
	};
	for (const [name, bytes] of Object.entries(files)) await writeFile(join(profile, name), bytes, { mode: 0o600 });
	let compatible = true;
	let globalUpdate = true;
	const requests: string[] = [];
	const server = createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		assert.equal(req.headers["x-pilot-github-capability"], "a".repeat(64));
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify(
				req.url === "/api/hello"
					? {
							daemonId: "daemon",
							lineageId: "lineage",
							protocolVersion: 1,
							minimumClientProtocolVersion: compatible ? 1 : 2,
							capabilities: {
								independentExecution: true,
								dayOverview: compatible ? 1 : 0,
								globalUpdate: globalUpdate ? 1 : undefined,
							},
						}
					: { id: "project", path: project },
			),
		);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const selection: Selection = {
		app,
		trustFrom: app,
		source: "b".repeat(40),
		binarySha256: await digest(join(app, "Contents/MacOS/pilot-desktop")),
		sourceProfile: profile,
		targetProfile: profile,
		installDirectory: join(root, "installs/Day"),
		port: address.port,
		daemonId: "daemon",
		lineageId: "lineage",
		build: "1.2.3",
		operationId: "8817ea02-15c3-4931-8800-65d359f13001",
		savedState: join(profile, "drafts.json"),
		updaterPublicKey: Buffer.alloc(32, 42).toString("base64"),
	};
	// Only the platform seal adapter is synthetic. HTTP, paths, copies and failures are real.
	const verify = async (s: Selection, path = s.app) =>
		assert.equal(await digest(join(path, "Contents/MacOS/pilot-desktop")), s.binarySha256);
	return {
		root,
		profile,
		selection,
		files,
		requests,
		verify,
		incompatible() {
			compatible = false;
		},
		legacyUpdates() {
			globalUpdate = false;
		},
		async close() {
			await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("flat Pilot.app installation preserves legacy files and refuses replacement", async () => {
	const f = await fixture();
	try {
		const app = f.selection.app.replace("Pilot Next.app", "Pilot.app");
		await rename(f.selection.app, app);
		const s = { ...f.selection, app, trustFrom: app, appDestination: join(f.root, "installs/Pilot.app") };
		const legacy = join(f.root, "installs/Pilot/Pilot Next.app");
		await mkdir(legacy, { recursive: true });
		await writeFile(join(legacy, "keep"), "legacy");
		await install(s, f.verify);
		assert.equal(installedApp(s), s.appDestination);
		assert.equal(await readFile(join(legacy, "keep"), "utf8"), "legacy");
		assert.match(launcher(s), /installs\/Pilot\.app\/Contents\/MacOS\/pilot-desktop/);
		assert.match(await install(s, f.verify), /Already installed/);
		await assert.rejects(
			install({ ...s, installDirectory: join(f.root, "installs/other") }, f.verify),
			/App destination exists/,
		);
		await assert.rejects(
			preflight({ ...s, appDestination: join(f.root, "Pilot.app") }, f.verify),
			/Flat installation/,
		);
	} finally {
		await f.close();
	}
});

test("native interface pins the exact original operation and profile without credentials", async () => {
	const f = await fixture();
	try {
		const args = handoffArgs(f.selection, "apply");
		assert.deepEqual(args.slice(0, 2), ["--daemon-handoff", "apply"]);
		assert.equal(args[args.indexOf("--operation-id") + 1], f.selection.operationId);
		assert.equal(args[args.indexOf("--profile") + 1], f.profile);
		assert.ok(!args.join(" ").includes("a".repeat(64)));
	} finally {
		await f.close();
	}
});

test("preflight is read-only; install/repeat preserve all profile bytes and Day drafts", async () => {
	const f = await fixture();
	try {
		const s = f.selection;
		await preflight(s, f.verify);
		assert.deepEqual(await readdir(join(f.root, "installs")), []);
		assert.match(await install(s, f.verify), /Installed, not launched/);
		await writeFile(join(s.installDirectory, "window-journal"), "Day saved draft 👩‍💻");
		assert.match(await install(s, f.verify), /Already installed/);
		assert.equal(await readFile(join(s.installDirectory, "window-journal"), "utf8"), "Day saved draft 👩‍💻");
		assert.equal(await readFile(join(s.installDirectory, "Launch Day.command"), "utf8"), launcher(s));
		assert.ok(!launcher(s).includes("--project"));
		assert.ok(!launcher(s).includes("--planning-model"));
		for (const [name, bytes] of Object.entries(f.files))
			assert.equal(await readFile(join(f.profile, name), "utf8"), bytes);
		assert.ok(f.requests.every((r) => r === "GET /api/hello"));
		await assert.rejects(install({ ...s, planningModel: "different" }, f.verify), /another selection/);
	} finally {
		await f.close();
	}
});

test("failed staged verification leaves no installation and retry succeeds", async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			install(f.selection, async (s, app = s.app) => {
				await f.verify(s, app);
				if (app !== s.app) throw new Error("copied signature refused");
			}),
			/signature refused/,
		);
		assert.deepEqual(await readdir(join(f.root, "installs")), []);
		assert.match(await install(f.selection, f.verify), /Installed/);
	} finally {
		await f.close();
	}
});

test("historical project/model fields neither gate startup nor reach the launcher", async () => {
	const f = await fixture();
	try {
		const old = {
			...f.selection,
			projectId: "removed-project",
			projectPath: "/no-longer-present",
			planningModel: "",
		};
		await preflight(old, f.verify);
		assert.equal(launcher(old), launcher(f.selection));
		assert.deepEqual(f.requests, ["GET /api/hello"]);
		assert.equal(old.operationId, f.selection.operationId);
	} finally {
		await f.close();
	}
});

test("rejects a different profile, incompatible daemon, and changed bundle without writes", async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			preflight({ ...f.selection, targetProfile: join(f.root, "project '日本語'") }, f.verify),
			/same canonical profile/,
		);
		await assert.rejects(preflight({ ...f.selection, binarySha256: "c".repeat(64) }, f.verify));
		f.incompatible();
		await assert.rejects(install(f.selection, f.verify), /lacks the base native protocol/);
		assert.deepEqual(await readdir(join(f.root, "installs")), []);
	} finally {
		await f.close();
	}
});

test("legacy daemon with base protocol cannot enter a global handoff", async () => {
	const f = await fixture();
	const calls: string[] = [];
	try {
		f.legacyUpdates();
		await assert.rejects(
			migrate(f.selection, f.verify, (_s, action) => {
				calls.push(action);
				if (action === "preflight") return { state: "ready", changed: false };
				throw new Error("Native apply: ActiveWork");
			}),
			/lacks native global-update support/,
		);
		assert.deepEqual(calls, [], "service preflight alone does not prove global-update support");
		assert.deepEqual(await readdir(join(f.root, "installs")), []);
		assert.deepEqual(f.requests, ["GET /api/hello"]);
		for (const [name, bytes] of Object.entries(f.files))
			assert.equal(await readFile(join(f.profile, name), "utf8"), bytes);
	} finally {
		await f.close();
	}
});

test("repeat refuses tampered installed bytes without erasing drafts or repairing files", async () => {
	const f = await fixture();
	try {
		await install(f.selection, f.verify);
		const journal = join(f.selection.installDirectory, "window-journal");
		const executable = join(f.selection.installDirectory, "Pilot Next.app/Contents/MacOS/pilot-desktop");
		await writeFile(journal, "unconfirmed operation and saved draft");
		await writeFile(executable, "changed");
		await assert.rejects(install(f.selection, f.verify));
		assert.equal(await readFile(executable, "utf8"), "changed");
		assert.equal(await readFile(journal, "utf8"), "unconfirmed operation and saved draft");
	} finally {
		await f.close();
	}
});

test("preflight refuses exposed credentials and profile aliases before HTTP or writes", async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			preflight(Object.assign({}, f.selection, { token: "never copy credentials" }), f.verify),
			/Unknown selection field/,
		);
		const alias = join(f.root, "alias");
		await symlink(f.profile, alias);
		await assert.rejects(
			preflight({ ...f.selection, sourceProfile: alias, targetProfile: alias }, f.verify),
			/canonical absolute path/,
		);
		await chmod(join(f.profile, "github-app-capability"), 0o644);
		await assert.rejects(preflight(f.selection, f.verify), /Unsafe native identity file/);
		assert.deepEqual(f.requests, []);
		assert.deepEqual(await readdir(join(f.root, "installs")), []);
	} finally {
		await f.close();
	}
});

test("complete migration uses native apply once; repeated invocation only inspects", async () => {
	const f = await fixture();
	const calls: string[] = [];
	try {
		const native = (_s: Selection, action: string, app: string) => {
			calls.push(action);
			if (action === "preflight") return { state: "ready", changed: false };
			assert.equal(app, join(f.selection.installDirectory, "Pilot Next.app"));
			return action === "apply"
				? { state: "complete", completion: { role: "successor" }, releaseReceipt: { state: "accepted" } }
				: { state: "observed" };
		};
		assert.equal((await migrate(f.selection, f.verify, native)).state, "complete");
		await writeFile(join(f.selection.installDirectory, "window-journal"), "saved Day state");
		assert.equal((await migrate(f.selection, f.verify, native)).state, "observed");
		assert.deepEqual(calls, ["preflight", "apply", "inspect"]);
		for (const [name, bytes] of Object.entries(f.files))
			assert.equal(await readFile(join(f.profile, name), "utf8"), bytes);
	} finally {
		await f.close();
	}
});

test("lost apply reply and rollback completion never replay or authorize retirement", async () => {
	for (const lost of [true, false]) {
		const f = await fixture();
		const calls: string[] = [];
		try {
			const native = (_s: Selection, action: string) => {
				calls.push(action);
				if (action === "preflight") return { state: "ready", changed: false };
				if (action === "apply" && lost) throw new Error("reply lost");
				return action === "apply"
					? { state: "complete", completion: { role: "rollback" }, releaseReceipt: { state: "accepted" } }
					: { state: "observed" };
			};
			await assert.rejects(migrate(f.selection, f.verify, native));
			assert.equal((await migrate(f.selection, f.verify, native)).state, "observed");
			assert.deepEqual(calls, ["preflight", "apply", "inspect"]);
			assert.ok(!(await readdir(f.selection.installDirectory)).includes("handoff-complete.json"));
		} finally {
			await f.close();
		}
	}
});
