import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("every PR and main push runs CI, including manifest-only and lockfile-only changes", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	const events = workflow.split("\non:\n")[1].split("\npermissions:\n")[0];
	assert.match(events, /^  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:/m);
	assert.doesNotMatch(events, /paths(?:-ignore)?:/);
	const node = workflow.split("\n  node:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.match(node, /run: pnpm install --frozen-lockfile/);
	assert.match(node, /run: pnpm typecheck/);
	assert.match(node, /run: pnpm test/);
});

test("portable tests run on Linux and native coverage plus packaging stay on macOS", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	const linux = workflow.split("\n  node:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const macos = workflow.split("\n  node-macos:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.match(linux, /runs-on: ubuntu-24\.04/);
	assert.match(linux, /apt-get install --yes python3 make g\+\+/);
	assert.match(linux, /pnpm test -- --lane=portable/);
	assert.match(macos, /runs-on: macos-15/);
	assert.match(macos, /pnpm test -- --lane=macos/);
	assert.match(macos, /python3 -B -m unittest discover/);
	assert.match(macos, /node --test apps\/macos\/scripts\/tests\/\*\.test\.mjs/);
	assert.match(macos, /Verify packaged dependency updates/);
	assert.doesNotMatch(linux, /ditto|Packaging and release metadata tests|Verify packaged dependency updates/);
	assert.match(macos, /pilot-ci-main-node-macos-/);
});

test("both Node lanes install architecture-matched checksum-verified jj before testing", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	assert.match(workflow, /JJ_VERSION: 0\.46\.0/);
	assert.match(workflow, /JJ_SHA256: [a-f0-9]{64}/);
	for (const [name, target, verifier] of [
		["node", "x86_64-unknown-linux-musl", "sha256sum"],
		["node-macos", "aarch64-apple-darwin", "shasum -a 256"],
	]) {
		const job = workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
		const start = job.indexOf("- name: Install Jujutsu");
		const end = job.indexOf("\n      -", start);
		assert.ok(start >= 0 && end > start && job.indexOf("pnpm test") > end);
		const installation = job.slice(start, end);
		assert.ok(installation.includes(`releases/download/v$JJ_VERSION/jj-v$JJ_VERSION-${target}.tar.gz`));
		assert.ok(installation.indexOf(`${verifier} --check`) < installation.indexOf("tar -xzf"));
		assert.ok(installation.includes(`echo "$JJ_SHA256  $archive" | ${verifier} --check`));
		assert.match(installation, /echo "\$install_dir" >> "\$GITHUB_PATH"/);
		assert.match(installation, /"\$install_dir\/jj" --version/);
	}
});

test("Swift verification and bundle jobs cache only pinned dependencies with toolchain-specific keys", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	for (const name of ["swift-test", "app-bundle"]) {
		const job = workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
		assert.match(job, /id: swift-toolchain/);
		assert.match(job, /xcrun --show-sdk-version/);
		assert.match(job, /uses: actions\/cache@v4/);
		assert.match(job, /steps\.swift-toolchain\.outputs\.key/);
		assert.match(job, /runner\.os.*runner\.arch/);
		assert.match(job, /hashFiles\('apps\/macos\/Package.resolved', 'apps\/macos\/Package.swift'/);
		assert.match(job, /scripts\/vendor-ghostty.sh.*scripts\/patch-ghostty-resources.py/);
		const cached = job.slice(job.indexOf("path: |"), job.indexOf("key: swift-deps"));
		assert.match(cached, /org.swift.swiftpm\/repositories/);
		assert.match(cached, /org.swift.swiftpm\/artifacts/);
		assert.match(cached, /Vendor\/libghostty-spm/);
		assert.ok(!cached.includes(".build") && !cached.includes("build/") && !cached.includes("sign"));
		assert.ok(job.indexOf("uses: actions/cache@v4") < job.indexOf("run: apps/macos/scripts/"));
	}
});

test("release job publishes only newly created stable releases or explicit draft retries", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	const condition = workflow.split("\n  release:\n")[1].match(/^    if: (.+)$/m)[1];
	const github = { event_name: "push", ref: "refs/heads/main", event: { repository: { fork: false } } };
	const verification = ["node", "node-macos", "swift-test", "app-bundle", "linux-publish"];
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
	assert.match(workflow, /\n  release-please:\n    needs: \[node, node-macos, swift-test, app-bundle\]\n/);
	assert.match(workflow, /\n  release:\n    needs: \[node, node-macos, swift-test, app-bundle, release-please, linux-publish\]\n/);
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

test("Linux release signing follows successful production verification and stays out of PR jobs", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/macos-release.yml", import.meta.url), "utf8");
	const linux = workflow.split("\n  linux-release:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.match(linux, /needs: \[node, node-macos, swift-test, app-bundle, release-please\]/);
	assert.match(linux, /github\.ref == 'refs\/heads\/main'/);
	assert.match(linux, /github\.event\.repository\.fork == false/);
	assert.match(linux, /uses: \.\/\.github\/workflows\/linux-package.yml/);
	const publish = workflow.split("\n  linux-publish:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.match(publish, /needs: \[linux-release, release-please\]/);
	assert.match(publish, /needs\.linux-release\.result == 'success'/);
	assert.match(publish, /contents: write/);
	assert.ok(publish.indexOf("release-manifest.mjs sign") < publish.indexOf("gh release upload"));
	assert.match(publish, /Only stable drafts may receive runtime assets/);
	assert.match(publish, /runtime-manifest\.json\.sig/);
	const verification = readFileSync(new URL("../../../../.github/workflows/linux-package.yml", import.meta.url), "utf8");
	assert.match(verification, /permissions:\n  contents: read/);
	assert.doesNotMatch(verification, /contents: write|secrets\.|gh release upload|PRIVATE_KEY/);
	assert.match(verification, /verify-service\.sh/);
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
	const tools = workflow.indexOf("- name: Load current release packaging tools");
	const overlay = workflow.indexOf("- name: Apply current packaging policy");
	const build = workflow.indexOf("- name: Build self-contained Pilot.app");
	assert.ok(tools >= 0 && tools < overlay && overlay < build);
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
