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
	assert.match(job("macos-app"), /^    needs: target$/m);
	assert.match(job("linux-package"), /^    needs: target$/m);
	assert.match(job("macos-publish"), /^    needs: \[target, macos-app\]$/m);
	assert.match(job("linux-publish"), /^    needs: \[target, linux-package\]$/m);
	assert.match(job("publish"), /^    needs: \[target, linux-publish, macos-publish\]$/m);
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
	const headless = job("linux-headless");
	assert.match(headless, /PILOT_REQUIRE_LINUX_ISOLATION: "1"/);
	assert.match(headless, /native-runtime\.test\.ts/);
	assert.doesNotMatch(headless, /linux-package|production/);
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

test("Swift test and release build jobs cache only pinned dependencies with toolchain-specific keys", () => {
	for (const [job, script] of [
		[jobOf(read("tests.yaml"))("macos"), "test"],
		[jobOf(read("release.yaml"))("macos-app"), "bundle"],
	]) {
		assert.match(job, /id: swift-toolchain/);
		assert.match(job, /xcrun --show-sdk-version/);
		assert.match(job, /uses: actions\/cache@v4/);
		assert.match(job, /steps\.swift-toolchain\.outputs\.key/);
		assert.match(job, /runner\.os.*runner\.arch/);
		assert.match(job, /hashFiles\('apps\/macos\/Package.resolved', 'apps\/macos\/Package.swift'/);
		assert.match(job, /scripts\/vendor-ghostty.sh.*scripts\/patch-ghostty-resources.py/);
		assert.match(job, /scripts\/vendor-mermaidkit.sh.*scripts\/patches\/\*\*/);
		assert.match(job, /scripts\/vendor-quickjs.sh/);
		const cached = job.slice(job.indexOf("path: |"), job.indexOf("key: swift-deps"));
		assert.match(cached, /org.swift.swiftpm\/repositories/);
		assert.match(cached, /org.swift.swiftpm\/artifacts/);
		assert.match(cached, /Vendor\/libghostty-spm/);
		assert.match(cached, /Vendor\/MermaidKit/);
		assert.match(cached, /Vendor\/QuickJSNG/);
		assert.ok(!cached.includes(".build") && !cached.includes("build/") && !cached.includes("sign"));
		const build = job.indexOf(`run: apps/macos/scripts/${script}.sh`);
		assert.ok(build >= 0 && job.indexOf("uses: actions/cache@v4") < build);
	}
});

test("PRs skip Swift only when the app is untouched, and smoke-test the test build", () => {
	const macos = jobOf(read("tests.yaml"))("macos");
	// Independent Rust native/opt-in artifact lanes also need Mac runners.
	// Preserve one Swift gate, not an obsolete one-Mac-job total.
	assert.match(macos, /runs-on: macos-15/);
	assert.equal(read("tests.yaml").match(/run: apps\/macos\/scripts\/test\.sh/g).length, 1);
	assert.match(macos, /fetch-depth: 2/);
	const block = runBlock(macos, "          swift=true");
	const prefix = 'git() { test "$*" = "diff --name-only HEAD^1 HEAD" && test "$GIT_OK" = 1 && printf "%s" "$FILES"; }';
	for (const [event, files, ok, expected] of [
		["push", "packages/daemon/src/a.ts", "1", "true"],
		["pull_request", "packages/daemon/src/a.ts\ndocs/testing.md", "1", "false"],
		["pull_request", "packages/protocol/src/a.ts\napps/macos/Sources/PilotCore/A.swift", "1", "true"],
		["pull_request", "scripts/verification-slot.py", "1", "true"],
		// The visual service runs the shared runtime against the kernel's conformance fixtures.
		["pull_request", "packages/artifacts/src/visual/runtime.js", "1", "true"],
		["pull_request", "packages/protocol/fixtures/visual/conformance.json", "1", "true"],
		["pull_request", "packages/artifacts/src/visual/check.ts", "1", "false"],
		["pull_request", ".github/workflows/tests.yaml", "1", "true"],
		["pull_request", ".github/workflows/pr.yaml", "1", "true"],
		["pull_request", ".github/workflows/release.yaml", "1", "false"],
		["pull_request", "package.json", "1", "true"],
		["pull_request", "packages/foo/package.json\nmyapps/macos/x", "1", "false"],
		["pull_request", "", "0", "true"],
	]) {
		const result = run(block, { EVENT_NAME: event, FILES: files, GIT_OK: ok }, prefix);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.output, `swift=${expected}\n`, `${event} ${JSON.stringify(files)}`);
	}
	const swift = macos.indexOf("run: apps/macos/scripts/test.sh");
	const bundle = macos.indexOf("run: apps/macos/scripts/bundle.sh");
	assert.ok(macos.indexOf("pnpm test -- --lane=macos") < swift && swift < bundle);
	assert.match(macos, /Verify Swift toolchain\n        id: swift-toolchain\n        if: \$\{\{ !cancelled\(\) && steps\.changes\.outputs\.swift == 'true' \}\}/);
	const packaging = macos.slice(macos.lastIndexOf("- name:", bundle), bundle);
	assert.match(packaging, /github\.event_name == 'pull_request' && steps\.swift-test\.outcome == 'success'/);
	assert.match(packaging, /CONFIGURATION: debug/);
	assert.match(packaging, /BUNDLE_PREBUILT: '1'/);
	assert.doesNotMatch(packaging, /BUNDLE_RUNTIME|secrets\./);
	assert.match(macos, /--snapshot "\$RUNNER_TEMP\/delegated-screenshots" --delegated-tasks-only/);
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

test("SwiftLint is a strict standalone macOS check even when Swift compilation is skipped", () => {
	const macos = jobOf(read("tests.yaml"))("macos");
	assert.match(macos, /- name: SwiftLint\n        if: \$\{\{ !cancelled\(\) \}\}\n        run: apps\/macos\/scripts\/lint\.sh/);
	assert.ok(macos.indexOf("run: apps/macos/scripts/lint.sh") < macos.indexOf("run: apps/macos/scripts/test.sh"));
	const script = readFileSync(new URL("../lint.sh", import.meta.url), "utf8");
	assert.match(script, /--strict --force-exclude --no-cache/);
	assert.doesNotMatch(script, /swift (build|test)|--fix|--baseline|--lenient/);
});

test("only main saves and only PRs reuse a cached Swift test build, with content-derived timestamps", () => {
	const macos = jobOf(read("tests.yaml"))("macos");
	const step = (name) => macos.slice(macos.indexOf(`- name: ${name}`), macos.indexOf("\n      - ", macos.indexOf(`- name: ${name}`)));
	const restore = step("Restore the Swift test build");
	const save = step("Save the Swift test build");
	assert.match(restore, /github\.event_name == 'pull_request' \}\}/);
	assert.match(restore, /uses: actions\/cache\/restore@v4/);
	assert.match(save, /uses: actions\/cache\/save@v4/);
	assert.match(save, /if: \$\{\{ !cancelled\(\) && steps\.swift-test\.outcome != 'skipped' && github\.ref == 'refs\/heads\/main' \}\}/);
	const settings = (text) => text.split("\n").filter((line) => /^\s+(path|key):/.test(line));
	assert.deepEqual(settings(restore), settings(save));
	assert.deepEqual(settings(save), [
		"          path: apps/macos/.build",
		"          key: ${{ steps.swift-toolchain.outputs.build }}-${{ github.sha }}",
	]);
	assert.match(restore, /restore-keys: \|\n +\$\{\{ steps\.swift-toolchain\.outputs\.build \}\}-\n +\$\{\{ steps\.swift-toolchain\.outputs\.compatible \}\}/);
	assert.match(macos, /BUILD_INPUTS: \$\{\{ hashFiles\('apps\/macos\/Package\.resolved', 'apps\/macos\/Package\.swift', 'apps\/macos\/scripts\/swift-env\.sh', 'apps\/macos\/scripts\/stable-mtimes\.py'\) \}\}/);
	assert.match(macos, /compatible=swift-build-v1-\$RUNNER_OS-\$RUNNER_ARCH-\$identity-/);
	assert.doesNotMatch(macos.match(/BUILD_INPUTS: .*/)[0], /test\.sh|run-swift-tests/);
	const stamped = macos.indexOf("python3 apps/macos/scripts/stable-mtimes.py apps/macos");
	assert.ok(macos.indexOf("Restore the Swift test build") < stamped);
	assert.ok(macos.indexOf("apps/macos/scripts/vendor-ghostty.sh", macos.indexOf("Give Swift inputs")) < stamped);
	assert.ok(stamped < macos.indexOf("run: apps/macos/scripts/test.sh"));
	assert.ok(macos.indexOf("run: apps/macos/scripts/test.sh") < macos.indexOf("Save the Swift test build"));
	assert.doesNotMatch(read("release.yaml"), /swift-build|actions\/cache\/restore|actions\/cache\/save|stable-mtimes/);
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
	for (const name of ["macos-app", "macos-publish", "linux-package", "linux-publish", "publish"]) {
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
	for (const name of ["macos-app", "macos-publish", "linux-publish"]) {
		assert.match(job(name), /- uses: actions\/checkout@v4\n        with:\n(?:          .*\n)*?          ref: \$\{\{ needs\.target\.outputs\.sha \}\}/, name);
	}
	assert.match(job("linux-package"), /ref: \$\{\{ needs\.target\.outputs\.sha \}\}/);
	for (const name of ["macos-publish", "linux-publish", "publish"]) {
		assert.match(job(name), /RELEASE_TAG: \$\{\{ needs\.target\.outputs\.tag \}\}/, name);
	}
	assert.doesNotMatch(read("release.yaml"), /linux-release-rebuild|rebuild=true|production-source/);
});

test("production packages are built once without private keys and publishing promotes the same bytes", () => {
	const job = jobOf(read("release.yaml"));
	const app = job("macos-app");
	const publish = job("macos-publish");
	assert.equal(app.match(/run: apps\/macos\/scripts\/bundle\.sh/g).length, 1);
	assert.match(app, /BUNDLE_RUNTIME: '1'/);
	assert.match(app, /GITHUB_RUN_NUMBER \+ BUNDLE_VERSION_OFFSET/);
	assert.match(app, /GITHUB_RUN_ATTEMPT/);
	// release.yml ended near run 1,100 with offset 10,000. The renamed workflow restarts at run 1.
	assert.ok(Number(app.match(/BUNDLE_VERSION_OFFSET: '(\d+)'/)[1]) >= 20000);
	assert.doesNotMatch(app, /secrets\.|contents: write/);
	assert.match(app, /production_artifact\.py create/);
	assert.match(app, /codesign --verify --deep --strict "\$stage\/extracted\/Pilot.app"/);
	assert.match(app, /check-runtime.sh "\$stage\/extracted\/Pilot.app\/Contents\/Resources\/runtime"/);
	assert.ok(app.indexOf('check-runtime.sh "$stage/extracted') < app.indexOf("- name: Upload verified production app"));
	assert.match(app, /name: macos-production-app/);
	assert.match(publish, /uses: actions\/download-artifact@v4\n        with:\n          name: macos-production-app/);
	assert.match(publish, /production_artifact\.py verify "\$stage" "\$\(git rev-parse HEAD\)"/);
	assert.ok(publish.indexOf("production_artifact.py verify") < publish.indexOf('ditto -x -k "$stage/Pilot-arm64.zip"'));
	assert.match(publish, /publish-release.sh apps\/macos\/build\/Pilot.app "\$RUNNER_TEMP\/macos-production\/Pilot-arm64.zip"/);
	assert.doesNotMatch(publish, /swift build|pnpm install|bundle\.sh|bundle-runtime\.sh/);
	assert.doesNotMatch(publish, /run-id:|github-token:/);
	assert.match(publish, /contents: write/);
	assert.doesNotMatch(publish, /LINUX_RUNTIME_PUBLIC_KEY/);
	assert.doesNotMatch(publish, /--draft=false|finalize-release|concurrency:/);
});

test("Linux release signing follows successful package verification", () => {
	const job = jobOf(read("release.yaml"));
	assert.doesNotMatch(job("linux-package"), /secrets\.|contents: write/);
	const publish = job("linux-publish");
	assert.match(publish, /contents: write/);
	assert.match(publish, /name: linux-production-runtime/);
	assert.ok(publish.indexOf("release-manifest.mjs sign") < publish.indexOf("gh release upload"));
	assert.ok(publish.indexOf("Require Linux runtime signing configuration") < publish.indexOf("uses: actions/checkout"));
	assert.match(publish, /Only stable drafts may receive runtime assets/);
	assert.match(publish, /runtime-manifest\.json\.sig/);
	const verification = read("linux-package.yml");
	assert.match(verification, /permissions:\n  contents: read/);
	assert.doesNotMatch(verification, /contents: write|secrets\.|gh release upload|PRIVATE_KEY/);
	assert.match(verification, /check-runtime\.mjs/);
	assert.doesNotMatch(verification, /verify-service\.sh|openssh-server/);
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

test("release jobs apply current packaging helpers without changing tagged application source", () => {
	const job = jobOf(read("release.yaml"));
	for (const name of ["macos-app", "macos-publish"]) {
		const body = job(name);
		const tools = body.indexOf("- name: Load current release packaging tools");
		const overlay = body.indexOf("- name: Apply current packaging policy");
		assert.ok(tools >= 0 && tools < overlay, name);
		assert.match(body.slice(tools, overlay), /ref: \$\{\{ github\.sha \}\}/);
		assert.match(body.slice(tools, overlay), /persist-credentials: false/);
		assert.match(body.slice(tools, overlay), /path: \.pilot-release-tools/);
		const end = body.indexOf("\n      - ", overlay + 1);
		const commands = body
			.slice(overlay, end)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("cp "));
		assert.deepEqual(commands, [
			"cp .pilot-release-tools/apps/macos/scripts/production_artifact.py apps/macos/scripts/production_artifact.py",
			"cp .pilot-release-tools/apps/macos/scripts/release_metadata.py apps/macos/scripts/release_metadata.py",
			"cp .pilot-release-tools/apps/macos/scripts/publish-release.sh apps/macos/scripts/publish-release.sh",
			"cp -p .pilot-release-tools/apps/macos/scripts/check-runtime.sh apps/macos/scripts/check-runtime.sh",
		], name);
	}
	assert.ok(job("macos-app").indexOf("Apply current packaging policy") < job("macos-app").indexOf("run: apps/macos/scripts/bundle.sh"));
});
