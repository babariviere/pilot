import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../check-app.sh", import.meta.url));
const sandbox = fileURLToPath(new URL("../../Resources/Visuals.entitlements", import.meta.url));
const macOS = { skip: process.platform !== "darwin" };

function fixture(t, { layout = "flat", exitCode = 0, sign = true, missing, entitlements = sandbox } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pilot app fixture-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const app = join(dir, "Original Pilot.app");
	const contents = join(app, "Contents");
	const executable = join(contents, "MacOS/Pilot");
	const powerHelper = join(contents, "Helpers/PilotPower");
	mkdirSync(dirname(powerHelper), { recursive: true });
	// Presence/signing fixture only. Accidentally launching this helper must fail, never touch power settings.
	writeFileSync(powerHelper, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
	const visuals = join(contents, "XPCServices/PilotVisuals.xpc");
	const visualsExecutable = join(visuals, "Contents/MacOS/PilotVisuals");
	mkdirSync(dirname(visualsExecutable), { recursive: true });
	// Never launched: the app stand-in below answers --visuals-check itself. A Mach-O, because only Mach-O
	// signatures carry entitlements, and one that fails if anything launches it.
	copyFileSync("/usr/bin/false", visualsExecutable);
	writeFileSync(
		join(visuals, "Contents/Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.pilot.smoke-fixture.visuals</string>
<key>CFBundleExecutable</key><string>PilotVisuals</string>
<key>CFBundlePackageType</key><string>XPC!</string>
</dict></plist>
`,
	);
	mkdirSync(dirname(executable), { recursive: true });
	writeFileSync(
		executable,
		`#!/bin/sh
set -eu
[ "$#" -eq 1 ] && { [ "$1" = --terminal-resource-test ] || [ "$1" = --visuals-check ]; }
[ "\${PACKAGE_RESOURCE_BUNDLE_PATH+x}" != x ]
[ "\${PACKAGE_RESOURCE_BUNDLE_URL+x}" != x ]
[ -x "$(dirname "$0")/../Helpers/PilotPower" ]
printf '%s\\n' "$PWD" "$0" "$1" >> "$SMOKE_LOG"
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
	const coreBundle = join(contents, "Resources/PilotMac_PilotCore.bundle");
	const coreResources = layout === "flat" ? coreBundle : join(coreBundle, "Contents/Resources");
	mkdirSync(coreResources, { recursive: true });
	const sshHelper = join(coreResources, "LinuxSSHBootstrap.py");
	writeFileSync(sshHelper, "# bundled SSH helper\n");
	if (missing) {
		const path =
			missing === "Pilot" ? executable :
			missing === "PilotPower" ? powerHelper :
			missing === "PilotVisuals" ? visuals :
			missing === "bundle" ? bundle :
			missing === "coreBundle" ? coreBundle :
			missing === "sshHelper" ? sshHelper : join(resources, missing);
		rmSync(path, { recursive: true });
	}
	if (sign && missing !== "Pilot") {
		const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", app], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		// As bundle.sh does: the visual service keeps its own entitlements, then the app is resealed around it.
		if (missing !== "PilotVisuals" && entitlements) {
			for (const args of [["--entitlements", entitlements, visuals], [app]]) {
				const signed = spawnSync("codesign", ["--force", "--sign", "-", ...args], { encoding: "utf8" });
				assert.equal(signed.status, 0, signed.stderr);
			}
		}
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
	return { app, executable, powerHelper, log, scratch, run };
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
		const [cwd, executable, check, ...rest] = readFileSync(log, "utf8").trim().split("\n");
		assert.match(cwd, /pilot app check\./);
		assert.equal(executable, join(cwd, "Pilot.app/Contents/MacOS/Pilot"));
		assert.notEqual(executable, join(app, "Contents/MacOS/Pilot"));
		assert.deepEqual([check, rest[2]], ["--terminal-resource-test", "--visuals-check"]);
		assert.equal(existsSync(cwd), false, "relocated app is cleaned up");
		assert.deepEqual(readdirSync(scratch), []);
	});
}

for (const missing of ["Pilot", "PilotPower", "PilotVisuals", "bundle", "Ghostty", "terminfo", "coreBundle", "sshHelper"]) {
	test(`rejects missing ${missing}`, macOS, (t) => {
		const { log, scratch, run } = fixture(t, { missing });
		const result = run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Missing (executable|XPC service|resource bundle|resource directory|resource file)/);
		assert.equal(existsSync(log), false);
		assert.deepEqual(readdirSync(scratch), []);
	});
}

test("rejects a visual service without exactly the sandbox entitlement", macOS, (t) => {
	// null signs the service without entitlements.
	for (const entitlements of [null, "network"]) {
		let path = entitlements;
		if (entitlements === "network") {
			path = join(mkdtempSync(join(tmpdir(), "pilot entitlements-")), "network.entitlements");
			t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
			writeFileSync(
				path,
				readFileSync(sandbox, "utf8").replace(
					"</dict>",
					"<key>com.apple.security.network.client</key><true/></dict>",
				),
			);
		}
		const { log, scratch, run } = fixture(t, { entitlements: path });
		const result = run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /must have only the App Sandbox entitlement/);
		assert.equal(existsSync(log), false);
		assert.deepEqual(readdirSync(scratch), []);
	}
});

test("rejects a non-executable power helper before running the app", macOS, (t) => {
	const { powerHelper, log, scratch, run } = fixture(t);
	chmodSync(powerHelper, 0o644);
	const result = run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Missing executable: Contents\/Helpers\/PilotPower/);
	assert.equal(existsSync(log), false);
	assert.deepEqual(readdirSync(scratch), []);
});

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
