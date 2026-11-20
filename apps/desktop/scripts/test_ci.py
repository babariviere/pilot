"""CI orchestration plus real manifest/source registration contracts. No builds."""
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
        shutil.copyfile(SCRIPT, self.root / "scripts/ci.sh")
        self.env = dict(os.environ, PATH=f"{self.root / 'bin'}:{os.environ['PATH']}",
                        HOME=str(self.root), CALLS=str(self.root / "calls"))
        for key in ("FAIL_MATCH", "FAKE_OS", "FAKE_ARCH", "FAKE_VERSION", "UPDATER_TEST_LIST"):
            self.env.pop(key, None)
        self.write("scripts/cargo.sh", '''#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$CALLS"
if [[ -n "${FAIL_MATCH:-}" && "$*" == *"$FAIL_MATCH"* ]]; then exit 42; fi
if [[ "$*" == 'test --locked --manifest-path updater/Cargo.toml --lib'*'-- --list' ]]; then
  printf '%s\\n' "${UPDATER_TEST_LIST:-}"
fi
''')
        self.write("bin/uname", '''#!/bin/sh
case "$1" in -s) echo "${FAKE_OS:-Darwin}";; -m) echo "${FAKE_ARCH:-arm64}";; esac
''')
        self.write("bin/sw_vers", '#!/bin/sh\necho "${FAKE_VERSION:-15.7}"\n')
        self.write("bin/xcrun", '#!/bin/sh\n[ "$1" = --show-sdk-version ] && echo synthetic-sdk\n')

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
            self.run_ci("visual-check", expected=1, **env)
        self.assertEqual(self.calls(), [])

    def test_power_check_runs_isolated_models_on_both_hosts(self):
        desktop = self.root / "nested/desktop"
        power = self.root / "nested/power/scripts"
        (desktop / "scripts").mkdir(parents=True)
        power.mkdir(parents=True)
        shutil.copyfile(SCRIPT, desktop / "scripts/ci.sh")
        (power / "cargo.sh").write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n')
        for platform in ("Linux", "Darwin"):
            with self.subTest(platform=platform):
                self.calls_path = self.root / ("power-calls-" + platform)
                result = subprocess.run([self.BASH, str(desktop / "scripts/ci.sh"), "power-check"],
                                        env=dict(self.env, FAKE_OS=platform, FAKE_ARCH="x86_64" if platform == "Linux" else "arm64",
                                                 CALLS=str(self.calls_path)), capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                commands = self.calls_path.read_text().splitlines()
                self.assertEqual(commands[:3], ["fmt -- --check", "clippy --locked --all-targets -- -D warnings", "test --locked"])
                self.assertEqual(commands[3:], ["build --locked"])
        workflow = WORKFLOW.read_text()
        self.assertEqual(workflow.count("run: bash apps/desktop/scripts/ci.sh power-check"), 2)

    def test_visual_check_prepares_engine_and_builds_only_the_real_shared_worker(self):
        self.write("bin/python3", '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n')
        commands = [
            ["scripts/prepare-visual-worker.py"],
            ["fmt", "--all", "--", "--check"],
            ["clippy", "--locked", "-p", "pilot-visual-worker", "--all-targets", "--", "-D", "warnings"],
            ["build", "--locked", "-p", "pilot-visual-worker", "--bin", "pilot-visual-worker"],
        ]
        for host in (dict(FAKE_OS="Linux", FAKE_ARCH="x86_64"), dict(FAKE_OS="Darwin", FAKE_ARCH="arm64")):
            with self.subTest(host=host):
                start = len(self.calls())
                self.run_ci("visual-check", **host)
                self.assertEqual(self.calls()[start:], commands)
        start = len(self.calls())
        self.run_ci("visual-check", expected=42, FAIL_MATCH="clippy")
        self.assertEqual(self.calls()[start:], commands[:3])

    def test_removed_gui_phases_do_not_invoke_cargo(self):
        for phase in ("check", "build", "artifact", "native", "mac-tests", "nsh-native", "linux-gui-check"):
            with self.subTest(phase=phase):
                self.run_ci(phase, expected=2)
        self.assertEqual(self.calls(), [])

    def updater_native_names(self):
        block = SCRIPT.read_text().split("    updater_native_tests=(", 1)[1].split("    )", 1)[0]
        return re.findall(r'^      (\w+)$', block, flags=re.M)

    def updater_listing(self):
        names = self.updater_native_names() + ["signature_verifies_exact_bytes_and_key_not_a_nearby_checksum"]
        return "\n".join(f"owned_tests::{name}: test" for name in names)

    def test_updater_portable_invokes_real_manifest_fmt_strict_clippy_and_nonzero_core_suite(self):
        result = self.run_ci("updater-check", FAKE_OS="Linux", FAKE_ARCH="x86_64",
                             UPDATER_TEST_LIST=self.updater_listing())
        self.assertIn("Standalone updater portable checks started", result.stdout)
        base = ["--manifest-path", "updater/Cargo.toml"]
        self.assertEqual(self.calls(), [
            ["fmt", *base, "--all", "--", "--check"],
            ["clippy", "--locked", *base, "--all-targets", "--", "-D", "warnings"],
            ["test", "--locked", *base, "--lib", "--", "--list"],
            ["nextest", "run", "--locked", "--profile", "ci", "--no-tests=fail", *base, "--lib"],
        ])
        for call in self.calls():
            self.assertNotIn("native-macos", call)
            self.assertNotIn("--release", call)

    def test_linux_updater_native_checks_do_not_use_macos_platform_or_release(self):
        self.run_ci("updater-linux-tests", FAKE_OS="Linux", FAKE_ARCH="x86_64")
        base = ["--manifest-path", "updater/Cargo.toml"]
        self.assertEqual(self.calls(), [
            ["clippy", "--locked", *base, "--all-targets", "--features", "native-linux", "--", "-D", "warnings"],
            ["build", "--locked", *base, "--features", "native-linux", "--bin", "pilot-desktop-update-helper"],
            ["nextest", "run", "--locked", "--profile", "ci", "--no-tests=fail", *base, "--lib", "--features", "native-linux"],
        ])
        self.run_ci("updater-linux-tests", expected=1, FAKE_OS="Darwin", FAKE_ARCH="arm64")

    def test_updater_native_builds_real_helper_and_checks_exact_test_registration(self):
        result = self.run_ci("updater-mac-tests", UPDATER_TEST_LIST=self.updater_listing())
        self.assertIn("Standalone updater macOS Security/ACL/stage/swap/helper checks started", result.stdout)
        base = ["--locked", "--manifest-path", "updater/Cargo.toml"]
        calls = self.calls()
        self.assertEqual(calls[0], ["clippy", *base, "--all-targets", "--features", "native-macos",
                                    "--", "-D", "warnings"])
        self.assertEqual(calls[1], ["build", *base, "--features", "native-macos",
                                    "--bin", "pilot-desktop-update-helper"])
        self.assertEqual(calls[2], ["test", *base, "--lib", "--features", "native-macos", "--", "--list"])
        self.assertEqual(calls[3:], [["nextest", "run", "--locked", "--profile", "ci", "--no-tests=fail",
                                      "--manifest-path", "updater/Cargo.toml", "--lib", "--features",
                                      "native-macos", "--test-threads=1"]])

    def test_updater_missing_registration_zero_counts_and_failed_commands_are_failures(self):
        for phase in ["updater-check", "updater-mac-tests"]:
            with self.subTest(phase=phase):
                self.run_ci(phase, expected=1, UPDATER_TEST_LIST="unrelated: test")
                # Zero selected tests fail inside nextest; the suite must request that.
                self.run_ci(phase, UPDATER_TEST_LIST=self.updater_listing())
                self.assertIn("--no-tests=fail", self.calls()[-1])
                for failure in ["clippy", "-- --list", "nextest run"]:
                    self.run_ci(phase, expected=42, UPDATER_TEST_LIST=self.updater_listing(),
                                FAIL_MATCH=failure)
        self.run_ci("updater-check", expected=42, FAIL_MATCH="fmt")
        self.run_ci("updater-mac-tests", expected=42, FAIL_MATCH="build")
        self.run_ci("updater-mac-tests", expected=42, UPDATER_TEST_LIST=self.updater_listing(),
                    FAIL_MATCH="--lib --features native-macos --test-threads=1")

    def test_missing_local_signed_source_native_test_fails_before_execution(self):
        name = "local_signed_source_stages_then_normal_release_verification_still_works"
        listing = self.updater_listing().splitlines()
        listing.remove(f"owned_tests::{name}: test")
        # A nearby name must not satisfy the exact required-test registration.
        listing.append(f"owned_tests::{name}_nearby: test")
        result = self.run_ci("updater-mac-tests", expected=1, UPDATER_TEST_LIST="\n".join(listing))
        self.assertIn(f"Missing required macOS updater test: {name}", result.stderr)
        self.assertEqual(len(self.calls()), 3)  # clippy, helper build, list; no execution
        self.assertFalse(any(call[0] == "nextest" for call in self.calls()))

    def test_missing_temporary_payload_native_tests_fail_before_execution(self):
        names = [
            "macos_staging_never_exposes_intermediate_apps_beside_installation",
            "temporary_payload_handoff_survives_worker_drop_and_relocated_target",
            "purged_temporary_payload_never_replays_committed_install_or_loses_recovery",
            "failed_download_cleans_only_its_exact_private_temporary_workspace",
            "prepared_payload_moves_extraction_before_commit_but_never_trusts_mutable_staging",
            "prepared_payload_cancellation_can_retry_but_commit_never_discards_evidence",
            "prepared_payload_still_requires_commit_and_fresh_post_exit_guard",
        ]
        for name in names:
            with self.subTest(name=name):
                previous_calls = len(self.calls())
                listing = self.updater_listing().splitlines()
                listing.remove(f"owned_tests::{name}: test")
                listing.append(f"owned_tests::{name}_nearby: test")
                result = self.run_ci("updater-mac-tests", expected=1, UPDATER_TEST_LIST="\n".join(listing))
                self.assertIn(f"Missing required macOS updater test: {name}", result.stderr)
                calls = self.calls()[previous_calls:]
                self.assertEqual(len(calls), 3)
                self.assertFalse(any(call[0] == "nextest" for call in calls))















class CiSystemBashTests(CiTests):
    # CI/macOS ships Bash 3.2; developer PATH may resolve to Bash 5.x instead.
    # The complete fake-tool suite must pass under the actual system shell too.
    BASH = "/bin/bash"


class WorkflowTests(unittest.TestCase):

    def test_rust_is_parallel_sibling_reached_by_both_existing_wrappers(self):
        source = WORKFLOW.read_text()
        jobs = source.split("\njobs:\n", 1)[1]
        self.assertEqual(re.findall(r'^  ([\w-]+):$', jobs, flags=re.M),
                         ["day-contracts", "node", "macos", "rust", "rust-macos-native"])
        self.assertNotRegex(jobs, r'(?m)^    needs:')
        self.assertIn("  workflow_call:", source)
        for wrapper, trigger in [("pr.yaml", "pull_request:"), ("main.yaml", "push:")]:
            caller = WORKFLOW.with_name(wrapper).read_text()
            self.assertIn(trigger, caller)
            self.assertIn("uses: ./.github/workflows/tests.yaml", caller)
            self.assertIn("contents: read", caller)
            self.assertIn("cancel-in-progress: true", caller)
        self.assertIn("branches: [main]", WORKFLOW.with_name("main.yaml").read_text())

    def rust_jobs(self):
        source = WORKFLOW.read_text()
        return {name: re.split(r"\n  [\w-]+:\n", source.split(f"\n  {name}:\n", 1)[1], maxsplit=1)[0]
                for name in ("rust", "rust-macos-native")}

    def test_updater_registration_resolves_real_standalone_manifest_and_all_native_source_tests(self):
        desktop = SCRIPT.parents[1]
        updater = desktop / "updater"
        manifest = tomllib.loads((updater / "Cargo.toml").read_text())
        self.assertEqual(manifest["package"]["name"], "pilot-desktop-updater")
        self.assertFalse(manifest["package"]["autotests"])
        self.assertIn("workspace", manifest)
        self.assertTrue((updater / "Cargo.lock").is_file())
        helper, = manifest["bin"]
        self.assertEqual(helper["name"], "pilot-desktop-update-helper")
        self.assertEqual(helper["required-features"], ["native"])
        self.assertIn("native", manifest["features"]["native-macos"])
        self.assertIn("native", manifest["features"]["native-linux"])
        self.assertTrue((updater / helper["path"]).is_file())
        lib = (updater / "src/lib.rs").read_text()
        self.assertIn('#[cfg(test)]\n#[path = "../tests/owned.rs"]\nmod owned_tests;', lib)
        owned = (updater / "tests/owned.rs").read_text()
        real_tests = set(re.findall(r'#\[test\]\nfn (\w+)\(', owned))
        native_tests = set(re.findall(r'#\[cfg\([^\n]*target_os = "macos"[^\n]*\)\]\n#\[test\]\nfn (\w+)\(', owned))
        selected = set(re.findall(r'^      (\w+)$',
                                 SCRIPT.read_text().split("updater_native_tests=(", 1)[1].split("    )", 1)[0],
                                 flags=re.M))
        self.assertGreater(len(native_tests), 0)
        self.assertTrue(native_tests <= selected, native_tests - selected)
        self.assertTrue(selected <= real_tests, selected - real_tests)
        self.assertIn("signature_verifies_exact_bytes_and_key_not_a_nearby_checksum", real_tests)
        jobs = self.rust_jobs()
        self.assertIn("ci.sh updater-check", jobs["rust"])
        self.assertNotIn("ci.sh updater-mac-tests", jobs["rust"])
        self.assertIn("ci.sh updater-mac-tests", jobs["rust-macos-native"])
        self.assertNotIn("ci.sh updater-check", jobs["rust-macos-native"])
        # Still use the project wrapper (plain Cargo on CI), never a
        # copied miniature crate that could pass while production is untested.
        self.assertIn('cargo() { bash scripts/cargo.sh "$@"; }', SCRIPT.read_text())
        wrapper = SCRIPT.with_name("cargo.sh").read_text()
        for required in ['CARGO_TARGET_DIR="$PWD/target/dev"', 'GITHUB_ACTIONS:-}" == true', 'exec cargo "$@"']:
            self.assertIn(required, wrapper)






if __name__ == "__main__":
    unittest.main()
