import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const read = (name) => readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), "utf8");
const jobOf = (workflow) => (name) => {
	const parts = workflow.split(`\n  ${name}:\n`);
	assert.equal(parts.length, 2, `job ${name}`);
	return parts[1].split(/\n  [a-z-]+:\n/)[0];
};
const condition = (job) => job.match(/^    if: (.+)$/m)[1];
// GitHub permits hyphenated identifiers; JavaScript requires bracket notation.
const evaluate = (source, context) =>
	new Function("github", "needs", "inputs", "always", `return ${source.replace(/needs\.([a-z-]+)/g, 'needs["$1"]')}`)(
		context.github,
		context.needs,
		context.inputs,
		() => true,
	);
const run = (block, env, prefix = "") => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-workflow-"));
	try {
		const output = join(dir, "outputs");
		writeFileSync(output, "");
		const result = spawnSync("bash", ["-euo", "pipefail", "-c", `${prefix}\n${block}`], {
			encoding: "utf8",
			env: { ...process.env, GITHUB_OUTPUT: output, ...env },
		});
		return { status: result.status, stderr: result.stderr, output: readFileSync(output, "utf8") };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};
const runBlock = (job, marker) => {
	const start = job.indexOf(marker);
	// The block ends at the first line indented less than a run script (the next step, job or comment).
	const next = job.slice(start).search(/\n(?! {10}|\n| *$)/);
	const end = next < 0 ? job.length : start + next;
	assert.ok(start >= 0 && end > start, marker);
	return job
		.slice(start, end)
		.split("\n")
		.map((line) => line.slice(10))
		.join("\n");
};

test("CI is split into PR, main and release entry points sharing one test workflow", () => {
	const pr = read("pr.yaml");
	const main = read("main.yaml");
	const release = read("release.yaml");
	const tests = read("tests.yaml");
	assert.match(pr, /^on:\n  pull_request:\n/m);
	assert.doesNotMatch(pr, /\n  push:|workflow_dispatch/);
	assert.match(main, /^on:\n  push:\n    branches: \[main\]\n\n/m);
	assert.match(release, /^on:\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n/m);
	assert.doesNotMatch(release, /pull_request/);
	assert.match(tests, /^on:\n  workflow_call:\n/m);
	const sharedTrigger = tests.split("on:\n")[1].split("\npermissions:")[0];
	assert.doesNotMatch(sharedTrigger, /^  (push|pull_request|workflow_dispatch):/m);
	assert.match(
		sharedTrigger,
		/    inputs:\n      desktop-release-build:\n        description: [^\n]+\n        type: boolean\n        required: false\n        default: false/,
	);
	assert.match(jobOf(pr)("tests"), /uses: \.\/\.github\/workflows\/tests\.yaml/);
	assert.match(jobOf(main)("tests"), /uses: \.\/\.github\/workflows\/tests\.yaml/);
	// The package is validated in PRs; main and release builds never use it as a gate.
	assert.match(jobOf(pr)("linux-package"), /uses: \.\/\.github\/workflows\/linux-package\.yml/);
	for (const workflow of [pr, main, release, tests]) {
		assert.match(workflow, /^permissions:\n  contents: read$/m);
	}
	for (const name of ["release.yml", "linux-headless.yml"]) {
		assert.throws(() => read(name), /ENOENT/, `${name} was merged into the split workflows`);
	}
});

test("tests never block a release and Release Please never waits for tests", () => {
	const release = read("release.yaml");
	assert.doesNotMatch(release, /tests\.yaml|lane=|apps\/macos\/scripts\/test\.sh|pnpm test/);
	assert.doesNotMatch(release, /workflow_run/);
	const job = jobOf(release);
	assert.doesNotMatch(job("release-please"), /^    needs:/m);
	assert.match(job("target"), /^    needs: release-please$/m);
	assert.match(job("macos-gui"), /^    needs: target$/m);
	assert.match(job("linux-gui"), /^    needs: target$/m);
	assert.match(job("gui-publish"), /^    needs: \[target, macos-gui, linux-gui\]$/m);
	assert.match(job("publish"), /^    needs: \[target, gui-publish\]$/m);
	for (const name of ["pr.yaml", "main.yaml", "tests.yaml"]) {
		assert.doesNotMatch(read(name), /release-please-action|contents: write|secrets\./, name);
	}
});

test("Release Please PRs and release commits start no test runs", () => {
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
	assert.match(macos, /node --test apps\/macos\/scripts\/tests\/\*\.test\.mjs/);
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
	for (const name of ["pr.yaml", "main.yaml", "tests.yaml", "release.yaml", "gui-package.yml", "linux-package.yml"]) {
		const source = read(name);
		assert.doesNotMatch(source, /apps\/macos\/scripts\/(?:build|test|bundle)\.sh|swift (?:build|test)\b/, name);
		assert.doesNotMatch(source, /steps\.(?:swift[\w-]*|pr-fixtures)\.|outputs\.swift/, name);
		assert.doesNotMatch(source, /swift-(?:build|deps|test-stalls)|apps\/macos\/\.build|org\.swift\.swiftpm|apps\/macos\/Vendor/, name);
		assert.doesNotMatch(source, /vendor-(?:ghostty|mermaidkit|quickjs)\.sh|stable-mtimes\.py|delegated-screenshots/, name);
	}
	assert.doesNotMatch(jobOf(workflow)("macos"), /id: changes|fetch-depth:|upload-artifact|actions\/cache|PILOT_SWIFT_JOBS/);
	assert.doesNotMatch(workflow, /^    needs:/m, "remaining test lanes are independent");
	// Keep local Swift source/build tooling, but no legacy release jobs or credentials.
	assert.doesNotMatch(read("release.yaml"), /macos-app:|macos-publish|SPARKLE_|macos-production-app/);
	assert.doesNotMatch(read("release.yaml"), /swift-build|actions\/cache\/restore|actions\/cache\/save|stable-mtimes/);
	const script = readFileSync(new URL("../bundle.sh", import.meta.url), "utf8");
	assert.match(script, /Release bundles always compile from source/);
	const guard = script.indexOf('if [ "$prebuilt" = 1 ] && [ "$runtime" = 1 ]');
	assert.ok(guard >= 0 && guard < script.indexOf("swift build --package-path"));
});

test("Rust test, native and opt-in artifact jobs preserve platform and release boundaries", () => {
	const workflow = read("tests.yaml");
	const job = jobOf(workflow);
	const portable = job("rust");
	const native = job("rust-macos-native");
	const artifact = job("rust-macos-release");
	for (const lane of [portable, native, artifact]) {
		assert.doesNotMatch(lane, /^    needs:/m);
	}
	assert.match(portable, /runs-on: ubuntu-24\.04/);
	assert.match(portable, /ci\.sh check/);
	assert.doesNotMatch(portable, /ci\.sh (build|artifact|native|mac-tests)|upload-artifact/);
	assert.match(native, /runs-on: macos-15/);
	assert.match(native, /ci\.sh mac-tests/);
	assert.match(native, /ci\.sh native/);
	assert.doesNotMatch(native, /ci\.sh (check|build|artifact)/);
	assert.equal(condition(artifact), "inputs.desktop-release-build");
	assert.match(artifact, /runs-on: macos-15/);
	assert.match(artifact, /ci\.sh build/);
	assert.match(artifact, /ci\.sh artifact/);
	assert.match(artifact, /name: desktop-rust-unsigned-aarch64-apple-darwin-/);
	assert.doesNotMatch(artifact, /secrets\.|contents: write|gh release|scripts\/publish/);
	for (const caller of ["pr.yaml", "main.yaml"]) {
		assert.doesNotMatch(read(caller), /desktop-release-build:/, caller);
	}
});

test("SwiftLint remains a strict static check without compiling the legacy app", () => {
	const macos = jobOf(read("tests.yaml"))("macos");
	assert.match(macos, /- name: SwiftLint\n        if: \$\{\{ !cancelled\(\) \}\}\n        run: apps\/macos\/scripts\/lint\.sh/);
	const script = readFileSync(new URL("../lint.sh", import.meta.url), "utf8");
	assert.match(script, /--strict --force-exclude --no-cache/);
	assert.doesNotMatch(script, /swift (build|test)|--fix|--baseline|--lenient/);
});

test("release builds run only for newly created stable drafts or explicit retries on trusted main", () => {
	const job = jobOf(read("release.yaml"));
	assert.match(condition(job("release-please")), /inputs\.release_tag == ''/);
	const source = condition(job("target"));
	const context = () => ({
		github: { event_name: "push", ref: "refs/heads/main", event: { repository: { fork: false } } },
		needs: { "release-please": { result: "success", outputs: { release_created: "false" } } },
		inputs: { release_tag: "" },
	});
	let c = context();
	assert.equal(evaluate(source, c), false, "ordinary main pushes only update the release PR");
	c.needs["release-please"].outputs.release_created = "true";
	assert.equal(evaluate(source, c), true);
	c.needs["release-please"].result = "failure";
	assert.equal(evaluate(source, c), false);
	c = context();
	c.github.event_name = "workflow_dispatch";
	c.needs["release-please"].result = "skipped";
	c.inputs.release_tag = "v1.2.3";
	assert.equal(evaluate(source, c), true, "explicit retry");
	c.inputs.release_tag = "";
	assert.equal(evaluate(source, c), false);
	c.inputs.release_tag = "v1.2.3";
	c.github.ref = "refs/heads/other";
	assert.equal(evaluate(source, c), false);
	c.github.ref = "refs/heads/main";
	c.github.event.repository.fork = true;
	assert.equal(evaluate(source, c), false);
	for (const name of ["macos-gui", "linux-gui", "gui-publish", "publish"]) {
		assert.doesNotMatch(job(name), /^    if:/m, `${name} runs only after target succeeds`);
	}
});

test("the release target resolves the tagged commit and rejects unstable or mismatched tags", () => {
	const target = jobOf(read("release.yaml"))("target");
	const block = runBlock(target, "          set -euo pipefail");
	const prefix = 'gh() { test "$*" = "api repos/owner/repo/commits/v1.2.3 --jq .sha" && printf "%s\n" "$TAG_SHA"; }';
	const sha = "a".repeat(40);
	const cases = [
		[{ RELEASE_TAG: "v1.2.3", RELEASE_SHA: sha }, `tag=v1.2.3\nsha=${sha}\n`],
		[{ RELEASE_TAG: "v1.2.3", RELEASE_SHA: "" }, `tag=v1.2.3\nsha=${sha}\n`],
		[{ RELEASE_TAG: "v1.2.3", RELEASE_SHA: "b".repeat(40) }, null],
		[{ RELEASE_TAG: "v1.2.3-beta.1", RELEASE_SHA: "" }, null],
		[{ RELEASE_TAG: "v1.2.3; rm -rf /", RELEASE_SHA: "" }, null],
		[{ RELEASE_TAG: "", RELEASE_SHA: "" }, null],
	];
	for (const [env, expected] of cases) {
		const result = run(block, { ...env, GITHUB_REPOSITORY: "owner/repo", TAG_SHA: sha }, prefix);
		assert.equal(result.status === 0, expected !== null, `${JSON.stringify(env)}: ${result.stderr}`);
		assert.equal(result.output, expected ?? "", JSON.stringify(env));
	}
	assert.match(target, /RELEASE_TAG: \$\{\{ inputs\.release_tag \|\| needs\.release-please\.outputs\.tag_name \}\}/);
});

test("release jobs build and publish the tagged commit, never this run's newer main", () => {
	const job = jobOf(read("release.yaml"));
	for (const name of ["gui-publish"]) {
		assert.match(job(name), /- uses: actions\/checkout@v4\n        with:\n(?:          .*\n)*?          ref: \$\{\{ needs\.target\.outputs\.sha \}\}/, name);
	}
	for (const name of ["macos-gui", "linux-gui"]) {
		assert.match(job(name), /ref: \$\{\{ needs\.target\.outputs\.sha \}\}/, name);
	}
	for (const name of ["gui-publish", "publish"]) {
		assert.match(job(name), /RELEASE_TAG: \$\{\{ needs\.target\.outputs\.tag \}\}/, name);
	}
	assert.doesNotMatch(read("release.yaml"), /linux-release-rebuild|rebuild=true|production-source/);
});

test("GUI release signing follows successful package verification", () => {
	const job = jobOf(read("release.yaml"));
	assert.doesNotMatch(job("macos-gui"), /secrets\.|contents: write/);
	const publish = job("gui-publish");
	assert.match(publish, /contents: write/);
	assert.match(publish, /name: gui-production-\$\{\{ matrix\.platform \}\}/);
	assert.ok(publish.indexOf("gui-release-manifest.mjs") < publish.indexOf("gh release upload"));
	const packaging = read("gui-package.yml");
	assert.match(packaging, /permissions:\n  contents: read/);
	assert.doesNotMatch(packaging, /contents: write|gh release upload/);
});

test("one serialized job publishes the complete draft after both platforms upload", () => {
	const publish = jobOf(read("release.yaml"))("publish");
	assert.match(publish, /group: pilot-macos-release-\$\{\{ github\.repository \}\}-stable\n      cancel-in-progress: false/);
	assert.match(publish, /ref: \$\{\{ github\.sha \}\}/);
	assert.match(publish, /run: bash apps\/macos\/scripts\/finalize-release\.sh/);
	assert.doesNotMatch(publish, /secrets\./);
	const script = readFileSync(new URL("../publish-release.sh", import.meta.url), "utf8");
	assert.doesNotMatch(script, /--draft=false/);
});

test("finalization verifies GUI signatures without requiring legacy Sparkle assets", () => {
	const script = readFileSync(new URL("../finalize-release.sh", import.meta.url), "utf8");
	assert.match(script, /complete-draft/);
	assert.match(script, /gui-release-manifest\.mjs" verify-release/);
	assert.match(script, /is-newer "\$app_version" "\$latest_tag"/);
	assert.doesNotMatch(script, /appcast|Sparkle|is-newer-build|publish-release\.sh/);
	assert.ok(script.indexOf("verify-release") < script.indexOf("gh release edit"));
});
