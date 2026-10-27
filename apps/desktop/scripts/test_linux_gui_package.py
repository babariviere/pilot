"""Synthetic assembly only. Never represents Linux-native qualification."""
import os
import sys
from pathlib import Path
import tempfile
import unittest

import linux_gui_package as package


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.executables = self.root / "executables"
        self.executables.mkdir()
        self.output = self.root / "candidate"
        self.source = "a" * 40
        for name in package.REQUIRED:
            path = self.runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic resource\n")
        package.write_json(self.runtime / "package.json", dict(version="1.0.0"))
        package.write_json(self.runtime / "runtime-build.json", dict(schema=1, source=self.source,
                           platform="linux", arch="x64", protocol=1, node="24.21.0", version="1.0.0"))
        entries = []
        for name in package.BINARIES:
            path = self.executables / name
            path.write_text("synthetic, never execute\n")
            entries.append(dict(name=name, sha256=package.digest(path), bytes=path.stat().st_size))
        package.write_json(self.executables / "manifest.json", dict(tested_sha=self.source,
                           target=package.TARGET, binaries=entries))
        self.receipt = self.root / "runtime-receipt.json"
        self.receipt_runtime()

    def receipt_runtime(self):
        package.write_json(self.receipt, dict(source=self.source, target=package.TARGET,
                           files=package.inventory(self.runtime)))

    def assemble(self):
        package.assemble(self.runtime, self.executables, self.receipt, self.output, self.source)

    def test_full_update_payload_binds_helper_and_policy(self):
        updater = self.root / "updater"
        updater.mkdir()
        helper = updater / "pilot-desktop-update-helper"
        helper.write_bytes(b"synthetic updater helper, never execute")
        config = dict(schema=1, mode="configured", build="101.1", application_id="com.example.next",
                      repository="synthetic/fixture", public_key=__import__("base64").b64encode(bytes([42]) * 32).decode(),
                      code_requirement="signed-linux-inventory-v1")
        rust = package.read_json(self.executables / "manifest.json")
        package.write_json(self.executables / "manifest.json", dict(rust, updater_configuration=config))
        package.write_json(updater / "manifest.json", dict(tested_sha=self.source, target=package.TARGET, updater_configuration=config,
            binaries=[dict(name=helper.name, bytes=helper.stat().st_size, sha256=package.digest(helper))]))
        output = self.root / "install path with spaces/Pilot Next"
        output.parent.mkdir()
        package.assemble(self.runtime, self.executables, self.receipt, output, self.source,
                         updater, "101.1", "com.example.next", ["a" * 64])
        package.verify(output)
        value = package.read_json(output / package.MANIFEST)
        self.assertEqual(value["kind"], "linux-gui-distribution")
        self.assertEqual(value["bundle_build"], "101.1")
        self.assertTrue(value["updater"])
        self.assertFalse(value["native_visual_execution"])
        self.assertEqual(package.read_json(output / "update-runtime-policy.json")["accepted_capsules"], ["a" * 64])
        (output / "linux-gui-package.sig").write_text("detached signature placeholder, not an authenticity test")
        package.verify(output)
        (output / "libexec/pilot-desktop-update-helper").write_text("tampered")
        with self.assertRaises(ValueError):
            package.verify(output)

    def test_relocation_and_exact_inventory(self):
        self.assemble()
        relocated = self.root / "different path"
        self.output.rename(relocated)
        package.verify(relocated)
        value = package.read_json(relocated / package.MANIFEST)
        self.assertFalse(value["bundled_launch"])
        self.assertFalse(value["updater"])
        self.assertEqual((relocated / "bin/pilot-next").read_text(), package.LAUNCHER)
        (relocated / "libexec/pilot-desktop").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "inventory"):
            package.verify(relocated)

    def test_wrong_source_arch_missing_resource_and_hash_refused(self):
        for field, value in [("source", "b" * 40), ("arch", "arm64"), ("platform", "darwin")]:
            path = self.runtime / "runtime-build.json"
            original = package.read_json(path)
            package.write_json(path, dict(original, **{field: value}))
            with self.assertRaises(ValueError):
                self.assemble()
            package.write_json(path, original)
        (self.executables / "pilot-desktop").write_text("changed")
        with self.assertRaisesRegex(ValueError, "hash"):
            self.assemble()
        (self.runtime / "node/LICENSE").unlink()
        with self.assertRaisesRegex(ValueError, "Missing"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_stale_runtime_receipt_and_external_links_are_refused(self):
        (self.runtime / "extra").write_text("unreceipted")
        with self.assertRaisesRegex(ValueError, "receipt"):
            self.assemble()
        (self.runtime / "extra").unlink()
        (self.runtime / "escape").symlink_to(self.executables)
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.assemble()

    def test_relative_links_preserved_and_existing_output_never_erased(self):
        (self.runtime / "node/current").symlink_to("bin/node")
        self.receipt_runtime()
        self.assemble()
        self.assertEqual(os.readlink(self.output / "runtime/node/current"), "bin/node")
        with self.assertRaisesRegex(ValueError, "fresh"):
            self.assemble()
        package.verify(self.output)

    def test_failure_removes_only_fresh_output(self):
        from unittest.mock import patch
        with patch.object(package, "verify", side_effect=ValueError("synthetic failure")):
            with self.assertRaisesRegex(ValueError, "synthetic failure"):
                self.assemble()
        self.assertFalse(self.output.exists())
        self.assertTrue(self.runtime.exists())

    def test_copy_race_cannot_be_blessed_by_final_inventory(self):
        from unittest.mock import patch
        import shutil
        copy = shutil.copytree
        def changed_copy(*args, **kwargs):
            result = copy(*args, **kwargs)
            if Path(args[0]) == self.runtime:
                (Path(args[1]) / "node/LICENSE").write_text("changed during copy")
            return result
        with patch.object(package.shutil, "copytree", side_effect=changed_copy):
            with self.assertRaises(ValueError):
                self.assemble()
        self.assertFalse(self.output.exists())

    def test_added_files_and_false_readiness_are_refused(self):
        self.assemble()
        (self.output / "extra").write_text("extra")
        with self.assertRaises(ValueError):
            package.verify(self.output)

        (self.output / "extra").unlink()
        path = self.output / package.MANIFEST
        value = package.read_json(path)
        value["updater"] = True
        package.write_json(path, value)
        with self.assertRaises(ValueError):
            package.verify(self.output)

    def test_native_audit_checks_every_elf_and_dependency_resolution(self):
        from unittest.mock import patch
        import subprocess
        binary = self.executables / "pilot-desktop"
        binary.write_bytes(b"\x7fELF\x02\x01" + bytes(12) + b"\x3e\x00")
        dynamic = "(NEEDED) Shared library: [libc.so.6]\n(RUNPATH) Library runpath: [$ORIGIN]"
        with patch.object(package, "native_host"), patch.object(package.subprocess, "check_output",
                side_effect=[dynamic, "GLIBC_2.34"]), patch.object(package.subprocess, "run",
                return_value=subprocess.CompletedProcess([], 0, "libc.so.6 => /lib/libc.so.6", "")):
            result = package.elf_closure(self.executables)
        self.assertEqual(result[0]["needed"], ["libc.so.6"])
        self.assertEqual(result[0]["symbol_versions"], ["GLIBC_2.34"])
        for text in ("(NEEDED) [/tmp/escape.so]", "(RUNPATH) [/tmp/build]", "(RUNPATH) [$ORIGIN/../../escape]"):
            with patch.object(package, "native_host"), patch.object(package.subprocess, "check_output", return_value=text):
                with self.assertRaises(ValueError):
                    package.elf_closure(self.executables)
        with patch.object(package, "native_host"), patch.object(package.subprocess, "check_output", return_value=dynamic), \
                patch.object(package.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "libc.so.6 => not found", "")):
            with self.assertRaisesRegex(ValueError, "Unresolved"):
                package.elf_closure(self.executables)

    def test_native_probe_refuses_wrong_source_before_process_creation(self):
        from unittest.mock import patch
        import linux_gui_package_native as native
        with patch.object(package, "native_host"), patch.object(native.subprocess, "check_output", return_value="b" * 40), \
                patch.object(native.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(ValueError, "source mismatch"):
                native.probe(self.executables, self.output, self.source)
            spawn.assert_not_called()

    def test_runtime_archive_preflight_refuses_escape_special_and_oversized_entries(self):
        import io
        import tarfile
        import linux_gui_package_runtime as runtime
        for name, kind, size in (("../../escape", tarfile.REGTYPE, 0),
                                 ("fifo", tarfile.FIFOTYPE, 0),
                                 ("large", tarfile.REGTYPE, 256 * 1024**2 + 1)):
            archive = self.root / "fixture.tar"
            with tarfile.open(archive, "w") as tar:
                member = tarfile.TarInfo(name)
                member.type = kind
                # A sparse/truncated fixture need not allocate the declared bytes.
                if size:
                    member.size = size
                    tar.fileobj.write(member.tobuf())
                else:
                    tar.addfile(member, io.BytesIO())
            destination = self.root / "extract"
            destination.mkdir(exist_ok=True)
            with self.assertRaises((ValueError, tarfile.TarError)):
                runtime.extract(archive, destination)
        self.assertFalse((self.root.parent / "escape").exists())

    def test_runtime_archive_relative_links_and_regular_files_extract(self):
        import io
        import tarfile
        import linux_gui_package_runtime as runtime
        archive = self.root / "fixture.tar"
        with tarfile.open(archive, "w") as tar:
            regular = tarfile.TarInfo("runtime/a")
            regular.size = 2
            tar.addfile(regular, io.BytesIO(b"ok"))
            link = tarfile.TarInfo("runtime/link")
            link.type, link.linkname = tarfile.SYMTYPE, "a"
            tar.addfile(link)
        destination = self.root / "extract"
        destination.mkdir()
        runtime.extract(archive, destination)
        self.assertEqual((destination / "runtime/link").read_bytes(), b"ok")

    def test_runtime_hardlinks_become_independent_files_and_count_expanded_bytes(self):
        import io
        import tarfile
        from unittest.mock import patch
        import linux_gui_package_runtime as runtime
        archive = self.root / "fixture.tar"
        with tarfile.open(archive, "w") as tar:
            regular = tarfile.TarInfo("runtime/a")
            regular.size = 3
            tar.addfile(regular, io.BytesIO(b"abc"))
            link = tarfile.TarInfo("runtime/b")
            link.type, link.linkname = tarfile.LNKTYPE, "runtime/a"
            tar.addfile(link)
        destination = self.root / "extract"
        destination.mkdir()
        with patch.object(runtime, "CAP_BYTES", 5):
            with self.assertRaisesRegex(ValueError, "exceeds"):
                runtime.extract(archive, destination)
        self.assertEqual(list(destination.iterdir()), [])
        runtime.extract(archive, destination)
        for filename in ("a", "b"):
            path = destination / "runtime" / filename
            self.assertEqual(path.read_bytes(), b"abc")
            self.assertEqual(path.stat().st_nlink, 1)
        self.assertNotEqual((destination / "runtime/a").stat().st_ino,
                            (destination / "runtime/b").stat().st_ino)

    def test_runtime_builder_signals_owned_group_before_reaping_on_success_and_timeout(self):
        from unittest.mock import Mock, patch
        import subprocess
        import linux_gui_package_runtime as runtime
        for ready in (True, False):
            events = []
            child = Mock(pid=123, wait=lambda: events.append("wait") or 0)
            with patch.object(runtime.subprocess, "Popen", return_value=child), \
                    patch.object(runtime.os, "waitid", return_value=object() if ready else None), \
                    patch.object(runtime.time, "sleep"), \
                    patch.object(runtime.os, "killpg", side_effect=lambda *args: events.append("signal")):
                if ready:
                    runtime.run_builder(["synthetic"], self.root, {})
                else:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        runtime.run_builder(["synthetic"], self.root, {}, timeout=0)
            self.assertEqual(events, ["signal", "wait"])

    @unittest.skipUnless(sys.platform == "linux", "native Linux process-group fixture")
    def test_native_runtime_builder_reaps_real_owned_success_and_timeout(self):
        import subprocess
        import linux_gui_package_runtime as runtime
        runtime.run_builder([sys.executable, "-c", "pass"], self.root, {})
        with self.assertRaises(subprocess.TimeoutExpired):
            runtime.run_builder([sys.executable, "-c", "import time; time.sleep(60)"],
                                self.root, {}, timeout=0.1)

    def test_explicit_existing_compositor_is_never_owned_or_stopped(self):
        from unittest.mock import patch
        import socket
        import linux_gui_package_native as native
        path = self.root / "wayland-test"
        with socket.socket(socket.AF_UNIX) as compositor:
            compositor.bind(str(path))
            with patch.object(native.subprocess, "Popen") as spawn, patch.object(native, "stop") as stop:
                with native.compositor_display(self.root, {}, path) as display:
                    self.assertEqual(display, str(path))
                spawn.assert_not_called()
                stop.assert_not_called()
        ordinary = self.root / "not-a-socket"
        ordinary.write_text("fixture")
        with self.assertRaises(ValueError):
            with native.compositor_display(self.root, {}, ordinary):
                self.fail("ordinary file admitted")


if __name__ == "__main__":
    unittest.main()
