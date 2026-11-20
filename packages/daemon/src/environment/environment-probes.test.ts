import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	candidates,
	detectInstallers,
	miseInstallDir,
	miseRegistry,
	PROBE_LIMITS,
	type ProbeDeps,
	type ProbeHost,
	parseMiseRegistry,
	probeDeps,
	probeHost,
} from "./environment-probes.ts";

const host: ProbeHost = {
	platform: "darwin",
	home: "/Users/me",
	path: ["/usr/bin", "relative/bin", "/Users/me/.local/share/mise/shims", "/repo/node_modules/.bin"],
	miseDataDir: "/Users/me/.local/share/mise",
	neutralDir: "/pilot/environment/probe",
	excluded: ["/repo", "/pilot"],
};

/** A fake host: executables with their real paths and command output. Nothing is spawned. */
function fakeHost(
	files: Record<string, { real?: string; output?: string | ((args: string[]) => string); delayMs?: number }>,
	dirs: Record<string, string[]> = {},
) {
	const runs: {
		file: string;
		args: string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeoutMs: number;
		maxBytes: number;
	}[] = [];
	let active = 0;
	let peak = 0;
	const deps: ProbeDeps = {
		executable: async (path) => Object.hasOwn(files, path),
		realpath: async (path) => files[path]?.real ?? path,
		directories: async (path) => dirs[path] ?? [],
		run: async (file, args, options) => {
			runs.push({ file, args, ...options });
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, files[file]?.delayMs ?? 1));
			active--;
			const output = files[file]?.output;
			return { code: 0, output: typeof output === "function" ? output(args) : (output ?? ""), timedOut: false };
		},
	};
	return { deps, runs, peak: () => peak };
}

test("tools come from mise's install records without running anything", async () => {
	const installs = "/Users/me/.local/share/mise/installs";
	const dirs: Record<string, string[]> = {
		[`${installs}/go`]: ["1.22.5", "1.23.4", "latest-link-is-not-a-dir"],
		[`${installs}/go/1.22.5`]: ["bin"],
		[`${installs}/go/1.23.4`]: ["bin", "src"],
		[`${installs}/aqua-denoland-deno`]: ["2.9.7"],
		[`${installs}/aqua-denoland-deno/2.9.7`]: ["bin"],
		[`${installs}/node`]: ["20.11.1"],
		[`${installs}/node/20.11.1`]: [],
	};
	const { deps, runs } = fakeHost({ "/Users/me/.local/bin/mise": {} }, dirs);
	const probes = await probeHost(
		host,
		["go", "aqua:denoland/deno", "node"].map((id) => ({ id, version: "1.0.0", from: "user" as const })),
		[],
		deps,
	);
	assert.deepEqual(probes.mise, {
		go: [
			{ version: "1.22.5", path: `${installs}/go/1.22.5` },
			{ version: "1.23.4", path: `${installs}/go/1.23.4` },
		],
		"aqua:denoland/deno": [{ version: "2.9.7", path: `${installs}/aqua-denoland-deno/2.9.7` }],
		node: [],
	});
	assert.deepEqual(probes.installers.mise, "/Users/me/.local/bin/mise");
	assert.equal(runs.length, 0, "no tool or mise command runs");
	assert.equal(miseInstallDir("aqua:owner/repo"), "aqua-owner-repo");
});

test("mise registry parsing is defensive", () => {
	assert.deepEqual(
		parseMiseRegistry(
			"1password   aqua:1password/cli\ngo          core:go\n\n  golangci-lint aqua:golangci/golangci-lint\n$(bad) x\n",
		),
		["1password", "go", "golangci-lint"],
	);
});

test("the registry lists tools from the host's mise", async () => {
	const mise = "/opt/homebrew/bin/mise";
	const { deps, runs } = fakeHost({ [mise]: { output: "go  core:go\nnode core:node\n" } });
	assert.deepEqual(await miseRegistry(host, deps), { mise, tools: ["go", "node"] });
	assert.deepEqual(runs[0]!.args, ["registry"]);
	assert.equal(runs[0]!.maxBytes, PROBE_LIMITS.miseOutputBytes);
	assert.deepEqual(await miseRegistry(host, fakeHost({}).deps), { tools: [] });
});

test("candidates skip shims, checkouts and relative PATH entries", async () => {
	const { deps } = fakeHost({
		"/opt/homebrew/bin/postgres": { real: "/opt/homebrew/Cellar/postgresql@16/16.4/bin/postgres" },
		"/usr/local/bin/postgres": { real: "/opt/homebrew/Cellar/postgresql@16/16.4/bin/postgres" },
		"/Users/me/.local/share/mise/shims/postgres": {},
		"/repo/node_modules/.bin/postgres": {},
		"/usr/bin/postgres": { real: "/usr/local/bin/mise" },
		"/usr/lib/postgresql/16/bin/postgres": { real: "/repo/evil" },
	});
	assert.deepEqual(
		await candidates(
			host,
			"postgres",
			["/opt/homebrew/bin", "/usr/local/bin", "/usr/lib/postgresql/16/bin", ...host.path],
			deps,
		),
		["/opt/homebrew/bin/postgres"],
	);
});

test("Postgres probes check versioned locations for the required major, within the budget", async () => {
	const { deps } = fakeHost({
		"/opt/homebrew/opt/postgresql@16/bin/postgres": { output: "postgres (PostgreSQL) 16.4" },
		"/opt/homebrew/bin/postgres": { output: "postgres (PostgreSQL) 17.0" },
	});
	const service = {
		id: "postgres",
		kind: "postgres" as const,
		version: "16",
		provider: "pilot" as const,
		exports: {},
	};
	const probes = await probeHost(host, [], [service], deps);
	assert.deepEqual(probes.postgres["16"], [{ path: "/opt/homebrew/opt/postgresql@16/bin/postgres", version: "16.4" }]);

	const files: Record<string, { output: string; delayMs: number }> = {};
	const majors = ["11", "12", "13", "14", "15"];
	for (const major of majors)
		for (const dir of [
			`/opt/homebrew/opt/postgresql@${major}/bin`,
			`/usr/lib/postgresql/${major}/bin`,
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/usr/bin",
		])
			files[`${dir}/postgres`] = { output: "postgres (PostgreSQL) 9.6", delayMs: 5 };
	const busy = fakeHost(files);
	const many = await probeHost(
		host,
		[],
		majors.map((version) => ({ ...service, id: `pg${version}`, version })),
		busy.deps,
	);
	assert.equal(busy.runs.length, PROBE_LIMITS.probes);
	assert.ok(busy.peak() <= PROBE_LIMITS.concurrency);
	assert.equal(many.exhausted, true);
});

test("installer detection: mise, Homebrew, Linux package managers and Docker only for services", async () => {
	const linux = { ...host, platform: "linux", home: "/home/me", path: ["/usr/bin"] };
	const { deps } = fakeHost({
		"/home/me/.local/bin/mise": {},
		"/usr/bin/dnf": {},
		"/usr/bin/yum": {},
		"/usr/bin/docker": {},
	});
	assert.deepEqual(await detectInstallers(linux, { docker: false }, deps), {
		mise: "/home/me/.local/bin/mise",
		system: "dnf",
	});
	assert.equal((await detectInstallers(linux, { docker: true }, deps)).docker, "/usr/bin/docker");
	const mac = fakeHost({ "/opt/homebrew/bin/brew": {}, "/usr/bin/apt-get": {} });
	assert.deepEqual(await detectInstallers(host, { docker: false }, mac.deps), { homebrew: "/opt/homebrew/bin/brew" });
});

test("a real probe of a fake postgres runs in the neutral directory and never inside the checkout", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-environment-probe-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const neutralDir = join(root, "pilot", "environment", "probe");
	const checkout = join(root, "repo");
	const bin = join(root, "bin");
	await Promise.all([
		mkdir(neutralDir, { recursive: true }),
		mkdir(join(checkout, "bin"), { recursive: true }),
		mkdir(bin, { recursive: true }),
	]);
	await writeFile(join(bin, "postgres"), '#!/bin/sh\necho "postgres (PostgreSQL) 16.4 cwd=$(pwd)"\n');
	await writeFile(join(checkout, "bin", "postgres"), '#!/bin/sh\ntouch "$0.ran"\n');
	await Promise.all([chmod(join(bin, "postgres"), 0o755), chmod(join(checkout, "bin", "postgres"), 0o755)]);
	const outputs: string[] = [];
	const probes = await probeHost(
		{
			platform: process.platform,
			home: join(root, "home"),
			path: [join(checkout, "bin"), bin],
			miseDataDir: join(root, "mise"),
			neutralDir,
			excluded: [checkout, join(root, "pilot")],
		},
		[],
		[{ id: "postgres", kind: "postgres", version: "16", provider: "pilot", exports: {} }],
		{
			...probeDeps,
			// Only the fixture's executables: never this machine's own Postgres.
			executable: async (path) => path.startsWith(root) && (await probeDeps.executable(path)),
			run: async (file, args, options) => {
				const result = await probeDeps.run(file, args, options);
				outputs.push(result.output);
				return result;
			},
		},
	);
	assert.deepEqual(probes.postgres["16"], [{ path: join(bin, "postgres"), version: "16.4" }]);
	assert.ok(outputs[0]!.includes(`cwd=${await realpath(neutralDir)}`), outputs[0]);
	await assert.rejects(stat(join(checkout, "bin", "postgres.ran")), /ENOENT/);
});
