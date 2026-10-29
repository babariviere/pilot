"""Admit only authenticated, fully verified prior Rust macOS runtime capsules."""
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import struct
import subprocess
import tempfile
import time
import unicodedata
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
import zipfile

import bundle_runtime as bundle

ARCHIVE = "Pilot-Next-macos-arm64.zip"
ENVELOPE = "desktop-macos-arm64-update.json"
BUNDLE = "Pilot Next.app"
MAX_API = 8 * 1024**2
MAX_ENVELOPE = 64 * 1024
MAX_ARCHIVE = 1024**3
MAX_EXPANDED = 2 * 1024**3
MAX_FILE = 256 * 1024**2
MAX_ENTRIES = 30_000
TOTAL_SECONDS = 20 * 60
SOCKET_SECONDS = 30
BUILD = r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,3}"


def _json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON field")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def _base64(value, length=None):
    if not isinstance(value, str):
        raise ValueError("Expected canonical base64")
    raw = base64.b64decode(value, validate=True)
    if base64.b64encode(raw).decode() != value or (length is not None and len(raw) != length):
        raise ValueError("Expected canonical base64 of exact length")
    return raw


class _ReleaseRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        target = urlsplit(new_url)
        if (target.scheme != "https" or target.username or target.password
                or (request.get_header("Authorization") and target.netloc != "api.github.com")):
            raise ValueError("Unsafe release redirect")
        return super().redirect_request(request, fp, code, message, headers, new_url)


def _remaining(deadline, cap=30):
    if deadline is None:
        return cap
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Prior release admission deadline exceeded")
    return min(cap, remaining)


def _download(url, opener, maximum, destination=None, token=None, deadline=None):
    headers = {"User-Agent": "pilot-release", "Accept": "application/vnd.github+json" if token else "*/*"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if opener is urlopen:
        opener = build_opener(_ReleaseRedirect()).open
    output = destination if destination is not None else io.BytesIO()
    size, digest = 0, hashlib.sha256()
    with opener(Request(url, headers=headers), timeout=_remaining(deadline, SOCKET_SECONDS)) as response:
        read = getattr(response, "read1", response.read)
        while True:
            _remaining(deadline)
            # HTTPResponse.read1 performs at most one socket read, so a peer
            # cannot keep read(n) alive indefinitely by trickling tiny chunks.
            chunk = read(min(1024**2, maximum - size + 1))
            _remaining(deadline)
            if not chunk:
                break
            size += len(chunk)
            if size > maximum:
                raise ValueError("Release response exceeds byte limit")
            digest.update(chunk)
            output.write(chunk)
    return (size, digest.hexdigest()) if destination is not None else output.getvalue()


def _asset_url(asset, repository, tag):
    url = asset.get("browser_download_url", "")
    # Exact public release location. Never forward the API credential to downloads,
    # including when urllib follows GitHub's public CDN redirect.
    expected = f"https://github.com/{repository}/releases/download/{quote(tag, safe='')}/{asset['name']}"
    parsed = urlsplit(url)
    if url != expected or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Unexpected public release asset URL")
    return url


def _manifest(raw, key, archive, tag, deadline=None):
    envelope = _json(raw)
    if not isinstance(envelope, dict) or set(envelope) != {"signed", "signature"}:
        raise ValueError("Invalid release envelope")
    signed = _base64(envelope["signed"])
    _base64(envelope["signature"], 64)
    script = """
const c = require('node:crypto');
const v = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const key = c.createPublicKey({key:Buffer.concat([
 Buffer.from('302a300506032b6570032100','hex'), Buffer.from(v.key,'base64')]),
 format:'der',type:'spki'});
if (!c.verify(null,Buffer.from(v.signed,'base64'),key,Buffer.from(v.signature,'base64'))) process.exit(1);
"""
    subprocess.run(["node", "-e", script], input=json.dumps(dict(envelope, key=key)),
                   text=True, check=True, timeout=_remaining(deadline), capture_output=True, env=bundle.subprocess_env())
    value = _json(signed)
    expected = dict(schema=1, application_id=bundle.APP_ID, channel="desktop-stable", platform="macos",
                    architecture="aarch64", bundle_name=BUNDLE, archive_name=ARCHIVE,
                    archive_asset_id=archive["id"], archive_size=archive["size"])
    fields = set(expected) | {"build", "short_version", "archive_sha256"}
    if (not isinstance(value, dict) or set(value) - fields - {"source"}
            or not fields <= set(value) or type(value["schema"]) is not int
            or (value.get("source") is not None and not isinstance(value["source"], str))
            or type(value["archive_asset_id"]) is not int or type(value["archive_size"]) is not int
            or any(value.get(k) != v for k, v in expected.items())
            or not isinstance(value["build"], str) or not re.fullmatch(BUILD, value["build"])
            or not isinstance(value["short_version"], str)
            or not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", value["short_version"])
            or len(value["short_version"]) > 64 or tag != "v" + value["short_version"]
            or not isinstance(value["archive_sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", value["archive_sha256"])
            or archive.get("digest") != "sha256:" + value["archive_sha256"]):
        raise ValueError("Authenticated release identity mismatch")
    return value


def _extras(extra):
    # Only timestamp and uid/gid metadata used by ditto/Info-ZIP. Alternate
    # names, link encodings and ZIP64 interpretation are deliberately excluded.
    while extra:
        if len(extra) < 4:
            raise ValueError("Malformed ZIP extra")
        field, length = struct.unpack_from("<HH", extra)
        if length + 4 > len(extra) or field not in (0x5455, 0x5855, 0x7875):
            raise ValueError("Unsupported ZIP extra")
        extra = extra[4 + length:]


def _archive(path, deadline=None):
    """Preflight before ditto: bounded ZIP32, no aliases or writes through links."""
    with path.open("rb") as stream:
        stream.seek(0, 2)
        size = stream.tell()
        stream.seek(max(0, size - 65557))
        tail = stream.read()
    at = tail.rfind(b"PK\x05\x06")
    if at < 0 or len(tail) - at < 22:
        raise ValueError("Missing ZIP footer")
    _, disk, directory_disk, count_disk, count, directory_size, start, comment = struct.unpack_from("<4s4H2LH", tail, at)
    if (disk or directory_disk or count_disk != count or not 0 < count <= MAX_ENTRIES
            or directory_size > 16 * 1024**2 or start + directory_size != size - len(tail) + at
            or at + 22 + comment != len(tail)):
        raise ValueError("Unbounded or unsupported ZIP directory")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) != count:
            raise ValueError("ZIP entry count mismatch")
        names, targets, total = {}, [], 0
        for entry in entries:
            _remaining(deadline)
            name = entry.filename.rstrip("/")
            normalized = unicodedata.normalize("NFD", name).casefold()
            parts = name.split("/")
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if (entry.orig_filename != entry.filename or len(name) > 4096 or "\\" in name
                    or entry.filename != name + ("/" if kind == stat.S_IFDIR else "")
                    or any(ord(c) < 32 or ord(c) == 127 for c in name)
                    or any(p in ("", ".", "..") or ":" in p for p in parts) or parts[0] != BUNDLE
                    or normalized in names or entry.flag_bits & 1
                    or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    or kind not in (stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK)
                    or (kind == stat.S_IFDIR) != entry.is_dir()
                    or (kind != stat.S_IFLNK and mode & 0o7022)
                    or entry.file_size > MAX_FILE):
                raise ValueError("Unsafe ZIP entry")
            _extras(entry.extra)
            # Native extraction also interprets local extras; zipfile ignores them.
            archive.fp.seek(entry.header_offset)
            header = archive.fp.read(30)
            if len(header) != 30 or header[:4] != b"PK\x03\x04":
                raise ValueError("Invalid ZIP local header")
            local = struct.unpack("<4s5H3L2H", header)
            archive.fp.seek(local[9], 1)
            local_extra = archive.fp.read(local[10])
            if len(local_extra) != local[10]:
                raise ValueError("Truncated ZIP local extra")
            _extras(local_extra)
            names[normalized] = kind
            total += entry.file_size
            if total > MAX_EXPANDED or (kind == stat.S_IFDIR and entry.file_size):
                raise ValueError("ZIP expanded byte limit")
            if kind == stat.S_IFLNK:
                if entry.file_size > 4096:
                    raise ValueError("Oversized ZIP link")
                target = archive.read(entry).decode("utf-8")
                if not target or target.startswith("/") or "\\" in target or any(ord(c) < 32 for c in target):
                    raise ValueError("Unsafe ZIP link")
                targets.append((parts[:-1], target))
                resolved = parts[:-1]
                for part in target.split("/"):
                    if part == "..":
                        if len(resolved) <= 1:
                            raise ValueError("ZIP link escapes bundle")
                        resolved.pop()
                    elif part not in ("", "."):
                        resolved.append(part)
            else:
                # Validate decompression and CRC before the native extractor sees it.
                # Opening empty directories also checks local-header path aliases.
                with archive.open(entry) as stream:
                    while stream.read(1024**2):
                        _remaining(deadline)
        for name in names:
            parents = PurePosixPath(name).parents
            if any(str(parent) in names and names[str(parent)] != stat.S_IFDIR for parent in parents):
                raise ValueError("ZIP writes through non-directory")
        if names.get(BUNDLE.casefold()) != stat.S_IFDIR:
            raise ValueError("Missing exact bundle root")
        # Reject all link-target chains, including Unicode aliases and prefixes
        # later cancelled by '..'. No extractor can traverse such a chain.
        for parent, target in targets:
            resolved = list(parent)
            for part in target.split("/"):
                if part == "..":
                    resolved.pop()  # Root containment was checked above.
                elif part not in ("", "."):
                    resolved.append(part)
                key = unicodedata.normalize("NFD", "/".join(resolved)).casefold()
                if names.get(key) == stat.S_IFLNK:
                    raise ValueError("ZIP link target traverses another link")


def _verify(path, manifest, protocol, deadline=None):
    _archive(path, deadline)
    extracted = path.parent / "extracted"
    extracted.mkdir(mode=0o700)
    subprocess.run(["/usr/bin/ditto", "-x", "-k", "--noextattr", "--noqtn", str(path), str(extracted)],
                   check=True, timeout=_remaining(deadline, 300), capture_output=True, env=bundle.subprocess_env())
    app = extracted / BUNDLE
    if sorted(p.name for p in extracted.iterdir()) != [BUNDLE] or app.is_symlink() or not app.is_dir():
        raise ValueError("Unexpected extracted bundle root")
    stamp_path = app / "Contents/Resources/runtime/runtime-build.json"
    if not stamp_path.resolve(strict=True).is_relative_to(app.resolve(strict=True)):
        raise ValueError("Runtime stamp escapes extracted bundle")
    stamp = bundle.read_json(stamp_path, 4096)
    if (type(stamp.get("schema")) is not int or stamp["schema"] != 1
            or stamp.get("platform") != "darwin" or stamp.get("arch") != "arm64"
            or type(stamp.get("protocol")) is not int or stamp["protocol"] < 1):
        raise ValueError("Invalid prior runtime stamp")
    if stamp.get("version") != manifest["short_version"]:
        raise ValueError("Runtime version differs from authenticated release")
    # Inventory first bounds native verifier input and rejects escaped links.
    # Validate the authenticated prior runtime's own protocol, then separately
    # decide compatibility. Never weaken verification to skip a broken release.
    bundle.verify(app, protocol=stamp["protocol"])
    _remaining(deadline)
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R=identifier \"" + bundle.APP_ID + "\"", str(app)],
                   check=True, timeout=_remaining(deadline, 120), capture_output=True, env=bundle.subprocess_env())
    for binary in bundle.native_closure(app):
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(binary)],
                       check=True, timeout=_remaining(deadline, 60), capture_output=True, env=bundle.subprocess_env())
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if (info.get("CFBundleIdentifier") != bundle.APP_ID or info.get("CFBundleVersion") != manifest["build"]
            or info.get("CFBundleShortVersionString") != manifest["short_version"]):
        raise ValueError("Signed bundle build differs from release")
    if stamp["protocol"] != protocol:
        return None
    return bundle.capsule_identity(app)


def previous_macos_capsules(repository, public_key, protocol, token=None, limit=4, opener=urlopen):
    """Newest unique verified compatible capsules, never an unverified fallback.

    Only API discovery carries a token. Missing Rust pairs (old Swift releases)
    and verified protocol-incompatible releases are skipped; invalid pairs fail.
    """
    deadline = time.monotonic() + TOTAL_SECONDS
    if (not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}", repository)
            or any(p in (".", "..") for p in repository.split("/"))
            or type(protocol) is not int or protocol < 1 or type(limit) is not int or not 0 <= limit <= 4):
        raise ValueError("Invalid prior release admission configuration")
    if _base64(public_key, 32) == bytes(32):
        raise ValueError("Missing pinned Ed25519 public key")
    if limit == 0:
        return []
    releases = _json(_download(f"https://api.github.com/repos/{repository}/releases?per_page=30", opener, MAX_API, token=token, deadline=deadline))
    if not isinstance(releases, list) or len(releases) > 30:
        raise ValueError("Expected bounded GitHub release list")
    result = []
    for release in releases:
        _remaining(deadline)
        if not isinstance(release, dict):
            raise ValueError("Invalid GitHub release")
        if release.get("draft") or release.get("prerelease"):
            continue
        assets = release.get("assets", [])
        if not isinstance(assets, list) or any(not isinstance(asset, dict) for asset in assets):
            raise ValueError("Invalid release assets")
        pairs = [[a for a in assets if a.get("name") == name] for name in (ARCHIVE, ENVELOPE)]
        if not pairs[0] and not pairs[1]:
            continue
        # The archive name was historically Rust-specific; either half means an
        # attempted Rust release, never silently downgrade a broken pair to Swift.
        if any(len(items) != 1 for items in pairs):
            raise ValueError("Expected unique macOS archive and signed envelope pair")
        archive, envelope = (items[0] for items in pairs)
        for asset, maximum in ((archive, MAX_ARCHIVE), (envelope, MAX_ENVELOPE)):
            if (asset.get("state") != "uploaded" or type(asset.get("id")) is not int or asset["id"] < 1
                    or type(asset.get("size")) is not int or not 0 < asset["size"] <= maximum):
                raise ValueError("Invalid uploaded release asset")
        if archive["id"] == envelope["id"]:
            raise ValueError("Release assets share identity")
        tag = release.get("tag_name")
        if not isinstance(tag, str) or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
            raise ValueError("Invalid stable release tag")
        archive_url, envelope_url = (_asset_url(a, repository, tag) for a in (archive, envelope))
        raw = _download(envelope_url, opener, MAX_ENVELOPE, deadline=deadline)
        if len(raw) != envelope["size"]:
            raise ValueError("Release envelope size mismatch")
        manifest = _manifest(raw, public_key, archive, tag, deadline)
        with tempfile.TemporaryDirectory(prefix="pilot-prior-macos-") as temporary:
            path = Path(temporary) / ARCHIVE
            with path.open("wb") as output:
                size, digest = _download(archive_url, opener, manifest["archive_size"], output, deadline=deadline)
            if size != manifest["archive_size"] or digest != manifest["archive_sha256"]:
                raise ValueError("Release archive hash/size mismatch")
            identity = _verify(path, manifest, protocol, deadline)
            _remaining(deadline)
            if identity is not None:
                if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{64}", identity):
                    raise ValueError("Invalid verified capsule identity")
                if identity not in result:
                    result.append(identity)
        if len(result) == limit:
            break
    return result
