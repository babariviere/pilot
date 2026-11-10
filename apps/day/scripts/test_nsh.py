"""Installed CLI dispatch tests. Only fake tools run; state lives in TMPDIR."""
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import tempfile
import tomllib
import unittest


DAY = Path(__file__).resolve().parents[1]
PIN = "e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3"

FAKE = '''#!/usr/bin/env python3
import json, os, pathlib, signal, subprocess, sys
kind = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["TRACE"], "a") as out:
    out.write(json.dumps(dict(kind=kind, args=args, cwd=os.getcwd(), env={
        k: os.environ.get(k) for k in ["CARGO", "CARGO_TARGET_DIR", "RUSTUP_TOOLCHAIN",
        "CARGO_PROFILE_DEV_DEBUG", "CARGO_INCREMENTAL", "MBX_CARGO_SHIM_MODE",
        "MBX_CARGO_SHIM_PATH", "MBX_CACHE_DIR", "MBX_SCHEDULER_CPUS",
        "MBX_SCHEDULER_MEMORY", "MBX_TARGET_VIEWS", "MBX_GC_AUTO", "MBX_REMOTE_URL",
        "MBX_BLAZE", "MBX_DISABLE", "CARGO_NET_OFFLINE"]})) + "\\n")
if kind == "mbx":
    if args == ["--version"]:
        print(os.environ.get("FAKE_MBX_VERSION", "mbx 1.26.0"))
        sys.exit(int(os.environ.get("VERSION_EXIT", 0)))
    assert os.environ["MBX_CARGO_SHIM_MODE"] == "1"
    os.environ["VIA_MBX"] = "yes"
    os.execv(os.environ["CARGO"], [os.environ["CARGO"], *args])
elif kind == "real-cargo":
    assert os.environ["VIA_MBX"] == "yes", "local Cargo bypass"
    assert "nsh-cli" not in args, "never build nsh-cli locally"
    sys.exit(int(os.environ.get("NESTED_EXIT", 0)))
elif kind == "nsh":
    assert "VIA_MBX" not in os.environ, "runtime wrapped in compiler session"
    if args == ["--version"]:
        print(os.environ.get("FAKE_NSH_VERSION", "nsh 0.4.0 (e626a8d)"))
        sys.exit(int(os.environ.get("NSH_VERSION_EXIT", 0)))
    command = args[0] if args else "help"
    if command == "signal-probe":
        print("ready", flush=True)
        signal.pause()
    if command in ["run", "check", "build", "test"]:
        # Models the release's supported CARGO hook, not native acceptance.
        nested = {"run": ["build", "--manifest-path", ".nsh/rust/Cargo.toml", "-p", "macos-host"],
            "check": ["check", "--all-targets", "--manifest-path", "native/Cargo.toml"],
            "build": ["build", "--manifest-path", ".nsh/rust/Cargo.toml", "-p", "describe"],
            "test": ["build", "--manifest-path", ".nsh/rust/Cargo.toml", "-p", "test"]}[command]
        result = subprocess.run([os.environ["CARGO"], *nested])
        if result.returncode: sys.exit(result.returncode)
    sys.exit(int(os.environ.get("RUNTIME_EXIT", 0)))
'''


class ReleasePins(unittest.TestCase):
    def test_configs_use_only_release_supported_window_configuration(self):
        for config in (DAY / "nsh.json", DAY / "fixtures/rust-today/nsh.json"):
            self.assertNotIn("window", json.loads(config.read_text()))

    def test_manifests_and_locks_share_the_peeled_release_commit(self):
        for directory in (DAY / "native", DAY / "fixtures/rust-today"):
            with self.subTest(directory=directory):
                manifest = tomllib.loads((directory / "Cargo.toml").read_text())
                for group in ("dependencies", "dev-dependencies"):
                    for name, dep in manifest.get(group, {}).items():
                        if name.startswith("nsh-"):
                            self.assertEqual(dep["git"], "https://github.com/longbridge/nsh")
                            self.assertEqual(dep["rev"], PIN)
                packages = tomllib.loads((directory / "Cargo.lock").read_text())["package"]
                nsh = [p for p in packages if p["name"].startswith("nsh-")]
                self.assertTrue(nsh)
                expected = f"git+https://github.com/longbridge/nsh?rev={PIN}#{PIN}"
                for package in nsh:
                    self.assertEqual(package["version"], "0.4.0")
                    self.assertEqual(package["source"], expected)
                self.assertNotIn("nsh-i18n", [p["name"] for p in nsh])

    def test_runner_lock_uses_the_release_path_crates(self):
        lock = tomllib.loads((DAY / "runner.Cargo.lock").read_text())
        nsh = [p for p in lock["package"] if p["name"].startswith("nsh-") and not p["name"].startswith("nsh-app-")]
        self.assertTrue(nsh)
        for package in nsh:
            self.assertEqual(package["version"], "0.4.0")
            self.assertNotIn("source", package)
        self.assertNotIn("nsh-i18n", [p["name"] for p in nsh])


class Dispatch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="day dispatch ", dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.day = self.root / "app with spaces"
        self.bin = self.root / "fake tools"
        self.bin.mkdir()
        self.day.mkdir()
        shutil.copytree(DAY / "scripts", self.day / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy2(DAY / "nsh.sh", self.day / "nsh.sh")
        shutil.copy2(DAY / "runner.Cargo.lock", self.day / "runner.Cargo.lock")
        for name in ("mbx", "real-cargo", "nsh"):
            (self.bin / name).write_text(FAKE)
            (self.bin / name).chmod(0o755)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("NSH_", "CARGO", "MBX_", "RUSTUP_"))}
        self.env.update(NSH_DAY_CLI=str(self.bin / "nsh"), NSH_DAY_MBX=str(self.bin / "mbx"),
                        CARGO=str(self.bin / "real-cargo"), TRACE=str(self.root / "trace"),
                        HOME=str(self.root / "home"), CARGO_TARGET_DIR=str(self.root / "app target"),
                        CARGO_PROFILE_DEV_DEBUG="0", CARGO_INCREMENTAL="0")

    def run_day(self, *args, env=None):
        return subprocess.run(["/bin/bash", str(self.day / "nsh.sh"), *args], cwd=self.root,
                              env=self.env | (env or {}), text=True, capture_output=True, timeout=10)

    def trace(self):
        path = self.root / "trace"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_commands_use_installed_cli_and_only_nested_cargo(self):
        installed = (self.bin / "nsh").read_bytes()
        for command in ("run", "check", "build", "test"):
            with self.subTest(command=command):
                (self.root / "trace").unlink(missing_ok=True)
                args = [command, "Entry with spaces.tsx", "--", "", "a'b", "$(false)", "two\nlines"]
                result = self.run_day(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                events = self.trace()
                compiles = [e for e in events if e["kind"] == "real-cargo"]
                self.assertEqual(len(compiles), 1)
                nested = compiles[0]
                self.assertEqual(nested["cwd"], str(self.day.resolve()))
                for name, value in {"CARGO_TARGET_DIR": self.env["CARGO_TARGET_DIR"],
                                    "RUSTUP_TOOLCHAIN": "1.99.1", "CARGO_PROFILE_DEV_DEBUG": "0",
                                    "CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true"}.items():
                    self.assertEqual(nested["env"][name], value)
                runtime = next(e for e in events if e["kind"] == "nsh" and e["args"] != ["--version"])
                self.assertEqual(runtime["args"], args)
                self.assertIsNone(runtime["env"]["MBX_CARGO_SHIM_MODE"])
                self.assertEqual((self.bin / "nsh").read_bytes(), installed)
                self.assertFalse((self.day / ".tools").exists())

    def test_missing_wrong_and_unrelated_cli_never_build_or_download(self):
        self.assertEqual(self.run_day("check", env={"NSH_DAY_CLI": str(self.root / "absent")}).returncode, 127)
        for version in ("nsh 0.4.0 (530b731)", "0.4.2", "nsh 0.4.1 (e626a8d)"):
            result = self.run_day("check", env={"FAKE_NSH_VERSION": version})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("expected longbridge/nsh", result.stderr)
        self.assertEqual(self.run_day("check", env={"NSH_VERSION_EXIT": "39"}).returncode, 39)
        self.assertFalse(any(e["kind"] == "real-cargo" for e in self.trace()))
        self.assertFalse((self.day / ".tools").exists())

    def test_path_and_official_install_keep_distribution_in_place(self):
        result = self.run_day("check", env={"NSH_DAY_CLI": "", "PATH": f"{self.bin}:{os.environ['PATH']}"})
        self.assertEqual(result.returncode, 0, result.stderr)
        official = Path(self.env["HOME"]) / ".nsh/bin"
        official.mkdir(parents=True)
        shutil.copy2(self.bin / "nsh", official / "nsh")
        result = self.run_day("check", env={"NSH_DAY_CLI": "", "PATH": "/usr/bin:/bin"})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_nested_and_runtime_failures_are_not_swallowed(self):
        self.assertEqual(self.run_day("check", env={"NESTED_EXIT": "42"}).returncode, 42)
        self.assertEqual(self.run_day("help", env={"RUNTIME_EXIT": "23"}).returncode, 23)

    def test_fresh_runner_locks_are_seeded_existing_locks_are_kept(self):
        self.assertEqual(self.run_day("check").returncode, 0)
        for directory in (self.day, self.day / "fixtures/rust-today"):
            lock = directory / ".nsh/rust/Cargo.lock"
            self.assertEqual(lock.read_bytes(), (DAY / "runner.Cargo.lock").read_bytes())
            lock.write_text("existing resolved lock\n")
        self.assertEqual(self.run_day("build").returncode, 0)
        for directory in (self.day, self.day / "fixtures/rust-today"):
            self.assertEqual((directory / ".nsh/rust/Cargo.lock").read_text(), "existing resolved lock\n")

    def test_missing_or_wrong_mbx_has_no_local_build_fallback(self):
        self.assertEqual(self.run_day("run", env={"NSH_DAY_MBX": str(self.root / "missing")}).returncode, 127)
        self.assertEqual(self.run_day("run", env={"FAKE_MBX_VERSION": "mbx 1.28.0"}).returncode, 1)
        self.assertEqual(self.run_day("run", env={"VERSION_EXIT": "38"}).returncode, 38)
        self.assertEqual(self.run_day("run", env={"NSH_DAY_MBX": "", "PATH": "/usr/bin:/bin"}).returncode, 127)
        self.assertFalse(any(e["kind"] in ("real-cargo", "nsh") for e in self.trace()))

    def test_relative_cli_and_explicit_toolchain(self):
        result = self.run_day("check", env={"NSH_DAY_CLI": "fake tools/nsh", "RUSTUP_TOOLCHAIN": "named-toolchain"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.trace()[-1]["env"]["RUSTUP_TOOLCHAIN"], "named-toolchain")

    def test_default_project_mbx_and_cache_settings(self):
        dest = self.day / ".tools/bin"
        dest.mkdir(parents=True)
        shutil.copy2(self.bin / "mbx", dest / "mbx")
        result = self.run_day("check", env={"NSH_DAY_MBX": "", "MBX_DISABLE": "1", "MBX_BLAZE": "1",
            "MBX_TARGET_VIEWS": "1", "MBX_REMOTE_URL": "https://not-used.invalid"})
        self.assertEqual(result.returncode, 0, result.stderr)
        event = next(e for e in self.trace() if e["kind"] == "real-cargo")
        for name, value in {"MBX_GC_AUTO": "0", "MBX_REMOTE_URL": "", "MBX_SCHEDULER_CPUS": "2",
                            "MBX_SCHEDULER_MEMORY": "4GiB", "MBX_TARGET_VIEWS": "0", "MBX_BLAZE": "0",
                            "MBX_DISABLE": "0"}.items():
            self.assertEqual(event["env"][name], value)
        self.assertTrue(event["env"]["MBX_CACHE_DIR"].endswith("/gpui-fixture-mbx-v1"))

    def test_cargo_namespace_and_arguments(self):
        args = ["--color", "always", "test", "--locked", "--profile", "custom", "--", "--help", "a b", ""]
        result = subprocess.run([str(self.day / "scripts/cargo"), *args], env=self.env,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.trace()[-1]["args"], args)

    def test_bootstrap_uses_existing_project_pin_and_checksums(self):
        bootstrap = (DAY / "scripts/bootstrap.sh").read_text()
        existing = (DAY.parent / "desktop/scripts/bootstrap.sh").read_text()
        for line in bootstrap.splitlines():
            if "; sha=" in line:
                self.assertIn(line.strip(), existing)
        self.assertIn("v1.26.0/mbx-", bootstrap)
        self.assertIn("mktemp -d", bootstrap)
        self.assertNotIn("cargo ", bootstrap.lower())

    def test_enclosing_mbx_session_is_refused(self):
        result = self.run_day("run", env={"MBX_SOCKET": "/not-a-session"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside an existing mbx", result.stderr)

    def test_runtime_exec_keeps_signal_delivery(self):
        process = subprocess.Popen(["/bin/bash", str(self.day / "nsh.sh"), "signal-probe"],
                                   env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        self.assertTrue(select.select([process.stdout], [], [], 10)[0], "runtime did not start")
        self.assertEqual(process.stdout.readline(), "ready\n")
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, -signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
