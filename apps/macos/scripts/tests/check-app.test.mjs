import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../check-app.sh", import.meta.url));
const macOS = { skip: process.platform !== "darwin" };

function fixture(t, { layout = "flat", exitCode = 0, sign = true, missing } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pilot app fixture-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const app = join(dir, "Original Pilot.app");
	const contents = join(app, "Contents");
	const executable = join(contents, "MacOS/Pilot");
	mkdirSync(dirname(executable), { recursive: true });
	writeFileSync(
		executable,
		`#!/bin/sh
set -eu
[ "$#" -eq 1 ] && [ "$1" = --terminal-resource-test ]
[ "\${PACKAGE_RESOURCE_BUNDLE_PATH+x}" != x ]
[ "\${PACKAGE_RESOURCE_BUNDLE_URL+x}" != x ]
printf '%s\\n' "$PWD" "$0" > "$SMOKE_LOG"
echo fixture-stdout
echo fixture-stderr >&2
exit ${exitCode}
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(contents, "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.pilot.smoke-fixture</string>
<key>CFBundleExecutable</key><string>Pilot</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
	);
	const bundle = join(contents, "Resources/GhosttyKit_GhosttyTerminal.bundle");
	const resources = layout === "flat" ? bundle : join(bundle, "Contents/Resources");
	for (const resource of ["Ghostty", "terminfo"]) {
		mkdirSync(join(resources, resource), { recursive: true });
		writeFileSync(join(resources, resource, "fixture"), "bundled resource\n");
	}
	if (missing) {
		const path = missing === "Pilot" ? executable : missing === "bundle" ? bundle : join(resources, missing);
		rmSync(path, { recursive: true });
	}
	if (sign && missing !== "Pilot") {
		const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", app], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	const scratch = join(dir, "scratch");
	mkdirSync(scratch);
	const log = join(dir, "smoke.log");
	const run = () =>
		spawnSync("bash", [script, app], {
			encoding: "utf8",
			timeout: 40_000,
			env: {
				...process.env,
				TMPDIR: scratch,
				SMOKE_LOG: log,
				PACKAGE_RESOURCE_BUNDLE_PATH: "/invalid/override",
				PACKAGE_RESOURCE_BUNDLE_URL: "file:///invalid/override",
			},
		});
	return { app, executable, log, scratch, run };
}

test("requires exactly one app path", () => {
	for (const args of [[], ["one", "two"]]) {
		const result = spawnSync("bash", [script, ...args], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Usage: check-app.sh/);
	}
});

for (const layout of ["flat", "macOS"]) {
	test(`runs the relocated signed app with ${layout} resources and no overrides`, macOS, (t) => {
		const { app, log, scratch, run } = fixture(t, { layout });
		const result = run();
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const [cwd, executable] = readFileSync(log, "utf8").trim().split("\n");
		assert.match(cwd, /pilot app check\./);
		assert.equal(executable, join(cwd, "Pilot.app/Contents/MacOS/Pilot"));
		assert.notEqual(executable, join(app, "Contents/MacOS/Pilot"));
		assert.equal(existsSync(cwd), false, "relocated app is cleaned up");
		assert.deepEqual(readdirSync(scratch), []);
	});
}

for (const missing of ["Pilot", "bundle", "Ghostty", "terminfo"]) {
	test(`rejects missing ${missing}`, macOS, (t) => {
		const { log, scratch, run } = fixture(t, { missing });
		const result = run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Missing (executable|resource bundle|resource directory)/);
		assert.equal(existsSync(log), false);
		assert.deepEqual(readdirSync(scratch), []);
	});
}

test("reports a failing smoke test and cleans up", macOS, (t) => {
	const { log, scratch, run } = fixture(t, { exitCode: 7 });
	const result = run();
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /fixture-stdout/);
	assert.match(result.stdout, /fixture-stderr/);
	assert.match(result.stderr, /smoke test failed \(exit 7\)/);
	assert.equal(existsSync(log), true);
	assert.deepEqual(readdirSync(scratch), []);
});

test("rejects an unsigned app before running it", macOS, (t) => {
	const { log, scratch, run } = fixture(t, { sign: false });
	const result = run();
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(log), false);
	assert.deepEqual(readdirSync(scratch), []);
});

test("rejects a tampered signature before running the app", macOS, (t) => {
	const { app, log, scratch, run } = fixture(t);
	writeFileSync(join(app, "Contents/Resources/GhosttyKit_GhosttyTerminal.bundle/Ghostty/fixture"), "tampered\n");
	const result = run();
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(log), false);
	assert.deepEqual(readdirSync(scratch), []);
});
