#!/usr/bin/env python3
"""Pinned real GitHub Actions schema/expression validator, project-local only.

No Cargo/native builds. External shellcheck/pyflakes integrations are disabled:
this gate checks Actions structure, contexts and calls, not the shell/Python ABI.
"""
import hashlib
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
VERSION = "1.7.12"
ARCHIVES = {
    ("Darwin", "arm64"): ("darwin_arm64", "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f"),
    ("Linux", "x86_64"): ("linux_amd64", "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"),
}
WORKFLOWS = [ROOT / ".github/workflows" / name for name in
             ("pr.yaml", "main.yaml", "tests.yaml", "release.yaml", "gui-package.yml", "linux-package.yml")]


def prepare():
    target, expected = ARCHIVES[(platform.system(), platform.machine())]
    directory = ROOT / "apps/desktop/.tools" / f"actionlint-{VERSION}"
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / "archive.tar.gz"
    if not archive.exists():
        url = f"https://github.com/rhysd/actionlint/releases/download/v{VERSION}/actionlint_{VERSION}_{target}.tar.gz"
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError("actionlint archive checksum mismatch")
        archive.write_bytes(data)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise RuntimeError("actionlint cached archive checksum mismatch")
    # Re-extract the verified executable rather than trusting a mutable binary.
    with tempfile.TemporaryDirectory(dir=directory) as temporary:
        with tarfile.open(archive, "r:gz") as source:
            source.extractall(temporary, members=[source.getmember("actionlint")], filter="data")
        binary = Path(temporary) / "actionlint"
        binary.chmod(0o755)
        binary.replace(directory / "actionlint")
    return directory / "actionlint"


def validate(binary, paths=WORKFLOWS, source=None):
    arguments = [str(binary), "-shellcheck=", "-pyflakes=", "-no-color"]
    if source is None:
        arguments += [str(path) for path in paths]
    else:
        arguments += ["-stdin-filename", str(ROOT / ".github/workflows/tests.yaml"), "-"]
    return subprocess.run(arguments, cwd=ROOT, input=source, text=True,
                          capture_output=True, timeout=30)


def main():
    binary = prepare()
    result = validate(binary)
    print(result.stdout + result.stderr, end="")
    if result.returncode:
        raise SystemExit(result.returncode)
    # Mutation regression: real validator MUST catch the original fatal context.
    source = (ROOT / ".github/workflows/tests.yaml").read_text()
    prefix, rust = source.split("  rust:\n", 1)
    invalid = prefix + "  rust:\n" + rust.replace("    env:\n", "    env:\n      INVALID_TEMP: ${{ runner.temp }}\n", 1)
    if invalid == source:
        raise RuntimeError("Missing Rust job env for context regression")
    rejected = validate(binary, source=invalid)
    if rejected.returncode == 0 or 'context "runner" is not allowed here' not in rejected.stdout + rejected.stderr:
        raise RuntimeError("Validator failed to reject invalid job-env runner context")
    print(f"actionlint {VERSION}: CI/release/package workflows valid; original job-env context regression rejected")


if __name__ == "__main__":
    main()
