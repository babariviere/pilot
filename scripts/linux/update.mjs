/** Independent systemd user-service updater. No sudo, tool replay, database restore or downgrade. */

import { spawnSync } from "node:child_process";
import { createPublicKey, randomUUID } from "node:crypto";
import { lstat, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	committedPhases,
	privateUpdateDirectory,
	processIdentity,
	readUpdate,
	sameProcess,
	writeUpdate,
} from "../../packages/daemon/src/runtime-update-journal.ts";
import { authenticateManifest } from "./release-manifest.mjs";
import { probe, serviceUnit } from "./service.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const unitName = "pilot-update.service";
class UpdateBlocked extends Error {
	constructor(code, detail, plan) {
		super(detail);
		this.code = code;
		this.plan = plan;
	}
}
/** Stable numeric releases only. Unknown/pre-release values cannot authorize a downgrade or repair. */
export function checkTargetVersion(current, target, sameRuntime = false) {
	const parse = (value) => {
		if (typeof value !== "string" || value.length > 96 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
			throw new UpdateBlocked(
				"version",
				"The running or requested runtime version cannot be compared safely. No service was changed.",
			);
		return value.split(".").map((part) => BigInt(part));
	};
	const running = parse(current),
		requested = parse(target);
	for (let index = 0; index < 3; index++) {
		if (requested[index] < running[index])
			throw new UpdateBlocked(
				"newer-runtime",
				"The devbox runs a newer Pilot runtime. Update this app before updating the devbox; downgrades are not supported.",
			);
		if (requested[index] > running[index]) return "upgrade";
	}
	if (!sameRuntime)
		throw new UpdateBlocked(
			"repair",
			"This version is already running from another package. Replacing it needs explicit repair; an ordinary update will not restart it.",
		);
	return "current";
}
export function checked(command, args, timeout = 20_000) {
	const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 128 * 1024 });
	if (result.status !== 0)
		throw new Error("The owned update service could not complete a service operation. Check its journal.");
	return result.stdout.trim();
}
const ctl = (...args) => checked("systemctl", ["--user", ...args]);
export function updaterUnit(runtime, home) {
	// Reuse the service's audited systemd path encoding, including percent/dollar expansion.
	const base = serviceUnit(runtime, home);
	const exec = base
		.split("\n")
		.find((line) => line.startsWith("ExecStart="))
		.replace("packages/daemon/src/main.ts", "scripts/linux/update.mjs");
	const environment = base
		.split("\n")
		.filter((line) => line.startsWith("Environment="))
		.join("\n");
	// A user manager can inherit another login's HOME/XDG values. Never derive the update
	// journal/lock or user bus from those inherited values. %t is this systemd user's runtime dir.
	return `# Managed by Pilot remote updater v1\n[Unit]\nDescription=Finish a requested Pilot update\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=%h\n${exec} run\n${environment}\nEnvironment="XDG_RUNTIME_DIR=%t"\nEnvironment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"\nUMask=0077\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n`;
}
export async function replaceOwned(file, oldValue, newValue) {
	if ((await realpath(dirname(file))) !== dirname(file)) throw new Error("Service paths must not traverse links");
	const info = await lstat(file);
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		info.uid !== process.getuid() ||
		info.mode & 0o022 ||
		(await readFile(file, "utf8")) !== oldValue
	)
		throw new Error("Service ownership changed. No unit was replaced.");
	const temp = `${file}.${randomUUID()}.pilot-update.tmp`;
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.writeFile(newValue);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if ((await readFile(file, "utf8")) !== oldValue) throw new Error("Service ownership changed during publication");
		await rename(temp, file);
		const directory = await open(dirname(file), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temp).catch(() => {});
	}
}
export function rootFromUnit(unit, home) {
	const match = /^ExecStart="((?:[^"\\]|\\.)*)\/node\/bin\/node" /m.exec(unit);
	if (!match) throw new Error("The installed service is not owned by Pilot");
	const from = match[1]
		.replace(/\\([\\"])/g, "$1")
		.replaceAll("%%", "%")
		.replaceAll("$$", "$");
	if (serviceUnit(from, home) !== unit) throw new Error("The installed service was changed. Repair it explicitly.");
	return from;
}
async function secureRuntime(runtime, home) {
	const base = join(home, ".local/share/pilot/runtimes");
	if (
		!runtime.startsWith(`${base}/`) ||
		!/^[a-f0-9]{64}\/runtime$/.test(runtime.slice(base.length + 1)) ||
		(await realpath(runtime)) !== runtime
	)
		throw new Error("Runtime path is not a complete owned package");
	await privateUpdateDirectory(dirname(runtime));
	if ((await readFile(join(runtime, "../complete"), "utf8")).trim() !== dirname(runtime).split("/").at(-1))
		throw new Error("Runtime completion record changed");
}
export function verifyRequest(metadata) {
	const bytes = Buffer.from(metadata.manifest, "base64"),
		signature = Buffer.from(metadata.signature, "base64");
	const raw = Buffer.from(metadata.publicKey, "base64");
	if (raw.length !== 32) throw new Error("A trusted app signing key is required");
	const key = createPublicKey({
		key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
		format: "der",
		type: "spki",
	});
	const manifest = authenticateManifest(bytes, signature, key);
	if (
		manifest.version !== metadata.version ||
		manifest.archive.sha256 !== metadata.archive ||
		!/^[a-f0-9-]{36}$/.test(metadata.id) ||
		!/^[a-f0-9-]{36}$/.test(metadata.daemonId) ||
		!/^[a-f0-9-]{36}$/.test(metadata.lineageId)
	)
		throw new Error("Authenticated update coordinates do not match");
	return manifest;
}
async function identity(home, journal) {
	for (const [name, expected] of [
		["daemon-id", journal.daemonId],
		["storage-lineage", journal.lineageId],
	])
		if ((await readFile(join(home, name), "utf8")).trim() !== expected)
			throw new Error("Pinned host history changed");
}
async function ownedState(journal, home, allowTarget = false) {
	await identity(join(home, ".local/share/pilot"), journal);
	const file = join(home, ".config/systemd/user/pilotd.service");
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid())
		throw new Error("Service path ownership changed");
	const unit = await readFile(file, "utf8");
	if (unit !== journal.oldUnit && !(allowTarget && unit === journal.newUnit)) throw new Error("Service unit changed");
	const state = Object.fromEntries(
		ctl("show", "pilotd.service", "--property=FragmentPath,DropInPaths,MainPID,InvocationID,ActiveState")
			.split("\n")
			.map((line) => {
				const at = line.indexOf("=");
				return [line.slice(0, at), line.slice(at + 1)];
			}),
	);
	if (state.FragmentPath !== file || state.DropInPaths)
		throw new Error("Service ownership or administrator overrides changed. Review them explicitly.");
	return { ...state, unit, file };
}
async function api(action, id) {
	const response = await fetch(`http://127.0.0.1:4319/api/runtime-update${action ? `/${action}` : ""}`, {
		method: action ? "POST" : "GET",
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
		...(action ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) } : {}),
	});
	if (!response.ok) throw new Error("The daemon could not confirm the update barrier");
	return response.json();
}
async function runningHello() {
	const response = await fetch("http://127.0.0.1:4319/api/hello", {
		redirect: "error",
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new Error("Cannot confirm the running runtime version");
	return response.json();
}
export async function prepare(metadata, runtime = root, home, preflight = { state: ownedState, hello: runningHello }) {
	home ??= await realpath(homedir());
	if (
		Object.keys(metadata).some(
			(key) =>
				!["id", "daemonId", "lineageId", "version", "archive", "manifest", "signature", "publicKey"].includes(key),
		)
	)
		throw new Error("Unexpected update request fields");
	verifyRequest(metadata); // Key is provided by the signed app over authenticated SSH, never an asset/host.
	await secureRuntime(runtime, home);
	if (dirname(runtime).split("/").at(-1) !== metadata.archive) throw new Error("Staged package digest differs");
	const data = join(home, ".local/share/pilot");
	const previous = await readUpdate(data);
	const retired = join(data, "runtime-update", `${metadata.id}.json`);
	if (await lstat(retired).catch(() => undefined))
		throw new Error("This update ID is already retired. Its original receipt was retained.");
	if ((await readdir(join(data, "runtime-update"))).length > 128)
		throw new Error("Update receipts need explicit reconciliation before more updates");
	if (previous) {
		if (previous.id === metadata.id) {
			for (const key of ["manifest", "signature", "publicKey", "archive", "daemonId", "lineageId", "version"])
				if (previous[key] !== metadata[key]) throw new Error("Update ID already has another request");
			if (!committedPhases.has(previous.phase) && previous.phase !== "cancelled") {
				const hello = await preflight.hello();
				if (
					hello.daemonId !== previous.daemonId ||
					hello.lineageId !== previous.lineageId ||
					hello.capabilities.runtimeUpdates !== 1
				)
					throw new UpdateBlocked("compatibility", "The current host cannot confirm this saved update request.");
				checkTargetVersion(hello.daemonVersion, metadata.version, previous.from === previous.to);
			}
			return previous;
		}
		if (!["completed", "cancelled"].includes(previous.phase))
			throw new Error("Another update still needs reconciliation");
		if (ctl("show", unitName, "--property=ActiveState", "--value") === "active")
			throw new Error("The previous updater is still finishing. Check its status before starting another update.");
		// Old receipts are retained, not expired or silently overwritten.
		const archive = join(data, "runtime-update", `${previous.id}.json`);
		if (!(await lstat(archive).catch(() => undefined))) {
			const handle = await open(archive, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(previous));
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
	}
	const file = join(home, ".config/systemd/user/pilotd.service");
	const oldUnit = await readFile(file, "utf8"),
		from = rootFromUnit(oldUnit, home);
	await secureRuntime(from, home);
	const journal = {
		...metadata,
		schema: 1,
		revision: 1,
		phase: "staged",
		blockers: [],
		from,
		to: runtime,
		oldUnit,
		newUnit: serviceUnit(runtime, home),
	};
	await preflight.state(journal, home);
	const hello = await preflight.hello();
	if (
		hello.daemonId !== journal.daemonId ||
		hello.lineageId !== journal.lineageId ||
		hello.capabilities.runtimeUpdates !== 1
	)
		throw new UpdateBlocked(
			"compatibility",
			"The running service does not support safe remote updates. No service was changed.",
		);
	const versionAction = checkTargetVersion(hello.daemonVersion, metadata.version, from === runtime);
	if (versionAction === "current") {
		const complete = {
			...journal,
			phase: "completed",
			detail: "This runtime is already current. No restart was needed.",
		};
		await writeUpdate(data, complete);
		return complete;
	}
	const prerequisites = probe();
	if (!prerequisites.ok)
		throw new UpdateBlocked(
			"prerequisites",
			"Service prerequisites changed. Review the package or linger plan; no privilege changes were made.",
			prerequisites,
		);
	try {
		checked("flock", ["--version"]);
	} catch {
		throw new UpdateBlocked(
			"prerequisites",
			"The host needs the util-linux file-locking helper before updating. Review the package plan; no package was installed.",
			prerequisites.packagePlan,
		);
	}
	checked(join(runtime, "node/bin/node"), [join(runtime, "check-runtime.mjs")], 60_000);
	journal.detail =
		"Package staged, but the update request is not confirmed. Retry this same update ID to start its independent remote owner.";
	await writeUpdate(data, journal);
	return journal;
}

/** A staged record alone is not acceptance. Publication follows durable enablement/start of its owner. */
export async function confirmRequest(journal, home, effects = { installRunner, write: writeUpdate }) {
	if (["completed", "cancelled"].includes(journal.phase)) return journal;
	await effects.installRunner(journal, home);
	if (journal.phase !== "staged") return journal;
	const confirmed = {
		...journal,
		phase: "requested",
		revision: journal.revision + 1,
		detail: "Update requested. Its independent remote owner will wait for running work.",
	};
	await effects.write(join(home, ".local/share/pilot"), confirmed);
	return confirmed;
}
export async function installRunner(journal, home) {
	home ??= await realpath(homedir());
	const file = join(home, ".config/systemd/user", unitName),
		expected = updaterUnit(journal.to, home);
	if ((await realpath(dirname(file))) !== dirname(file)) throw new Error("Updater paths must not traverse links");
	const info = await lstat(file).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (info && (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o022))
		throw new Error("The updater service has different ownership");
	const loaded = ctl("show", unitName, "--property=FragmentPath", "--value");
	if (loaded && loaded !== file) throw new Error("A different updater unit is already loaded");
	const existing = await readFile(file, "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (existing === undefined) {
		const handle = await open(file, "wx", 0o600);
		try {
			await handle.writeFile(expected);
			await handle.sync();
		} finally {
			await handle.close();
		}
	} else if (existing !== expected) {
		// Only the completed prior updater's exact content may be replaced.
		const previous = await readFile(join(home, ".local/share/pilot/runtime-update", "runner.json"), "utf8");
		if (
			JSON.parse(previous).unit !== existing ||
			ctl("show", unitName, "--property=ActiveState", "--value") === "active"
		)
			throw new Error("A different updater owns the service");
		await replaceOwned(file, existing, expected);
	}
	await writeRunnerReceipt(home, expected);
	const unitDirectory = await open(dirname(file), "r");
	try {
		await unitDirectory.sync();
	} finally {
		await unitDirectory.close();
	}
	ctl("daemon-reload");
	ctl("enable", unitName);
	const wants = await open(join(dirname(file), "default.target.wants"), "r");
	try {
		await wants.sync();
	} finally {
		await wants.close();
	}
	ctl("start", unitName);
}
async function writeRunnerReceipt(home, unit) {
	const { durableJSON } = await import("../../packages/daemon/src/operation-journal.ts");
	await durableJSON(join(home, ".local/share/pilot/runtime-update/runner.json"), { unit });
}

/** Fault hooks are injectable only in tests, not environment variables accepted by the installed service. */
export async function reconcile(home, effects) {
	const data = join(home, ".local/share/pilot");
	let journal = await effects.read(data);
	if (!journal || ["completed", "cancelled"].includes(journal.phase)) return "done";
	verifyRequest(journal);
	await effects.verify(journal);
	const save = async (phase, extra = {}) => {
		journal = { ...journal, ...extra, phase, revision: journal.revision + 1 };
		await effects.write(data, journal);
	};
	const cancel = async () => {
		if (!committedPhases.has(journal.phase) && (await effects.cancelled?.(journal.id))) {
			await save("cancelled", { blockers: [], detail: "Update cancelled. Running work was not stopped." });
			return true;
		}
		return false;
	};
	if (await cancel()) return "done";
	if (["staged", "requested", "waiting", "draining", "ready"].includes(journal.phase)) {
		await save("draining", { blockers: [], detail: undefined });
		let proof;
		const deadline = effects.now() + 10_000;
		do {
			proof = await effects.api("drain", journal.id);
			if (proof.ready || !proof.blockers.every((item) => item.kind === "tool-drain")) break;
			await effects.delay(100);
		} while (effects.now() < deadline);
		if (!proof.ready) {
			await save("waiting", {
				blockers: proof.blockers,
				detail: "Waiting for running work. Let it finish, or explicitly stop jobs and close shells.",
			});
			return "waiting"; // Journal watcher releases tools and admissions. Never hold children indefinitely.
		}
		const state = await effects.state(journal);
		if (!sameProcess(proof.process, await effects.process(Number(state.MainPID))))
			throw new Error("Service process changed before restart");
		await save("ready", { process: proof.process, invocation: state.InvocationID, blockers: [] });
		const final = await effects.api("commit", journal.id);
		if (!final.ready || !sameProcess(journal.process, final.process)) {
			await save("waiting", { blockers: final.blockers });
			return "waiting";
		}
		if (await cancel()) return "done";
		await save("stopping"); // Restart authorization is durable before the external stop.
	}
	if (journal.phase === "needs-repair") return "repair";
	if (journal.phase === "stopping") {
		const state = await effects.state(journal);
		if (Number(state.MainPID) > 0) {
			if (
				!sameProcess(journal.process, await effects.process(Number(state.MainPID))) ||
				state.InvocationID !== journal.invocation
			) {
				// Reboot/replacement invalidates the old proof. New daemon is startup-fenced, inspect it afresh.
				await save("draining", { process: undefined, invocation: undefined });
				return "waiting";
			}
			await effects.stop(journal);
		}
		if (Number((await effects.state(journal)).MainPID) !== 0) throw new Error("Old service has not exited");
		await save("switching");
	}
	if (journal.phase === "switching") {
		const state = await effects.state(journal);
		if (Number(state.MainPID) > 0 && state.unit === journal.oldUnit) {
			// A reboot may start the old enabled unit after the prior stop. Its startup fence is
			// not a process proof: acquire a fresh correlated drain before stopping that invocation.
			await save("draining", { process: undefined, invocation: undefined });
			return "waiting";
		}
		if (Number(state.MainPID) === 0) await effects.publish(journal);
		else if (state.unit !== journal.newUnit) throw new Error("Unexpected service process during publication");
		await save("validating");
	}
	if (journal.phase === "validating") {
		await effects.start(journal);
		await effects.health(journal);
		await save("completed", { detail: "Update installed. Saved chats can continue.", blockers: [] });
	}
	return "done";
}
export async function run(home) {
	home ??= await realpath(homedir());
	const effects = {
		read: readUpdate,
		write: writeUpdate,
		now: Date.now,
		delay,
		api,
		process: processIdentity,
		cancelled: async (id) => {
			try {
				return (
					JSON.parse(await readFile(join(home, ".local/share/pilot/runtime-update/cancel.json"), "utf8")).id === id
				);
			} catch (error) {
				if (error.code === "ENOENT") return false;
				throw error;
			}
		},
		verify: async (journal) => {
			await secureRuntime(journal.to, home);
			await secureRuntime(journal.from, home);
			await identity(join(home, ".local/share/pilot"), journal);
			if (!probe().ok) throw new Error("Persistent-service prerequisites changed; explicit repair is required");
			if (!committedPhases.has(journal.phase)) {
				const response = await fetch("http://127.0.0.1:4319/api/hello", {
					redirect: "error",
					signal: AbortSignal.timeout(5000),
				});
				const hello = await response.json();
				if (!response.ok || hello.daemonId !== journal.daemonId || hello.lineageId !== journal.lineageId)
					throw new Error("Cannot confirm the running host history");
				checkTargetVersion(hello.daemonVersion, journal.version, journal.from === journal.to);
			}
		},
		state: (journal) => ownedState(journal, home, true),
		stop: async () => {
			ctl("stop", "pilotd.service");
		},
		publish: async (journal) => {
			const state = await ownedState(journal, home, true);
			if (Number(state.MainPID) !== 0) throw new Error("A service process appeared before unit replacement");
			if (state.unit !== journal.newUnit) await replaceOwned(state.file, journal.oldUnit, journal.newUnit);
			ctl("daemon-reload");
		},
		start: async (journal) => {
			await ownedState(journal, home, true);
			ctl("start", "pilotd.service");
		},
		health: async (journal) => {
			const deadline = Date.now() + 60_000;
			while (true) {
				try {
					const response = await fetch("http://127.0.0.1:4319/api/hello", {
						redirect: "error",
						signal: AbortSignal.timeout(3000),
					});
					const hello = await response.json();
					const state = await ownedState(journal, home, true);
					if (
						response.ok &&
						hello.daemonId === journal.daemonId &&
						hello.lineageId === journal.lineageId &&
						hello.daemonVersion === journal.version &&
						hello.protocolVersion === 1 &&
						hello.minimumClientProtocolVersion >= 1 &&
						hello.minimumClientProtocolVersion <= 1 &&
						hello.platform === "linux" &&
						hello.arch === "x64" &&
						hello.capabilities.independentExecution &&
						hello.capabilities.runtimeUpdates === 1 &&
						hello.capabilities.coordinatorIsolation &&
						state.unit === journal.newUnit &&
						state.ActiveState === "active" &&
						Number(state.MainPID) > 0
					)
						return;
				} catch {
					/* bounded readiness wait; never starts work or guesses a process */
				}
				if (Date.now() >= deadline)
					throw new Error(
						"The new service needs repair. Saved ownership is retained; no downgrade or data restore was attempted.",
					);
				await delay(500);
			}
		},
	};
	try {
		while ((await reconcile(home, effects)) === "waiting") await delay(3000);
	} catch (error) {
		const data = join(home, ".local/share/pilot"),
			journal = await readUpdate(data);
		if (journal && !committedPhases.has(journal.phase))
			await writeUpdate(data, {
				...journal,
				phase: "waiting",
				revision: journal.revision + 1,
				blockers: [{ kind: "unknown-process", id: "update-check" }],
				detail: "Could not confirm that running work is safe to restart. The update will check again.",
			});
		else if (journal && journal.phase !== "completed")
			await writeUpdate(data, {
				...journal,
				revision: journal.revision + 1,
				detail:
					"The new runtime could not be confirmed. Saved work remains protected while the remote updater checks again.",
			});
		throw error; // systemd retries; pre-commit failures release tools rather than leaving them frozen.
	}
}
async function main() {
	const [action, encoded] = process.argv.slice(2);
	if (action === "prepare") {
		if (!encoded || encoded.length > 100_000) throw new Error("Missing authenticated update request");
		const journal = await prepare(JSON.parse(Buffer.from(encoded, "base64")));
		await confirmRequest(journal, await realpath(homedir()));
		console.log(JSON.stringify({ ok: true, id: journal.id, requestConfirmed: true }));
	} else if (action === "run") {
		// flock lives outside pilotd's cgroup and serializes activation with bootstrap/staging.
		const home = await realpath(homedir());
		if (!process.argv.includes("--locked")) {
			const lock = join(home, ".local/share/pilot/runtimes/.bootstrap.lock");
			checked(
				"flock",
				["--nonblock", lock, process.execPath, fileURLToPath(import.meta.url), "run", "--locked"],
				24 * 60 * 60 * 1000,
			);
			return;
		}
		await run(home);
		ctl("disable", unitName); // Keep the exact unit and receipt for later ownership checks.
	} else throw new Error("Usage: update.mjs prepare|run");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main().catch((error) => {
		if (process.argv[2] === "prepare") {
			console.log(
				JSON.stringify(
					error instanceof UpdateBlocked
						? { ok: false, code: error.code, detail: error.message, plan: error.plan }
						: {
								ok: false,
								code: "update",
								detail:
									"The update request could not be confirmed. Reconnect and check the same update. Inspect the owned service journal if it still needs repair; no unsafe fallback was attempted.",
							},
				),
			);
			return;
		}
		console.error(
			"The remote update needs reconciliation. Check journalctl --user -u pilot-update. No unsafe fallback was attempted.",
		);
		process.exitCode = 1;
	});
