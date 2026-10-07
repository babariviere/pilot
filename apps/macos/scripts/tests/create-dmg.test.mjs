import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("DMG contains the app and Applications shortcut with app symlinks preserved", {
	skip: process.platform !== "darwin",
}, () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot dmg test-"));
	const mount = join(dir, "mounted");
	let attached = false;
	const run = (command, args) => {
		const result = spawnSync(command, args, { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		return result;
	};
	try {
		const contents = join(dir, "Pilot.app/Contents");
		mkdirSync(join(contents, "Resources"), { recursive: true });
		writeFileSync(join(contents, "Resources/fixture"), "bundled runtime");
		symlinkSync("fixture", join(contents, "Resources/link"));
		const dmg = join(dir, "output/Pilot-arm64.dmg");
		run("bash", [new URL("../create-dmg.sh", import.meta.url).pathname, join(dir, "Pilot.app"), dmg]);
		mkdirSync(mount);
		run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
		attached = true;
		assert.equal(readlinkSync(join(mount, "Applications")), "/Applications");
		assert.equal(readFileSync(join(mount, "Pilot.app/Contents/Resources/fixture"), "utf8"), "bundled runtime");
		assert.equal(readlinkSync(join(mount, "Pilot.app/Contents/Resources/link")), "fixture");
	} finally {
		if (attached) run("hdiutil", ["detach", mount]);
		rmSync(dir, { recursive: true, force: true });
	}
});
