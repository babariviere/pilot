import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	discoverTests,
	type Suite,
	type TestLane,
	testInLane,
	testLimits,
	testSuite,
	testWeight,
} from "./test-suites.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
let suite: Suite | "all" = "all";
let lane: TestLane = "all";
let list = false;
let timings = false;
let tsx = false;
const flags: string[] = [];
for (const argument of process.argv.slice(2)) {
	if (argument === "--") continue;
	if (argument.startsWith("--suite=")) {
		const value = argument.slice(8);
		if (!["all", "fast", "integration", "stress"].includes(value)) throw new Error(`Unknown test suite: ${value}`);
		suite = value as typeof suite;
	} else if (argument.startsWith("--lane=")) {
		const value = argument.slice(7);
		if (!["all", "portable", "macos"].includes(value)) throw new Error(`Unknown test lane: ${value}`);
		lane = value as TestLane;
	} else if (argument === "--list") list = true;
	else if (argument === "--timings") timings = true;
	else if (argument === "--tsx") tsx = true;
	else flags.push(argument);
}
if (lane === "macos" && process.platform !== "darwin" && !list)
	throw new Error("The macos test lane requires macOS; use --list to inspect it on other hosts.");
const { concurrency, timeoutMs } = testLimits(process.env);
const files = (await discoverTests(root))
	.filter((path) => (suite === "all" || testSuite(path) === suite) && testInLane(path, lane))
	.sort((a, b) => testWeight(b) - testWeight(a) || a.localeCompare(b));
if (!files.length) throw new Error(`No tests in suite: ${suite}, lane: ${lane}`);
if (list) {
	console.log(files.join("\n"));
} else {
	const child = spawn(
		"python3",
		[
			fileURLToPath(new URL("./verification-slot.py", import.meta.url)),
			"node",
			"--",
			process.execPath,
			...(tsx ? ["--import", "tsx"] : []),
			"--test",
			"--test-force-exit",
			`--test-timeout=${timeoutMs}`,
			`--test-concurrency=${concurrency}`,
			...(timings ? ["--test-reporter", fileURLToPath(new URL("./test-reporter.ts", import.meta.url))] : []),
			...flags,
			...files,
		],
		{ cwd: root, stdio: "inherit" },
	);
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
	child.on("error", (error) => {
		console.error(error);
		process.exitCode = 1;
	});
	child.on("exit", (code, signal) => {
		process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
	});
}
