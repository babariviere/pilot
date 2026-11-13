#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/** Side-by-side connected installation. Never changes a profile or starts a process/service. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, cp, lstat, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export interface Selection {
	app: string;
	trustFrom: string;
	source: string;
	binarySha256: string;
	sourceProfile: string;
	targetProfile: string;
	installDirectory: string;
	port: number;
	daemonId: string;
	lineageId: string;
	projectId: string;
	projectPath: string;
	planningModel: string;
	build: string;
	operationId: string;
	savedState: string;
	updaterPublicKey: string;
}

const root = fileURLToPath(new URL("../", import.meta.url));
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
function requireThat(ok: unknown, message: string): asserts ok {
	if (!ok) throw new Error(message);
}
async function canonical(path: string) {
	requireThat(
		typeof path === "string" && isAbsolute(path) && (await realpath(path)) === path,
		`Use a canonical absolute path: ${path}`,
	);
}
async function exists(path: string) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
export async function digest(path: string) {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path)) hash.update(bytes);
	return hash.digest("hex");
}
function run(command: string, args: string[], timeout = 60_000) {
	return execFileSync(command, args, {
		encoding: "utf8",
		timeout,
		env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
}
export async function verifyApp(s: Selection, app = s.app) {
	requireThat(
		process.platform === "darwin" && process.arch === "arm64",
		"Connected installation requires macOS arm64.",
	);
	await canonical(app);
	requireThat(basename(app) === "Pilot Next.app", "Keep the supported Pilot Next.app bundle name.");
	// Daemon replacement needs the full distribution, never the runtime-free candidate.
	requireThat(
		await exists(join(app, "Contents/Resources/runtime/runtime-build.json")),
		"The connected-only candidate has no daemon runtime. Select the configured, code-sealed full Pilot distribution.",
	);
	const inputs = await json(join(app, "Contents/Resources/updater-inputs.json"));
	requireThat(inputs.source === s.source, "Bundle source differs from the selected commit.");
	// Inspect still works after explicit retirement. The selected target key,
	// executable hash/source and native verifier remain pinned independently.
	let trust = inputs.configuration;
	if (await exists(s.trustFrom)) {
		await canonical(s.trustFrom);
		trust = (await json(join(s.trustFrom, "Contents/Resources/updater-inputs.json"))).configuration;
		run("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${trust.code_requirement}`, s.trustFrom]);
		run("python3", [join(root, "apps/desktop/scripts/bundle_runtime.py"), "verify", s.trustFrom]);
	}
	for (const key of ["repository", "application_id", "code_requirement"]) {
		requireThat(trust[key] && inputs.configuration[key] === trust[key], `Candidate changes existing trust: ${key}`);
	}
	requireThat(
		inputs.configuration.public_key === s.updaterPublicKey &&
			inputs.configuration.build === s.build &&
			inputs.configuration.mode === "configured",
		"Bundle does not match the explicitly selected public updater key/build.",
	);
	run("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${trust.code_requirement}`, app]);
	run("python3", [join(root, "apps/desktop/scripts/bundle_runtime.py"), "verify", app]);
	const resources = await json(join(app, "Contents/Resources/gui-resources.json"));
	requireThat(resources.source === s.source, "Full distribution is missing source-matched NSH resources.");
	requireThat(
		(await digest(join(app, "Contents/MacOS/pilot-desktop"))) === s.binarySha256,
		"Candidate executable digest changed.",
	);
	const compiled = JSON.parse(run(join(app, "Contents/MacOS/pilot-desktop"), ["--build-input-receipt"]));
	requireThat(
		compiled.source === s.source &&
			compiled.profile === "release" &&
			isDeepStrictEqual(compiled.updater_configuration, inputs.configuration),
		"Full distribution's compiled source/trust differs.",
	);
}

async function privateFile(path: string, limit: number) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = await file.stat();
		requireThat(
			st.isFile() && st.uid === process.getuid?.() && !(st.mode & 0o077) && st.size <= limit,
			`Unsafe native identity file: ${basename(path)}`,
		);
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}
async function identity(s: Selection) {
	requireThat(
		(await privateFile(join(s.sourceProfile, "daemon-id"), 128)).trim() === s.daemonId,
		"Profile daemon identity changed.",
	);
	requireThat(
		(await privateFile(join(s.sourceProfile, "storage-lineage"), 128)).trim() === s.lineageId,
		"Profile storage lineage changed.",
	);
	const c = JSON.parse(await privateFile(join(s.sourceProfile, "github-app-capability"), 4096));
	requireThat(
		c.daemonId === s.daemonId && c.lineageId === s.lineageId && /^[a-f0-9]{64}$/.test(c.token),
		"Native credentials do not match this profile.",
	);
	return c.token as string;
}
async function get(s: Selection, path: string) {
	const token = await identity(s);
	const value = await new Promise<unknown>((accept, reject) => {
		const req = request(
			{ host: "127.0.0.1", port: s.port, path, method: "GET", headers: { "x-pilot-github-capability": token } },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("error", reject);
				res.on("data", (chunk) => {
					body += chunk;
					if (body.length > 1024 * 1024) req.destroy(new Error("Preflight reply exceeds 1 MiB."));
				});
				res.on("end", () => {
					try {
						requireThat(
							res.statusCode === 200,
							`Connected preflight refused (${res.statusCode}). No daemon change attempted.`,
						);
						accept(JSON.parse(body));
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		// Wall-clock timeout, including a slow response. No redirects, proxies or retries.
		const timer = setTimeout(
			() => req.destroy(new Error("Existing daemon is unavailable. No restart attempted.")),
			5000,
		);
		req.on("close", () => clearTimeout(timer));
		req.on("error", reject);
		req.end();
	});
	requireThat((await identity(s)) === token, "Native credentials changed during preflight.");
	return value as {
		daemonId?: string;
		lineageId?: string;
		protocolVersion?: number;
		minimumClientProtocolVersion?: number;
		capabilities?: { independentExecution?: boolean; dayOverview?: number };
		id?: string;
		path?: string;
	};
}

export async function preflight(s: Selection, verify = verifyApp) {
	const fields =
		"app trustFrom source binarySha256 sourceProfile targetProfile installDirectory port daemonId lineageId projectId projectPath planningModel build operationId savedState updaterPublicKey".split(
			" ",
		);
	requireThat(
		Object.keys(s).every((key) => fields.includes(key)),
		"Unknown selection field. Do not put credentials in the selection file.",
	);
	requireThat(
		/^[0-9]+(?:\.[0-9]+){0,3}$/.test(s.build) &&
			/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s.operationId),
		"Select a numeric build and stable operation UUID.",
	);
	requireThat(
		typeof s.savedState === "string" && isAbsolute(s.savedState),
		"Select the existing private saved GUI state file.",
	);
	for (const key of ["app", "trustFrom", "sourceProfile", "targetProfile", "projectPath"] as const)
		await canonical(s[key]);
	requireThat(
		s.sourceProfile === s.targetProfile,
		"Reuse the same canonical profile. Database copying/conversion is not supported.",
	);
	requireThat(
		/^[a-f0-9]{40}$/.test(s.source) && /^[a-f0-9]{64}$/.test(s.binarySha256),
		"Pin the full source commit and sealed executable SHA-256.",
	);
	for (const id of [s.daemonId, s.lineageId, s.projectId])
		requireThat(typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id), "Invalid native identity.");
	requireThat(Number.isInteger(s.port) && s.port > 0 && s.port <= 65535, "Select the existing daemon port.");
	requireThat(
		typeof s.planningModel === "string" && s.planningModel.trim() && s.planningModel.length <= 256,
		"Select a planning model for connected daily use.",
	);
	requireThat(
		isAbsolute(s.installDirectory) && resolve(s.installDirectory) === s.installDirectory,
		"Use an absolute installation directory.",
	);
	const parent = dirname(s.installDirectory);
	await canonical(parent);
	const st = await lstat(parent);
	requireThat(
		st.isDirectory() && st.uid === process.getuid?.() && !(st.mode & 0o022),
		"Installation parent must be yours and not group/world writable.",
	);
	for (const protectedPath of [s.app, s.trustFrom, s.sourceProfile, s.projectPath]) {
		const rel = relative(protectedPath, s.installDirectory);
		requireThat(rel.startsWith("../"), "Install outside the app, data profile and project.");
	}
	await verify(s);
	const hello = await get(s, "/api/hello");
	requireThat(hello.daemonId === s.daemonId && hello.lineageId === s.lineageId, "Connected daemon identity differs.");
	requireThat(
		typeof hello.protocolVersion === "number" &&
			hello.protocolVersion >= 1 &&
			typeof hello.minimumClientProtocolVersion === "number" &&
			hello.minimumClientProtocolVersion <= 1 &&
			hello.capabilities?.independentExecution === true,
		"Existing daemon lacks the base native protocol. Its supported migration path must be verified first.",
	);
	const project = await get(s, `/api/projects/${s.projectId}`);
	requireThat(
		project.id === s.projectId && project.path === s.projectPath,
		"Connected project differs from selection.",
	);
	return s;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function launcher(s: Selection) {
	const args = [
		join(s.installDirectory, "Pilot Next.app/Contents/MacOS/pilot-desktop"),
		"--profile",
		s.targetProfile,
		"--port",
		String(s.port),
		"--daemon-id",
		s.daemonId,
		"--lineage-id",
		s.lineageId,
		"--project-id",
		s.projectId,
		"--project-path",
		s.projectPath,
		"--journal",
		join(s.installDirectory, "window-journal"),
		"--planning-model",
		s.planningModel,
	];
	return `#!/bin/bash\nset -euo pipefail\n# Native bootstrap rechecks trust, identity and credentials on every launch.\nexec ${args.map(quote).join(" ")}\n`;
}

export async function stageApp(s: Selection, verify = verifyApp) {
	await preflight(s, verify);
	const binding = JSON.stringify(s, Object.keys(s).sort());
	if (await exists(s.installDirectory)) {
		await canonical(s.installDirectory);
		requireThat(
			(await readFile(join(s.installDirectory, "selection.json"), "utf8")) === binding,
			"Existing installation has another selection. Use a fresh directory; nothing was replaced.",
		);
		await verify(s, join(s.installDirectory, "Pilot Next.app"));
		requireThat(
			(await readFile(join(s.installDirectory, "Launch Day.command"), "utf8")) === launcher(s),
			"Installed launcher changed. Nothing was replaced.",
		);
		return "Already installed. Kept the existing window journal.";
	}
	const stage = await mkdtemp(join(dirname(s.installDirectory), ".day-install-"));
	try {
		const app = join(stage, "Pilot Next.app");
		await cp(s.app, app, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
		await verify(s, app);
		await writeFile(join(stage, "selection.json"), binding, { mode: 0o600, flag: "wx" });
		await writeFile(join(stage, "Launch Day.command"), launcher(s), { mode: 0o700, flag: "wx" });
		await identity(s);
		requireThat(!(await exists(s.installDirectory)), "Installation destination appeared. Nothing was replaced.");
		// Only a fresh side-by-side directory is published. No app/profile replacement.
		await rename(stage, s.installDirectory);
		return "Installed, not launched. Open Launch Day.command when ready.";
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

export type NativeAction = "preflight" | "apply" | "inspect" | "retire";
export interface NativeResult {
	state?: string;
	changed?: boolean;
	completion?: { role?: string };
	releaseReceipt?: { state?: string };
	[key: string]: unknown;
}
export function handoffArgs(s: Selection, action: NativeAction) {
	return [
		"--daemon-handoff",
		action,
		"--profile",
		s.targetProfile,
		"--port",
		String(s.port),
		"--daemon-id",
		s.daemonId,
		"--lineage-id",
		s.lineageId,
		"--operation-id",
		s.operationId,
		"--source",
		s.source,
		"--build",
		s.build,
		"--saved-state",
		s.savedState,
		"--old-app",
		s.trustFrom,
	];
}
export function nativeAction(s: Selection, action: NativeAction, app: string): NativeResult {
	try {
		return JSON.parse(run(join(app, "Contents/MacOS/pilot-desktop"), handoffArgs(s, action), 300_000));
	} catch (error) {
		const stdout = (error as { stdout?: string | Buffer }).stdout;
		if (stdout) {
			let value: { error?: unknown; recovery?: unknown };
			try {
				value = JSON.parse(String(stdout));
			} catch {
				value = {};
			}
			if (typeof value.error === "string")
				throw new Error(
					`Native ${action}: ${value.error}. ${typeof value.recovery === "string" ? value.recovery : "Inspect the original operation."}`,
				);
		}
		throw new Error(
			`Native ${action} failed or its reply was lost. Keep the app, profile and original operation UUID; run inspect, never repeat apply.`,
		);
	}
}

async function durableNew(path: string, value: unknown) {
	const f = await open(path, "wx", 0o600);
	try {
		await f.writeFile(JSON.stringify(value));
		await f.sync();
	} finally {
		await f.close();
	}
	const parent = await open(dirname(path), "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}

export async function install(s: Selection, verify = verifyApp, native = nativeAction) {
	const app = join(s.installDirectory, "Pilot Next.app");
	const entered = join(s.installDirectory, "handoff-entered.json");
	if (await exists(entered)) {
		requireThat(isDeepStrictEqual(await json(entered), s), "Retained operation selection differs. Nothing replayed.");
		await verify(s, app);
		return native(s, "inspect", app); // Observation only, even if an earlier apply completed.
	}
	await preflight(s, verify);
	const ready = native(s, "preflight", s.app);
	requireThat(ready.state === "ready" && ready.changed === false, "Native handoff preflight was not ready.");
	await stageApp(s, verify);
	await durableNew(entered, s); // Persist before possible service effects. Never recreate on retry.
	const result = native(s, "apply", app);
	requireThat(
		result.state === "complete" &&
			result.completion?.role === "successor" &&
			result.releaseReceipt?.state === "accepted",
		"Successor/release not complete. Keep old app/runtimes and inspect the original operation.",
	);
	await durableNew(join(s.installDirectory, "handoff-complete.json"), result);
	return result;
}

async function main() {
	const [mode, file, ...extra] = process.argv.slice(2);
	requireThat(
		["preflight", "install", "inspect", "retire"].includes(mode) &&
			file &&
			(extra.length === 0 || (extra.length === 1 && extra[0] === "--gui-closed")),
		"Usage: node scripts/day-install.ts preflight|install|inspect|retire /absolute/selection.json [--gui-closed]",
	);
	const s: Selection = await json(file);
	let result: unknown;
	if (mode === "install" || mode === "retire") {
		requireThat(
			extra[0] === "--gui-closed",
			"Save and close GPUI normally first, then pass --gui-closed. This flag is your acknowledgement, not a fabricated native close receipt.",
		);
		if (mode === "install") result = await install(s);
		else {
			const app = join(s.installDirectory, "Pilot Next.app");
			await verifyApp(s, app);
			result = nativeAction(s, "retire", app);
		}
	} else if (mode === "inspect") {
		const app = join(s.installDirectory, "Pilot Next.app");
		await verifyApp(s, app);
		result = nativeAction(s, "inspect", app);
	} else {
		await preflight(s);
		result = nativeAction(s, "preflight", s.app);
	}
	console.log(
		"Requested order: install verified Day, update the same daemon safely, verify successor, then retire Pilot Next and unused runtimes.",
	);
	console.log("Reuse the same profile. Never delete shared data or GUI drafts with runtime cleanup.");
	console.log("GPUI drafts/settings stay in GPUI. Day uses its own window journal. No parity claim.");
	console.log(JSON.stringify(result));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => {
		console.error(`Day installation stopped: ${error.message}`);
		process.exitCode = 1;
	});
}
