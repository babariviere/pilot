"""Day dispatch tests. Only fake compilers/runtimes run; state lives in TMPDIR."""
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import tempfile
import unittest


DAY = Path(__file__).resolve().parents[1]
PIN = "530b73170f61e5bf16380959de9e622f8ce130cd"

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
        "MBX_BLAZE", "MBX_DISABLE"]})) + "\\n")
if kind == "mbx":
    if args == ["--version"]:
        print(os.environ.get("FAKE_MBX_VERSION", "mbx 1.26.0"))
        sys.exit(int(os.environ.get("VERSION_EXIT", 0)))
    assert os.environ["MBX_CARGO_SHIM_MODE"] == "1"
    os.environ["VIA_MBX"] = "yes"
    os.execv(os.environ["CARGO"], [os.environ["CARGO"], *args])
if kind == "real-cargo":
    assert os.environ["VIA_MBX"] == "yes", "local Cargo bypass"
    if "nsh-cli" in args:
        status = int(os.environ.get("COMPILE_EXIT", 0))
        if status: sys.exit(status)
        target = pathlib.Path(args[args.index("--target-dir") + 1])
        exe = target / "debug" / "nsh"
        exe.parent.mkdir(parents=True, exist_ok=True)
        exe.write_text(pathlib.Path(__file__).read_text())
        exe.chmod(0o755)
    else:
        sys.exit(int(os.environ.get("NESTED_EXIT", 0)))
elif kind == "nsh":
    assert "VIA_MBX" not in os.environ, "runtime wrapped in compiler session"
    command = args[0] if args else "help"
    if command == "signal-probe":
        print("ready", flush=True)
        signal.pause()
    if command in ["run", "check", "build", "test"]:
        # Models the audited CARGO hook. Real upstream coverage is separate.
        nested = {"run": ["build", "--manifest-path", ".nsh/rust/Cargo.toml", "-p", "macos-host"],
            "check": ["check", "--all-targets", "--manifest-path", "native/Cargo.toml"],
            "build": ["build", "--manifest-path", ".nsh/rust/Cargo.toml", "-p", "describe"],
            "test": ["build", "--manifest-path", ".nsh/rust/Cargo.toml", "-p", "test"]}[command]
        result = subprocess.run([os.environ["CARGO"], *nested])
        if result.returncode: sys.exit(result.returncode)
    sys.exit(int(os.environ.get("RUNTIME_EXIT", 0)))
'''


class Dispatch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="day dispatch ", dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.day = self.root / "app with spaces"
        self.src = self.root / "upstream with spaces"
        self.bin = self.root / "fake tools"
        self.bin.mkdir()
        self.src.mkdir()
        self.day.mkdir()
        shutil.copytree(DAY / "scripts", self.day / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        subprocess.run(["/usr/bin/git", "init", "-q", str(self.src)], check=True)
        (self.src / "Cargo.lock").write_text("fixture lock\n")
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
        self.pin = self.git("rev-parse", "HEAD").stdout.strip()
        (self.day / "nsh.sh").write_text((DAY / "nsh.sh").read_text().replace(PIN, self.pin))
        for name in ("mbx", "real-cargo"):
            (self.bin / name).write_text(FAKE)
            (self.bin / name).chmod(0o755)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("NSH_", "CARGO", "MBX_", "RUSTUP_"))}
        self.env.update(NSH_DAY_SOURCE=str(self.src), NSH_DAY_MBX=str(self.bin / "mbx"),
                        CARGO=str(self.bin / "real-cargo"), TRACE=str(self.root / "trace"),
                        HOME=str(self.root / "home"), CARGO_TARGET_DIR=str(self.root / "app target"),
                        CARGO_PROFILE_DEV_DEBUG="0", CARGO_INCREMENTAL="0")

    def git(self, *args):
        return subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                               "-C", str(self.src), *args], check=True, text=True, capture_output=True)

    def run_day(self, *args, env=None, shell="/bin/bash"):
        return subprocess.run([shell, str(self.day / "nsh.sh"), *args], cwd=self.root,
                              env=self.env | (env or {}), text=True, capture_output=True, timeout=10)

    def trace(self):
        path = self.root / "trace"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_each_command_routes_cli_and_nested_compilation_but_not_execution(self):
        for command in ("run", "check", "build", "test"):
            with self.subTest(command=command):
                (self.root / "trace").unlink(missing_ok=True)
                args = [command, "Entry with spaces.tsx", "--", "", "a'b", "$(false)", "two\nlines"]
                result = self.run_day(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                events = self.trace()
                compiles = [e for e in events if e["kind"] == "real-cargo"]
                self.assertEqual(len(compiles), 2)
                cli, nested = compiles
                self.assertEqual(cli["args"][:5], ["build", "--locked", "--quiet", "-p", "nsh-cli"])
                self.assertEqual(cli["cwd"], str(self.src.resolve()))
                self.assertIn(str(self.day / ".tools" / "target" / f"nsh-{self.pin}"), cli["args"])
                self.assertEqual(nested["cwd"], str(self.day.resolve()))
                self.assertEqual(nested["env"]["CARGO_TARGET_DIR"], self.env["CARGO_TARGET_DIR"])
                self.assertEqual(nested["env"]["RUSTUP_TOOLCHAIN"], "1.99.1")
                self.assertEqual(nested["env"]["CARGO_PROFILE_DEV_DEBUG"], "0")
                self.assertEqual(nested["env"]["CARGO_INCREMENTAL"], "0")
                runtime = next(e for e in events if e["kind"] == "nsh")
                self.assertEqual(runtime["args"], args)
                self.assertIsNone(runtime["env"]["MBX_CARGO_SHIM_MODE"])
                self.assertEqual(self.git("status", "--porcelain").stdout, "")
                self.assertFalse((self.src / "target").exists())

    def test_compile_failure_never_runs_cli_or_falls_back(self):
        self.assertEqual(self.run_day("run", env={"COMPILE_EXIT": "37"}).returncode, 37)
        self.assertFalse(any(e["kind"] == "nsh" for e in self.trace()))

    def test_nested_and_runtime_failures_are_not_swallowed(self):
        self.assertEqual(self.run_day("check", env={"NESTED_EXIT": "42"}).returncode, 42)
        self.assertEqual(self.run_day("help", env={"RUNTIME_EXIT": "23"}).returncode, 23)

    def test_missing_or_wrong_mbx_fails_before_clone_or_cargo(self):
        result = self.run_day("run", env={"NSH_DAY_MBX": str(self.root / "missing")})
        self.assertEqual(result.returncode, 127)
        self.assertIn("requires mbx", result.stderr)
        result = self.run_day("run", env={"FAKE_MBX_VERSION": "mbx 1.28.0"})
        self.assertEqual(result.returncode, 1)
        self.assertFalse(any(e["kind"] in ("real-cargo", "nsh") for e in self.trace()))
        self.assertEqual(self.run_day("run", env={"VERSION_EXIT": "38"}).returncode, 38)

    def test_missing_mbx_on_path_has_no_local_build_fallback(self):
        result = self.run_day("run", env={"NSH_DAY_MBX": "", "PATH": "/usr/bin:/bin"})
        self.assertEqual(result.returncode, 127)
        self.assertEqual(self.trace(), [])

    def test_path_and_existing_desktop_install(self):
        result = self.run_day("check", env={"NSH_DAY_MBX": "", "PATH": f"{self.bin}:{os.environ['PATH']}"})
        self.assertEqual(result.returncode, 0, result.stderr)
        desktop_bin = self.root / "desktop" / ".tools" / "bin"
        desktop_bin.mkdir(parents=True)
        shutil.copy2(self.bin / "mbx", desktop_bin / "mbx")
        result = self.run_day("check", env={"NSH_DAY_MBX": ""})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dirty_wrong_and_missing_explicit_sources_are_not_changed(self):
        lock = self.src / "Cargo.lock"
        lock.write_text("edited\n")
        self.assertNotEqual(self.run_day("run").returncode, 0)
        self.assertEqual(lock.read_text(), "edited\n")
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "later")
        later = self.git("rev-parse", "HEAD").stdout
        self.assertNotEqual(self.run_day("run").returncode, 0)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout, later)
        absent = self.root / "absent"
        self.assertNotEqual(self.run_day("run", env={"NSH_DAY_SOURCE": str(absent)}).returncode, 0)
        self.assertFalse(absent.exists())

    def test_relative_source_and_explicit_toolchain(self):
        result = self.run_day("check", env={"NSH_DAY_SOURCE": self.src.name, "RUSTUP_TOOLCHAIN": "named-toolchain"})
        self.assertEqual(result.returncode, 0, result.stderr)
        for e in self.trace():
            if e["kind"] == "real-cargo":
                self.assertEqual(e["env"]["RUSTUP_TOOLCHAIN"], "named-toolchain")

    def test_default_project_install_and_cache_settings(self):
        dest = self.day / ".tools" / "bin"
        dest.mkdir(parents=True)
        shutil.copy2(self.bin / "mbx", dest / "mbx")
        result = self.run_day("check", env={"NSH_DAY_MBX": "", "MBX_DISABLE": "1", "MBX_BLAZE": "1",
            "MBX_TARGET_VIEWS": "1", "MBX_REMOTE_URL": "https://not-used.invalid"})
        self.assertEqual(result.returncode, 0, result.stderr)
        for e in self.trace():
            if e["kind"] == "real-cargo":
                self.assertEqual(e["env"]["MBX_GC_AUTO"], "0")
                self.assertEqual(e["env"]["MBX_REMOTE_URL"], "")
                self.assertEqual(e["env"]["MBX_SCHEDULER_CPUS"], "2")
                self.assertEqual(e["env"]["MBX_SCHEDULER_MEMORY"], "4GiB")
                self.assertTrue(e["env"]["MBX_CACHE_DIR"].endswith("/gpui-fixture-mbx-v1"))
                for name in ("MBX_TARGET_VIEWS", "MBX_BLAZE", "MBX_DISABLE"):
                    self.assertEqual(e["env"][name], "0")

    def test_cargo_namespace_and_arguments(self):
        args = ["--color", "always", "test", "--locked", "--profile", "custom", "--", "--help", "a b", ""]
        result = subprocess.run([str(self.day / "scripts" / "cargo"), *args], env=self.env,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.trace()[-1]["args"], args)

    def test_bootstrap_uses_existing_project_pin_and_checksums(self):
        bootstrap = (DAY / "scripts" / "bootstrap.sh").read_text()
        existing = (DAY.parent / "desktop" / "scripts" / "bootstrap.sh").read_text()
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
