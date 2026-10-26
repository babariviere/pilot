"""Synthetic assembly only. Never represents Linux-native qualification."""
import os
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


if __name__ == "__main__":
    unittest.main()
