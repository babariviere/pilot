/** Linux coordinators require a verified bubblewrap boundary. No binary-presence or chmod fallback. */
import { type ChildProcess, execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const guard = fileURLToPath(new URL("./linux-coordinator-guard.ts", import.meta.url));
const execute = promisify(execFile);
const guidance =
	"Install bubblewrap (dnf install bubblewrap, or your package manager's equivalent). Permit unprivileged user, mount, PID and IPC namespaces and nested-userns disabling in the host/container/service policy. Check AppArmor/SELinux/seccomp denials and user.max_user_namespaces; do not disable host security globally. Restart pilotd after correcting the policy. Refusing an unrestricted coordinator worker.";
export interface LinuxCoordinatorCapability {
	available: boolean;
	detail?: string;
}
export interface CoordinatorPaths {
	scratch: string;
	protectedPaths: string[];
}

function within(path: string, parent: string): boolean {
	const part = relative(parent, path);
	return part === "" || (!part.startsWith("..") && !isAbsolute(part));
}

async function bubblewrap(): Promise<string> {
	// Only system-owned installation locations, never an executable supplied by the workspace/PATH.
	for (const path of ["/usr/bin/bwrap", "/bin/bwrap"]) {
		try {
			const canonical = await realpath(path);
			const info = await lstat(canonical);
			if (!info.isFile() || info.uid !== 0 || (info.mode & 0o6022) !== 0) continue;
			await access(canonical, constants.X_OK);
			return canonical;
		} catch {}
	}
	throw new Error(`A non-setuid, root-owned bubblewrap executable is required. ${guidance}`);
}

/** Reject broad roots, symlink roots, shared directories and pre-existing hardlink write aliases. */
export async function validateCoordinatorWrites(writable: string[], protectedPaths: string[]): Promise<string[]> {
	const protectedCanonical = await Promise.all(protectedPaths.map((path) => realpath(path)));
	const result: string[] = [];
	let count = 0;
	async function inspect(path: string): Promise<void> {
		if (++count > 50_000)
			throw new Error("Coordinator private state exceeds the 50,000-entry isolation validation limit");
		const info = await lstat(path);
		if (info.isSymbolicLink()) return; // Traversal resolves into the read-only root, not another writable mount.
		if (info.uid !== process.getuid!())
			throw new Error(`Coordinator private state is not owned by this user: ${path}`);
		if (info.isDirectory()) {
			if (info.mode & 0o022) throw new Error(`Coordinator private state is shared-writable: ${path}`);
			for (const child of await readdir(path)) await inspect(join(path, child));
		} else if (!info.isFile() || info.nlink !== 1)
			throw new Error(`Coordinator private state contains a hardlink or special file: ${path}`);
	}
	for (const path of writable) {
		const canonical = await realpath(path);
		const info = await lstat(path);
		if (!info.isDirectory() || resolve(path) !== canonical || info.mode & 0o077)
			throw new Error(`Coordinator writable roots must be canonical private directories (0700): ${path}`);
		if (
			["/", "/tmp", "/var/tmp", "/home", "/run", process.env.HOME].includes(canonical) ||
			protectedCanonical.some((source) => within(source, canonical) || within(canonical, source))
		)
			throw new Error(`Coordinator writable root overlaps protected source or a broad host location: ${path}`);
		if (result.some((other) => within(canonical, other) || within(other, canonical)))
			throw new Error(`Coordinator writable roots overlap: ${path}`);
		await inspect(canonical);
		result.push(canonical);
	}
	return result;
}

async function boundary(writable: string[], protectedPaths: string[], sentinel: string) {
	const hostNamespaces = Object.fromEntries(
		await Promise.all(
			["user", "mnt", "pid", "ipc"].map(async (name) => [name, await readlink(`/proc/self/ns/${name}`)]),
		),
	);
	return {
		hostNamespaces,
		writable,
		protectedPaths: await Promise.all(protectedPaths.map((path) => realpath(path))),
		sentinel,
	};
}

function argumentsFor(writable: string[], scratch: string): string[] {
	return [
		"--unshare-user",
		"--disable-userns",
		"--assert-userns-disabled",
		"--unshare-pid",
		"--unshare-ipc",
		"--cap-drop",
		"ALL",
		"--new-session",
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--remount-ro",
		"/proc",
		"--dev",
		"/dev",
		...writable.flatMap((path) => ["--bind", path, path]),
		"--chdir",
		scratch,
	];
}

/** Runs the same guard/descendant check as every worker launch; safe fixtures only, never real source writes. */
export async function probeLinuxCoordinatorIsolation(): Promise<LinuxCoordinatorCapability> {
	if (process.platform !== "linux") return { available: false, detail: "Linux OS isolation requires Linux" };
	let root: string | undefined;
	try {
		const executable = await bubblewrap();
		root = await realpath(await mkdtemp(join(tmpdir(), "pilot-isolation-probe-")));
		const scratch = join(root, "scratch");
		await mkdir(scratch, { mode: 0o700 });
		const sentinel = join(root, "sentinel");
		await writeFile(sentinel, "protected", { mode: 0o600 });
		const config = await boundary([scratch], [sentinel], sentinel);
		const result = await execute(
			executable,
			[...argumentsFor([scratch], scratch), process.execPath, guard, JSON.stringify(config), "--probe"],
			{ timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16_384 },
		);
		if (result.stdout.trim() !== "pilot-linux-isolation-v1")
			throw new Error("Isolation guard did not acknowledge verification");
		if ((await readFile(sentinel, "utf8")) !== "protected")
			throw new Error("Isolation probe modified the protected sentinel");
		return { available: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			available: false,
			detail: `Linux coordinator isolation verification failed: ${message.slice(0, 3000)}. ${guidance}`,
		};
	} finally {
		if (root) await rm(root, { recursive: true, force: true });
	}
}

/** Private same-host auth snapshots. Refreshes persist here, never write back into executable configuration. */
async function privateAuth(directory: string, agentDir: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const marker = join(directory, ".source-revisions.json");
	let revisions: Record<string, string> = {};
	try {
		revisions = JSON.parse(await readFile(marker, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const name of ["auth.json", "mcp-auth.json"]) {
		const value = await readFile(join(agentDir, name)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return Buffer.from("{}");
		});
		const revision = createHash("sha256").update(value).digest("hex");
		if (revisions[name] !== revision) {
			const target = join(directory, name);
			await rm(target, { force: true });
			await writeFile(target, value, { flag: "wx", mode: 0o600 });
			revisions[name] = revision;
		}
	}
	await rm(marker, { force: true });
	await writeFile(marker, JSON.stringify(revisions), { mode: 0o600, flag: "wx" });
}

export async function forkLinuxCoordinator(
	entry: string,
	view: CoordinatorPaths,
	state: { storageDir: string; agentDir: string },
): Promise<ChildProcess> {
	try {
		const executable = await bubblewrap();
		const sessionDir = dirname(state.storageDir);
		if ((await realpath(sessionDir)) !== resolve(sessionDir))
			throw new Error("Coordinator session directory is not canonical");
		const auth = join(sessionDir, "coordinator-auth");
		const artifacts = join(sessionDir, "artifacts");
		for (const path of [state.storageDir, artifacts, auth]) await mkdir(path, { recursive: true, mode: 0o700 });
		// Validate before touching auth contents, then again after materializing the private snapshots.
		const writable = await validateCoordinatorWrites(
			[view.scratch, state.storageDir, artifacts, auth],
			view.protectedPaths,
		);
		await privateAuth(auth, state.agentDir);
		await validateCoordinatorWrites([auth], view.protectedPaths);
		const sentinel = join(sessionDir, "coordinator-isolation-sentinel");
		await writeFile(sentinel, "protected", { mode: 0o600 });
		const config = await boundary(writable, view.protectedPaths, sentinel);
		const args = argumentsFor(writable, view.scratch);
		// Shadow only this process's agent directory. Canonical config/resources stay read-only;
		// writable auth/locks live in the private backing directory, not in the global agent directory.
		const agentDir = await realpath(state.agentDir);
		const sources = await Promise.all(view.protectedPaths.map((path) => realpath(path)));
		if ([...writable, ...sources].some((path) => within(agentDir, path) || within(path, agentDir)))
			throw new Error("Agent directory overlaps protected source or private state");
		args.push("--bind", auth, agentDir);
		for (const name of await readdir(agentDir)) {
			if (["auth.json", "mcp-auth.json", "auth.json.lock", "mcp-auth.json.lock"].includes(name)) continue;
			args.push("--ro-bind", join(agentDir, name), join(agentDir, name));
		}
		// The shadow agent directory is a second private writable alias, validated by the guard.
		config.writable.push(agentDir);
		return fork(entry, [], {
			cwd: view.scratch,
			execPath: executable,
			execArgv: [...args, process.execPath, guard, JSON.stringify(config)],
			env: {
				...process.env,
				NODE_OPTIONS: "",
				NODE_COMPILE_CACHE: join(view.scratch, "node-cache"),
				TMPDIR: view.scratch,
				TMP: view.scratch,
				TEMP: view.scratch,
				GIT_OPTIONAL_LOCKS: "0",
			},
			serialization: "advanced",
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
	} catch (error) {
		throw new Error(`Linux coordinator isolation: ${error instanceof Error ? error.message : error}. ${guidance}`);
	}
}
