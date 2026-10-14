import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = JSON.parse(readFileSync(new URL("../renovate.json", import.meta.url), "utf8"));
const packageFile = readFileSync(new URL("../packages/kernel/package.json", import.meta.url), "utf8");
const name = "@babariviere/pi-extensions";
const manager = config.customManagers.find((entry: { depNameTemplate: string }) => entry.depNameTemplate === name);

test("Renovate finds the bundled Git digest and replaces only its immutable pin", () => {
	assert.ok(manager);
	assert.equal(manager.datasourceTemplate, "git-refs");
	assert.equal(manager.currentValueTemplate, "main");
	assert.equal(manager.packageNameTemplate, "https://github.com/babariviere/pi-extensions.git");
	assert.ok(config.enabledManagers.includes("npm"), "npm extraction must retain pnpm lockfile metadata");
	assert.ok(config.enabledManagers.includes("custom.regex"));
	const pattern = manager.managerFilePatterns[0];
	const files = new RegExp(pattern.slice(1, -1));
	assert.ok(files.test("packages/kernel/package.json"));
	assert.ok(!files.test("packages/daemon/package.json"));
	assert.ok(!files.test("backup/packages/kernel/package.json"));
	const matches = [...packageFile.matchAll(new RegExp(manager.matchStrings[0], "g"))];
	assert.equal(matches.length, 1);
	const match = matches[0]!;
	const digest = match.groups?.currentDigest;
	assert.match(digest!, /^[a-f0-9]{40}$/);
	const nextDigest = "a".repeat(40);
	const updated = JSON.parse(packageFile.replace(match[0], match[0].replace(digest!, nextDigest)));
	const original = JSON.parse(packageFile);
	assert.equal(updated.dependencies[name], `git+https://github.com/babariviere/pi-extensions.git#${nextDigest}`);
	delete original.dependencies[name];
	delete updated.dependencies[name];
	assert.deepEqual(updated, original);
});

test("Renovate never treats a floating ref, short hash or unrelated Git package as the bundled pin", () => {
	const value = JSON.parse(packageFile).dependencies[name];
	for (const ref of ["main", "v1.0.0", "1234567", "a".repeat(39)]) {
		const changed = packageFile.replace(value, value.replace(/#[a-f0-9]{40}$/, `#${ref}`));
		assert.equal(new RegExp(manager.matchStrings[0]).test(changed), false);
	}
	assert.equal(new RegExp(manager.matchStrings[0]).test(packageFile.replaceAll(name, "@example/unrelated")), false);
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
	const duplicate = config.packageRules.find((rule: { matchDepNames?: string[] }) =>
		rule.matchDepNames?.includes(name),
	);
	assert.deepEqual(duplicate.matchManagers, ["npm"]);
	assert.equal(duplicate.enabled, false);
});

test("Renovate changes validate offline, and update PRs check production runtime relocation", () => {
	const validator = readFileSync(new URL("../.github/workflows/renovate-config.yml", import.meta.url), "utf8");
	assert.match(validator, /permissions:\n {2}contents: read/);
	assert.match(validator, /--network=none/);
	assert.match(validator, /--volume "\$PWD:\/repo:ro"/);
	assert.match(validator, /--strict --no-global renovate\.json/);
	const workflow = readFileSync(new URL("../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	const step = workflow.split("- name: Verify packaged dependency updates\n")[1]!.split("\n  swift-test:")[0]!;
	assert.match(step, /if: github\.event_name == 'pull_request' && startsWith\(github\.head_ref, 'renovate\/'\)/);
	assert.match(step, /bundle-runtime\.sh "\$stage\/runtime"/);
	assert.match(step, /ditto -c -k --keepParent/);
	assert.match(step, /ditto -x -k/);
	assert.match(step, /check-runtime\.sh "\$stage\/relocated\/runtime"/);
});
