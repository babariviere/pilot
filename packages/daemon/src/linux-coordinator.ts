/** Linux coordinators require a verified bubblewrap boundary. No binary-presence or chmod fallback. */
import { type ChildProcess, execFile, fork } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, opendir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type CredentialEndpoint, credentialEnvironment } from "@pilot/kernel/credential-client";
import { credentialRequest } from "@pilot/kernel/credential-rpc";

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
	const mounts =
		process.platform === "linux"
			? (await readFile("/proc/self/mountinfo", "utf8"))
					.trim()
					.split("\n")
					.map((line) =>
						line
							.split(" ")[4]!
							.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))),
					)
			: [];
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
			for await (const child of await opendir(path)) await inspect(join(path, child.name));
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
		// A bind mount can alias repository inodes without symlinks or nlink>1. Never recursively
		// re-expose any pre-existing mount (even at the root itself) through a writable exception.
		if (mounts.some((mount) => within(mount, canonical)))
			throw new Error(`Coordinator private state contains a mount point: ${path}`);
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

export async function forkLinuxCoordinator(
	entry: string,
	view: CoordinatorPaths,
	state: { storageDir: string; agentDir: string; credentials?: CredentialEndpoint },
): Promise<ChildProcess> {
	try {
		if (!state.credentials) throw new Error("Canonical credential broker is required; refusing private snapshots");
		await credentialRequest(state.credentials, { op: "list", namespace: "pi" });
		const executable = await bubblewrap();
		const sessionDir = dirname(state.storageDir);
		if ((await realpath(sessionDir)) !== resolve(sessionDir))
			throw new Error("Coordinator session directory is not canonical");
		await rm(join(sessionDir, "coordinator-auth"), { recursive: true, force: true });
		const artifacts = join(sessionDir, "artifacts");
		for (const path of [state.storageDir, artifacts]) await mkdir(path, { recursive: true, mode: 0o700 });
		const writable = await validateCoordinatorWrites(
			[view.scratch, state.storageDir, artifacts],
			view.protectedPaths,
		);
		const sentinel = join(sessionDir, "coordinator-isolation-sentinel");
		const agent = await realpath(state.agentDir);
		const sources = await Promise.all(view.protectedPaths.map((path) => realpath(path)));
		if ([...sources, ...writable].some((path) => within(path, agent) || within(agent, path)))
			throw new Error("Canonical agent configuration overlaps protected source or writable private state");
		await writeFile(sentinel, "protected", { mode: 0o600 });
		const config = await boundary(writable, view.protectedPaths, sentinel);
		const args = argumentsFor(writable, view.scratch);
		return fork(entry, [], {
			cwd: view.scratch,
			execPath: executable,
			execArgv: [...args, process.execPath, guard, JSON.stringify(config)],
			env: {
				...process.env,
				...credentialEnvironment(state.credentials),
				NODE_OPTIONS: "",
				PILOT_READ_ONLY_CONFIG: "1",
				PI_CODING_AGENT_DIR: state.agentDir,
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
