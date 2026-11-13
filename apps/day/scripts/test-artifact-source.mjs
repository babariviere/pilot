#!/usr/bin/env node
// Only the native capture/compiler helper and directly affected Node tests.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const command = spawn(
	"apps/day/scripts/cargo",
	[
		"build",
		"--locked",
		"--manifest-path",
		"apps/day/native/Cargo.toml",
		"--features",
		"artifact-host",
		"--bin",
		"pilot-artifact-host",
		"--message-format=json",
	],
	{ cwd: root, stdio: ["ignore", "pipe", "inherit"] },
);
let executable;
for await (const line of createInterface({ input: command.stdout })) {
	try {
		const value = JSON.parse(line);
		if (value.reason === "compiler-artifact" && value.target?.name === "pilot-artifact-host" && value.executable)
			executable = value.executable;
		if (value.reason === "compiler-message" && value.message?.rendered) process.stderr.write(value.message.rendered);
	} catch {
		/* MBX may also print a non-JSON status line. */
	}
}
const code = command.exitCode ?? (await new Promise((resolve) => command.once("close", resolve)));
if (code !== 0 || !executable) throw new Error("Artifact source helper did not build");
const tests = spawn(
	process.execPath,
	[
		"--test",
		"--test-timeout=120000",
		"--test-concurrency=1",
		"--test-name-pattern=NSH ",
		"packages/artifacts/src/nsh-source.test.ts",
		"packages/artifacts/src/nsh-host.test.ts",
		"packages/kernel/src/artifact-tools.test.ts",
	],
	{ cwd: root, env: { ...process.env, NSH_ARTIFACT_TEST_HOST: executable }, stdio: "inherit" },
);
process.exitCode = tests.exitCode ?? (await new Promise((resolve) => tests.once("close", resolve)));
