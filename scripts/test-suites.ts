/** Unknown tests stay in the integration gate; fast feedback is an explicit opt-in. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function discoverTests(root: string): Promise<string[]> {
	const packages = (await readdir(join(root, "packages"), { withFileTypes: true })).filter((entry) =>
		entry.isDirectory(),
	);
	const groups = await Promise.all(
		packages.map(async ({ name }) => {
			try {
				return (await readdir(join(root, "packages", name, "src"), { recursive: true }))
					.filter((path) => path.endsWith(".test.ts"))
					.map((path) => `packages/${name}/src/${path}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		}),
	);
	return groups
		.flat()
		.concat(
			(await readdir(join(root, "scripts")))
				.filter((path) => path.endsWith(".test.ts"))
				.map((path) => `scripts/${path}`),
		);
}

export type Suite = "fast" | "integration" | "stress";
export type TestLane = "all" | "portable" | "macos";

// This integration exercises native SwiftUI publication and preview, not just validation.
const macosOnly = new Set(["packages/kernel/src/ask.integration.test.ts"]);

// Repeat OS-sensitive paths on Darwin while the broad suite runs on Linux.
const macosCoverage = new Set([
	"packages/artifacts/src/preview.test.ts",
	"packages/artifacts/src/swiftui.test.ts",
	"packages/daemon/src/coordinator-role.test.ts",
	"packages/daemon/src/main-view.test.ts",
	"packages/daemon/src/platform.test.ts",
	"packages/daemon/src/schedule-detection.test.ts",
	"packages/daemon/src/terminals.test.ts",
	"packages/kernel/src/bundled-extensions.integration.test.ts",
	"packages/kernel/src/runtime-environment.test.ts",
]);

export function testInLane(path: string, lane: TestLane): boolean {
	if (lane === "all") return true;
	if (lane === "portable") return !macosOnly.has(path);
	return macosOnly.has(path) || macosCoverage.has(path);
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

const fast = new Set([
	"artifacts/image",
	"daemon/backpressure",
	"daemon/config",
	"daemon/coordinator-compaction",
	"daemon/event-loop-watchdog",
	"daemon/github",
	"daemon/linear-source",
	"daemon/mission-notices",
	"daemon/mission-task-refs",
	"daemon/origin",
	"daemon/power",
	"daemon/project-dashboard",
	"daemon/pull-request-health",
	"daemon/pull-request-readiness",
	"daemon/pull-requests",
	"daemon/reviews",
	"daemon/schedule-detection",
	"daemon/session-activity",
	"daemon/session-outcomes",
	"daemon/session-pr-follow-ups",
	"daemon/session-pull-requests",
	"daemon/slack-cache",
	"daemon/slack-classifier",
	"daemon/slack-format",
	"daemon/slack-source",
	"daemon/sources",
	"daemon/service-cassettes",
	"daemon/testing/cassette",
	"daemon/subscription-usage",
	"daemon/ttl-cache",
	"daemon/update-gate",
	"daemon/worker-activity",
	"daemon/worker-starts",
	"kernel/artifact-skill",
	"kernel/artifact-tools",
	"kernel/attention",
	"kernel/gh-stack",
	"kernel/idle-input",
	"kernel/input-origin",
	"kernel/policy",
	"kernel/pull-request-provenance",
	"kernel/queue",
	"kernel/ref-activity",
	"kernel/usage",
	"kernel/worker",
]);

export function testSuite(path: string): Suite {
	if (path === "scripts/test-suites.test.ts" || path === "scripts/test-verification-slot.test.ts") return "fast";
	if (path.endsWith(".stress.test.ts")) return "stress";
	const match = /^packages\/([^/]+)\/src\/(.+)\.test\.ts$/.exec(path);
	return match && fast.has(`${match[1]}/${match[2]}`) ? "fast" : "integration";
}

/** Start known subprocess-heavy files first to avoid a long serial tail. Concurrency stays bounded. */
export function testWeight(path: string): number {
	if (/shared-workspaces-/.test(path)) return 4;
	if (/session-workspaces-/.test(path)) return 3;
	if (/\/(ask-sessions|changes|workspaces)[.]/.test(path)) return 2;
	return 1;
}
