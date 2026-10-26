"""CI orchestration contracts, fake tools only. Never invokes Rust/native/Swift."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import tomllib
import unittest

SCRIPT = Path(__file__).with_name("ci.sh")
WORKFLOW = SCRIPT.parents[3] / ".github/workflows/tests.yaml"


class CiTests(unittest.TestCase):
    BASH = "bash"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        (self.root / "bin").mkdir()
        (self.root / ".tools/bin").mkdir(parents=True)
        (self.root / "visual-worker").mkdir()
        shutil.copyfile(SCRIPT, self.root / "scripts/ci.sh")
        for path in ["Cargo.toml", "visual-worker/Cargo.toml"]:
            (self.root / path).write_text('[package]\nversion = "0.1.0"\n')
        (self.root / "Cargo.lock").write_text("synthetic lockfile\n")
        self.env = dict(os.environ, PATH=f"{self.root / 'bin'}:{os.environ['PATH']}",
                        HOME=str(self.root), CALLS=str(self.root / "calls"),
                        GITHUB_SHA="a" * 40, PR_HEAD_SHA="b" * 40,
                        GITHUB_OUTPUT=str(self.root / "github-output"),
                        DESKTOP_CI_OUTPUT=str(self.root / "output"),
                        GITHUB_STEP_SUMMARY=str(self.root / "summary"))
        # Eliminate inherited test controls, never production environment tools.
        for key in ["FAIL_MATCH", "FAKE_OS", "FAKE_ARCH", "FAKE_VERSION", "METAL_CODE", "FAKE_LIPO", "MAC_TEST_LIST",
                    "DIFF_FILES", "DIFF_FAIL", "GITHUB_EVENT_NAME"]:
            self.env.pop(key, None)
        self.write("scripts/cargo.sh", '''#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$CALLS"
if [[ -n "${FAIL_MATCH:-}" && "$*" == *"$FAIL_MATCH"* ]]; then exit 42; fi
if [[ "$*" == 'test --locked -p pilot-desktop --lib -- --list' ]]; then
  printf '%s\\n' "${MAC_TEST_LIST:-}"
fi
if [[ "$*" == 'build --locked --release --workspace --bins' ]]; then
  mkdir -p target/dev/release
  printf 'synthetic app' > target/dev/release/pilot-desktop
  printf 'synthetic helper' > target/dev/release/pilot-visual-worker
fi
''')
        self.write(".tools/bin/mbx", "#!/bin/sh\necho 'mbx 1.26.0'\n")
        self.write("bin/uname", '''#!/bin/sh
case "$1" in -s) echo "${FAKE_OS:-Darwin}";; -m) echo "${FAKE_ARCH:-arm64}";; esac
''')
        self.write("bin/sw_vers", '#!/bin/sh\necho "${FAKE_VERSION:-15.7}"\n')
        self.write("bin/lipo", '#!/bin/sh\necho "${FAKE_LIPO:-arm64}"\n')
        self.write("bin/rustc", "#!/bin/sh\necho 'rustc synthetic 1.98.1'\n")
        self.write("bin/xcodebuild", "#!/bin/sh\necho 'Xcode synthetic'\n")
        self.write("bin/git", '''#!/bin/sh
if [ "$1" = diff ]; then
  if [ "${DIFF_FAIL:-}" = 1 ]; then exit 1; fi
  if [ -n "${DIFF_FILES:-}" ]; then printf '%s\\n' "$DIFF_FILES" | tr '\\n' '\\0'; fi
  exit 0
fi
if [ "$2" = HEAD ]; then echo "$GITHUB_SHA"; else printf '%040d\n' 1; fi
''')
        self.write("bin/xcrun", '''#!/usr/bin/env bash
set -eu
if [[ "$1" == --show-sdk-version ]]; then echo 'synthetic-sdk'; exit; fi
[[ "$1" == clang ]]
while [[ "$1" != -o ]]; do shift; done
shift
printf '#!/bin/sh\nexit %s\n' "${METAL_CODE:-0}" > "$1"
chmod +x "$1"
''')

    def write(self, path, source):
        file = self.root / path
        file.write_text(source)
        file.chmod(0o755)

    def run_ci(self, phase, expected=0, **environment):
        result = subprocess.run([self.BASH, str(self.root / "scripts/ci.sh"), phase],
                                env=dict(self.env, **environment), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def calls(self):
        path = self.root / "calls"
        return [shlex.split(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_host_rejects_unknown_linux_arch_intel_mac_and_old_macos_before_cargo(self):
        for env in [dict(FAKE_OS="Linux", FAKE_ARCH="arm64"), dict(FAKE_ARCH="x86_64"), dict(FAKE_VERSION="14.8")]:
            self.run_ci("check", expected=1, **env)
        self.assertEqual(self.calls(), [])

    def test_linux_is_portable_build_host_but_never_macos_native_or_release_host(self):
        linux = dict(FAKE_OS="Linux", FAKE_ARCH="x86_64")
        result = self.run_ci("host", **linux)
        self.assertIn("x86_64-unknown-linux-gnu", result.stdout)
        for phase in ["build", "artifact", "native", "mac-tests"]:
            self.run_ci(phase, expected=1, **linux)
        self.assertEqual(self.calls(), [])

    def test_release_build_is_locked_workspace_both_bins_without_test_features(self):
        self.run_ci("build")
        self.assertEqual(self.calls(), [["build", "--locked", "--release", "--workspace", "--bins"]])

    def test_checks_fail_fast_and_do_not_hide_clippy_failure(self):
        self.run_ci("check", expected=42, FAIL_MATCH="clippy")
        calls = self.calls()
        self.assertEqual(calls[0], ["fmt", "--all", "--", "--check"])
        self.assertEqual(calls[1], ["build", "--locked", "--workspace", "--bins"])
        self.assertIn("--all-targets", calls[2])
        self.assertEqual(calls[2][-2:], ["-D", "warnings"])
        self.assertEqual(len(calls), 3)

    def test_library_helper_and_runner_checks_are_executed(self):
        # Do not recursively execute this suite in the temporary script fixture.
        self.write("bin/python3", '#!/bin/sh\necho "$*" >> "$CALLS"\n')
        self.run_ci("check")
        calls = self.calls()
        self.assertIn(["test", "--locked", "-p", "pilot-visual-worker", "--bin", "pilot-visual-worker",
                       "--", "--test-threads=1"], calls)
        self.assertIn(["test", "--locked", "-p", "pilot-desktop", "--lib", "--", "--test-threads=1"], calls)
        self.assertIn(["test", "--locked", "-p", "pilot-desktop", "--test", "settings_state",
                       "--", "--test-threads=1"], calls)
        self.assertEqual(calls[-1], ["-m", "unittest", "discover", "-s", "scripts", "-p", "test_*.py", "-v"])

    def test_linux_executes_production_portable_library_and_state_tests_without_release(self):
        self.write("bin/python3", '#!/bin/sh\necho "$*" >> "$CALLS"\n')
        self.run_ci("check", FAKE_OS="Linux", FAKE_ARCH="x86_64")
        calls = self.calls()
        self.assertIn(["build", "--locked", "--workspace", "--bins"], calls)
        self.assertIn(["test", "--locked", "-p", "pilot-desktop", "--lib", "--", "--test-threads=1"], calls)
        self.assertIn(["test", "--locked", "-p", "pilot-desktop", "--test", "settings_state",
                       "--", "--test-threads=1"], calls)
        self.assertFalse(any("--release" in call for call in calls))

    def test_mac_specific_tests_are_list_verified_exact_and_not_portable_suite(self):
        selected = SCRIPT.read_text().split("  mac-tests)", 1)[1].split("    )", 1)[0]
        names = re.findall(r'^      ([\w:]+)$', selected, flags=re.M)
        self.assertEqual(len(names), 8)
        listing = "\n".join(f"{name}: test" for name in names)
        self.run_ci("mac-tests", MAC_TEST_LIST=listing)
        calls = self.calls()
        self.assertEqual(len(calls), 10)  # helper build + list + 8 exact tests
        self.assertTrue(all("--exact" in call for call in calls[2:]))
        self.assertEqual({call[5] for call in calls[2:]}, set(names))

    def test_missing_mac_specific_test_fails_instead_of_zero_test_success(self):
        self.run_ci("mac-tests", expected=1, MAC_TEST_LIST="unrelated: test")
        self.assertEqual(len(self.calls()), 2)

    def test_missing_metal_is_explicitly_unsupported_not_native_pass(self):
        result = self.run_ci("native", METAL_CODE="78")
        self.assertIn("::warning::", result.stdout)
        self.assertEqual(len(self.calls()), 1)
        self.assertIn("--no-run", self.calls()[0])
        self.assertIn("UNSUPPORTED", (self.root / "summary").read_text())
        self.assertIn("NOT executed or passed", (self.root / "target/ci-native-status.txt").read_text())

    def test_native_failure_never_becomes_unsupported_or_pass(self):
        self.run_ci("native", expected=42, FAIL_MATCH="--features native-probes --test rendering")
        self.assertEqual(len(self.calls()), 2)
        status = (self.root / "target/ci-native-status.txt").read_text()
        self.assertIn("FAILED (exit 42)", status)
        self.assertNotIn("UNSUPPORTED", status)
        self.assertNotIn("PASSED", status)

    def test_native_compile_error_is_failure_even_without_metal(self):
        self.run_ci("native", expected=42, FAIL_MATCH="--no-run", METAL_CODE="78")
        self.assertIn("FAILED", (self.root / "target/ci-native-status.txt").read_text())

    def test_capability_crash_is_failure_not_unsupported(self):
        self.run_ci("native", expected=9, METAL_CODE="9")
        self.assertIn("FAILED (exit 9)", (self.root / "target/ci-native-status.txt").read_text())

    def test_native_supported_runs_entire_compiled_probe_list(self):
        self.run_ci("native")
        calls = self.calls()
        compiled = calls[0][5:]
        executed = [arg for call in calls[1:] for arg in call[4:]]
        self.assertEqual(compiled, executed)
        self.assertEqual(len(compiled) % 2, 0)
        self.assertEqual(len(calls), 1 + len(compiled) // 2)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "project_creation"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "project_add"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "scoped_models"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "artifact_images"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "artifact_gallery"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "delivery_diagnostics"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "mission_inspector"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "chat_actions"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "questions"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "catalog"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "settings"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "mission"], calls)
        self.assertIn(["test", "--locked", "--features", "native-probes", "--test", "missions"], calls)
        self.assertIn("PASSED", (self.root / "target/ci-native-status.txt").read_text())

    def test_manifest_hashes_both_binaries_and_distinguishes_merge_from_head(self):
        self.run_ci("build")
        self.run_ci("artifact")
        output = self.root / "output"
        manifest = json.loads((output / "manifest.json").read_text())
        self.assertEqual(manifest["tested_sha"], "a" * 40)
        self.assertEqual(manifest["pr_head_sha"], "b" * 40)
        self.assertEqual(manifest["target"], "aarch64-apple-darwin")
        self.assertFalse(manifest["installable_update"])
        self.assertEqual(manifest["profile"], "release")
        self.assertEqual(manifest["features"], [])
        self.assertEqual(len(manifest["binaries"]), 2)
        for entry in manifest["binaries"]:
            self.assertEqual(entry["sha256"], hashlib.sha256((output / entry["name"]).read_bytes()).hexdigest())
        self.assertEqual({p.name for p in output.iterdir()}, {"pilot-desktop", "pilot-visual-worker", "manifest.json"})
        self.run_ci("artifact", expected=1)  # stale destinations fail closed

    def test_wrong_binary_architecture_refuses_artifact(self):
        self.run_ci("build")
        self.run_ci("artifact", expected=1, FAKE_LIPO="x86_64")
        self.assertFalse((self.root / "output/manifest.json").exists())

    def test_unknown_phase_is_usage_error(self):
        self.run_ci("unknown", expected=2)
        self.assertEqual(self.calls(), [])

    def test_pr_input_filter_covers_workspace_transitive_inputs_and_wrappers(self):
        for path in ["apps/desktop/Cargo.lock", "apps/desktop/Cargo.toml", "apps/desktop/patches/base.json",
                     "apps/desktop/rust-toolchain.toml", "apps/desktop/scripts/ci.sh",
                     "apps/desktop/fixtures/reply.md", "apps/desktop/visual-worker/build.rs",
                     "apps/macos/Sources/PilotVisualEngine/include/pilot_visual_engine.h",
                     "packages/artifacts/src/visual/runtime.js", "packages/protocol/fixtures/visual/conformance.json",
                     "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml",
                     ".github/workflows/pr.yaml", ".github/workflows/main.yaml", ".github/workflows/tests.yaml",
                     ".github/workflows/desktop-rust.yml"]:
            with self.subTest(path=path):
                result = self.run_ci("changed", GITHUB_EVENT_NAME="pull_request", DIFF_FILES=path)
                self.assertIn("Rust checks: true", result.stdout)
        self.assertEqual(self.calls(), [])

    def test_unrelated_and_evidence_only_prs_skip_heavy_rust_but_main_and_unknown_diff_do_not(self):
        result = self.run_ci("changed", GITHUB_EVENT_NAME="pull_request",
                             DIFF_FILES="README.md\napps/desktop/evidence/rust-ci.md\npackages/daemon/src/main.ts")
        self.assertIn("Rust checks: false", result.stdout)
        for env in [dict(GITHUB_EVENT_NAME="push"), dict(GITHUB_EVENT_NAME="pull_request", DIFF_FAIL="1"),
                    dict(GITHUB_EVENT_NAME="unknown")]:
            self.assertIn("Rust checks: true", self.run_ci("changed", **env).stdout)
        self.assertIn("rust=false", (self.root / "github-output").read_text())


class CiSystemBashTests(CiTests):
    # CI/macOS ships Bash 3.2; developer PATH may resolve to Bash 5.x instead.
    # The complete fake-tool suite must pass under the actual system shell too.
    BASH = "/bin/bash"


class WorkflowTests(unittest.TestCase):
    def test_native_slider_stress_keeps_clock_rate_and_per_event_ack_contract(self):
        # Source guard only. It does not substitute for the real native probe.
        source = (SCRIPT.parents[1] / "src/artifact_slider_probe.rs").read_text()
        pacing = source.split("fn pacing_probe(", 1)[1].split("pub fn run_slider_probe", 1)[0]
        self.assertIn("const INPUTS_PER_TICK: usize = 4;", pacing)
        self.assertIn("for tick in 0..120", pacing)
        self.assertIn("cx.advance_clock(std::time::Duration::from_millis(8))", pacing)
        burst = pacing.split("for input in tick * INPUTS_PER_TICK", 1)[1].split("        })", 1)[0]
        self.assertIn("input_times.push(Instant::now())", burst)
        self.assertIn("window.dispatch_event(", burst)
        self.assertIn("fast_ack_in_app(cx, &pane, &commands)", burst)
        self.assertNotIn("advance_clock", burst)
        self.assertIn("fast_inputs>=90*INPUTS_PER_TICK&&input_window_max>30", pacing)
        for guard in ["samples.len()>=15&&samples.len()<=31", "v>=crate::visual_slider::DRAG_INTERVAL",
                      "w>=std::time::Duration::from_millis(33)", "count()<=30",
                      "p.slider_wake.is_none()&&p.slider_flow.queued.is_none()&&p.slider_flow.flight.is_none()"]:
            self.assertIn(guard, pacing)

    def test_native_negative_controls_share_rate_and_latest_oracles(self):
        source = (SCRIPT.parents[1] / "src/artifact_slider_probe.rs").read_text()
        self.assertIn("for fault in [PacingFault::Unpaced, PacingFault::OldestQueued]", source)
        self.assertIn("p.slider_flow = Default::default()", source)
        self.assertIn("p.slider_flow.flight = flight", source)
        self.assertIn("p.slider_flow.queued = queued", source)
        self.assertIn("p.slider_flow.queued = Some(old)", source)
        self.assertIn("assert!(!callback_rate_valid(samples)", source)
        self.assertIn("assert!(!latest_was_valid", source)
        self.assertIn('assert!(callback_rate_valid(samples), "shared callback-rate oracle")', source)
        self.assertIn('assert!(latest_was_valid, "shared latest/thumb oracle")', source)
        self.assertIn('"rejected_by_shared_oracle":true', source)

    def test_non_macos_refusal_regression_is_test_only_and_uses_real_process_entry(self):
        source = (SCRIPT.parents[1] / "src/visual_runtime.rs").read_text()
        self.assertIn('#[cfg(all(test, not(target_os = "macos")))]\nmod unsupported_platform_tests', source)
        test = source.split("mod unsupported_platform_tests", 1)[1].split('#[cfg(all(test, target_os = "macos"))]', 1)[0]
        self.assertIn("Process::start().await", test)
        self.assertIn('assert_eq!(error.kind, "unavailable")', test)
        self.assertIn("process.stop().await", test)
        self.assertIn("assert_eq!(SLOTS.available_permits(), 2)", test)

    def test_registered_targets_match_real_merged_manifest_and_discovered_test_sources(self):
        # Fake Cargo output alone cannot prove that a target exists or that a
        # new integration harness was added to actual execution, not just lint.
        desktop = SCRIPT.parents[1]
        manifest = tomllib.loads((desktop / "Cargo.toml").read_text())
        declared = {test["name"]: test for test in manifest["test"]}
        optional_workloads = {"capture", "scaling"}
        native = {name for name, target in declared.items()
                  if target.get("harness") is False and name not in optional_workloads}
        source = SCRIPT.read_text()
        registered = set(shlex.split(re.search(r'^    tests=\(([^\n]+)\)$', source, flags=re.M)[1]))
        self.assertEqual(registered, native)
        for name, target in declared.items():
            self.assertTrue((desktop / target.get("path", f"tests/{name}.rs")).is_file(), name)
        # Cargo's auto-discovered test files need not have a [[test]] entry.
        discovered = {path.stem for path in (desktop / "tests").glob("*.rs")}
        pure = (discovered - declared.keys()) | {name for name, target in declared.items()
                                                if target.get("harness", True)}
        executed = set(re.findall(r'cargo test --locked -p pilot-desktop --test ([\w-]+)', source))
        self.assertEqual(executed, pure)
        self.assertIn("catalog", native)
        self.assertIn("settings", native)
        self.assertIn("mission", native)
        self.assertIn("settings_state", pure)
        harness = desktop / "tests/settings_state.rs"
        self.assertIn('#[path = "../src/settings_state.rs"]', harness.read_text())
        self.assertTrue((desktop / "src/settings_state.rs").is_file())
        self.assertEqual(len(re.findall(r'#\[test\]', harness.read_text())), 17)

    def test_rust_is_parallel_sibling_reached_by_both_existing_wrappers(self):
        source = WORKFLOW.read_text()
        jobs = source.split("\njobs:\n", 1)[1]
        self.assertEqual(re.findall(r'^  ([\w-]+):$', jobs, flags=re.M),
                         ["node", "macos", "linux-headless", "rust", "rust-macos-native", "rust-macos-release"])
        self.assertNotRegex(jobs, r'(?m)^    needs:')
        self.assertIn("  workflow_call:", source)
        self.assertFalse(WORKFLOW.with_name("desktop-rust.yml").exists())
        for wrapper, trigger in [("pr.yaml", "pull_request:"), ("main.yaml", "push:")]:
            caller = WORKFLOW.with_name(wrapper).read_text()
            self.assertIn(trigger, caller)
            self.assertIn("uses: ./.github/workflows/tests.yaml", caller)
            self.assertIn("contents: read", caller)
            self.assertIn("cancel-in-progress: true", caller)
        self.assertIn("branches: [main]", WORKFLOW.with_name("main.yaml").read_text())

    def test_runtime_temp_is_initialized_in_step_not_invalid_job_env(self):
        jobs = self.rust_jobs()
        for rust in jobs.values():
            self.assertNotIn("runner.temp", rust.split("    steps:", 1)[0])
            self.assertIn('echo "XDG_CACHE_HOME=$RUNNER_TEMP/desktop-rust-cache" >> "$GITHUB_ENV"', rust)
            self.assertIn('echo "DESKTOP_CI_OUTPUT=$RUNNER_TEMP/desktop-rust-unsigned" >> "$GITHUB_ENV"', rust)
        self.assertIn("python3 apps/desktop/scripts/validate-workflows.py", jobs["rust"])
        for name, phase in [("rust", "check"), ("rust-macos-native", "mac-tests"), ("rust-macos-native", "native")]:
            step = jobs[name].split(f"bash apps/desktop/scripts/ci.sh {phase}", 1)[0].rsplit("      - name:", 1)[1]
            self.assertIn("if: steps.changes.outputs.rust == 'true'", step)

    def rust_jobs(self):
        source = WORKFLOW.read_text()
        names = ["rust", "rust-macos-native", "rust-macos-release"]
        return {name: source.split(f"\n  {name}:\n", 1)[1].split("\n  rust-", 1)[0] for name in names}

    def test_linux_portable_mac_native_and_opt_in_release_are_distinct_not_duplicated(self):
        jobs = self.rust_jobs()
        linux, native, release = (jobs[name] for name in ["rust", "rust-macos-native", "rust-macos-release"])
        self.assertIn("runs-on: ubuntu-24.04", linux)
        self.assertIn("env -u DISPLAY -u WAYLAND_DISPLAY bash apps/desktop/scripts/ci.sh check", linux)
        for dependency in ["libfontconfig1-dev", "libwayland-dev", "libxkbcommon-x11-dev", "lld"]:
            self.assertIn(dependency, linux)
        self.assertNotIn("ci.sh build", linux)
        self.assertNotIn("upload-artifact", linux)
        self.assertIn("runs-on: macos-15", native)
        self.assertIn("ci.sh mac-tests", native)
        self.assertIn("ci.sh native", native)
        self.assertNotIn("ci.sh check", native)
        self.assertNotIn("ci.sh build", native)
        self.assertNotIn("ci.sh artifact", native)
        self.assertIn("if: inputs.desktop-release-build", release)
        self.assertIn("runs-on: macos-15", release)
        self.assertIn("ci.sh build", release)
        self.assertIn("ci.sh artifact", release)
        self.assertIn("default: false", WORKFLOW.read_text().split("permissions:", 1)[0])
        for wrapper in ["pr.yaml", "main.yaml"]:
            self.assertNotIn("desktop-release-build:", WORKFLOW.with_name(wrapper).read_text())

    def test_mac_only_filter_inventory_uses_real_source_definitions(self):
        selected = SCRIPT.read_text().split("  mac-tests)", 1)[1].split("    )", 1)[0]
        names = re.findall(r'^      ([\w:]+)$', selected, flags=re.M)
        for name in names:
            module, _, function = name.split("::")
            source = (SCRIPT.parents[1] / "src" / f"{module}.rs").read_text()
            self.assertIn(f"async fn {function}(", source)
            # Runtime has a macOS-only test module; the other two have cfg per test.
            self.assertIn('target_os = "macos"', source)

    def test_least_privilege_bounded_unsigned_pipeline_and_download_only_cache(self):
        source = WORKFLOW.read_text().split("\n  rust:\n", 1)[1]
        self.assertIn("contents: read", WORKFLOW.read_text())
        for required in ["persist-credentials: false",
                         "runs-on: macos-15", "runs-on: ubuntu-24.04", "timeout-minutes: 60", "retention-days: 7",
                         "github.event.pull_request.head.sha", "${{ github.sha }}", "hashFiles(",
                         "~/.cargo/registry/cache", "apps/desktop/.tools/downloads"]:
            self.assertIn(required, source)
        for forbidden in ["pull_request_target:", "secrets.", "contents: write", "continue-on-error:",
                          "restore-keys:", "release.yaml", "bundle.sh", "gh release", "cargo publish"]:
            self.assertNotIn(forbidden, source)
        self.assertLess(source.index("ci.sh bootstrap"), source.index("ci.sh check"))
        cache = source.split("          path: |", 1)[1].split("          key:", 1)[0]
        cached_paths = [line.strip() for line in cache.splitlines() if line.strip() and not line.strip().startswith("#")]
        self.assertEqual(cached_paths, ["~/.cargo/registry/cache", "apps/desktop/.tools/downloads"])

    def test_toolchain_pins_match_existing_wrappers(self):
        desktop = SCRIPT.parents[1]
        self.assertIn('channel = "1.98.1"', (desktop / "rust-toolchain.toml").read_text())
        self.assertIn('toolchain install 1.98.1', SCRIPT.with_name("bootstrap.sh").read_text())
        self.assertIn('RUSTUP_TOOLCHAIN=1.98.1', SCRIPT.with_name("cargo.sh").read_text())
        self.assertIn('mbx-1.26.0-', SCRIPT.with_name("bootstrap.sh").read_text())


if __name__ == "__main__":
    unittest.main()
