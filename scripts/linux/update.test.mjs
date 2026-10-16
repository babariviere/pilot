import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	processIdentity,
	publicUpdate,
	readUpdate,
	sameProcess,
	writeUpdate,
} from "../../packages/daemon/src/runtime-update-journal.ts";
import { serviceUnit } from "./service.mjs";
import {
	checkTargetVersion,
	confirmRequest,
	prepare,
	reconcile,
	replaceOwned,
	rootFromUnit,
	updaterUnit,
	verifyRequest,
} from "./update.mjs";

function request() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const manifest = Buffer.from(
		JSON.stringify({
			schemaVersion: 1,
			platform: "linux",
			arch: "x64",
			version: "1.40.0",
			tag: "v1.40.0",
			commit: "a".repeat(40),
			protocolVersion: 1,
			minimumClientProtocolVersion: 1,
			minimumGlibc: "2.28",
			minimumGlibcxx: "3.4.21",
			node: { version: "24.21.0", modules: "137" },
			archive: { name: "Pilot-linux-x64.tar.gz", size: 1, sha256: "b".repeat(64) },
		}),
	);
	return {
		id: randomUUID(),
		daemonId: randomUUID(),
		lineageId: randomUUID(),
		version: "1.40.0",
		archive: "b".repeat(64),
		manifest: manifest.toString("base64"),
		signature: sign(null, manifest, privateKey).toString("base64"),
		publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
	};
}
async function fixture(t) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-update-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	const data = join(home, ".local/share/pilot");
	const initial = {
		...request(),
		schema: 1,
		revision: 1,
		phase: "staged",
		blockers: [],
		from: "/old",
		to: "/new",
		oldUnit: "old",
		newUnit: "new",
	};
	await writeUpdate(data, initial);
	const process = { bootId: randomUUID(), pid: 123, start: "10" };
	let pid = process.pid,
		unit = "old",
		time = 0;
	const calls = [];
	const effects = {
		read: readUpdate,
		write: writeUpdate,
		now: () => time,
		delay: async (ms) => {
			time += ms;
		},
		verify: async () => {},
		process: async () => process,
		state: async () => ({ MainPID: String(pid), InvocationID: "owned-invocation", unit }),
		api: async (action) => {
			calls.push(action);
			return { ready: true, process, blockers: [] };
		},
		stop: async () => {
			calls.push("stop");
			pid = 0;
		},
		publish: async () => {
			calls.push("publish");
			unit = "new";
		},
		start: async () => {
			calls.push("start");
			pid = 456;
		},
		health: async () => {
			calls.push("health");
		},
	};
	return { home, data, initial, process, effects, calls };
}

test("update verifies signed exact bytes and never accepts a release-supplied replacement key", () => {
	const value = request();
	verifyRequest(value);
	for (const change of [
		{ publicKey: Buffer.alloc(32).toString("base64") },
		{ manifest: Buffer.from("{}").toString("base64") },
		{ signature: "" },
		{ archive: "c".repeat(64) },
		{ version: "1.41.0" },
	])
		assert.throws(() => verifyRequest({ ...value, ...change }));
});

test("stable versions compare numerically and reject older apps or an unknown current version", () => {
	assert.equal(checkTargetVersion("1.9.0", "1.10.0"), "upgrade");
	assert.equal(checkTargetVersion("1.40.0", "1.40.0", true), "current");
	for (const current of ["1.41.0", "2.0.0", "1.40.1", "unknown", "v1.40.0", "1.40.0-beta", "01.40.0", undefined])
		assert.throws(() => checkTargetVersion(current, "1.40.0"));
	assert.throws(() => checkTargetVersion("1.40.0", "1.40.0", false), /explicit repair/);
});

test("prepare rejects an older signed package before recording intent; an already installed package is a no-op", async (t) => {
	const f = await fixture(t),
		metadata = request();
	await rm(join(f.data, "runtime-update"), { recursive: true });
	const parent = join(f.data, "runtimes", metadata.archive),
		runtime = join(parent, "runtime");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	await mkdir(runtime, { mode: 0o700 });
	await writeFile(join(parent, "complete"), metadata.archive);
	const units = join(f.home, ".config/systemd/user");
	await mkdir(units, { recursive: true });
	await writeFile(join(units, "pilotd.service"), serviceUnit(runtime, f.home));
	const hello = {
		daemonId: metadata.daemonId,
		lineageId: metadata.lineageId,
		daemonVersion: "1.41.0",
		capabilities: { runtimeUpdates: 1 },
	};
	const preflight = { state: async () => {}, hello: async () => hello };
	await assert.rejects(prepare(metadata, runtime, f.home, preflight), /newer Pilot runtime/);
	assert.equal(await readUpdate(f.data), undefined);
	hello.daemonVersion = "not-orderable";
	await assert.rejects(prepare(metadata, runtime, f.home, preflight), /compared safely/);
	assert.equal(await readUpdate(f.data), undefined);
	// A saved staging UUID does not bypass the same version gate on a later retry.
	await writeUpdate(f.data, { ...f.initial, ...metadata, from: runtime, to: runtime, phase: "staged" });
	hello.daemonVersion = "1.41.0";
	await assert.rejects(prepare(metadata, runtime, f.home, preflight), /newer Pilot runtime/);
	await rm(join(f.data, "runtime-update"), { recursive: true });
	hello.daemonVersion = metadata.version;
	const current = await prepare(metadata, runtime, f.home, preflight);
	assert.equal(current.phase, "completed");
	assert.match(current.detail, /No restart/);
	let installed = false;
	await confirmRequest(current, f.home, {
		installRunner: async () => {
			installed = true;
		},
		write: writeUpdate,
	});
	assert.equal(installed, false);
});

test("staging is not confirmed acceptance, including a crash before or after enabling the remote owner", async (t) => {
	for (const failure of ["before-owner", "after-owner"])
		await t.test(failure, async (t) => {
			const f = await fixture(t);
			assert.equal(publicUpdate(await readUpdate(f.data)).requestConfirmed, false);
			let owned = false;
			await assert.rejects(
				confirmRequest(f.initial, f.home, {
					installRunner: async () => {
						if (failure === "before-owner") throw new Error("crash");
						owned = true;
					},
					write: async () => {
						throw new Error("lost acceptance reply");
					},
				}),
			);
			const uncertain = await readUpdate(f.data);
			assert.equal(uncertain.id, f.initial.id);
			assert.equal(uncertain.phase, "staged");
			assert.equal(publicUpdate(uncertain).requestConfirmed, false);
			assert.equal(owned, failure === "after-owner");
			const same = await confirmRequest(uncertain, f.home, {
				installRunner: async () => {
					owned = true;
				},
				write: writeUpdate,
			});
			assert.equal(same.id, f.initial.id);
			assert.equal(same.phase, "requested");
			assert.equal(publicUpdate(await readUpdate(f.data)).requestConfirmed, true);
		});
});

test("each journal boundary reconciles a lost reply without another unproved stop or unsafe replay", async (t) => {
	for (const phase of ["draining", "ready", "stopping", "switching", "validating", "completed"])
		await t.test(phase, async (t) => {
			const f = await fixture(t);
			let injected = false;
			f.effects.write = async (home, value) => {
				await writeUpdate(home, value);
				if (value.phase === phase && !injected) {
					injected = true;
					throw new Error("crash after fsync");
				}
			};
			await assert.rejects(reconcile(f.home, f.effects), /crash/);
			f.effects.write = writeUpdate;
			assert.equal(await reconcile(f.home, f.effects), "done");
			const final = await readUpdate(f.data);
			assert.equal(final.phase, "completed");
			assert.equal(final.id, f.initial.id);
			assert.equal(f.calls.filter((call) => call === "stop").length, 1);
			assert.ok(f.calls.indexOf("commit") < f.calls.indexOf("stop"));
		});
});

test("crashes after external stop, unit publication and service start reconcile observed state", async (t) => {
	for (const effect of ["stop", "publish", "start", "health"])
		await t.test(effect, async (t) => {
			const f = await fixture(t),
				original = f.effects[effect];
			f.effects[effect] = async (...args) => {
				await original(...args);
				throw new Error("lost external reply");
			};
			await assert.rejects(reconcile(f.home, f.effects));
			f.effects[effect] = original;
			assert.equal(await reconcile(f.home, f.effects), "done");
			assert.equal(f.calls.filter((call) => call === "stop").length, 1);
		});
});

test("live jobs, terminals, transfers and unknown state defer restart and release the draining phase", async (t) => {
	for (const kind of ["job", "terminal", "setup", "transfer", "download", "child-process", "unknown-process"])
		await t.test(kind, async (t) => {
			const f = await fixture(t);
			f.effects.api = async () => ({ ready: false, process: f.process, blockers: [{ kind, id: "live" }] });
			assert.equal(await reconcile(f.home, f.effects), "waiting");
			assert.equal((await readUpdate(f.data)).phase, "waiting");
			assert.deepEqual(f.calls, []);
		});
});

test("a slow unsafe tool is not aborted and its update hold is yielded after the bounded drain attempt", async (t) => {
	const f = await fixture(t);
	f.effects.api = async () => ({ ready: false, process: f.process, blockers: [{ kind: "tool-drain", id: "agents" }] });
	assert.equal(await reconcile(f.home, f.effects), "waiting");
	assert.equal((await readUpdate(f.data)).phase, "waiting");
	assert.deepEqual(f.calls, []);
});

test("PID reuse, reboot and service invocation replacement invalidate an old stop authorization", async (t) => {
	for (const mismatch of [{ pid: 124 }, { start: "11" }, { bootId: randomUUID() }])
		await t.test(JSON.stringify(mismatch), async (t) => {
			const f = await fixture(t);
			await writeUpdate(f.data, {
				...f.initial,
				phase: "stopping",
				process: { ...f.process, ...mismatch },
				invocation: "owned-invocation",
			});
			assert.equal(await reconcile(f.home, f.effects), "waiting");
			assert.equal((await readUpdate(f.data)).phase, "draining");
			assert.deepEqual(f.calls, []);
		});
});

test("cancellation is settled only by the owner and is refused after stop authorization", async (t) => {
	const f = await fixture(t);
	f.effects.cancelled = async () => true;
	assert.equal(await reconcile(f.home, f.effects), "done");
	assert.equal((await readUpdate(f.data)).phase, "cancelled");
	assert.deepEqual(f.calls, []);
});

test("a cancellation arriving at final proof is honored, but committed activation cannot be undone", async (t) => {
	const f = await fixture(t);
	let reads = 0;
	f.effects.cancelled = async () => ++reads > 1;
	assert.equal(await reconcile(f.home, f.effects), "done");
	assert.equal((await readUpdate(f.data)).phase, "cancelled");
	assert.equal(f.calls.includes("stop"), false);
	await writeUpdate(f.data, { ...f.initial, phase: "stopping", process: f.process, invocation: "owned-invocation" });
	assert.equal(await reconcile(f.home, f.effects), "done");
	assert.equal((await readUpdate(f.data)).phase, "completed");
});

test("a reboot during publication drains the new old-runtime invocation instead of guessing it safe", async (t) => {
	const f = await fixture(t);
	await writeUpdate(f.data, { ...f.initial, phase: "switching", process: f.process });
	assert.equal(await reconcile(f.home, f.effects), "waiting");
	assert.equal((await readUpdate(f.data)).phase, "draining");
	assert.deepEqual(f.calls, []);
	assert.equal(await reconcile(f.home, f.effects), "done");
});

test("a changed systemd invocation blocks a stop even when the process tuple appears unchanged", async (t) => {
	const f = await fixture(t);
	await writeUpdate(f.data, { ...f.initial, phase: "stopping", process: f.process, invocation: "other" });
	assert.equal(await reconcile(f.home, f.effects), "waiting");
	assert.equal(f.calls.includes("stop"), false);
});

test("owned service publication rejects substitutions and quotes spaces, dollars and percent paths", async (t) => {
	const f = await fixture(t),
		path = '/home/u/with space % $ " quote';
	const unit = serviceUnit(path, "/home/u");
	assert.equal(rootFromUnit(unit, "/home/u"), path);
	assert.throws(() => rootFromUnit(`${unit}\n[Service]\nExecStart=bad`, "/home/u"));
	assert.match(updaterUnit(path, "/home/u"), /scripts\/linux\/update.mjs.* run/);
	assert.match(updaterUnit(path, "/home/u"), /Environment="HOME=\/home\/u"/);
	assert.match(updaterUnit(path, "/home/u"), /Environment="PILOT_HOME=\/home\/u\/\.local\/share\/pilot"/);
	assert.match(updaterUnit(path, "/home/u"), /Environment="PATH=.*node\/bin/);
	assert.match(updaterUnit(path, "/home/u"), /Environment="XDG_RUNTIME_DIR=%t"/);
	assert.match(updaterUnit(path, "/home/u"), /Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t\/bus"/);
	assert.match(updaterUnit(path, "/home/u"), /WorkingDirectory=%h/);
	assert.doesNotMatch(updaterUnit(path, "/home/u"), /PartOf=|BindsTo=|pilotd.service/);
	const file = join(f.home, "unit");
	await writeFile(file, "foreign", { mode: 0o600 });
	await assert.rejects(replaceOwned(file, "old", "new"));
	assert.equal(await readFile(file, "utf8"), "foreign");
});

test("the updater's rendered environment overrides a foreign inherited home and bus for journal and control commands", async (t) => {
	const f = await fixture(t);
	const runtimeDir = `/run/user/${process.getuid()}`;
	const unit = updaterUnit("/private/verified-runtime", f.home);
	// Resolve this unit's fixed systemd environment values. No real service, bus or host writes.
	const environment = Object.fromEntries(
		unit
			.split("\n")
			.filter((line) => line.startsWith("Environment="))
			.map((line) => {
				const assignment = JSON.parse(line.slice("Environment=".length)).replaceAll("%t", runtimeDir);
				const equals = assignment.indexOf("=");
				return [assignment.slice(0, equals), assignment.slice(equals + 1)];
			}),
	);
	const script = `import { homedir } from 'node:os'; import { checked } from ${JSON.stringify(new URL("./update.mjs", import.meta.url).href)};
		console.log(checked(process.execPath, ['-e', 'console.log(JSON.stringify({home:require("node:os").homedir(), data:process.env.PILOT_HOME, runtime:process.env.XDG_RUNTIME_DIR, bus:process.env.DBUS_SESSION_BUS_ADDRESS, cwd:process.cwd()}))']));`;
	const result = JSON.parse(
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: f.home,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: "/foreign/user",
				PILOT_HOME: "/foreign/data",
				XDG_RUNTIME_DIR: "/run/user/foreign",
				DBUS_SESSION_BUS_ADDRESS: "unix:path=/foreign/bus",
				...environment,
			},
		}),
	);
	assert.deepEqual(result, {
		home: f.home,
		data: join(f.home, ".local/share/pilot"),
		runtime: runtimeDir,
		bus: `unix:path=${runtimeDir}/bus`,
		cwd: f.home,
	});
});

test("Linux process identity uses boot plus process start, not kill(pid, 0) alone", {
	skip: process.platform !== "linux",
}, async () => {
	const actual = await processIdentity();
	assert.equal(actual.pid, process.pid);
	assert.ok(sameProcess(actual, await processIdentity()));
	assert.equal(sameProcess({ ...actual, start: "0" }, actual), false);
});
