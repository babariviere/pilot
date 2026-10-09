import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("verification and tagged release tests install checksum-verified jj before npm test", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	assert.match(workflow, /JJ_VERSION: 0\.46\.0/);
	assert.match(workflow, /JJ_SHA256: [a-f0-9]{64}/);
	const installations = [];
	for (const name of ["node", "release"]) {
		const job = workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
		const start = job.indexOf("- name: Install Jujutsu");
		const end = job.indexOf("\n      -", start);
		const test = job.indexOf("npm test");
		assert.ok(start >= 0 && end > start && test > end, `${name} must install jj before testing`);
		const installation = job.slice(start, end);
		assert.match(installation, /releases\/download\/v\$JJ_VERSION\/jj-v\$JJ_VERSION-aarch64-apple-darwin\.tar\.gz/);
		assert.ok(installation.indexOf("shasum -a 256 --check") < installation.indexOf("tar -xzf"));
		assert.match(installation, /echo "\$JJ_SHA256  \$archive" \| shasum -a 256 --check/);
		assert.match(installation, /echo "\$install_dir" >> "\$GITHUB_PATH"/);
		assert.match(installation, /"\$install_dir\/jj" --version/);
		installations.push(installation);
	}
	assert.equal(installations[0], installations[1]);
});

test("release job publishes only newly created stable releases or explicit draft retries", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	const condition = workflow.split("\n  release:\n")[1].match(/^    if: (.+)$/m)[1];
	const github = { event_name: "push", ref: "refs/heads/main", event: { repository: { fork: false } } };
	const verification = ["node", "swift-test", "app-bundle"];
	const needs = {
		...Object.fromEntries(verification.map((name) => [name, { result: "success" }])),
		"release-please": { result: "success", outputs: { release_created: "false" } },
	};
	// GitHub permits hyphenated identifiers; JavaScript requires bracket notation.
	const evaluate = new Function(
		"github",
		"needs",
		"inputs",
		"always",
		`return ${condition.replace(/needs\.([a-z-]+)/g, 'needs["$1"]')}`,
	);
	assert.equal(
		evaluate(github, needs, { release_tag: "" }, () => true),
		false,
	);
	needs["release-please"].outputs.release_created = "true";
	assert.equal(
		evaluate(github, needs, { release_tag: "" }, () => true),
		true,
	);
	github.event_name = "pull_request";
	assert.equal(
		evaluate(github, needs, { release_tag: "" }, () => true),
		false,
	);
	github.event_name = "push";
	needs["release-please"].result = "failure";
	assert.equal(
		evaluate(github, needs, { release_tag: "" }, () => true),
		false,
	);
	needs["release-please"].result = "skipped";
	github.event_name = "workflow_dispatch";
	assert.equal(
		evaluate(github, needs, { release_tag: "v1.2.3" }, () => true),
		true,
	);
	assert.equal(
		evaluate(github, needs, { release_tag: "" }, () => true),
		false,
	);
	for (const name of verification) {
		needs[name].result = "failure";
		assert.equal(
			evaluate(github, needs, { release_tag: "v1.2.3" }, () => true),
			false,
			`${name} must gate the release`,
		);
		needs[name].result = "success";
	}
	assert.match(workflow, /\n  release-please:\n    needs: \[node, swift-test, app-bundle\]\n/);
	assert.match(workflow, /\n  release:\n    needs: \[node, swift-test, app-bundle, release-please\]\n/);
	github.ref = "refs/heads/other";
	assert.equal(
		evaluate(github, needs, { release_tag: "v1.2.3" }, () => true),
		false,
	);
	github.ref = "refs/heads/main";
	github.event.repository.fork = true;
	assert.equal(
		evaluate(github, needs, { release_tag: "v1.2.3" }, () => true),
		false,
	);
});

test("DMG workflow is manual-only and limited to trusted main", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-dmg.yml", import.meta.url), "utf8");
	assert.match(workflow, /on:\n  workflow_dispatch:\n\n/);
	const condition = workflow.match(/^    if: (.+)$/m)[1];
	const evaluate = new Function("github", `return ${condition}`);
	const github = { ref: "refs/heads/main", event: { repository: { fork: false } } };
	assert.equal(evaluate(github), true);
	github.ref = "refs/heads/other";
	assert.equal(evaluate(github), false);
	github.ref = "refs/heads/main";
	github.event.repository.fork = true;
	assert.equal(evaluate(github), false);
	assert.match(workflow, /run: bash apps\/macos\/scripts\/publish-dmg\.sh/);
	assert.ok(!workflow.includes("SPARKLE_PRIVATE_KEY"));
});

test("draft retries apply current packaging helpers without changing tagged application source", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	const sourceTests = workflow.indexOf("- name: Verify release source tests");
	const tools = workflow.indexOf("- name: Load current release packaging tools");
	const overlay = workflow.indexOf("- name: Apply current packaging policy");
	const build = workflow.indexOf("- name: Build self-contained Pilot.app");
	assert.ok(sourceTests < tools && tools < overlay && overlay < build);
	assert.match(workflow.slice(tools, overlay), /ref: \$\{\{ github\.sha \}\}/);
	assert.match(workflow.slice(tools, overlay), /persist-credentials: false/);
	assert.match(workflow.slice(tools, overlay), /path: \.pilot-release-tools/);
	const commands = workflow
		.slice(overlay, build)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("cp "));
	assert.deepEqual(commands, [
		"cp .pilot-release-tools/apps/macos/scripts/release_metadata.py apps/macos/scripts/release_metadata.py",
		"cp .pilot-release-tools/apps/macos/scripts/publish-release.sh apps/macos/scripts/publish-release.sh",
		"cp -p .pilot-release-tools/apps/macos/scripts/check-runtime.sh apps/macos/scripts/check-runtime.sh",
	]);
});
