/** A test's suite comes from its file name: `*.fast.test.ts` is fast, `*.stress.test.ts` is stress, and every
 * other test is integration. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const SUITES = ["fast", "integration", "stress"] as const;
export type Suite = (typeof SUITES)[number];
export const TEST_LANES = ["all", "macos"] as const;
export type TestLane = (typeof TEST_LANES)[number];

async function testFiles(root: string, folder: string, recursive: boolean): Promise<string[]> {
	try {
		return (await readdir(join(root, folder), { recursive }))
			.filter((path) => path.endsWith(".test.ts"))
			.map((path) => `${folder}/${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function discoverTests(root: string): Promise<string[]> {
	const packages = (await readdir(join(root, "packages"), { withFileTypes: true })).filter((entry) =>
		entry.isDirectory(),
	);
	const groups = await Promise.all([
		...packages.map(({ name }) => testFiles(root, `packages/${name}/src`, true)),
		testFiles(root, "apps/day/node-tests", true),
		testFiles(root, "scripts", false),
	]);
	return groups.flat();
}

// Repeat OS-sensitive paths on Darwin while the broad suite runs on Linux.
const macosCoverage = new Set([
	"packages/kernel/src/tools/ask/ask.integration.test.ts",
	"packages/daemon/src/runtime/coordination/coordinator-role.test.ts",
	"packages/daemon/src/projects/dashboard/main-view.test.ts",
	"packages/daemon/src/runtime/platform/platform.test.ts",
	"packages/daemon/src/schedules/schedule-detection.fast.test.ts",
	"packages/daemon/src/sessions/terminals/terminals.test.ts",
	"packages/daemon/src/sessions/terminals/pty-input.test.ts",
	"packages/daemon/src/sessions/terminals/terminal-output.test.ts",
	"packages/daemon/src/sessions/terminals/workspace-terminal-server.test.ts",
	"packages/kernel/src/runtime/bundled-extensions.integration.test.ts",
	"packages/kernel/src/runtime/runtime-environment.test.ts",
]);

/** Known subprocess-heavy files start first to avoid a long serial tail. Concurrency stays limited. */
const weights: [RegExp, number][] = [
	[/shared-workspaces-/, 4],
	[/session-workspaces-/, 3],
	[/\/(ask-sessions|changes|workspaces)[.]/, 2],
];

/** Fails when a configured path or weight pattern no longer names a discovered file. */
export function testLaneFiles(files: string[], lane: TestLane): string[] {
	const stale = weights
		.filter(([pattern]) => !files.some((path) => pattern.test(path)))
		.map(([pattern]) => String(pattern));
	if (lane === "macos") stale.push(...[...macosCoverage].filter((path) => !files.includes(path)));
	if (stale.length) throw new Error(`Configured tests were not discovered: ${stale.join(", ")}`);
	return lane === "all" ? files : files.filter((path) => macosCoverage.has(path));
}

export function testLimits(env: Record<string, string | undefined>) {
	const positive = (name: string, fallback: number): number => {
		const raw = env[name] ?? String(fallback);
		const value = Number(raw);
		if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value))
			throw new Error(`${name} must be a positive integer`);
		return value;
	};
	return { concurrency: positive("PILOT_TEST_CONCURRENCY", 2), timeoutMs: positive("PILOT_TEST_TIMEOUT_MS", 120_000) };
}

export function testSuite(path: string): Suite {
	if (path.endsWith(".fast.test.ts")) return "fast";
	if (path.endsWith(".stress.test.ts")) return "stress";
	return "integration";
}

export function testWeight(path: string): number {
	return weights.find(([pattern]) => pattern.test(path))?.[1] ?? 1;
}
