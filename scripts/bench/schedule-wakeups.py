"""macOS per-process CPU/wakeup counters, without sudo or changing host networking.

python3 scripts/bench/schedule-wakeups.py
Runs 70 seconds per phase, sampling kernel counters across the middle 65 seconds.
The isolated detector benchmark reports cold-start cost separately. Child sysctl costs are excluded.
"""
import ctypes
import json
import subprocess
import sys
import time

if sys.platform != "darwin":
    raise SystemExit("macOS is required for proc_pid_rusage")


class Usage(ctypes.Structure):
    # rusage_info_v2 from sys/resource.h (RUSAGE_INFO_V2 = 2).
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64)
        for name in [
            "user", "system", "pkg_idle", "interrupt", "pageins", "wired",
            "resident", "footprint", "start", "exit", "child_user", "child_system",
            "child_pkg", "child_interrupt", "child_pageins", "child_elapsed",
            "read_bytes", "write_bytes",
        ]
    ]


lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
lib.proc_pid_rusage.restype = ctypes.c_int


def sample(pid):
    out = Usage()
    if lib.proc_pid_rusage(pid, 2, ctypes.byref(out)) != 0:
        raise OSError(ctypes.get_errno())
    return out


for mode in ["idle", "online", "offline"]:
    child = subprocess.Popen(
        ["node", "scripts/bench/schedule-detection.ts", "70", mode],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        time.sleep(2)
        before = sample(child.pid)
        time.sleep(65)
        after = sample(child.pid)
        print(json.dumps({
            "phase": mode,
            "measuredSeconds": 65,
            "kernelCpuMs": (after.user + after.system - before.user - before.system) / 1_000_000,
            "packageIdleWakeups": after.pkg_idle - before.pkg_idle,
            "interruptWakeups": after.interrupt - before.interrupt,
        }), flush=True)
        stdout, _ = child.communicate(timeout=20)
        print(stdout, end="", flush=True)
        if child.returncode:
            raise RuntimeError(f"benchmark exited {child.returncode}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
