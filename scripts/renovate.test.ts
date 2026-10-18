import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = JSON.parse(readFileSync(new URL("../renovate.json", import.meta.url), "utf8"));
const name = "@babariviere/pi-extensions";

test("Renovate uses native npm Git updates with pnpm artifact generation", () => {
	assert.deepEqual(config.enabledManagers, ["npm"]);
	assert.equal(config.customManagers, undefined);
	assert.equal(config.skipArtifactsUpdate, false);
	assert.equal(config.statusCheckWhen.artifactError, "always");
	const extensions = config.packageRules.find((rule: { overrideDatasource?: string }) => rule.overrideDatasource);
	assert.deepEqual(extensions.matchManagers, ["npm"]);
	assert.deepEqual(extensions.matchPackageNames, ["babariviere/pi-extensions"]);
	assert.equal(extensions.overrideDatasource, "git-refs");
	assert.equal(extensions.overridePackageName, "https://github.com/babariviere/pi-extensions.git");
	assert.equal(extensions.versioning, "git");
	assert.equal(extensions.followTag, "main");
	assert.equal(extensions.pinDigests, true);
	assert.equal(extensions.enabled, false, "upstream main does not yet export Pilot's embedding API");
});

test("the compatible bundled pin matches the lockfile's specifier and resolution", () => {
	const manifest = JSON.parse(readFileSync(new URL("../packages/kernel/package.json", import.meta.url), "utf8"));
	const value = manifest.dependencies[name];
	assert.match(value, /^git\+https:\/\/github\.com\/babariviere\/pi-extensions\.git#[a-f0-9]{40}$/);
	const digest = value.split("#")[1];
	const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
	const importer = lock.split("  packages/kernel:\n")[1]!.split("\n  packages/protocol:")[0]!;
	assert.ok(importer.includes(`specifier: ${value}\n`));
	assert.ok(importer.includes(`version: https://codeload.github.com/babariviere/pi-extensions/tar.gz/${digest}(`));
});

test("Renovate groups the Pi SDK and keeps required auth pinned without automerging", () => {
	assert.equal(config.automerge, false);
	const sdk = config.packageRules.find((rule: { groupSlug?: string }) => rule.groupSlug === "pi-sdk");
	assert.deepEqual(sdk.matchManagers, ["npm"]);
	assert.deepEqual(sdk.matchPackageNames, ["@earendil-works/**"]);
	assert.equal(sdk.rangeStrategy, "pin");
	assert.equal(sdk.separateMajorMinor, false);
	const auth = config.packageRules.find((rule: { matchPackageNames?: string[] }) =>
		rule.matchPackageNames?.includes("@gotgenes/pi-anthropic-auth"),
	);
	assert.equal(auth.rangeStrategy, "pin");
});

test("Renovate changes validate offline, and update PRs check production runtime relocation", () => {
	const validator = readFileSync(new URL("../.github/workflows/renovate-config.yml", import.meta.url), "utf8");
	assert.match(validator, /permissions:\n {2}contents: read/);
	assert.match(validator, /--network=none/);
	assert.match(validator, /--volume "\$PWD:\/repo:ro"/);
	assert.match(validator, /--strict --no-global renovate\.json/);
	assert.match(validator, /scripts\/renovate-contract\.mjs/);
	const workflow = readFileSync(new URL("../.github/workflows/tests.yaml", import.meta.url), "utf8");
	const step = workflow.split("- name: Verify packaged dependency updates\n")[1]!.split("\n      - ")[0]!;
	assert.match(step, /if: github\.event_name == 'pull_request' && startsWith\(github\.head_ref, 'renovate\/'\)/);
	assert.match(step, /bundle-runtime\.sh "\$stage\/runtime"/);
	assert.match(step, /ditto -c -k --keepParent/);
	assert.match(step, /ditto -x -k/);
	assert.match(step, /check-runtime\.sh "\$stage\/relocated\/runtime"/);
});
