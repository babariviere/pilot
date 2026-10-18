/**
 * Read-only host probes for environment plans. Toolchains come from mise: installed versions are read from mise's
 * install records (<mise data>/installs/<tool>/<version>), so no tool runs, and tool names come from its registry,
 * with no built-in tool table. Postgres is a dedicated service probed by its own binaries, run by absolute path from
 * a private empty directory with a sparse environment, so a probe cannot pick up project configuration or run
 * repository content.
 */
import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";
import type { EnvironmentService, EnvironmentTool } from "@pilot/protocol";
import { subprocesses } from "./subprocess.ts";

export const PROBE_LIMITS = {
	probes: 16,
	concurrency: 4,
	perSubject: 4,
	timeoutMs: 5000,
	outputBytes: 64 * 1024,
	/** mise's install list and registry are larger than a version line. */
	miseOutputBytes: 1024 * 1024,
	registryNames: 4096,
} as const;

export interface ProbeHost {
	platform: string;
	home: string;
	/** The daemon's PATH entries. Relative entries and shim directories are ignored. */
	path: string[];
	/** mise's data directory (MISE_DATA_DIR, or ~/.local/share/mise). */
	miseDataDir: string;
	/** Private empty directory used as the working directory of every probe. */
	neutralDir: string;
	/** Checkouts and Pilot's data: nothing under these is ever executed. */
	excluded: string[];
}

export interface ProbeRun {
	code: number | null;
	output: string;
	timedOut: boolean;
}

export interface ProbeDeps {
	executable(path: string): Promise<boolean>;
	realpath(path: string): Promise<string | undefined>;
	/** Names of subdirectories, [] when missing. */
	directories(path: string): Promise<string[]>;
	run(
		file: string,
		args: string[],
		options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number },
	): Promise<ProbeRun>;
}

export const probeDeps: ProbeDeps = {
	async executable(path) {
		try {
			await access(path, constants.X_OK);
			return (await stat(path)).isFile();
		} catch {
			return false;
		}
	},
	async realpath(path) {
		return realpath(path).catch(() => undefined);
	},
	async directories(path) {
		try {
			return (await readdir(path, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch {
			return [];
		}
	},
	async run(file, args, options) {
		const result = await subprocesses.run(file, args, {
			cwd: options.cwd,
			env: options.env,
			timeoutMs: options.timeoutMs,
			killSignal: "SIGKILL",
			detached: process.platform !== "win32",
			maxBytes: options.maxBytes,
			overflow: "truncate",
			maxStderrBytes: 64 * 1024,
		});
		return {
			code: result.code,
			output: result.truncated ? "" : result.stdout.toString("utf8"),
			timedOut: result.timedOut,
		};
	},
};

export interface ProbeResult {
	path: string;
	version?: string;
	/** "timed out", "exit 1", "no version in output". */
	error?: string;
}

export interface InstallerProbe {
	mise?: string;
	homebrew?: string;
	system?: "apt-get" | "dnf" | "yum";
	docker?: string;
}

/** What mise reports as installed, by tool name as mise lists it ("go", "aqua:owner/repo"). */
export type MiseInstalls = Record<string, { version: string; path: string }[]>;

export interface EnvironmentProbes {
	/** Versions in mise's install records, for the profile's tools. */
	mise?: MiseInstalls;
	/** Postgres server binaries per required major. */
	postgres: Record<string, ProbeResult[]>;
	installers: InstallerProbe;
	/** Probes skipped because the budget ran out. */
	exhausted: boolean;
}

function homebrewBins(host: Pick<ProbeHost, "platform" | "home">): string[] {
	return host.platform === "darwin"
		? ["/opt/homebrew/bin", "/usr/local/bin"]
		: ["/home/linuxbrew/.linuxbrew/bin", join(host.home, ".linuxbrew", "bin")];
}

/** Variables for probes: no inherited environment, no project config, no downloads. */
export function probeEnvironment(host: ProbeHost, executable: string): NodeJS.ProcessEnv {
	return {
		PATH: [dirname(executable), "/usr/bin", "/bin"].join(delimiter),
		HOME: host.home,
		TMPDIR: host.neutralDir,
		LANG: "C",
		LC_ALL: "C",
		NO_COLOR: "1",
		MISE_OFFLINE: "1",
		MISE_YES: "0",
	};
}

function within(path: string, roots: string[]): boolean {
	return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

/** Ordered, deduplicated executables named binary in dirs, never shims or anything inside a checkout. */
export async function candidates(
	host: ProbeHost,
	binary: string,
	dirs: string[],
	deps: ProbeDeps = probeDeps,
): Promise<string[]> {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const dir of [...new Set(dirs)]) {
		if (!isAbsolute(dir) || dir.split(sep).includes("shims")) continue;
		const path = join(dir, binary);
		if (within(path, host.excluded) || !(await deps.executable(path))) continue;
		const real = await deps.realpath(path);
		// mise and asdf shims resolve to the version manager itself and would choose a version from the cwd.
		const manager = ["mise", "asdf", "rtx"].includes(basename(real ?? "")) && basename(real ?? "") !== binary;
		if (!real || seen.has(real) || manager || real.split(sep).includes("shims")) continue;
		if (within(real, host.excluded)) continue;
		seen.add(real);
		result.push(path);
	}
	return result;
}

async function first(host: ProbeHost, binary: string, dirs: string[], deps: ProbeDeps): Promise<string | undefined> {
	return (await candidates(host, binary, dirs, deps))[0];
}

export async function detectInstallers(
	host: ProbeHost,
	options: { docker: boolean },
	deps: ProbeDeps = probeDeps,
): Promise<InstallerProbe> {
	const [mise, homebrew, system, docker] = await Promise.all([
		first(host, "mise", [join(host.home, ".local", "bin"), ...homebrewBins(host), ...host.path], deps),
		first(host, "brew", homebrewBins(host), deps),
		host.platform === "linux"
			? (async () => {
					for (const manager of ["apt-get", "dnf", "yum"] as const)
						if (await deps.executable(`/usr/bin/${manager}`)) return manager;
					return undefined;
				})()
			: Promise.resolve(undefined),
		options.docker
			? first(host, "docker", ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", ...host.path], deps)
			: Promise.resolve(undefined),
	]);
	return {
		...(mise ? { mise } : {}),
		...(homebrew ? { homebrew } : {}),
		...(system ? { system } : {}),
		...(docker ? { docker } : {}),
	};
}

class Budget {
	private used = 0;
	exhausted = false;
	private active = 0;
	private readonly waiting: (() => void)[] = [];

	take(): boolean {
		if (this.used >= PROBE_LIMITS.probes) {
			this.exhausted = true;
			return false;
		}
		this.used++;
		return true;
	}

	async slot<T>(work: () => Promise<T>): Promise<T> {
		if (this.active >= PROBE_LIMITS.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
		this.active++;
		try {
			return await work();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

async function runProbe(
	host: ProbeHost,
	path: string,
	args: string[],
	maxBytes: number,
	budget: Budget,
	deps: ProbeDeps,
): Promise<ProbeRun | undefined> {
	if (!budget.take()) return undefined;
	return budget.slot(async () => {
		try {
			return await deps.run(path, args, {
				cwd: host.neutralDir,
				env: probeEnvironment(host, path),
				timeoutMs: PROBE_LIMITS.timeoutMs,
				maxBytes,
			});
		} catch {
			return undefined;
		}
	});
}

/** mise's install directory name for a tool: backend references replace ":" and "/" with "-". */
export function miseInstallDir(tool: string): string {
	return tool.replace(/[:/]/g, "-");
}

/**
 * mise's install records for these tools: real version directories with a bin directory, without running mise.
 * Alias links (such as installs/node/20 → 20.11.1) are skipped; the versions they point to are listed themselves.
 */
export async function miseInstalls(
	host: Pick<ProbeHost, "miseDataDir">,
	tools: string[],
	deps: ProbeDeps = probeDeps,
): Promise<MiseInstalls> {
	const entries = await Promise.all(
		tools.map(async (tool) => {
			const root = join(host.miseDataDir, "installs", miseInstallDir(tool));
			const versions = (await deps.directories(root))
				.filter((name) => /^\d/.test(name))
				.slice(0, PROBE_LIMITS.registryNames);
			const installed: MiseInstalls[string] = [];
			for (const version of versions)
				if ((await deps.directories(join(root, version))).includes("bin"))
					installed.push({ version, path: join(root, version) });
			return [tool, installed] as const;
		}),
	);
	return Object.fromEntries(entries);
}

/** Tool names from `mise registry`: the first column of each line. */
export function parseMiseRegistry(output: string): string[] {
	const names = new Set<string>();
	for (const line of output.split("\n")) {
		const name = line.trim().split(/\s+/)[0];
		if (name && /^[a-z0-9][a-z0-9._-]*$/i.test(name)) names.add(name);
		if (names.size >= PROBE_LIMITS.registryNames) break;
	}
	return [...names];
}

/** The host's mise registry, for adding tools. Runs only the user's mise, from the neutral directory. */
export async function miseRegistry(
	host: ProbeHost,
	deps: ProbeDeps = probeDeps,
): Promise<{ mise?: string; tools: string[] }> {
	const { mise } = await detectInstallers(host, { docker: false }, deps);
	if (!mise) return { tools: [] };
	const result = await runProbe(host, mise, ["registry"], PROBE_LIMITS.miseOutputBytes, new Budget(), deps);
	return { mise, tools: result?.code === 0 ? parseMiseRegistry(result.output) : [] };
}

export const POSTGRES_PATTERN = /\(PostgreSQL\)\s+(\d+(?:\.\d+)?)/;

export function postgresDirs(host: Pick<ProbeHost, "platform" | "home">, major: string): string[] {
	return [
		...homebrewBins(host).map((bin) => join(dirname(bin), "opt", `postgresql@${major}`, "bin")),
		`/usr/lib/postgresql/${major}/bin`,
		`/usr/pgsql-${major}/bin`,
		...(host.platform === "darwin" ? [`/Applications/Postgres.app/Contents/Versions/${major}/bin`] : []),
	];
}

export function postgresMajor(version: string): string {
	return version.split(".")[0]!;
}

/** Postgres server binaries, probed until one matches the major. */
async function probePostgres(host: ProbeHost, major: string, budget: Budget, deps: ProbeDeps): Promise<ProbeResult[]> {
	const paths = await candidates(
		host,
		"postgres",
		[...postgresDirs(host, major), ...homebrewBins(host), ...host.path, "/usr/local/bin", "/usr/bin"],
		deps,
	);
	const results: ProbeResult[] = [];
	for (const path of paths.slice(0, PROBE_LIMITS.perSubject)) {
		const run = await runProbe(host, path, ["--version"], PROBE_LIMITS.outputBytes, budget, deps);
		if (!run) break;
		const version = POSTGRES_PATTERN.exec(run.output)?.[1];
		results.push(
			run.timedOut
				? { path, error: "timed out" }
				: version
					? { path, version }
					: { path, error: run.code === 0 ? "no version in output" : `exit ${run.code ?? "signal"}` },
		);
		if (version && postgresMajor(version) === major) break;
	}
	if (
		paths.length > PROBE_LIMITS.perSubject &&
		!results.some((result) => result.version && postgresMajor(result.version) === major)
	)
		budget.exhausted = true;
	return results;
}

/** Run every probe a profile needs. Changes nothing on the host. */
export async function probeHost(
	host: ProbeHost,
	tools: EnvironmentTool[],
	services: EnvironmentService[],
	deps: ProbeDeps = probeDeps,
): Promise<EnvironmentProbes> {
	const budget = new Budget();
	const installers = await detectInstallers(host, { docker: services.length > 0 }, deps);
	const miseRead = tools.length
		? miseInstalls(
				host,
				tools.map((tool) => tool.id),
				deps,
			)
		: Promise.resolve(undefined);
	const majors = [
		...new Set(services.filter((service) => service.provider === "pilot").map((service) => service.version)),
	];
	const postgresRead = Promise.all(
		majors.map(async (major) => [major, await probePostgres(host, major, budget, deps)] as const),
	);
	const [mise, postgres] = await Promise.all([miseRead, postgresRead]);
	return {
		...(mise ? { mise } : {}),
		postgres: Object.fromEntries(postgres),
		installers,
		exhausted: budget.exhausted,
	};
}
