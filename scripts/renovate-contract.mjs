// Run inside the pinned Renovate image, offline with the repository mounted read-only at /repo.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GlobalConfig } from "/usr/local/renovate/dist/config/global.js";
import * as cargo from "/usr/local/renovate/dist/modules/manager/cargo/index.js";
import { extractPackageFile } from "/usr/local/renovate/dist/modules/manager/npm/extract/index.js";
import { detectPnpmWorkspaces, getPnpmLock } from "/usr/local/renovate/dist/modules/manager/npm/extract/pnpm.js";
import { determineLockFileDirs } from "/usr/local/renovate/dist/modules/manager/npm/post-update/index.js";
import { updateDependency } from "/usr/local/renovate/dist/modules/manager/npm/update/dependency/index.js";
import { applyPackageRules } from "/usr/local/renovate/dist/util/package-rules/index.js";
import { getMatchingFiles } from "/usr/local/renovate/dist/workers/repository/extract/file-match.js";

GlobalConfig.set({ localDir: "/repo" });
const packageFile = "packages/kernel/package.json";
const content = await readFile(`/repo/${packageFile}`, "utf8");
const extracted = { ...(await extractPackageFile(content, packageFile, {})), packageFile };
await detectPnpmWorkspaces([extracted]);
assert.equal(extracted.managerData.pnpmLockFile, "pnpm-lock.yaml");
const dep = extracted.deps.find((entry) => entry.depName === "@babariviere/pi-extensions");
assert.ok(dep);
assert.equal(dep.skipReason, undefined);
assert.equal(dep.packageName, "babariviere/pi-extensions");
assert.match(dep.currentDigest, /^[a-f0-9]{40}$/);
assert.equal(dep.gitRef, true);

const config = JSON.parse(await readFile("/repo/renovate.json", "utf8"));
const configured = await applyPackageRules({ ...dep, manager: "npm", packageRules: config.packageRules });
assert.equal(configured.enabled, false, "incompatible upstream main updates must stay paused");
assert.equal(configured.datasource, "git-refs");
assert.equal(configured.packageName, "https://github.com/babariviere/pi-extensions.git");
assert.equal(configured.followTag, "main");
assert.equal(configured.pinDigests, true);

// Native npm updates retain the original Git URL and a full digest.
const newDigest = "a".repeat(40);
const upgrade = { ...dep, manager: "npm", updateType: "digest", newDigest };
const updated = updateDependency({ fileContent: content, packageFile, upgrade });
const nextManifest = JSON.parse(updated);
assert.equal(
	nextManifest.dependencies[dep.depName],
	`git+https://github.com/babariviere/pi-extensions.git#${newDigest}`,
);
const originalManifest = JSON.parse(content);
delete originalManifest.dependencies[dep.depName];
delete nextManifest.dependencies[dep.depName];
assert.deepEqual(nextManifest, originalManifest);

// Exercise Renovate's real pnpm post-update scheduling, not just our config shape.
const dirs = determineLockFileDirs(
	{ upgrades: [upgrade], updatedPackageFiles: [{ type: "addition", path: packageFile, contents: updated }] },
	{ npm: [extracted] },
);
assert.deepEqual(dirs.pnpmLockFileDirs, ["pnpm-lock.yaml"]);
const lock = await getPnpmLock("pnpm-lock.yaml");
const locked = lock.lockedVersionsWithPath["packages/kernel"].dependencies[dep.depName];
assert.ok(locked.endsWith(dep.currentDigest), "multi-document pnpm lockfile resolves the manifest's full pin");
console.log("Native Git digest updates schedule pnpm-lock.yaml regeneration.");

// Real Cargo file matching/extraction, without fetching crates or running Cargo.
assert.ok(config.enabledManagers.includes("cargo"));
const manifests = [
	["apps/desktop/Cargo.toml", "apps/desktop/Cargo.lock", "serde"],
	["apps/desktop/visual-worker/Cargo.toml", "apps/desktop/Cargo.lock", "cc"],
	["apps/desktop/updater/Cargo.toml", "apps/desktop/updater/Cargo.lock", "ring"],
	["experiments/nsh-chat/Cargo.toml", "experiments/nsh-chat/Cargo.lock", "nsh-core"],
	["experiments/nsh-chat/gpui/Cargo.toml", "experiments/nsh-chat/gpui/Cargo.lock", "gpui-kit"],
];
const matched = getMatchingFiles(
	{ ...cargo.defaultConfig, ...config, ...config.cargo, manager: "cargo" },
	manifests.map(([file]) => file),
);
assert.deepEqual(matched, manifests.map(([file]) => file).sort());
for (const [packageFile, lockFile, representative] of manifests) {
	const content = await readFile(`/repo/${packageFile}`, "utf8");
	const extracted = await cargo.extractPackageFile(content, packageFile, {});
	assert.ok(extracted, packageFile);
	assert.deepEqual(extracted.lockFiles, [lockFile], packageFile);
	assert.ok(
		extracted.deps.some((dep) => dep.depName === representative),
		packageFile,
	);
	for (const dep of extracted.deps) {
		const configured = await applyPackageRules({
			...config,
			...dep,
			// The repository extraction pipeline defaults packageName before applying rules.
			packageName: dep.packageName ?? dep.depName,
			manager: "cargo",
			packageFile,
		});
		const paused = packageFile.startsWith("experiments/") || dep.depName.startsWith("gpui-") || dep.depName === "zip";
		assert.equal(configured.enabled === false, paused, `${packageFile}: ${dep.depName}`);
		assert.equal(configured.automerge, false);
		if (dep.depName === "pilot-desktop-updater") {
			assert.equal(dep.skipReason, "path-dependency", "local helper stays a path dependency");
			continue;
		}
		if (!paused && dep.datasource === "crate") {
			assert.equal(dep.skipReason, undefined, `${packageFile}: ${dep.depName}`);
			assert.ok(dep.lockedVersion, `${packageFile}: ${dep.depName} retains lockfile resolution`);
		}
	}
}
console.log("Cargo discovers desktop/helper manifests and lockfiles; intentional baselines remain paused.");
