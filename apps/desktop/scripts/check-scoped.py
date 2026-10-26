#!/usr/bin/env python3
"""Explicit scoped Rust checks. Full CI/check.sh remain separate and unchanged.

Examples: --unit bundled_runtime::tests; --unit chat_models --test project_creation
See ../docs/scoped-checks.md. Never launches the application or a real daemon.
"""
import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import subprocess
import sys
import time
import tomllib

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_LIMIT = 16 * 1024 * 1024
# Positive, source-audited helper-free contracts. Unknown scopes keep the helper.
PURE_MODULES = {"task_status", "chat_rename", "chat_actions", "bundled_runtime", "chat_models", "delivery_store", "interaction",
                "local_client", "local_model", "mission_conversion", "mission_transport",
                "mission_metadata", "mission_metadata_transport", "mission_update", "mission_update_transport", "mission_task_create", "mission_create", "mission_create_transport", "mission_tasks", "mission_activity", "mission_tasks_reader", "project_registration", "reader_identity_tests", "scoped_models",
                "scoped_models_worker", "settings_state", "settings_worker"}
PURE_NATIVE = {"mission_metadata", "task_status", "chat_rename", "chat_actions", "controls", "project_creation", "mission_tasks", "mission_activity", "mission_update", "mission_task_create", "mission_create"}


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--unit", help="one nonempty library test filter (including transport suites)")
    result.add_argument("--test", action="append", default=[], help="explicit integration/native target; repeat to batch")
    result.add_argument("--native-probes", action="store_true", help="keep this feature stable for unit/native iteration")
    result.add_argument("--worker", action="store_true", help="explicitly require the visual helper")
    result.add_argument("--lint", action="store_true", help="lint only the selected production lib/native targets")
    result.add_argument("--report", type=Path, help="fresh JSON observation file, never overwritten")
    result.add_argument("--timeout", type=float, default=1200, help="per-command deadline, at most1200s")
    result.add_argument("--_queued-at", type=float, help=argparse.SUPPRESS)
    return result


def plan(args, root=ROOT):
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    if not args.unit and not args.test:
        raise ValueError("Select --unit FILTER or --test NAME; there is no default sweep")
    if args.unit is not None and (not args.unit.strip() or args.unit.startswith("-")):
        raise ValueError("A library filter must be nonempty and cannot be an option")
    if not 0 < args.timeout <= 1200:
        raise ValueError("Deadline must be positive and at most1200s")
    tests = list(dict.fromkeys(args.test))
    if len(tests) > 8:
        raise ValueError("Select at most8 targets; use the separate explicit full gate for broad coverage")
    entries = {item["name"]: item for item in manifest.get("test", [])}
    native = []
    for name in tests:
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", name):
            raise ValueError("Invalid test name")
        entry = entries.get(name, {})
        source = root / entry.get("path", f"tests/{name}.rs")
        if not source.is_file():
            raise ValueError(f"Unknown test target: {name}")
        if entry.get("harness", True) is False:
            if name not in {"rendering", "chrome", "visuals"} and "native-probes" not in entry.get("required-features", []):
                raise ValueError(f"Not an ordinary synthetic native test: {name}")
            if args.unit and re.search(r"\b(?:args|args_os)\s*\(", source.read_text()):
                raise ValueError("Mixed library/native batches require a main that ignores libtest arguments")
            native.append(name)
    if native and (platform.system(), platform.machine()) != ("Darwin", "arm64"):
        raise ValueError("Native execution requires macOS arm64; no Linux/native acceptance implied")
    flags = ["--locked", "--color", "never", "-p", "pilot-desktop"]
    if args.native_probes or native:
        flags += ["--features", "native-probes"]
    if args.unit:
        flags += ["--lib"]
    for name in tests:
        flags += ["--test", name]
    unit_module = args.unit.split("::", 1)[0] if args.unit else None
    worker = args.worker or (args.unit is not None and unit_module not in PURE_MODULES) or any(name not in PURE_NATIVE | {"settings_state"} for name in tests)
    return flags, tests, native, bool(worker)


def darwin_exited_group(pid, status):
    """Positive singleton census, never infer cleanup from EPERM/absent PIDs.

    Only the caller's still-unreaped terminal child can justify this fallback.
    libproc includes zombies and returns PID counts (not byte counts). Two
    slots ensure any extra member or a full/truncated buffer is rejected.
    """
    evidence = {"confirmed": False}
    if (sys.platform != "darwin" or status is None or status.si_pid != pid
            or status.si_code not in {os.CLD_EXITED, os.CLD_KILLED, os.CLD_DUMPED}):
        return evidence
    try:
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        query = library.proc_listpgrppids
        query.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        query.restype = ctypes.c_int
        members = (ctypes.c_int * 2)()
        ctypes.set_errno(0)
        count = query(pid, members, ctypes.sizeof(members))
        error = ctypes.get_errno()
        evidence.update(count=count, errno=error, members=list(members))
        if error == 0 and count == 1 and members[0] == pid and members[1] == 0:
            # No census can restore ownership lost to an unexpected waiter.
            current = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
            evidence["confirmed"] = current is not None and (current.si_pid, current.si_code, current.si_status) == (pid, status.si_code, status.si_status)
    except (OSError, AttributeError) as error:
        evidence.update(errno=getattr(error, "errno", None), query_error=type(error).__name__)
    return evidence


def run(command, root, timeout, records):
    """Bound capture/deadline; only this temporary check's own group is canceled."""
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
        raise RuntimeError("Retaining owned check identity requires default SIGCHLD; no command started")
    print("scoped:", " ".join(command), flush=True)
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output = bytearray()
    compile_end = None
    successful = False
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise RuntimeError("Scoped check deadline exceeded")
                if not selector.select(min(remaining, 0.2)):
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > OUTPUT_LIMIT:
                    raise RuntimeError("Scoped check output exceeded16MiB")
                if compile_end is None and b"Finished `test` profile" in output[-66000:]:
                    compile_end = time.monotonic() - started
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
        # Do not reap the session leader yet. Its unreaped child identity keeps
        # the group ID reserved even when it exits before descendants/stdout.
        while (status := os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)) is None:
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise RuntimeError("Scoped check deadline exceeded")
            time.sleep(min(remaining, 0.01))
        successful = status.si_code == os.CLD_EXITED and status.si_status == 0
    finally:
        cleanup_error = None
        cleanup = {"state": "not-needed", "leader_pid": process.pid}
        if not successful:
            try:
                # WNOWAIT never consumes the leader. No poll/wait/send_signal
                # may release it before failure cleanup, including exit7.
                retained = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                cleanup["retained_status"] = None if retained is None else dict(pid=retained.si_pid, code=retained.si_code, status=retained.si_status)
            except OSError as error:
                cleanup.update(state="identity-unconfirmed", identity_errno=error.errno)
                cleanup_error = "Owned check identity was lost; group cleanup is unconfirmed"
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                    cleanup["state"] = "group-signaled"
                except ProcessLookupError as error:
                    cleanup.update(state="no-group-target", signal_errno=error.errno)
                except OSError as error:
                    cleanup.update(state="group-unconfirmed", signal_errno=error.errno)
                    if error.errno == errno.EPERM:
                        # Darwin killpg rejects zombie-only groups. Require an
                        # affirmative, complete census containing ONLY the same
                        # retained terminal child, not ESRCH from getpgid/ps.
                        cleanup["group_census"] = darwin_exited_group(process.pid, retained)
                        if cleanup["group_census"]["confirmed"]:
                            cleanup["state"] = "retained-exited-leader-only"
                    if cleanup["state"] == "group-unconfirmed":
                        cleanup_error = f"Owned check group cleanup is unconfirmed (killpg errno={error.errno})"
        try:
            code = process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            cleanup["reap"] = "unconfirmed"
            cleanup_error = "Owned check leader reap is unconfirmed"
        process.stdout.close()
        duration = time.monotonic() - started
        records.append(dict(command=command, seconds=duration, exit_code=process.returncode, cleanup=cleanup,
                            compile_link_and_cargo_seconds_observed=compile_end,
                            execute_and_cargo_seconds_observed=None if compile_end is None else max(0, duration - compile_end)))
        if cleanup_error:
            raise RuntimeError(cleanup_error)
    if code:
        raise RuntimeError(f"Scoped command failed ({code})")
    return output.decode(errors="replace")


def verify_results(output, unit, tests, native):
    summaries = re.findall(r"test result: ok\. (\d+) passed;", output)
    expected = bool(unit) + len([name for name in tests if name not in native])
    if len(summaries) != expected or any(int(number) == 0 for number in summaries):
        raise RuntimeError("Missing/zero-test library or integration result; not passed")
    for name in native:
        if not re.search(r"Running .*\b" + re.escape(name) + r"-[a-zA-Z0-9]+\)", output):
            raise RuntimeError(f"Native target did not run: {name}")
    if native and re.search(r"\bUNSUPPORTED\b|NOT executed", output):
        raise RuntimeError("Unsupported native execution is not a passing probe")


def execute(args, root=ROOT):
    flags, tests, native, worker = plan(args, root)
    records = []
    report = dict(schema=1, stages=records, features=["native-probes"] if "--features" in flags else [],
                  profile="test (existing manifest/config/env; not overridden)",
                  manifest_profiles=tomllib.loads((root / "Cargo.toml").read_text()).get("profile", {}),
                  build_override_sha256={key: hashlib.sha256(value.encode()).hexdigest() for key, value in os.environ.items()
                                         if key.startswith("CARGO_PROFILE_") or key in {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER"}},
                  unit=args.unit, tests=tests,
                  native=native, worker=worker, platform=platform.platform(), arch=platform.machine(),
                  cpu_count=os.cpu_count(), cargo_lock_sha256=hashlib.sha256((root / "Cargo.lock").read_bytes()).hexdigest(),
                  queue_and_startup_seconds=None if args._queued_at is None else time.monotonic() - args._queued_at)
    handle = args.report.open("x") if args.report else None
    cargo = ["bash", "scripts/cargo.sh"]
    try:
        if worker:
            run([sys.executable, "scripts/prepare-visual-worker.py"], root, args.timeout, records)
            run(cargo + ["build", "--locked", "-p", "pilot-visual-worker"], root, args.timeout, records)
        if args.lint:
            run(cargo + ["clippy", *flags, "--", "-D", "warnings"], root, args.timeout, records)
        command = cargo + ["test", *flags]
        if args.unit:
            command += [args.unit]
        output = run(command + ["--", "--test-threads=1"], root, args.timeout, records)
        verify_results(output, args.unit, tests, native)
        report["passed"] = True
    except BaseException:
        report["passed"] = False
        raise
    finally:
        if handle:
            with handle:
                json.dump(report, handle, indent=2)
                handle.write("\n")
    return report


def interrupted(number, _frame):
    raise SystemExit(128 + number)


def admission_command(argv):
    holder = os.environ.get("PILOT_VERIFICATION_SWIFT_PID")
    if holder == str(os.getpid()):
        return None
    if holder:
        raise ValueError("Inherited verification holder: run directly or exec inside the held wrapper; refusing a nested queue")
    runner = ROOT.parents[1] / "scripts/verification-slot.py"
    return [sys.executable, str(runner), "swift", "--", sys.executable,
            str(Path(__file__).resolve()), *argv, "--_queued-at", str(time.monotonic())]


def main():
    args = parser().parse_args()
    plan(args)  # Reject typos/empty selection before queueing or preparing/building.
    command = admission_command(sys.argv[1:])
    if command is not None:
        os.execv(sys.executable, command)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    execute(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Scoped checks failed: {error}", file=sys.stderr)
        raise SystemExit(1)
