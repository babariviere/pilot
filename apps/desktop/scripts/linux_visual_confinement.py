#!/usr/bin/env python3
"""Native helper/kernel probes, NOT Wayland renderer or platform qualification.

Build the exact-source worker and its linux_confinement example first. All
attacks target fresh files, descriptors and listeners owned by this driver.
No daemon, app profile, existing compositor or product enablement is involved.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time


def read_exact(pipe, count, seconds=3):
    end = time.monotonic() + seconds
    result = bytearray()
    while len(result) < count:
        if not select.select([pipe], [], [], max(0, end - time.monotonic()))[0]:
            raise TimeoutError("fixture pipe stalled")
        part = os.read(pipe.fileno(), count - len(result))
        if not part:
            raise EOFError("helper closed")
        result.extend(part)
    return bytes(result)


def frame(child):
    size = struct.unpack("<I", read_exact(child.stdout, 4))[0]
    assert size <= 2 * 1024**2
    return read_exact(child.stdout, size)


def send(child, request):
    body = json.dumps(request, separators=(",", ":")).encode()
    child.stdin.write(struct.pack("<I", len(body)) + body)
    child.stdin.flush()


def pv(raw):
    """Fixture decoder only; production independently validates hostile replies."""
    assert raw[:3] == b"PV\x01"
    index, strings = 3, []

    def byte():
        nonlocal index
        value = raw[index]
        index += 1
        return value

    def integer():
        value = 0
        for shift in range(0, 70, 7):
            b = byte()
            value |= (b & 127) << shift
            if b < 128:
                return value
        raise ValueError("varint")

    def string():
        nonlocal index
        tag = integer()
        if not tag & 1:
            return strings[tag >> 1]
        length = tag >> 1
        value = raw[index:index + length].decode("utf-8", errors="strict")
        index += length
        if length <= 64 and len(strings) < 4096:
            strings.append(value)
        return value

    def value(depth=0):
        nonlocal index
        assert depth <= 64
        tag = byte()
        if tag < 3:
            return [None, False, True][tag]
        if tag == 3:
            n = integer()
            return (n >> 1) ^ -(n & 1)
        if tag == 4:
            n = struct.unpack("<d", raw[index:index + 8])[0]
            index += 8
            return n
        if tag == 5:
            return string()
        if tag == 6:
            return [value(depth + 1) for _ in range(integer())]
        assert tag == 7
        out = {}
        for _ in range(integer()):
            key = string()
            assert key not in out
            out[key] = value(depth + 1)
        return out

    out = value()
    assert index == len(raw)
    return out


def status(pid):
    tasks = []
    for task in sorted(Path(f"/proc/{pid}/task").iterdir()):
        text = (task / "status").read_text()
        fields = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
        assert fields["Seccomp"].strip() == "2"
        assert fields["NoNewPrivs"].strip() == "1"
        tasks.append({"tid": int(task.name), "seccomp": 2, "no_new_privs": 1,
                      "filters": fields["Seccomp_filters"].strip()})
    return tasks


def load(source="({ui})=>ui.text('Synthetic')", **kwargs):
    return dict(kind="load", source=source, data=None, state=None, seed="fixture", now=0, **kwargs)


class Fixture:
    def __init__(self, worker, probe, root):
        self.worker, self.probe, self.root = worker, probe, root
        self.sentinel = root / "sentinel"
        self.sentinel.write_bytes(b"fixture must not change")
        self.executable = root / "exec-target"
        shutil.copyfile("/usr/bin/true", self.executable)
        self.executable.chmod(0o700)
        self.count = 0

    @contextmanager
    def child(self, probe_mode=None):
        with socket.socket() as listener, self.sentinel.open("rb") as read, self.sentinel.open("r+b") as write:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.setblocking(False)
            port = listener.getsockname()[1]
            for target, fd in zip((100, 101, 102), (read.fileno(), write.fileno(), listener.fileno())):
                os.dup2(fd, target)
            args = ([str(self.probe), str(self.sentinel), str(self.executable), probe_mode, str(port)]
                    if probe_mode else [str(self.worker), "--probe-port", str(port)])
            try:
                child = subprocess.Popen(args, env={}, cwd="/", stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         pass_fds=(100, 101, 102))
            finally:
                for fd in (100, 101, 102):
                    os.close(fd)
            try:
                if not probe_mode:
                    hello = json.loads(frame(child))
                    assert hello == dict(protocol=1, pid=child.pid, engine="0.17.0",
                                         runtimeHash=RUNTIME_HASH, sandbox=True)
                    tasks = status(child.pid)
                    assert len(tasks) == 2, tasks  # actual helper main + watchdog
                yield child
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=3)
                assert not Path(f"/proc/{child.pid}").exists(), "not reaped"
                child.stdin.close()
                child.stdout.close()
                errors = child.stderr.read()
                child.stderr.close()
                assert not errors, errors.decode(errors="replace")
                try:
                    connection, _ = listener.accept()
                except BlockingIOError:
                    pass
                else:
                    connection.close()
                    raise AssertionError("helper contacted fixture listener")
                assert self.sentinel.read_bytes() == b"fixture must not change"

    def passed(self, name):
        self.count += 1
        print(f"PASS {name}", flush=True)

    def run(self, corpus):
        for mode in ("inspect", "watchdog"):
            with self.child(mode) as child:
                # A short JSON line, no buffered reads competing with frame IO.
                report = bytearray()
                while not report.endswith(b"\n"):
                    report.extend(read_exact(child.stdout, 1))
                    assert len(report) < 16384
                report = json.loads(report)
                assert report["main"] == report["preexisting_thread"]
                assert len(report["main"]) == 38
                tasks = status(child.pid)
                assert len(tasks) == 3, tasks
                print(json.dumps(dict(mode=mode, tasks=tasks, attacks=report["main"])), flush=True)
                if mode == "inspect":
                    child.stdin.write(b"x")
                    child.stdin.flush()
                    assert child.wait(timeout=3) == 0
                else:
                    assert child.wait(timeout=3) == 124
            self.passed(f"kernel-denials-tsync-{mode}")

        with self.child() as child:
            limits = Path(f"/proc/{child.pid}/limits").read_text()
            print(limits, flush=True)
            for name, soft, hard in (("Max cpu time", "60", "60"),
                                     ("Max file size", "0", "0"),
                                     ("Max core file size", "0", "0"),
                                     ("Max open files", "16", "16"),
                                     ("Max address space", "335544320", "335544320")):
                line = next(line for line in limits.splitlines() if line.startswith(name))
                assert line[len(name):].split()[:2] == [soft, hard], line
            send(child, load())
            assert pv(frame(child))["ok"] is True
        self.passed("actual-helper-threads-limits-load")

        for case in corpus["cases"]:
            with self.child() as child:
                request = load(case["source"])
                request.update(data=case["data"], state=case.get("state"), seed=case["id"], now=case["now"])
                send(child, request)
                reply = pv(frame(child))
                for i, step in enumerate(case["steps"]):
                    if i:
                        event = step["event"]
                        send(child, dict(kind="event", id=event["id"], value=event["value"], now=case["now"]))
                        reply = pv(frame(child))
                    assert reply["tree"] == step["tree"], case["name"]
                    assert reply.get("changed") == step.get("changed"), case["name"]
                assert reply["state"] == case["finalState"], case["name"]
            self.passed("shared-case: " + case["name"])

        for case in corpus["errors"]:
            with self.child() as child:
                request = load(case["source"])
                request["data"] = case["data"]
                send(child, request)
                reply = pv(frame(child))
                for draw in case.get("draws", []):
                    if not reply["ok"]:
                        break
                    request = dict(kind="draw", id=draw["id"], pointer=None)
                    request.update(draw["input"])
                    send(child, request)
                    raw = frame(child)
                    if raw.startswith(b"PV\x01"):
                        reply = pv(raw)
                for event in case.get("events", []):
                    if not reply["ok"]:
                        break
                    send(child, dict(kind="event", id=event["id"], value=event["value"], now=0))
                    reply = pv(frame(child))
                assert not reply["ok"], case["name"]
                error = reply["error"]
                text = (f"line {error['line']}: " if error.get("line") else "") + error["message"]
                assert text == case["error"] or ("drawMs" in case and error["kind"] == "timeout"), (case["name"], text)
                assert child.wait(timeout=3) != 0
            self.passed("shared-error: " + case["name"])

        malformed = [b"", b"{", b"null", b"{}", b' {"kind":"load","source":null}',
                     b'{"kind":"load","source":"x","data":null,"state":null,"seed":"","now":0,"extra":1}']
        for body in malformed:
            with self.child() as child:
                child.stdin.write(struct.pack("<I", len(body)) + body)
                child.stdin.flush()
                assert child.wait(timeout=3) != 0
            self.passed("malformed-frame-" + repr(body[:30]))
        for size, body in ((4 * 1024**2 + 1, b""), (12, b"{}")):
            with self.child() as child:
                child.stdin.write(struct.pack("<I", size) + body)
                child.stdin.close()
                assert child.wait(timeout=3) != 0
            self.passed("oversized-or-truncated-frame")

        oversized_source = load("x" * (256 * 1024 + 1))
        oversized_data = load()
        oversized_data["data"] = "x" * 1024**2
        oversized_seed = load()
        oversized_seed["seed"] = "x" * 129
        bad_state = load()
        bad_state["state"] = "{}"
        oversized_state = load()
        oversized_state["state"] = '["' + "x" * 65536 + '"]'
        invalid_requests = [oversized_source, oversized_data, oversized_seed, bad_state, oversized_state,
                            dict(kind="event", id="x" * 257, value=None, now=0),
                            dict(kind="event", id="0", value="x" * 4096, now=0),
                            dict(kind="draw", id="0", width=0, height=100, t=0, pointer=None),
                            dict(kind="draw", id="0", width=300, height=601, t=0, pointer=None),
                            dict(kind="draw", id="0", width=300, height=100, t=-1, pointer=None),
                            dict(kind="draw", id="0", width=300, height=100, t=0, pointer=dict(x=1e7, y=0))]
        for i, request in enumerate(invalid_requests):
            with self.child() as child:
                send(child, request)
                assert child.wait(timeout=3) != 0
                assert child.stdout.read() == b"", "rejected before engine evaluation"
            self.passed(f"request-bound-{i}")

        for source, kind in (("()=>{while(true){}}", "timeout"),
                             ("()=>{let a=[];while(true)a.push(new Uint8Array(1048576))}", "memory"),
                             ("()=>{function f(){return 1+f()}return f()}", "stack")):
            with self.child() as child:
                send(child, load(source))
                reply = pv(frame(child))
                assert not reply["ok"] and reply["error"]["kind"] == kind, reply
                assert child.wait(timeout=3) != 0
            self.passed("engine-limit-" + kind)

        # These are independent driver kill/wait checks, NOT product transport acceptance.
        with self.child() as child:
            os.kill(child.pid, signal.SIGSTOP)
            send(child, load())
            try:
                read_exact(child.stdout, 4, seconds=2)
            except TimeoutError:
                pass
            else:
                raise AssertionError("stopped helper did not stall")
        self.passed("owned-stall-timeout-kill-reap")
        with self.child() as child:
            child.stdin.write(struct.pack("<I", 128) + b"{")
            child.stdin.flush()
            child.kill()
            assert child.wait(timeout=3) == -signal.SIGKILL
        self.passed("cancel-partial-request-kill-reap")
        with self.child() as child:
            send(child, load())
            assert pv(frame(child))["ok"] is True
        self.passed("fresh-process-recovery")
        print(f"{self.count} native helper/kernel probes passed. Wayland/product lifecycle NOT qualified.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--probe", required=True, type=Path)
    parser.add_argument("--root", required=True, type=Path, help="Owned temporary parent, never a user profile")
    args = parser.parse_args()
    assert os.uname().sysname == "Linux", "Native Linux only"
    source = Path(__file__).resolve().parents[3]
    RUNTIME_HASH = hashlib.sha256((source / "packages/artifacts/src/visual/runtime.js").read_bytes()).hexdigest()
    corpus = json.loads((source / "packages/protocol/fixtures/visual/conformance.json").read_text())
    with tempfile.TemporaryDirectory(prefix="helper-probes-", dir=args.root) as temporary:
        Fixture(args.worker.resolve(), args.probe.resolve(), Path(temporary)).run(corpus)
