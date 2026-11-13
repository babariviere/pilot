import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { developmentPowerHelperPath, packagedPowerHelperPath } from "./power-helper.ts";

test("development power resolution uses standalone Rust on both platforms", async () => {
	const root = await mkdtemp(join(tmpdir(), "power-helper-path-"));
	try {
		assert.equal(developmentPowerHelperPath(root, "darwin"), join(root, "apps/power/target/release/PilotPower"));
		assert.equal(developmentPowerHelperPath(root, "linux"), join(root, "apps/power/target/release/PilotPower"));
		for (const profile of ["debug", "release"]) {
			const binary = join(root, "apps/power/target", profile, "PilotPower");
			await mkdir(join(root, "apps/power/target", profile), { recursive: true });
			await writeFile(binary, "synthetic helper, never executed");
			assert.equal(developmentPowerHelperPath(root), binary);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retained Linux runtime discovers its own inventoried power helper, independent of GUI", () => {
	assert.equal(
		packagedPowerHelperPath("/private/capsule/runtime/packages/daemon/src", "linux"),
		"/private/capsule/runtime/bin/PilotPower",
	);
	assert.equal(
		packagedPowerHelperPath("/private/App.app/Contents/Resources/runtime/packages/daemon/src", "darwin"),
		"/private/App.app/Contents/Helpers/PilotPower",
	);
	assert.equal(packagedPowerHelperPath("/repo/packages/daemon/src", "linux"), undefined);
});
