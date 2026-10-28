"""Faux command contract tests. No Rust build, GPU, daemon or profile access."""
import contextlib
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import shutil
import signal
import socket
import subprocess
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("scoped", Path(__file__).with_name("check-scoped.py"))
scoped = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scoped)


class ScopedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scoped-command-faux-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "tests").mkdir()
        for name in ["controls", "project_creation", "visuals", "settings_state", "capture"]:
            (self.root / "tests" / (name + ".rs")).write_text("fn main() {}\n")
        (self.root / "Cargo.lock").write_text("version=4\n")
        (self.root / "Cargo.toml").write_text('''[package]
name="pilot-desktop"
version="0.1.0"
[profile.dev]
debug=0
[profile.test]
debug=0
[[test]]
name="controls"
harness=false
required-features=["native-probes"]
[[test]]
name="project_creation"
harness=false
required-features=["native-probes"]
[[test]]
name="visuals"
harness=false
[[test]]
name="capture"
harness=false
test=false
''')
        self.platform = patch.multiple(scoped.platform, system=lambda: "Darwin", machine=lambda: "arm64")
        self.platform.start()
        self.addCleanup(self.platform.stop)

    def args(self, *values):
        return scoped.parser().parse_args(values)

    def test_no_default_or_empty_option_like_selection(self):
        for values in [(), ("--unit=",), ("--unit=  ",), ("--unit=--ignored",), ("--test=../controls",), ("--test=missing",), ("--test=capture",)]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                scoped.plan(self.args(*values), self.root)

    def test_scope_and_resource_defaults_remain_explicit(self):
        flags, tests, native, worker = scoped.plan(self.args("--unit", "bundled_runtime::tests"), self.root)
        self.assertEqual(flags, ["--locked", "--color", "never", "-p", "pilot-desktop", "--lib"])
        self.assertEqual((tests, native, worker), ([], [], False))
        self.assertFalse(scoped.plan(self.args("--unit", "draft_discard"), self.root)[3])
        for timeout in ["0", "1201", "nan"]:
            with self.assertRaises(ValueError):
                scoped.plan(self.args("--unit", "scope", "--timeout", timeout), self.root)

    def test_mixed_native_is_single_stable_feature_selection(self):
        flags, tests, native, worker = scoped.plan(self.args("--unit", "chat_models", "--test", "project_creation", "--test", "project_creation"), self.root)
        self.assertEqual(tests, ["project_creation"])
        self.assertEqual(native, ["project_creation"])
        self.assertFalse(worker)
        self.assertEqual(flags.count("--features"), 1)
        self.assertIn("--lib", flags)
        self.assertFalse(scoped.plan(self.args("--unit", "chat_model", "--test", "project_creation"), self.root)[3])
        self.assertFalse(scoped.plan(self.args("--unit", "model_picker", "--native-probes"), self.root)[3])

    def test_required_and_unknown_helpers_are_not_silently_omitted(self):
        for values in [("--unit", "visual_runtime::tests"), ("--unit", "future_module::tests"), ("--test", "visuals"), ("--unit", "bundled_runtime::tests", "--worker")]:
            self.assertTrue(scoped.plan(self.args(*values), self.root)[3])
        self.assertFalse(scoped.plan(self.args("--test", "settings_state"), self.root)[3])

    def test_provider_usage_uses_only_cached_summary_projections(self):
        self.assertFalse(scoped.plan(self.args("--unit", "provider_usage"), self.root)[3])
        (self.root / "tests/provider_usage.rs").write_text("fn main() {}\n")
        manifest = self.root / "Cargo.toml"
        manifest.write_text(manifest.read_text() + '\n[[test]]\nname="provider_usage"\nharness=false\nrequired-features=["native-probes"]\n')
        self.assertFalse(scoped.plan(self.args("--test", "provider_usage"), self.root)[3])

    def test_conversation_images_use_static_rasters_not_the_visual_worker(self):
        self.assertFalse(scoped.plan(self.args("--unit", "conversation_images"), self.root)[3])
        (self.root / "tests/conversation_images.rs").write_text("fn main() {}\n")
        manifest = self.root / "Cargo.toml"
        manifest.write_text(manifest.read_text() + '''
[[test]]
name="conversation_images"
harness=false
required-features=["native-probes"]
''')
        self.assertFalse(scoped.plan(self.args("--test", "conversation_images"), self.root)[3])
        self.assertTrue(scoped.plan(self.args("--test", "conversation_images", "--worker"), self.root)[3])

    def test_native_platform_and_argument_parser_are_fail_closed(self):
        with patch.object(scoped.platform, "system", return_value="Linux"), self.assertRaises(ValueError):
            scoped.plan(self.args("--test", "controls"), self.root)
        (self.root / "tests/controls.rs").write_text("fn main() { std::env::args(); }")
        with self.assertRaises(ValueError):
            scoped.plan(self.args("--unit", "chosen", "--test", "controls"), self.root)

    def test_zero_ignored_missing_harness_and_missing_native_never_pass(self):
        for output in ["", "test result: ok. 0 passed; 0 failed; 1 ignored;", "test result: ok. 1 passed;"]:
            with self.assertRaises(RuntimeError):
                scoped.verify_results(output, "chosen", ["controls"], ["controls"])
        scoped.verify_results("test result: ok. 1 passed;\nRunning tests/controls.rs (target/dev/debug/deps/controls-abcd)\n", "chosen", ["controls"], ["controls"])
        with self.assertRaises(RuntimeError):
            scoped.verify_results("Running tests/controls.rs (target/dev/debug/deps/controls-abcd)\nUNSUPPORTED", None, ["controls"], ["controls"])

    def test_execution_batches_once_and_preserves_failure_report(self):
        calls = []
        def command(command, _root, _timeout, records):
            calls.append(command)
            return "test result: ok. 2 passed;\nRunning tests/controls.rs (target/dev/debug/deps/controls-abcd)\n"
        report = self.root / "observed.json"
        with patch.object(scoped, "run", side_effect=command):
            result = scoped.execute(self.args("--unit", "chat_models", "--test", "controls", "--report", str(report)), self.root)
        self.assertTrue(result["passed"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][-3:], ["chat_models", "--", "--test-threads=1"])
        self.assertIn("test", calls[0])
        with self.assertRaises(FileExistsError):
            scoped.execute(self.args("--unit", "chat_models", "--report", str(report)), self.root)
        failed = self.root / "failed.json"
        with patch.object(scoped, "run", side_effect=RuntimeError("fixture failed")), self.assertRaises(RuntimeError):
            scoped.execute(self.args("--unit", "chat_models", "--report", str(failed)), self.root)
        self.assertIn('"passed": false', failed.read_text())

    def test_lint_is_only_selected_production_lib_and_native(self):
        calls = []
        def command(command, *_args):
            calls.append(command)
            return "test result: ok. 1 passed;"
        with patch.object(scoped, "run", side_effect=command):
            scoped.execute(self.args("--unit", "bundled_runtime::tests", "--lint"), self.root)
        self.assertEqual([command[2] for command in calls], ["clippy", "test"])
        self.assertFalse(any("--all-targets" in command or "--workspace" in command for command in calls))

    def test_required_helper_failure_stops_before_test_execution(self):
        calls = []
        def command(command, *_args):
            calls.append(command)
            if len(calls) == 2:
                raise RuntimeError("owned helper build failed")
            return ""
        with patch.object(scoped, "run", side_effect=command), self.assertRaises(RuntimeError):
            scoped.execute(self.args("--unit", "visual_runtime::tests"), self.root)
        self.assertEqual(calls[0][1], "scripts/prepare-visual-worker.py")
        self.assertIn("pilot-visual-worker", calls[1])
        self.assertEqual(len(calls), 2)

    def test_bounded_real_faux_process_exit_and_output_failure(self):
        records = []
        with contextlib.redirect_stdout(io.TextIOWrapper(io.BytesIO())):
            scoped.run([scoped.sys.executable, "-c", "print('small faux output')"], self.root, 2, records)
            with self.assertRaises(RuntimeError):
                scoped.run([scoped.sys.executable, "-c", "raise SystemExit(7)"], self.root, 2, records)
            with patch.object(scoped, "OUTPUT_LIMIT", 32), self.assertRaises(RuntimeError):
                scoped.run([scoped.sys.executable, "-c", "print('x'*1000)"], self.root, 2, records)
            with self.assertRaises(RuntimeError):
                scoped.run([scoped.sys.executable, "-c", "import time; time.sleep(60)"], self.root, 0.05, records)
            with self.assertRaises(RuntimeError):
                scoped.run([scoped.sys.executable, "-c", "import os,time;os.close(1);os.close(2);time.sleep(60)"], self.root, 0.05, records)
        self.assertEqual(records[0]["exit_code"], 0)
        self.assertEqual(records[1]["exit_code"], 7)
        self.assertLess(records[-1]["seconds"], 2)

    def test_nondefault_child_reaper_refused_before_start(self):
        with patch.object(scoped.signal, "getsignal", return_value=signal.SIG_IGN), patch.object(scoped.subprocess, "Popen") as start, self.assertRaisesRegex(RuntimeError, "no command started"):
            scoped.run(["must-not-start"], self.root, 1, [])
        start.assert_not_called()

    def test_lost_child_ownership_never_signals_group_or_claims_success(self):
        records = []
        with contextlib.redirect_stdout(io.TextIOWrapper(io.BytesIO())), patch.object(scoped.os, "waitid", side_effect=ChildProcessError), patch.object(scoped.os, "killpg") as kill, self.assertRaisesRegex(RuntimeError, "identity was lost"):
            scoped.run([scoped.sys.executable, "-c", "pass"], self.root, 2, records)
        kill.assert_not_called()
        self.assertEqual(records[0]["exit_code"], 0)

    @unittest.skipUnless(scoped.sys.platform == "darwin", "Darwin zombie-group regression")
    def test_darwin_exited_singleton_preserves_real_nonzero_with_positive_census(self):
        records, errors = [], []
        kill_group = scoped.os.killpg
        def observe(group, number):
            status = os.waitid(os.P_PID, group, os.WEXITED | os.WNOWAIT | os.WNOHANG)
            self.assertEqual((status.si_pid, status.si_code, status.si_status), (group, os.CLD_EXITED, 101))
            try:
                kill_group(group, number)
            except OSError as error:
                errors.append(error.errno)
                raise
        with contextlib.redirect_stdout(io.TextIOWrapper(io.BytesIO())), patch.object(scoped.os, "killpg", side_effect=observe), self.assertRaisesRegex(RuntimeError, r"failed \(101\)"):
            scoped.run([scoped.sys.executable, "-I", "-S", "-c", "import os;os._exit(101)"], self.root, 2, records)
        self.assertEqual(errors, [errno.EPERM], "reproduce actual native errno, not a mocked permission error")
        self.assertEqual(records[0]["exit_code"], 101)
        cleanup = records[0]["cleanup"]
        self.assertEqual(cleanup["state"], "retained-exited-leader-only")
        self.assertEqual(cleanup["signal_errno"], errno.EPERM)
        self.assertEqual(cleanup["group_census"], dict(confirmed=True, count=1, errno=0, members=[cleanup["leader_pid"], 0]))

    def test_census_requires_positive_complete_singleton_and_retained_terminal_identity(self):
        status = SimpleNamespace(si_pid=12345, si_code=os.CLD_EXITED, si_status=101)
        for count, members, error, confirmed in [
            (1, [12345, 0], 0, True),
            (0, [0, 0], 0, False),
            (-1, [0, 0], errno.EPERM, False),
            (1, [12345, 0], errno.EPERM, False),
            (1, [12346, 0], 0, False),
            (2, [12345, 12346], 0, False),
            (3, [12345, 12346], 0, False),
            (1, [12345, 12346], 0, False),
        ]:
            with self.subTest(count=count, members=members, error=error):
                library = SimpleNamespace()
                def query(pid, buffer, size):
                    self.assertEqual((pid, size), (12345, 8))
                    buffer[0], buffer[1] = members
                    scoped.ctypes.set_errno(error)
                    return count
                library.proc_listpgrppids = query
                with patch.object(scoped.sys, "platform", "darwin"), patch.object(scoped.ctypes, "CDLL", return_value=library), patch.object(scoped.os, "waitid", return_value=status):
                    self.assertEqual(scoped.darwin_exited_group(12345, status)["confirmed"], confirmed)
        for terminal in [None, SimpleNamespace(si_pid=12346, si_code=os.CLD_EXITED, si_status=101),
                         SimpleNamespace(si_pid=12345, si_code=os.CLD_STOPPED, si_status=signal.SIGSTOP)]:
            with patch.object(scoped.sys, "platform", "darwin"), patch.object(scoped.ctypes, "CDLL") as load:
                self.assertFalse(scoped.darwin_exited_group(12345, terminal)["confirmed"])
                load.assert_not_called()
        with patch.object(scoped.sys, "platform", "linux"), patch.object(scoped.ctypes, "CDLL") as load:
            self.assertFalse(scoped.darwin_exited_group(12345, status)["confirmed"])
            load.assert_not_called()
        with patch.object(scoped.sys, "platform", "darwin"), patch.object(scoped.ctypes, "CDLL", side_effect=OSError(errno.EPERM, "denied")):
            self.assertFalse(scoped.darwin_exited_group(12345, status)["confirmed"])
        def singleton(pid, buffer, size):
            buffer[0] = pid
            return 1
        library = SimpleNamespace(proc_listpgrppids=singleton)
        for changed in [None, SimpleNamespace(si_pid=12345, si_code=os.CLD_EXITED, si_status=102), ChildProcessError(errno.ECHILD, "lost")]:
            with patch.object(scoped.sys, "platform", "darwin"), patch.object(scoped.ctypes, "CDLL", return_value=library), patch.object(scoped.os, "waitid", **({"side_effect":changed} if isinstance(changed, BaseException) else {"return_value":changed})):
                self.assertFalse(scoped.darwin_exited_group(12345, status)["confirmed"])

    def test_signal_refusal_without_proof_stays_unconfirmed_and_records_errno(self):
        for number in [errno.EPERM, errno.EACCES]:
            records = []
            with contextlib.redirect_stdout(io.TextIOWrapper(io.BytesIO())), patch.object(scoped.os, "killpg", side_effect=OSError(number, "synthetic refusal")), patch.object(scoped, "darwin_exited_group", return_value={"confirmed":False}) as census, self.assertRaisesRegex(RuntimeError, "cleanup is unconfirmed"):
                scoped.run([scoped.sys.executable, "-c", "raise SystemExit(101)"], self.root, 2, records)
            self.assertEqual(records[0]["exit_code"], 101)
            self.assertEqual(records[0]["cleanup"]["signal_errno"], number)
            self.assertEqual(census.call_count, int(number == errno.EPERM))

    def test_subprocess_disables_ambient_blaze(self):
        with patch.dict(os.environ, MBX_BLAZE="1"), contextlib.redirect_stdout(io.TextIOWrapper(io.BytesIO())):
            output = scoped.run([scoped.sys.executable, "-c", "import os; print(os.environ['MBX_BLAZE'])"], self.root, 3, [])
        self.assertEqual(output.strip(), "0")

    def test_system_and_path_bash_keep_actual_wrapper_bounds_and_failure(self):
        scripts = self.root / "scripts"
        scripts.mkdir()
        shutil.copyfile(Path(__file__).with_name("cargo.sh"), scripts / "cargo.sh")
        (scripts / "prepare-patches.py").write_text("# Preparation stub in a disposable command fixture only.\n")
        binaries = self.root / ".tools/bin"
        binaries.mkdir(parents=True)
        mbx = binaries / "mbx"
        mbx.write_text("#!" + scoped.sys.executable + "\nimport os,sys\n"
                       "assert os.environ['CARGO_BUILD_JOBS']=='2'\n"
                       "assert os.environ['MBX_SCHEDULER_CPUS']=='2'\n"
                       "assert os.environ['MBX_SCHEDULER_MEMORY']=='4GiB'\n"
                       "assert os.environ['CARGO_TARGET_DIR']==os.getcwd()+'/target/dev'\n"
                       "assert os.environ['MBX_TARGET_VIEWS']=='0'\n"
                       "assert os.environ['RUSTUP_TOOLCHAIN']=='1.98.1'\n"
                       "assert os.environ['MBX_BLAZE']=='0'\n"
                       "assert '--lib' in sys.argv\nprint('test result: ok. 1 passed;')\n"
                       "raise SystemExit(int(os.environ.get('SCOPED_FAUX_EXIT','0')))\n")
        mbx.chmod(0o700)
        # Outside GitHub Actions the wrapper uses mbx; CI runs plain Cargo instead.
        ambient = {key: os.environ.pop(key) for key in ["GITHUB_ACTIONS"] if key in os.environ}
        self.addCleanup(os.environ.update, ambient)
        for shell in dict.fromkeys(["/bin/bash", shutil.which("bash")]):
            with self.subTest(shell=shell), contextlib.redirect_stdout(io.TextIOWrapper(io.BytesIO())):
                output = scoped.run([shell, "scripts/cargo.sh", "test", "--lib"], self.root, 3, [])
                scoped.verify_results(output, "chosen", [], [])
                with patch.dict(os.environ, SCOPED_FAUX_EXIT="7"), self.assertRaises(RuntimeError):
                    scoped.run([shell, "scripts/cargo.sh", "test", "--lib"], self.root, 3, [])

    def test_term_flushes_failed_receipt_after_reaping_only_its_faux_check(self):
        receipt = self.root / "terminated.json"
        program = (
            "import importlib.util,json,signal\nfrom pathlib import Path\n"
            f"s=importlib.util.spec_from_file_location('scoped',{str(Path(__file__).with_name('check-scoped.py'))!r})\n"
            "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"
            "signal.signal(signal.SIGTERM,m.interrupted)\nr=[]\ntry:\n"
            f" m.run([m.sys.executable,'-c',\"import time;print('READY',flush=True);time.sleep(60)\"],Path({str(self.root)!r}),10,r)\n"
            f"finally:\n Path({str(receipt)!r}).write_text(json.dumps(r))\n"
        )
        parent = subprocess.Popen([scoped.sys.executable, "-c", program], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertIn("scoped:", parent.stdout.readline())
            self.assertEqual(parent.stdout.readline().strip(), "READY")
            parent.send_signal(signal.SIGTERM)
            parent.communicate(timeout=3)
            self.assertEqual(parent.returncode, 128 + signal.SIGTERM)
            self.assertEqual(json.loads(receipt.read_text())[0]["exit_code"], -signal.SIGKILL)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.communicate()

    def exited_leader_fixture(self, inherited_stdout, denied=False):
        # A private connection is both the liveness oracle and cleanup handle.
        # Even a broken runner cannot leave the fixture's finite child behind:
        # closing this connection releases it, without signaling any PID/file ID.
        with tempfile.TemporaryDirectory(prefix="owned-group-", dir="/tmp") as short:
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(Path(short) / "control"))
            listener.listen(1)
            listener.settimeout(3)
            connections, errors = [], []
            ready = threading.Event()
            def accept():
                try:
                    connection, _ = listener.accept()
                    connections.append(connection)
                    connection.settimeout(3)
                    self.assertEqual(connection.recv(1), b"R")
                except BaseException as error:
                    errors.append(error)
                finally:
                    ready.set()
            thread = threading.Thread(target=accept)
            thread.start()
            child = (
                "import os,socket,sys\n"
                "s=socket.socket(socket.AF_UNIX);s.settimeout(3)\n"
                f"s.connect({str(Path(short) / 'control')!r});s.sendall(b'R')\n"
                "os.write(int(sys.argv[1]),b'R');os.close(int(sys.argv[1]))\n"
                "s.settimeout(60);s.recv(1)\n"
            )
            leader = (
                "import os,subprocess,sys\nr,w=os.pipe()\n"
                f"subprocess.Popen([sys.executable,'-c',{child!r},str(w)],pass_fds=(w,),stdout="
                + ("None" if inherited_stdout else "subprocess.DEVNULL")
                + ",stderr=" + ("None" if inherited_stdout else "subprocess.DEVNULL")
                + ")\nos.close(w);assert os.read(r,1)==b'R';os.close(r)\nraise SystemExit(7)\n"
            )
            records = []
            signaled = []
            kill_group = scoped.os.killpg
            def checked_signal(group, number):
                status = os.waitid(os.P_PID, group, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                self.assertIsNotNone(status, "exited child remains reserved until signal")
                self.assertEqual((status.si_code, status.si_status), (os.CLD_EXITED, 7))
                signaled.append(group)
                if denied:
                    raise PermissionError(errno.EPERM, "synthetic group signal denial with a real live descendant")
                kill_group(group, number)
            try:
                with contextlib.redirect_stdout(io.TextIOWrapper(io.BytesIO())), patch.object(scoped.os, "killpg", side_effect=checked_signal), self.assertRaises(RuntimeError) as outcome:
                    scoped.run([scoped.sys.executable, "-c", leader], self.root, 1, records)
                self.assertIn("cleanup is unconfirmed" if denied else ("deadline" if inherited_stdout else "failed (7)"), str(outcome.exception))
                self.assertTrue(ready.wait(3), "finite child established private lifetime handle")
                self.assertFalse(errors)
                self.assertEqual(records[0]["exit_code"], 7)
                self.assertEqual(len(signaled), 1)
                if denied:
                    connections[0].settimeout(0.05)
                    with self.assertRaises(socket.timeout):
                        connections[0].recv(1)
                    self.assertEqual(records[0]["cleanup"]["signal_errno"], errno.EPERM)
                    self.assertFalse(records[0]["cleanup"]["group_census"]["confirmed"])
                    self.assertEqual(records[0]["cleanup"]["group_census"]["count"], 2)
                else:
                    connections[0].settimeout(0.5)
                    self.assertEqual(connections[0].recv(1), b"", "owned descendant must exit despite leader already exiting")
            finally:
                # On regression this EOF, not PID signaling, releases the child.
                listener.close()
                thread.join(timeout=4)
                for connection in connections:
                    try:
                        try:
                            connection.shutdown(socket.SHUT_WR)
                        except OSError as error:
                            if error.errno not in (errno.ENOTCONN, errno.EPIPE):
                                raise
                        connection.settimeout(2)
                        self.assertEqual(connection.recv(1), b"", "fixture lifetime EOF releases its finite child")
                    finally:
                        connection.close()
                self.assertFalse(thread.is_alive())

    def test_exited_leader_with_inherited_pipe_does_not_leave_owned_descendant(self):
        self.exited_leader_fixture(True)

    def test_exited_nonzero_leader_with_redirected_child_does_not_leave_owned_descendant(self):
        self.exited_leader_fixture(False)

    @unittest.skipUnless(scoped.sys.platform == "darwin", "Darwin positive census negative control")
    def test_darwin_denied_group_with_live_descendant_is_never_singleton_success(self):
        self.exited_leader_fixture(False, denied=True)


if __name__ == "__main__":
    unittest.main()
