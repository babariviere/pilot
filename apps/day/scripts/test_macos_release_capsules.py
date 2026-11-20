"""Offline prior-release admission tests. Native verification is mocked, crypto is real."""
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import plistlib
import stat
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.request import Request
import zipfile

import macos_release_capsules as capsules


def encoded(value):
    return json.dumps(value).encode()


def package(version="1.2.3", build="42", protocol=1, entries=None):
    files = {
        "Pilot Next.app/": (stat.S_IFDIR | 0o755, b""),
        "Pilot Next.app/Contents/Info.plist": (stat.S_IFREG | 0o644, plistlib.dumps(dict(
            CFBundleIdentifier=capsules.bundle.APP_ID, CFBundleVersion=build, CFBundleShortVersionString=version))),
        "Pilot Next.app/Contents/Resources/runtime/runtime-build.json": (stat.S_IFREG | 0o644, encoded(dict(
            schema=1, platform="darwin", arch="arm64", protocol=protocol, version=version))),
    }
    if entries:
        files.update(entries)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, (mode, data) in files.items():
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = mode << 16
            archive.writestr(entry, data)
    return output.getvalue()


class AdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.real_run = staticmethod(subprocess.run)
        value = json.loads(subprocess.check_output(["node", "-e", """
const c=require('node:crypto'); const {publicKey,privateKey}=c.generateKeyPairSync('ed25519');
console.log(JSON.stringify({key:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64'),
 private:privateKey.export({format:'pem',type:'pkcs8'})}));
"""]))
        cls.key, cls.private = value["key"], value["private"]

    def sign(self, manifest):
        signed = base64.b64encode(encoded(manifest)).decode()
        signature = subprocess.check_output(["node", "-e", """
const c=require('node:crypto'); const v=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
process.stdout.write(c.sign(null,Buffer.from(v.signed,'base64'),v.private).toString('base64'));
"""], input=encoded(dict(signed=signed, private=self.private))).decode()
        return encoded(dict(signed=signed, signature=signature))

    def release(self, version="1.2.3", protocol=1, archive=None, change=None):
        raw = archive if archive is not None else package(version=version, protocol=protocol)
        manifest = dict(schema=1, application_id=capsules.bundle.APP_ID, channel="desktop-stable", platform="macos",
                        architecture="aarch64", build="42", short_version=version, bundle_name="Pilot Next.app",
                        archive_name=capsules.ARCHIVE, archive_asset_id=10, archive_size=len(raw),
                        archive_sha256=hashlib.sha256(raw).hexdigest())
        if change:
            manifest.update(change)
        envelope = self.sign(manifest)
        assets = [dict(id=10, name=capsules.ARCHIVE, size=len(raw), digest="sha256:" + hashlib.sha256(raw).hexdigest()),
                  dict(id=11, name=capsules.ENVELOPE, size=len(envelope))]
        downloads = {}
        for asset, data in zip(assets, (raw, envelope)):
            asset.update(state="uploaded", browser_download_url=f"https://github.com/owner/repo/releases/download/v{version}/{asset['name']}")
            downloads[asset["browser_download_url"]] = data
        return dict(draft=False, prerelease=False, tag_name="v" + version, assets=assets), downloads

    def discover(self, releases, downloads, **kwargs):
        requests = []
        def opener(request, **options):
            requests.append(request)
            if request.full_url == "https://api.github.com/repos/owner/repo/releases?per_page=30":
                return io.BytesIO(encoded(releases))
            return io.BytesIO(downloads[request.full_url])
        result = capsules.previous_macos_capsules("owner/repo", self.key, kwargs.pop("protocol", 1), opener=opener, **kwargs)
        return result, requests

    def native(self, argv, **kwargs):
        if argv[0] == "node":
            return self.real_run(argv, **kwargs)
        if argv[0] == "/usr/bin/ditto":
            with zipfile.ZipFile(argv[-2]) as archive:
                archive.extractall(argv[-1])
        elif argv[0] != "/usr/bin/codesign":
            self.fail(f"Unexpected command: {argv}")
        return subprocess.CompletedProcess(argv, 0)

    def setUp(self):
        self.run = patch.object(capsules.subprocess, "run", side_effect=self.native).start()
        self.verify = patch.object(capsules.bundle, "verify").start()
        self.closure = patch.object(capsules.bundle, "native_closure", return_value=[]).start()
        self.identity = patch.object(capsules.bundle, "capsule_identity", return_value="a" * 64, create=True).start()
        self.addCleanup(patch.stopall)

    def test_verified_digest_native_verification_and_token_isolation(self):
        release, downloads = self.release()
        result, requests = self.discover([release], downloads, token="secret")
        self.assertEqual(result, ["a" * 64])
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer secret")
        self.assertTrue(all(r.get_header("Authorization") is None for r in requests[1:]))
        self.verify.assert_called_once()
        commands = [call.args[0] for call in self.run.call_args_list]
        self.assertTrue(any("-R=identifier \"com.babariviere.pilot-next\"" in argv for argv in commands))
        self.assertTrue(any(argv[0] == "/usr/bin/ditto" for argv in commands))

    def test_incompatible_newest_skips_to_older(self):
        newer, new_data = self.release("1.2.4", protocol=2)
        older, old_data = self.release()
        result, _ = self.discover([newer, older], dict(new_data, **old_data))
        self.assertEqual(result, ["a" * 64])
        self.assertEqual(self.verify.call_count, 2)
        self.assertEqual([call.kwargs for call in self.verify.call_args_list], [dict(protocol=2), dict(protocol=1)])
        self.identity.assert_called_once()

    def test_unique_newest_limit_and_no_extra_downloads(self):
        releases, downloads = [], {}
        for version in ("1.2.8", "1.2.7", "1.2.6", "1.2.5", "1.2.4", "1.2.3"):
            release, data = self.release(version)
            releases.append(release)
            downloads.update(data)
        self.identity.side_effect = ["a" * 64, "a" * 64, "b" * 64, "c" * 64, "d" * 64]
        result, requests = self.discover(releases, downloads)
        self.assertEqual(result, [c * 64 for c in "abcd"])
        self.assertEqual(len(requests), 11)

    def test_draft_prerelease_non_mac_swift_only_are_ignored(self):
        release, _ = self.release()
        drafts = [dict(release, draft=True), dict(release, prerelease=True),
                  dict(assets=[dict(name="Pilot-macos.zip")]), dict(assets=[dict(name="Pilot-Next-linux-x64.zip")])]
        result, requests = self.discover(drafts, {})
        self.assertEqual(result, [])
        self.assertEqual(len(requests), 1)

    def test_duplicate_or_missing_pair_or_not_uploaded_fails(self):
        original, data = self.release()
        for assets in ([original["assets"][0]], [original["assets"][1]], original["assets"] * 2,
                       [dict(original["assets"][0], state="new"), original["assets"][1]]):
            with self.subTest(assets=assets), self.assertRaises(ValueError):
                self.discover([dict(original, assets=assets)], data)

    def test_untrusted_urls_rejected_before_download(self):
        release, data = self.release()
        for url in ("https://evil.test/file", "https://github.com/other/repo/releases/download/v1.2.3/a",
                    release["assets"][0]["browser_download_url"] + "?token=secret",
                    "https://user:pass@github.com/owner/repo/releases/download/v1.2.3/a"):
            candidate = copy.deepcopy(release)
            candidate["assets"][0]["browser_download_url"] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.discover([candidate], data)

    def test_authenticated_manifest_identity_checks(self):
        for change in (dict(schema=True), dict(application_id="com.babariviere.pilot"), dict(channel="swift-stable"),
                       dict(platform="linux"), dict(architecture="arm64"), dict(bundle_name="Pilot.app"),
                       dict(archive_name="other.zip"), dict(archive_asset_id=11), dict(archive_size=1),
                       dict(archive_sha256="A" * 64), dict(archive_sha256="0" * 64), dict(build="01"),
                       dict(short_version="1.2.4"), dict(unknown="field")):
            release, data = self.release(change=change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.discover([release], data)

    def test_invalid_signature_or_noncanonical_base64_fails(self):
        release, data = self.release()
        url = release["assets"][1]["browser_download_url"]
        original = json.loads(data[url])
        for replacement in (dict(signature=base64.b64encode(bytes(64)).decode()),
                            dict(signed=original["signed"] + "\n"), dict(signature=original["signature"][:-1]),
                            dict(extra="field")):
            payload = encoded(dict(original, **replacement))
            release["assets"][1]["size"] = len(payload)
            with self.subTest(replacement=replacement), self.assertRaises((ValueError, subprocess.CalledProcessError)):
                self.discover([release], dict(data, **{url: payload}))

    def test_archive_hash_and_truncation_mismatch_fail_before_extract(self):
        release, data = self.release()
        url = release["assets"][0]["browser_download_url"]
        for payload in (data[url][:-1], b"X" + data[url][1:], data[url] + b"x"):
            with self.subTest(size=len(payload)), self.assertRaises(ValueError):
                self.discover([release], dict(data, **{url: payload}))
        self.verify.assert_not_called()

    def test_bundle_plist_and_runtime_version_must_match(self):
        for archive, change in ((package(build="41"), None), (package(version="1.2.2"), None),
                                (package(), dict(build="43"))):
            release, data = self.release(archive=archive, change=change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.discover([release], data)
        # A version mismatch in the stamp alone also fails.
        archive = package(entries={"Pilot Next.app/Contents/Resources/runtime/runtime-build.json":
                                  (stat.S_IFREG | 0o644, encoded(dict(schema=1, platform="darwin", arch="arm64", protocol=1, version="0.0.0")))})
        release, data = self.release(archive=archive)
        with self.assertRaises(ValueError):
            self.discover([release], data)

    def test_native_failures_propagate(self):
        release, data = self.release()
        self.verify.side_effect = ValueError("inventory mismatch")
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.discover([release], data)
        self.identity.assert_not_called()

    def test_native_extraction_and_signature_failures_propagate(self):
        release, data = self.release()
        for tool in ("/usr/bin/ditto", "/usr/bin/codesign"):
            def fail(argv, **kwargs):
                if argv[0] == tool:
                    raise subprocess.CalledProcessError(1, argv)
                return self.native(argv, **kwargs)
            self.run.side_effect = fail
            with self.subTest(tool=tool), self.assertRaises(subprocess.CalledProcessError):
                self.discover([release], data)
        self.identity.assert_not_called()

    def test_invalid_runtime_platform_arch_schema_are_not_incompatible_skips(self):
        stamp = dict(schema=1, platform="darwin", arch="arm64", protocol=1, version="1.2.3")
        for change in (dict(schema=True), dict(schema=2), dict(platform="linux"), dict(arch="x64"),
                       dict(protocol=True), dict(protocol=0)):
            archive = package(entries={"Pilot Next.app/Contents/Resources/runtime/runtime-build.json":
                                      (stat.S_IFREG | 0o644, encoded(dict(stamp, **change)))})
            release, data = self.release(archive=archive)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.discover([release], data)
        self.identity.assert_not_called()

    def test_bounds_and_network_errors_do_not_become_empty_admission(self):
        release, data = self.release()
        with patch.object(capsules, "MAX_API", 1), self.assertRaises(ValueError):
            self.discover([release], data)
        with patch.object(capsules, "MAX_ENVELOPE", 1), self.assertRaises(ValueError):
            self.discover([release], data)
        with patch.object(capsules, "MAX_ARCHIVE", 1), self.assertRaises(ValueError):
            self.discover([release], data)
        with self.assertRaises(ValueError):
            self.discover([release] * 31, data)
        def offline(*args, **kwargs):
            raise OSError("offline")
        with self.assertRaises(OSError):
            capsules.previous_macos_capsules("owner/repo", self.key, 1, opener=offline)

    def test_configuration_and_public_key_are_strict(self):
        for kwargs in (dict(repository="../repo"), dict(repository="owner/repo?x"), dict(public_key=""),
                       dict(public_key=self.key + "\n"), dict(public_key=base64.b64encode(bytes(32)).decode()),
                       dict(protocol=True), dict(protocol=0), dict(limit=5), dict(limit=-1)):
            args = dict(repository="owner/repo", public_key=self.key, protocol=1)
            args.update(kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                capsules.previous_macos_capsules(**args)

    def test_redirect_policy_never_leaks_credentials_or_downgrades_https(self):
        handler = capsules._ReleaseRedirect()
        authenticated = Request("https://api.github.com/repos/owner/repo/releases", headers={"Authorization": "Bearer secret"})
        for url in ("https://evil.test", "http://api.github.com/path", "https://user:pass@api.github.com/path"):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "redirect"):
                handler.redirect_request(authenticated, None, 302, "redirect", {}, url)
        forwarded = handler.redirect_request(authenticated, None, 302, "redirect", {}, "https://api.github.com/path")
        self.assertEqual(forwarded.get_header("Authorization"), "Bearer secret")
        public = Request("https://github.com/owner/repo/releases/download/v1.2.3/archive.zip")
        forwarded = handler.redirect_request(public, None, 302, "redirect", {}, "https://release-assets.githubusercontent.com/blob")
        self.assertIsNone(forwarded.get_header("Authorization"))
        with self.assertRaises(ValueError):
            handler.redirect_request(public, None, 302, "redirect", {}, "http://release-assets.githubusercontent.com/blob")

    def test_total_monotonic_deadline_stops_slow_chunks(self):
        calls = []
        def opener(request, timeout):
            calls.append(timeout)
            return io.BytesIO(b"bytes")
        with patch.object(capsules.time, "monotonic", side_effect=[0, 1, 11]), self.assertRaises(TimeoutError):
            capsules._download("https://github.com/blob", opener, 100, deadline=10)
        self.assertEqual(calls, [10])
        with patch.object(capsules.time, "monotonic", return_value=10), self.assertRaises(TimeoutError):
            capsules._download("https://github.com/blob", opener, 100, deadline=10)
        self.assertEqual(calls, [10])
        with patch.object(capsules.time, "monotonic", return_value=0):
            self.assertEqual(capsules._remaining(1200, capsules.SOCKET_SECONDS), 30)

    def test_trickling_download_uses_single_socket_reads(self):
        class Trickle(io.BytesIO):
            def read(self, *args):
                raise AssertionError("Buffered read can be kept alive indefinitely")
            def read1(self, maximum):
                return super().read1(min(1, maximum))
        def opener(request, timeout):
            return Trickle(b"trickling bytes")
        with patch.object(capsules.time, "monotonic", side_effect=[0, 1, 2, 3, 11]), self.assertRaises(TimeoutError):
            capsules._download("https://github.com/blob", opener, 100, deadline=10)

    def test_archive_entry_admission(self):
        bad = [
            {"../escape": (stat.S_IFREG | 0o644, b"x")},
            {"Pilot Next.app/../escape": (stat.S_IFREG | 0o644, b"x")},
            {"Pilot Next.app/unsafe": (stat.S_IFREG | 0o666, b"x")},
            {"Pilot Next.app/socket": (stat.S_IFSOCK | 0o644, b"x")},
            {"Pilot Next.app/link": (stat.S_IFLNK | 0o777, b"../../escape")},
            {"Pilot Next.app/link": (stat.S_IFLNK | 0o777, b"Contents"),
             "Pilot Next.app/link/file": (stat.S_IFREG | 0o644, b"x")},
            {"Pilot Next.app/contents/INFO.plist": (stat.S_IFREG | 0o644, b"x")},
            {"Pilot Next.app/caf\u00e9": (stat.S_IFLNK | 0o777, b"Contents"),
             "Pilot Next.app/cafe\u0301/file": (stat.S_IFREG | 0o644, b"x")},
            {"Pilot Next.app/caf\u00e9": (stat.S_IFLNK | 0o777, b"Contents"),
             "Pilot Next.app/alias": (stat.S_IFLNK | 0o777, "cafe\u0301/Info.plist".encode())},
            {"Pilot Next.app/first": (stat.S_IFLNK | 0o777, b"Contents"),
             "Pilot Next.app/second": (stat.S_IFLNK | 0o777, b"first/../Contents")},
        ]
        for entries in bad:
            with self.subTest(entries=list(entries)), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "archive.zip"
                path.write_bytes(package(entries=entries))
                with self.assertRaises(ValueError):
                    capsules._archive(path)

    def test_archive_entry_expansion_and_count_bounds(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "archive.zip"
            path.write_bytes(package())
            for name in ("MAX_ENTRIES", "MAX_FILE", "MAX_EXPANDED"):
                with self.subTest(name=name), patch.object(capsules, name, 1), self.assertRaises(ValueError):
                    capsules._archive(path)

    def test_directory_local_header_alias_is_rejected(self):
        raw = package()
        # The central root remains safe, but ditto would see a different local
        # directory name. Equal lengths keep all offsets otherwise unchanged.
        raw = raw.replace(b"Pilot Next.app/", b"../escape-dir//", 1)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "archive.zip"
            path.write_bytes(raw)
            with self.assertRaises((ValueError, zipfile.BadZipFile)):
                capsules._archive(path)

    def test_alternate_path_local_extra_is_rejected(self):
        output = io.BytesIO()
        entry = zipfile.ZipInfo("Pilot Next.app/")
        entry.external_attr = (stat.S_IFDIR | 0o755) << 16
        entry.extra = struct.pack("<HH8s", 0x5855, 8, b"12345678")
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr(entry, b"")
        raw = bytearray(output.getvalue())
        local_extra = 30 + len(entry.filename)
        struct.pack_into("<H", raw, local_extra, 0x7075)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "archive.zip"
            path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, "extra"):
                capsules._archive(path)

    def test_safe_relative_link_and_ditto_timestamp_extra_are_admitted(self):
        raw = package(entries={"Pilot Next.app/link": (stat.S_IFLNK | 0o777, b"Contents/Info.plist")})
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "archive.zip"
            path.write_bytes(raw)
            capsules._archive(path)
        capsules._extras(struct.pack("<HH8s", 0x5855, 8, bytes(8)))


if __name__ == "__main__":
    unittest.main()
