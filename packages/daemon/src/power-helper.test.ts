import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { developmentPowerHelperPath } from "./power-helper.ts";

test("development power resolution prefers standalone Rust and retains Swift fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "power-helper-path-"));
	try {
		const legacy = join(root, "apps/macos/build/Pilot.app/Contents/Helpers/PilotPower");
		assert.equal(developmentPowerHelperPath(root), legacy);
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
