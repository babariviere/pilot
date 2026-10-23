"""CI orchestration contracts, fake tools only. Never invokes Rust/native/Swift."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("ci.sh")
WORKFLOW = SCRIPT.parents[3] / ".github/workflows/desktop-rust.yml"


class CiTests(unittest.TestCase):
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
                        DESKTOP_CI_OUTPUT=str(self.root / "output"),
                        GITHUB_STEP_SUMMARY=str(self.root / "summary"))
        # Eliminate inherited test controls, never production environment tools.
        for key in ["FAIL_MATCH", "FAKE_OS", "FAKE_ARCH", "FAKE_VERSION", "METAL_CODE", "FAKE_LIPO"]:
            self.env.pop(key, None)
        self.write("scripts/cargo.sh", '''#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$CALLS"
if [[ -n "${FAIL_MATCH:-}" && "$*" == *"$FAIL_MATCH"* ]]; then exit 42; fi
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
        result = subprocess.run(["bash", str(self.root / "scripts/ci.sh"), phase],
                                env=dict(self.env, **environment), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def calls(self):
        path = self.root / "calls"
        return [shlex.split(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_host_rejects_linux_intel_and_old_macos_before_cargo(self):
        for env in [dict(FAKE_OS="Linux"), dict(FAKE_ARCH="x86_64"), dict(FAKE_VERSION="14.8")]:
            self.run_ci("check", expected=1, **env)
        self.assertEqual(self.calls(), [])

    def test_release_build_is_locked_workspace_both_bins_without_test_features(self):
        self.run_ci("build")
        self.assertEqual(self.calls(), [["build", "--locked", "--release", "--workspace", "--bins"]])

    def test_checks_fail_fast_and_do_not_hide_clippy_failure(self):
        self.run_ci("check", expected=42, FAIL_MATCH="clippy")
        calls = self.calls()
        self.assertEqual(calls[0], ["fmt", "--all", "--", "--check"])
        self.assertEqual(calls[1], ["build", "--locked", "-p", "pilot-visual-worker"])
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
        self.assertEqual(calls[-1], ["-m", "unittest", "discover", "-s", "scripts", "-p", "test_*.py", "-v"])

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
        self.assertEqual(len(calls), 15)
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


class WorkflowTests(unittest.TestCase):
    def test_pr_main_paths_include_transitive_inputs_and_match_each_other(self):
        source = WORKFLOW.read_text()
        pull, push = source.split("  push:")
        paths = lambda text: [line.strip() for line in text.splitlines() if line.strip().startswith("- '")]
        self.assertEqual(paths(pull), paths(push))
        for pattern in ["apps/desktop/**", "apps/macos/Sources/PilotVisualEngine/**",
                        "packages/artifacts/src/visual/**", "packages/protocol/fixtures/visual/**",
                        ".github/workflows/desktop-rust.yml", ".cargo/**", "Cargo.*", "rust-toolchain*"]:
            self.assertIn(f"- '{pattern}'", pull)
        self.assertIn("branches: [main]", push)

    def test_least_privilege_bounded_unsigned_pipeline_and_download_only_cache(self):
        source = WORKFLOW.read_text()
        for required in ["contents: read", "persist-credentials: false", "cancel-in-progress: true",
                         "runs-on: macos-15", "timeout-minutes: 90", "retention-days: 7",
                         "github.event.pull_request.head.sha", "${{ github.sha }}", "hashFiles(",
                         "~/.cargo/registry/cache", "apps/desktop/.tools/downloads"]:
            self.assertIn(required, source)
        for forbidden in ["pull_request_target:", "secrets.", "contents: write", "continue-on-error:",
                          "restore-keys:", "release.yaml", "bundle.sh", "gh release", "cargo publish"]:
            self.assertNotIn(forbidden, source)
        phases = ["host", "bootstrap", "check", "build", "artifact", "native"]
        positions = [source.index(f"bash apps/desktop/scripts/ci.sh {phase}") for phase in phases]
        self.assertEqual(positions, sorted(positions))
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
