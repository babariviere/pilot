import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("every PR and main push runs CI, including manifest-only and lockfile-only changes", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const events = workflow.split("\non:\n")[1].split("\npermissions:\n")[0];
	assert.match(events, /^  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:/m);
	assert.doesNotMatch(events, /paths(?:-ignore)?:/);
	const node = workflow.split("\n  node:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.match(node, /run: pnpm install --frozen-lockfile/);
	assert.match(node, /run: pnpm typecheck/);
	assert.match(node, /run: pnpm test/);
});

test("portable tests run on Linux and native coverage plus packaging stay on macOS", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const linux = workflow.split("\n  node:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const macos = workflow.split("\n  macos:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.match(linux, /runs-on: ubuntu-24\.04/);
	assert.match(linux, /apt-get install --yes python3 make g\+\+/);
	assert.match(linux, /pnpm test -- --lane=portable/);
	assert.match(macos, /runs-on: macos-15/);
	assert.match(macos, /pnpm test -- --lane=macos/);
	assert.match(macos, /python3 -B -m unittest discover/);
	assert.match(macos, /node --test apps\/macos\/scripts\/tests\/\*\.test\.mjs/);
	assert.match(macos, /Verify packaged dependency updates/);
	assert.doesNotMatch(linux, /ditto|Packaging and release metadata tests|Verify packaged dependency updates/);
	assert.match(macos, /pilot-ci-main-macos-/);
});

test("both Node lanes install architecture-matched checksum-verified jj before testing", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	assert.match(workflow, /JJ_VERSION: 0\.46\.0/);
	assert.match(workflow, /JJ_SHA256: [a-f0-9]{64}/);
	for (const [name, target, verifier] of [
		["node", "x86_64-unknown-linux-musl", "sha256sum"],
		["macos", "aarch64-apple-darwin", "shasum -a 256"],
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
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	for (const name of ["macos", "app-bundle"]) {
		const job = workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
		assert.match(job, /id: swift-toolchain/);
		assert.match(job, /xcrun --show-sdk-version/);
		assert.match(job, /uses: actions\/cache@v4/);
		assert.match(job, /steps\.swift-toolchain\.outputs\.key/);
		assert.match(job, /runner\.os.*runner\.arch/);
		assert.match(job, /hashFiles\('apps\/macos\/Package.resolved', 'apps\/macos\/Package.swift'/);
		assert.match(job, /scripts\/vendor-ghostty.sh.*scripts\/patch-ghostty-resources.py/);
		assert.match(job, /scripts\/vendor-mermaidkit.sh.*scripts\/patches\/\*\*/);
		const cached = job.slice(job.indexOf("path: |"), job.indexOf("key: swift-deps"));
		assert.match(cached, /org.swift.swiftpm\/repositories/);
		assert.match(cached, /org.swift.swiftpm\/artifacts/);
		assert.match(cached, /Vendor\/libghostty-spm/);
		assert.match(cached, /Vendor\/MermaidKit/);
		assert.ok(!cached.includes(".build") && !cached.includes("build/") && !cached.includes("sign"));
		assert.ok(job.indexOf("uses: actions/cache@v4") < job.indexOf("run: apps/macos/scripts/"));
	}
});

test("PRs use one macOS job, skip Swift only when the app is untouched, and smoke-test the test build", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const job = (name) => workflow.split("\n  " + name + ":\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const macos = job("macos");
	assert.doesNotMatch(workflow, /\n  (?:node-macos|swift-test):\n/);
	assert.equal(workflow.match(/runs-on: macos-15/g).length, 3, "macos, app-bundle and release");
	assert.match(job("app-bundle"), /^    if: github\.event_name != 'pull_request'$/m);
	assert.match(macos, /fetch-depth: 2/);
	const start = macos.indexOf("          swift=true");
	const end = start + macos.slice(start).search(/\n {6}\S/);
	assert.ok(start >= 0 && end > start);
	const block = macos.slice(start, end).split("\n").map((line) => line.slice(10)).join("\n");
	const prefix = 'git() { test "$*" = "diff --name-only HEAD^1 HEAD" && test "$GIT_OK" = 1 && printf "%s" "$FILES"; }';
	for (const [event, files, ok, expected] of [
		["push", "packages/daemon/src/a.ts", "1", "true"],
		["workflow_dispatch", "docs/a.md", "1", "true"],
		["pull_request", "packages/daemon/src/a.ts\ndocs/testing.md", "1", "false"],
		["pull_request", "packages/protocol/src/a.ts\napps/macos/Sources/PilotCore/A.swift", "1", "true"],
		["pull_request", "scripts/verification-slot.py", "1", "true"],
		["pull_request", ".github/workflows/release.yml", "1", "true"],
		["pull_request", "package.json", "1", "true"],
		["pull_request", "packages/foo/package.json\nmyapps/macos/x", "1", "false"],
		["pull_request", "", "0", "true"],
	]) {
		const dir = mkdtempSync(join(tmpdir(), "pilot-swift-changes-"));
		try {
			const output = join(dir, "outputs");
			writeFileSync(output, "");
			const result = spawnSync("bash", ["-euo", "pipefail", "-c", prefix + "\n" + block], {
				encoding: "utf8",
				env: { ...process.env, GITHUB_OUTPUT: output, EVENT_NAME: event, FILES: files, GIT_OK: ok },
			});
			assert.equal(result.status, 0, result.stderr);
			assert.equal(readFileSync(output, "utf8"), "swift=" + expected + "\n", event + " " + JSON.stringify(files));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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

test("only main saves and only PRs reuse a cached Swift test build, with content-derived timestamps", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const job = (name) => workflow.split("\n  " + name + ":\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const macos = job("macos");
	const step = (name) => macos.slice(macos.indexOf("- name: " + name), macos.indexOf("\n      - ", macos.indexOf("- name: " + name)));
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
	assert.match(restore, /restore-keys: \$\{\{ steps\.swift-toolchain\.outputs\.build \}\}-$/);
	assert.match(macos, /BUILD_INPUTS: \$\{\{ hashFiles\('apps\/macos\/Package\.resolved', 'apps\/macos\/Package\.swift', 'apps\/macos\/scripts\/test\.sh', 'apps\/macos\/scripts\/swift-env\.sh', 'apps\/macos\/scripts\/stable-mtimes\.py'\) \}\}/);
	const stamped = macos.indexOf("python3 apps/macos/scripts/stable-mtimes.py apps/macos");
	assert.ok(macos.indexOf("Restore the Swift test build") < stamped);
	assert.ok(macos.indexOf("apps/macos/scripts/vendor-ghostty.sh", macos.indexOf("Give Swift inputs")) < stamped);
	assert.ok(stamped < macos.indexOf("run: apps/macos/scripts/test.sh"));
	assert.ok(macos.indexOf("run: apps/macos/scripts/test.sh") < macos.indexOf("Save the Swift test build"));
	for (const name of ["app-bundle", "release", "publish"]) {
		assert.doesNotMatch(job(name), /swift-build|actions\/cache\/restore|stable-mtimes/, name);
	}
});

test("release job publishes only newly created stable releases or explicit draft retries", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const condition = workflow.split("\n  release:\n")[1].match(/^    if: (.+)$/m)[1];
	const github = { event_name: "push", ref: "refs/heads/main", event: { repository: { fork: false } } };
	const verification = ["node", "macos", "app-bundle", "linux-production"];
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
	assert.match(workflow, /\n  release-please:\n    needs: \[node, macos, app-bundle, linux-production\]\n/);
	assert.match(workflow, /\n  release:\n(?:    #.*\n)*    needs: \[node, macos, app-bundle, linux-production, release-please\]\n/);
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
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const linux = workflow.split("\n  linux-production:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.doesNotMatch(linux, /needs:|if:|secrets\./);
	assert.match(linux, /ref: \$\{\{ inputs\.release_tag \|\| github\.sha \}\}/);
	assert.match(linux, /uses: \.\/\.github\/workflows\/linux-package.yml/);
	const publish = workflow.split("\n  linux-publish:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.match(publish, /needs: \[node, macos, app-bundle, linux-production, release-please, linux-release-rebuild\]/);
	assert.match(publish, /needs\.linux-production\.result == 'success'/);
	assert.match(publish, /contents: write/);
	assert.ok(publish.indexOf("release-manifest.mjs sign") < publish.indexOf("gh release upload"));
	assert.ok(publish.indexOf("Require Linux runtime signing configuration") < publish.indexOf("uses: actions/checkout"));
	assert.match(publish, /Only stable drafts may receive runtime assets/);
	assert.match(publish, /runtime-manifest\.json\.sig/);
	const verification = readFileSync(new URL("../../../../.github/workflows/linux-package.yml", import.meta.url), "utf8");
	assert.match(verification, /permissions:\n  contents: read/);
	assert.doesNotMatch(verification, /contents: write|secrets\.|gh release upload|PRIVATE_KEY/);
	assert.match(verification, /verify-service\.sh/);
});

test("macOS and Linux release jobs run in parallel and one serialized job publishes the complete draft", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const job = (name) => workflow.split("\n  " + name + ":\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const release = job("release");
	assert.doesNotMatch(release, /needs:.*linux-publish|concurrency:/);
	assert.doesNotMatch(release, /--draft=false|finalize-release/);
	assert.match(release, /run: apps\/macos\/scripts\/publish-release\.sh/);
	assert.match(release, /LINUX_RUNTIME_PUBLIC_KEY repository variable/);
	const publish = job("publish");
	assert.match(publish, /needs: \[release-please, linux-publish, release\]/);
	assert.match(publish, /if: always\(\) && needs\.linux-publish\.result == 'success' && needs\.release\.result == 'success'\n/);
	assert.match(publish, /group: pilot-macos-release-\$\{\{ github\.repository \}\}-stable\n      cancel-in-progress: false/);
	assert.match(publish, /ref: \$\{\{ github\.sha \}\}/);
	assert.match(publish, /run: bash apps\/macos\/scripts\/finalize-release\.sh/);
	assert.doesNotMatch(publish, /secrets\./);
	const script = readFileSync(new URL("../publish-release.sh", import.meta.url), "utf8");
	assert.doesNotMatch(script, /--draft=false/);
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
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const tools = workflow.indexOf("- name: Load current release packaging tools");
	const overlay = workflow.indexOf("- name: Apply current packaging policy");
	const build = workflow.indexOf("- run: apps/macos/scripts/bundle.sh", overlay);
	assert.ok(tools >= 0 && tools < overlay && overlay < build);
	assert.match(workflow.slice(tools, overlay), /ref: \$\{\{ github\.sha \}\}/);
	assert.match(workflow.slice(tools, overlay), /persist-credentials: false/);
	assert.match(workflow.slice(tools, overlay), /path: \.pilot-release-tools/);
	const app = workflow.split("\n  app-bundle:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.match(app, /Render delegated task fixtures\n(?:        #.*\n)*        if: inputs\.release_tag == ''/);
	assert.match(app, /Upload delegated task screenshots\n        if: inputs\.release_tag == ''/);
	const commands = workflow
		.slice(overlay, build)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("cp "));
	assert.deepEqual(commands, [
		"cp .pilot-release-tools/apps/macos/scripts/production_artifact.py apps/macos/scripts/production_artifact.py",
		"cp .pilot-release-tools/apps/macos/scripts/release_metadata.py apps/macos/scripts/release_metadata.py",
		"cp .pilot-release-tools/apps/macos/scripts/publish-release.sh apps/macos/scripts/publish-release.sh",
		"cp -p .pilot-release-tools/apps/macos/scripts/check-runtime.sh apps/macos/scripts/check-runtime.sh",
	]);
});

test("production packages are built once and publishing promotes only this run's verified artifacts", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const job = (name) => workflow.split("\n  " + name + ":\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const app = job("app-bundle");
	const release = job("release");
	assert.equal(app.match(/run: apps\/macos\/scripts\/bundle\.sh/g).length, 1);
	assert.match(job("linux-production"), /uses: \.\/\.github\/workflows\/linux-package.yml/);
	assert.match(app, /ref: \$\{\{ inputs\.release_tag \|\| github\.sha \}\}/);
	assert.match(app, /GITHUB_RUN_NUMBER \+ BUNDLE_VERSION_OFFSET/);
	assert.match(app, /BUNDLE_VERSION_OFFSET: '10000'/);
	assert.match(app, /GITHUB_RUN_ATTEMPT/);
	assert.doesNotMatch(app, /secrets\.|contents: write/);
	assert.match(app, /production_artifact\.py create/);
	assert.match(app, /codesign --verify --deep --strict "\$stage\/extracted\/Pilot.app"/);
	assert.match(app, /check-runtime.sh "\$stage\/extracted\/Pilot.app\/Contents\/Resources\/runtime"/);
	assert.ok(app.indexOf("check-runtime.sh \"$stage/extracted") < app.indexOf("- name: Upload verified production app"));
	assert.match(app, /name: macos-production-app/);
	assert.match(app, /overwrite: true/);
	assert.match(release, /uses: actions\/download-artifact@v4\n        with:\n          name: macos-production-app/);
	assert.match(release, /production_artifact\.py verify "\$stage" "\$\(git rev-parse HEAD\)"/);
	assert.ok(release.indexOf("production_artifact.py verify") < release.indexOf('ditto -x -k "$stage/Pilot-arm64.zip"'));
	assert.match(release, /publish-release.sh apps\/macos\/build\/Pilot.app "\$RUNNER_TEMP\/macos-production\/Pilot-arm64.zip"/);
	assert.doesNotMatch(release, /swift build|pnpm install|bundle-runtime\.sh/);
	assert.match(release, /if: steps\.production-source\.outputs\.rebuild == 'true'/);
	assert.doesNotMatch(release, /run-id:|github-token:/);
	const headless = readFileSync(new URL("../../../../.github/workflows/linux-headless.yml", import.meta.url), "utf8");
	assert.doesNotMatch(headless, /linux-package.yml|production:/);
});

test("only trusted main builds create a production Mac artifact, without exposing signing secrets", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const app = workflow.split("\n  app-bundle:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const condition = app.match(/BUNDLE_RUNTIME: \$\{\{ (.+) \}\}/)[1];
	const evaluate = new Function("github", "return " + condition);
	const github = {event_name: "push", ref: "refs/heads/main", event: {repository: {fork: false}}};
	assert.equal(evaluate(github), "1");
	github.event_name = "workflow_dispatch";
	assert.equal(evaluate(github), "1");
	github.event_name = "pull_request";
	assert.equal(evaluate(github), "0");
	github.event_name = "push";
	github.ref = "refs/heads/other";
	assert.equal(evaluate(github), "0");
	github.ref = "refs/heads/main";
	github.event.repository.fork = true;
	assert.equal(evaluate(github), "0");
	for (const name of ["Configure production bundle", "Archive and verify the production app", "Upload verified production app"]) {
		assert.ok(app.includes("- name: " + name + "\n        if: env.BUNDLE_RUNTIME == '1'"));
	}
	const release = workflow.split("\n  release:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const linuxPublish = workflow.split("\n  linux-publish:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	assert.ok(linuxPublish.match(/^    if: (.+)$/m)[1].startsWith(release.match(/^    if: (.+)$/m)[1]));
});


test("Linux fallback rebuilds only a different release commit and failures block signing", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const job = (name) => workflow.split("\n  " + name + ":\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const rebuild = job("linux-release-rebuild");
	const publish = job("linux-publish");
	const evaluate = (source, github, needs, inputs) => new Function("github", "needs", "inputs", "always",
		"return " + source.replace(/needs\.([a-z-]+)/g, 'needs["$1"]'))(github, needs, inputs, () => true);
	const condition = rebuild.match(/^    if: (.+)$/m)[1];
	const github = { event_name: "push", ref: "refs/heads/main", sha: "a".repeat(40), event: { repository: { fork: false } } };
	const needs = Object.fromEntries(["node", "macos", "app-bundle", "linux-production"].map((name) => [name, {result: "success"}]));
	needs["release-please"] = { result: "success", outputs: { release_created: "true", sha: github.sha } };
	needs["linux-release-rebuild"] = { result: "skipped" };
	assert.equal(evaluate(condition, github, needs, {release_tag: ""}), false);
	needs["release-please"].outputs.sha = "b".repeat(40);
	assert.equal(evaluate(condition, github, needs, {release_tag: ""}), true);
	assert.match(rebuild, /ref: \$\{\{ needs.release-please.outputs.sha \}\}/);
	assert.match(rebuild, /artifact-name: linux-release-runtime/);
	assert.doesNotMatch(rebuild, /secrets\.|contents: write/);
	github.event_name = "workflow_dispatch";
	needs["release-please"].result = "skipped";
	assert.equal(evaluate(condition, github, needs, {release_tag: "v1.2.3"}), false);
	github.event_name = "pull_request";
	needs["release-please"].result = "success";
	assert.equal(evaluate(condition, github, needs, {release_tag: ""}), false);
	github.event_name = "push";
	const publishCondition = publish.match(/^    if: (.+)$/m)[1];
	for (const result of ["failure", "cancelled"]) {
		needs["linux-release-rebuild"].result = result;
		assert.equal(evaluate(publishCondition, github, needs, {release_tag: ""}), false);
	}
	needs["linux-release-rebuild"].result = "success";
	assert.equal(evaluate(publishCondition, github, needs, {release_tag: ""}), true);
	assert.match(publish, /needs.linux-release-rebuild.result == 'success' && 'linux-release-runtime' \|\| 'linux-production-runtime'/);
});

test("Mac source selection reuses matching artifacts, rebuilds only the release race, and fails closed otherwise", () => {
	const workflow = readFileSync(new URL("../../../../.github/workflows/release.yml", import.meta.url), "utf8");
	const release = workflow.split("\n  release:\n")[1].split(/\n  [a-z-]+:\n/)[0];
	const start = release.indexOf('          stage="$RUNNER_TEMP/macos-production"', release.indexOf("id: production-source"));
	const end = release.indexOf("\n      -", start);
	assert.ok(start >= 0 && end > start);
	const block = release.slice(start, end).split("\n").map((line) => line.slice(10)).join("\n");
	const prefix = [
		'git() { printf "%s" "$EXPECTED_SOURCE"; }',
		'node() { printf "1.2.3"; }',
		'python3() { if [ "$1" = "-c" ]; then command python3 "$@"; else printf verify >> "$VERIFY_LOG"; test "$VALID_ARCHIVE" = 1; fi; }',
	].join("\n");
	for (const scenario of ["match", "race", "wrong-source", "retry-mismatch", "corrupt-match"]) {
		const dir = mkdtempSync(join(tmpdir(), "pilot-artifact-source-"));
		try {
			mkdirSync(join(dir, "macos-production"));
			const expected = "a".repeat(40);
			const trigger = "b".repeat(40);
			const source = scenario === "match" || scenario === "corrupt-match" ? expected :
				scenario === "wrong-source" ? "c".repeat(40) : trigger;
			writeFileSync(join(dir, "macos-production/production-artifact.json"), JSON.stringify({commit: source}));
			const output = join(dir, "outputs");
			const log = join(dir, "verified");
			writeFileSync(output, "");
			writeFileSync(log, "");
			const result = spawnSync("bash", ["-euo", "pipefail", "-c", prefix + "\n" + block], {
				encoding: "utf8",
				env: {...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, GITHUB_SHA: trigger,
					EXPECTED_SOURCE: expected, REQUESTED_RELEASE_TAG: scenario === "retry-mismatch" ? "v1.2.3" : "",
					VERIFY_LOG: log, VALID_ARCHIVE: scenario === "corrupt-match" ? "0" : "1"},
			});
			assert.equal(result.status === 0, ["match", "race"].includes(scenario), scenario + ": " + result.stderr);
			assert.equal(readFileSync(output, "utf8"), scenario === "race" ? "rebuild=true\n" : "", scenario);
			assert.equal(readFileSync(log, "utf8"), ["match", "corrupt-match"].includes(scenario) ? "verify" : "", scenario);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	}
});
