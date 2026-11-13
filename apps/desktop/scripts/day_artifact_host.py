"""Day-only source-helper inputs and binding. Never execute authored JavaScript."""
import hashlib
import json
import os
import selectors
import shutil
import stat
import subprocess
import time
from pathlib import Path

import bundle_runtime as bundle

NAME = "pilot-artifact-host"
RELATIVE = Path("packages/artifacts/native")
DESCRIPTOR = "artifact-host.json"


def identity(binary, source, recipe):
    """Use the existing Compile operation, not another command or an argv hook."""
    text = "export default function Artifact() { return null; }"
    request = {"action": "compile", "captured": {"artifactId": "11111111-1111-1111-1111-111111111111",
        "sourceSessionId": "packaging", "revision": 1, "entry": "Artifact.tsx", "source": text,
        "sourceSha256": hashlib.sha256(text.encode()).hexdigest(), "sourceBytes": len(text.encode())}}
    child = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, env={}, cwd=binary.parent)
    deadline = time.monotonic() + 5
    data = bytearray()
    try:
        child.stdin.write(json.dumps(request).encode())
        child.stdin.close()
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise ValueError("Artifact helper identity deadline")
                part = os.read(child.stdout.fileno(), 4096)
                if not part:
                    break
                data.extend(part)
                if len(data) > 8192:
                    raise ValueError("Artifact helper identity output exceeds limit")
        if child.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
            raise ValueError("Artifact helper identity failed")
        result = json.loads(data)
        wanted = {"schema": 1, "kind": "nsh-source-host", "runtime": "nsh 0.5.0", "source": source, "recipe": recipe}
        if (not isinstance(result, dict) or set(result) != {"identity", "value"}
                or result["identity"] != wanted or not isinstance(result["value"], dict)
                or result["value"].get("rendering") != "unsupported"
                or result["value"].get("sourceSha256") != request["captured"]["sourceSha256"]):
            raise ValueError("Artifact helper compiled source identity mismatch")
        return wanted
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        if not child.stdin.closed:
            child.stdin.close()
        child.stdout.close()


def checked(inputs, source):
    inputs = Path(inputs)
    value = bundle.read_json(inputs / "manifest.json")
    bundle.receipt(inputs, source, [NAME])
    recipe = value.get("recipe_sha256", "")
    if (value.get("source") != bundle.source(source) or value.get("target") != "aarch64-apple-darwin"
            or not isinstance(recipe, str) or len(recipe) != 64
            or any(c not in "0123456789abcdef" for c in recipe)):
        raise ValueError("Artifact helper input source/recipe mismatch")
    path = inputs / NAME
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o6022
            or not info.st_mode & 0o111):
        raise ValueError("Unsafe artifact helper input")
    with path.open("rb") as stream:
        if stream.read(4) != b"\xcf\xfa\xed\xfe":
            raise ValueError("Artifact helper must be native Mach-O")
    return identity(path, source, recipe)


def stage(inputs, runtime, source):
    """Called only for explicit Day resources, after ordinary runtime admission."""
    binding = checked(inputs, source)
    destination = Path(runtime) / RELATIVE
    for parent in (Path(runtime) / "packages", Path(runtime) / "packages/artifacts"):
        if not stat.S_ISDIR(parent.lstat().st_mode):
            raise ValueError("Artifact helper parents must be real runtime directories")
    # The existing runtime inventory checked the parents; never follow a new native alias.
    if destination.exists() or destination.is_symlink():
        raise ValueError("Artifact helper destination must be absent")
    destination.mkdir(mode=0o755)
    binary = destination / NAME
    shutil.copyfile(Path(inputs) / NAME, binary)
    binary.chmod(0o755)
    if bundle.digest(binary) != bundle.digest(Path(inputs) / NAME):
        raise ValueError("Artifact helper copy changed")
    identity(binary, source, binding["recipe"])
    write_binding(runtime, source, binding)


def write_binding(runtime, source, binding=None):
    """Refresh signed-byte identity only inside fresh Day assembly, before its outer seal."""
    directory = Path(runtime) / RELATIVE
    if binding is None:
        binding = bundle.read_json(directory / DESCRIPTOR, 4096)["identity"]
        identity(directory / NAME, source, binding["recipe"])
    if binding["source"] != source or bundle.read_json(Path(runtime) / "runtime-build.json", 4096)["source"] != source:
        raise ValueError("Artifact helper/runtime source mismatch")
    path = directory / NAME
    bundle.write_json(directory / DESCRIPTOR, {"schema": 1, "identity": binding,
        "bytes": path.stat().st_size, "sha256": bundle.digest(path)})
