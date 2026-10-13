import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverTests, type Suite, testLimits, testSuite, testWeight } from "./test-suites.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
let suite: Suite | "all" = "all";
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
	} else if (argument === "--list") list = true;
	else if (argument === "--timings") timings = true;
	else if (argument === "--tsx") tsx = true;
	else flags.push(argument);
}
const { concurrency, timeoutMs } = testLimits(process.env);
const files = (await discoverTests(root))
	.filter((path) => suite === "all" || testSuite(path) === suite)
	.sort((a, b) => testWeight(b) - testWeight(a) || a.localeCompare(b));
if (!files.length) throw new Error(`No tests in suite: ${suite}`);
if (list) {
	console.log(files.join("\n"));
} else {
	const child = spawn(
		process.execPath,
		[
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
		process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
	});
}
