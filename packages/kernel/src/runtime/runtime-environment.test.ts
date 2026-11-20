import assert from "node:assert/strict";
import { test } from "node:test";
import { isExecutable, resolveLoginShell, runtimeEnvironment } from "./runtime-environment.ts";

test("Linux shell selection checks executables, never assumes zsh or a distribution", () => {
	const executable = (path: string) => ["/bin/sh", "/custom/bash"].includes(path);
	assert.equal(resolveLoginShell({ SHELL: "/custom/bash" }, "linux", executable), "/custom/bash");
	assert.equal(resolveLoginShell({ SHELL: "/missing/zsh" }, "linux", executable), "/bin/sh");
	assert.equal(
		resolveLoginShell({}, "linux", executable, () => "/custom/bash"),
		"/custom/bash",
	);
	assert.equal(resolveLoginShell({ SHELL: "sh -c unsafe" }, "linux", executable), "/bin/sh");
	assert.equal(
		resolveLoginShell({ SHELL: "/missing/zsh" }, "linux", executable, () => "/custom/bash"),
		"/custom/bash",
	);
	assert.equal(
		resolveLoginShell({}, "linux", executable, () => {
			throw new Error("no passwd");
		}),
		"/bin/sh",
	);
	assert.throws(() => resolveLoginShell({}, "linux", () => false), /No executable login shell/);
	assert.equal(isExecutable("/tmp"), false, "an executable directory is not a shell");
});

test("headless tool environment preserves host configuration and fills sparse service PATH idempotently", () => {
	const input = { PATH: "/custom/bin:/usr/bin", HOME: "/home/example", SHELL: "/bin/sh", CUSTOM: "preserved" };
	const options = { platform: "linux", execPath: "/runtime/node/bin/node" };
	const env = runtimeEnvironment(input, options);
	assert.equal(input.PATH, "/custom/bin:/usr/bin");
	assert.equal(env.CUSTOM, "preserved");
	assert.ok(env.PATH?.startsWith(input.PATH));
	for (const path of ["/runtime/node/bin", "/home/example/.local/bin", "/usr/local/bin", "/bin"])
		assert.ok(env.PATH?.split(":").includes(path));
	assert.ok(!env.PATH?.includes("homebrew"));
	assert.deepEqual(runtimeEnvironment(env, options), env);
	assert.ok(runtimeEnvironment({ SHELL: "/bin/sh" }, options).PATH?.includes("/usr/bin"));
});
