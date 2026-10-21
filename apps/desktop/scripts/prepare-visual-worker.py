#!/usr/bin/env python3
"""Materialize only pinned engine sources into the private desktop tool cache."""
import hashlib, io, pathlib, tarfile, urllib.request
ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = "0.17.0"
SHA = "559bc4c420475e55c7ab4510adbc562f55d7524d75e8e89d79ce4bb02f5687d9"
archive = ROOT / ".tools" / "downloads" / f"quickjs-ng-{VERSION}.tar.gz"
archive.parent.mkdir(parents=True, exist_ok=True)
if not archive.exists():
    with urllib.request.urlopen(f"https://github.com/quickjs-ng/quickjs/archive/refs/tags/v{VERSION}.tar.gz", timeout=60) as response:
        data = response.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != SHA:
        raise SystemExit("QuickJS-NG archive checksum mismatch")
    archive.write_bytes(data)
data = archive.read_bytes()
if hashlib.sha256(data).hexdigest() != SHA:
    raise SystemExit("QuickJS-NG cached archive checksum mismatch")
target = ROOT / ".tools" / f"quickjs-ng-{VERSION}"
target.mkdir(exist_ok=True)
names = "quickjs.c quickjs.h quickjs-atom.h quickjs-opcode.h quickjs-c-atomics.h cutils.h list.h dtoa.c dtoa.h libregexp.c libregexp.h libregexp-opcode.h libunicode.c libunicode.h libunicode-table.h builtin-array-fromasync.h builtin-iterator-zip-keyed.h builtin-iterator-zip.h LICENSE".split()
with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
    for name in names:
        member = source.getmember(f"quickjs-{VERSION}/{name}")
        if not member.isfile() or member.size > 8 * 1024 * 1024:
            raise SystemExit("Invalid pinned engine member")
        content = source.extractfile(member).read()
        path = target / name
        if path.exists() and path.read_bytes() != content:
            raise SystemExit("QuickJS-NG materialized source changed; refusing to build")
        if not path.exists():
            path.write_bytes(content)
