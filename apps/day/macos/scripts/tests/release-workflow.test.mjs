import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (name) => readFileSync(new URL(`../../../../../.github/workflows/${name}`, import.meta.url), "utf8");
const jobOf = (workflow) => (name) => {
	const parts = workflow.split(`\n  ${name}:\n`);
	assert.equal(parts.length, 2, `job ${name}`);
	return parts[1].split(/\n  [a-z-]+:\n/)[0];
};
const condition = (job) => job.match(/^    if: (.+)$/m)[1];
test("CI is split into PR, main and release entry points sharing one test workflow", () => {
	const pr = read("pr.yaml");
	const main = read("main.yaml");
	const release = read("release.yaml");
	const tests = read("tests.yaml");
	assert.match(pr, /^on:\n  pull_request:\n/m);
	assert.doesNotMatch(pr, /\n  push:|workflow_dispatch/);
	assert.match(main, /^on:\n  push:\n    branches: \[main\]\n\n/m);
	assert.match(release, /^on:\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n/m);
	assert.doesNotMatch(release, /^  pull_request:/m);
	assert.match(tests, /^on:\n  workflow_call:\n/m);
	const sharedTrigger = tests.split("on:\n")[1].split("\npermissions:")[0];
	assert.doesNotMatch(sharedTrigger, /^  (push|pull_request|workflow_dispatch):/m);
	assert.doesNotMatch(sharedTrigger, /desktop-release-build:/);
	assert.match(jobOf(pr)("tests"), /uses: \.\/\.github\/workflows\/tests\.yaml/);
	assert.match(jobOf(main)("tests"), /uses: \.\/\.github\/workflows\/tests\.yaml/);
	// The package is validated in PRs; main and release builds never use it as a gate.
	assert.match(jobOf(pr)("linux-package"), /uses: \.\/\.github\/workflows\/linux-package\.yml/);
	for (const workflow of [pr, main, release, tests]) {
		assert.match(workflow, /^permissions:\n  contents: read$/m);
	}
	for (const name of ["release.yml", "gui-package.yml", "linux-headless.yml"]) {
		assert.throws(() => read(name), /ENOENT/, `${name} is not a workflow entry point`);
	}
});

test("Release Please bookkeeping runs on trusted main without waiting for tests", () => {
	const release = read("release.yaml");
	assert.doesNotMatch(release, /tests\.yaml|workflow_run|^    needs:/m);
	const job = jobOf(release)("release-please");
	const allowed = new Function("github", `return ${condition(job)}`);
	for (const [ref, fork, expected] of [
		["refs/heads/main", false, true],
		["refs/heads/main", true, false],
		["refs/heads/other", false, false],
		["refs/tags/main", false, false],
	]) {
		assert.equal(allowed({ ref, event: { repository: { fork } } }), expected, `${ref}, fork=${fork}`);
	}
	assert.match(job, /group: pilot-release-please-\$\{\{ github\.repository \}\}/);
	assert.doesNotMatch(job, /skip-github-pull-request/);
	for (const name of ["pr.yaml", "main.yaml", "tests.yaml"]) {
		assert.doesNotMatch(read(name), /release-please-action|contents: write|secrets\./, name);
	}
});

test("only an explicit dispatch can create a release, and it stays a draft", () => {
	const workflow = read("release.yaml");
	assert.match(workflow, /create_draft:\n(?:        description: .*\n)?        type: boolean\n        default: false/);
	const config = JSON.parse(readFileSync(new URL("../../../../../release-please-config.json", import.meta.url), "utf8"));
	assert.equal(config.draft, true);
	assert.equal(config.packages["."].draft, undefined, "the root package must use the global draft setting");
	const expression = workflow.match(/skip-github-release: \$\{\{ (.+) \}\}/)[1];
	const skip = new Function("github", "inputs", `return ${expression}`);
	for (const event_name of ["push", "workflow_dispatch"]) {
		for (const create_draft of [undefined, false, true]) {
			assert.equal(
				skip({ event_name }, { create_draft }),
				event_name !== "workflow_dispatch" || create_draft !== true,
			);
		}
	}
});

test("release automation cannot build, sign, upload or publish a payload", () => {
	const workflow = read("release.yaml");
	const jobs = workflow.split("\njobs:\n")[1];
	assert.deepEqual([...jobs.matchAll(/^  ([a-z-]+):$/gm)].map((match) => match[1]), ["release-please"]);
	assert.deepEqual([...jobs.matchAll(/^\s+-? ?uses: (.+)$/gm)].map((match) => match[1]), [
		"googleapis/release-please-action@v4",
	]);
	assert.doesNotMatch(jobs, /^ +(?:- )?(?:run|env|secrets):|^    uses:/m, "no commands or delegated workflow");
	assert.doesNotMatch(workflow, /release_tag|UPDATER_PRIVATE_KEY|secrets\.|gh release/);
	assert.throws(() => readFileSync(new URL("../finalize-release.sh", import.meta.url)), /ENOENT/);
});

test("Release Please PRs and release commits skip the shared test lanes", () => {
	const pr = read("pr.yaml");
	const ignored = pr.split("    paths-ignore:\n")[1].split("\n\n")[0].trim().split("\n").map((line) => line.trim());
	assert.deepEqual(ignored, ["- CHANGELOG.md", "- .release-please-manifest.json", "- package.json"]);
	const main = read("main.yaml");
	const source = condition(jobOf(main)("tests")).match(/^"\$\{\{ (.+) \}\}"$/)[1];
	const check = (message) =>
		new Function("github", "startsWith", `return ${source}`)({ event: { head_commit: { message } } }, (a, b) =>
			a.startsWith(b),
		);
	assert.equal(check("chore(main): release 1.50.0"), false);
	assert.equal(check("fix: something"), true);
	assert.doesNotMatch(read("release.yaml"), /RELEASE_PLEASE_TOKEN/);
});

test("PR runs cancel superseded pushes and main runs cancel superseded commits", () => {
	assert.match(read("pr.yaml"), /concurrency:\n  group: pilot-pr-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true/);
	assert.match(read("main.yaml"), /concurrency:\n  group: pilot-main-\$\{\{ github\.repository \}\}\n  cancel-in-progress: true/);
	assert.doesNotMatch(read("release.yaml"), /cancel-in-progress: true/);
});

test("portable tests run on Linux and native coverage plus packaging stay on macOS", () => {
	const job = jobOf(read("tests.yaml"));
	const linux = job("node");
	const macos = job("macos");
	assert.match(linux, /runs-on: ubuntu-24\.04/);
	assert.match(linux, /apt-get install --yes python3 make g\+\+/);
	assert.match(linux, /run: pnpm install --frozen-lockfile/);
	assert.match(linux, /run: pnpm typecheck/);
	assert.match(linux, /pnpm test -- --lane=portable/);
	assert.match(macos, /runs-on: macos-15/);
	assert.match(macos, /pnpm test -- --lane=macos/);
	assert.match(macos, /python3 -B -m unittest discover/);
	assert.match(macos, /node --test apps\/day\/macos\/scripts\/tests\/\*\.test\.mjs/);
	assert.match(macos, /Verify packaged dependency updates/);
	assert.doesNotMatch(linux, /ditto|Packaging and release metadata tests|Verify packaged dependency updates/);
	assert.doesNotMatch(read("tests.yaml"), /^  linux-headless:/m);
});

test("both Node lanes install architecture-matched checksum-verified jj before testing", () => {
	const workflow = read("tests.yaml");
	assert.match(workflow, /JJ_VERSION: 0\.46\.0/);
	assert.match(workflow, /JJ_SHA256: [a-f0-9]{64}/);
	for (const [name, target, verifier] of [
		["node", "x86_64-unknown-linux-musl", "sha256sum"],
		["macos", "aarch64-apple-darwin", "shasum -a 256"],
	]) {
		const job = jobOf(workflow)(name);
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

test("shared CI never builds or tests the legacy Swift app", () => {
	const workflow = read("tests.yaml");
	for (const name of ["pr.yaml", "main.yaml", "tests.yaml", "release.yaml", "linux-package.yml"]) {
		const source = read(name);
		assert.doesNotMatch(source, /apps\/(?:day\/)?macos\/scripts\/(?:build|test|bundle)\.sh|swift (?:build|test)\b/, name);
		assert.doesNotMatch(source, /steps\.(?:swift[\w-]*|pr-fixtures)\.|outputs\.swift/, name);
		assert.doesNotMatch(source, /swift-(?:build|deps|test-stalls)|apps\/(?:day\/)?macos\/\.build|org\.swift\.swiftpm|apps\/(?:day\/)?macos\/Vendor/, name);
		assert.doesNotMatch(source, /vendor-(?:ghostty|mermaidkit|quickjs)\.sh|stable-mtimes\.py|delegated-screenshots/, name);
	}
	assert.doesNotMatch(jobOf(workflow)("macos"), /id: changes|fetch-depth:|upload-artifact|actions\/cache|PILOT_SWIFT_JOBS/);
	assert.doesNotMatch(workflow, /^    needs:/m, "remaining test lanes are independent");
	// Shared runtime tools stay; GUI release automation does not.
	assert.doesNotMatch(read("release.yaml"), /macos-app:|macos-publish|SPARKLE_|macos-production-app/);
	assert.doesNotMatch(read("release.yaml"), /swift-build|actions\/cache\/restore|actions\/cache\/save|stable-mtimes/);
});

test("shared Rust helper jobs keep platform boundaries without building GPUI artifacts", () => {
	const workflow = read("tests.yaml");
	const job = jobOf(workflow);
	const portable = job("rust");
	const native = job("rust-macos-native");
	for (const lane of [portable, native]) {
		assert.doesNotMatch(lane, /^    needs:/m);
		assert.match(lane, /bash crates\/scripts\/ci\.sh bootstrap/);
		assert.match(lane, /bash crates\/scripts\/ci\.sh power-check/);
		assert.doesNotMatch(lane, /ci\.sh (?:check|build|artifact|native|mac-tests)\b|upload-artifact|secrets\.|contents: write|gh release|scripts\/publish/);
	}
	assert.match(portable, /runs-on: ubuntu-24\.04/);
	assert.match(portable, /bash crates\/scripts\/ci\.sh updater-check/);
	assert.match(portable, /bash crates\/scripts\/ci\.sh updater-linux-tests/);
	assert.match(portable, /python3 crates\/scripts\/verify_update_lifecycle\.py/);
	assert.match(portable, /python3 scripts\/validate-workflows\.py/);
	assert.match(native, /runs-on: macos-15/);
	assert.match(native, /bash crates\/scripts\/ci\.sh updater-mac-tests/);
	assert.match(job("day-contracts"), /unittest discover -s apps\/day\/scripts/);
	assert.match(job("day-contracts"), /unittest discover -s crates\/scripts/);
	assert.doesNotMatch(workflow, /apps\/(?:desktop|power)\//);
	assert.doesNotMatch(workflow, /^  rust-macos-release:/m);
	for (const caller of ["pr.yaml", "main.yaml"]) {
		assert.doesNotMatch(read(caller), /desktop-release-build:/, caller);
	}
});

test("obsolete Swift GUI lint tooling is not a shared CI dependency", () => {
	const macos = jobOf(read("tests.yaml"))("macos");
	assert.doesNotMatch(macos, /SwiftLint|scripts\/lint\.sh/);
	assert.match(macos, /scripts\/tests\/\*\.test\.mjs/);
});
