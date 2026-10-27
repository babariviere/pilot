"""Local dev dispatch, not compiler or application correctness tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent


class BlazeDispatch(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        for name in ["cargo.sh", "bootstrap.sh", "bootstrap-blaze.sh"]:
            shutil.copyfile(SCRIPTS / name, self.root / "scripts" / name)
        (self.root / "scripts/prepare-patches.py").write_text("")
        program = "#!/usr/bin/env python3\nimport os,sys,json\nprint(json.dumps({'args':sys.argv[1:],'env':dict(os.environ)}))\n"
        for name in [".tools/bin/mbx", ".tools/blaze/bin/mbx", ".tools/blaze/bin/ra-jit", ".tools/blaze/shim/cargo"]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(program)
            path.chmod(0o700)
        rustup = self.root / ".tools/bin/rustup"
        rustup.write_text("#!/bin/sh\nprintf '%s/bin/cargo\\n' \"$RUSTUP_HOME/toolchains/1.99.0-test\"\n")
        rustup.chmod(0o700)
        self.env = {key: value for key, value in os.environ.items() if key not in {"CI", "GITHUB_ACTIONS"}}
        self.env["MBX_BLAZE"] = "1"

    def run_wrapper(self, *args, env=None, script="cargo.sh", shell="/bin/bash"):
        return subprocess.run([shell, str(self.root / "scripts" / script), *args],
                              env=env or self.env, capture_output=True, text=True, timeout=5)

    def test_ordinary_path_retains_pins_and_disables_ambient_blaze(self):
        for args in [("test", "--lib"), ("build", "--release"), ("clippy", "--all-targets")]:
            result = self.run_wrapper(*args)
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads(result.stdout)
            self.assertEqual(record["args"], list(args))
            self.assertEqual(record["env"]["MBX_BLAZE"], "0")
            self.assertEqual(record["env"]["RUSTUP_TOOLCHAIN"], "1.98.1")
            self.assertEqual(record["env"]["CARGO_TARGET_DIR"], str(self.root / "target/dev"))

    def test_local_blaze_has_private_outputs_and_resource_reservation(self):
        for shell in dict.fromkeys(["/bin/bash", shutil.which("bash")]):
            result = self.run_wrapper("--blaze", "build", "--locked", shell=shell)
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads(result.stdout)
            self.assertEqual(record["args"], ["reserve", "--cpus", "2", "--memory", "4GiB", "--",
                                            "env", "MBX_CACHE_DIR=" + str(Path(self.env.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "gpui-fixture-blaze-mbx-v1"),
                                            str(self.root / ".tools/blaze/shim/cargo"), "build", "--locked"])
            env = record["env"]
            for key, value in {"MBX_BLAZE": "1", "CARGO_BUILD_JOBS": "2", "RUSTUP_TOOLCHAIN": "1.99.0",
                               "MBX_SCHEDULER_CPUS": "2", "MBX_SCHEDULER_MEMORY": "4GiB",
                               "MBX_TARGET_VIEWS": "0", "MBX_REMOTE_URL": "", "RA_JIT_SPARE": "0",
                               "RA_JIT_CACHE": "off", "MBX_GC_MAX_SIZE": "2GiB"}.items():
                self.assertEqual(env[key], value)
            self.assertEqual(env["CARGO_TARGET_DIR"], str(self.root / "target/blaze"))
            self.assertTrue(env["RA_JIT_HOME"].startswith(str(Path.home() / ".cache/pb")))

    def test_blaze_rejects_ci_and_non_dev_profiles(self):
        for args in [("build", "--release"), ("run", "-r"), ("test", "--profile", "dev"),
                     ("check", "--profile=release"), ("clippy",), ("+stable", "build"), ("-q", "build")]:
            self.assertNotEqual(self.run_wrapper("--blaze", *args).returncode, 0, args)
        for key in ["CI", "GITHUB_ACTIONS"]:
            env = {**self.env, key: "true"}
            for script in ["cargo.sh", "bootstrap.sh"]:
                result = self.run_wrapper("--blaze", "build", env=env, script=script)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("local development only", result.stderr)

    def test_program_arguments_are_not_cargo_profiles(self):
        result = self.run_wrapper("--blaze", "run", "--", "--release")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_setup_is_actionable_not_silent_fallback(self):
        (self.root / ".tools/blaze/shim/cargo").unlink()
        result = self.run_wrapper("--blaze", "build")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bootstrap.sh --blaze", result.stderr)

    def test_status_and_stop_only_address_private_daemon(self):
        for command in ["status", "stop"]:
            result = self.run_wrapper("--blaze", command)
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads(result.stdout)
            self.assertEqual(record["args"], [command])
            self.assertIn("/.cache/pb/", record["env"]["RA_JIT_HOME"])

    def test_bootstrap_bad_hash_stops_before_extract_or_install(self):
        binaries = self.root / ".tools/bin"
        curl = binaries / "curl"
        curl.write_text("#!/bin/sh\nwhile [ \"$1\" != -o ]; do shift; done\nshift\nprintf corrupt > \"$1\"\n")
        curl.chmod(0o700)
        # The fixture's rustup prints a path; none should be printed on failure.
        env = {**self.env, "PATH": str(binaries) + os.pathsep + self.env["PATH"]}
        result = self.run_wrapper("--blaze", script="bootstrap.sh", env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA256 mismatch", result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
