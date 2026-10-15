import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runtime_metadata", Path(__file__).with_name("runtime-metadata.py"))
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for binary in ["node/bin/node", "node_modules/node-pty/build/Release/pty.node"]:
            file = self.root / binary
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"\x7fELF\x02\x01" + bytes(12) + b"\x3e\x00")

    def audit(self, version="GLIBC_2.28 GLIBCXX_3.4.21", dynamic="", dependencies="libc.so.6 => /lib/libc.so.6"):
        def command(args, **_):
            output = version if args[:2] == ["readelf", "-V"] else dynamic if args[:2] == ["readelf", "-d"] else dependencies
            return SimpleNamespace(stdout=output, stderr="", returncode=0)
        with patch.object(metadata.subprocess, "run", command):
            metadata.audit(self.root)

    def test_records_real_symbol_floor(self):
        self.audit()
        report = json.loads((self.root / "runtime-abi.json").read_text())
        self.assertEqual(report["minimumGlibc"], "2.28")
        self.assertEqual(report["minimumGlibcxx"], "3.4.21")
        self.assertEqual(len(report["elfFiles"]), 2)

    def test_rejects_unresolved_or_newer_libraries_and_search_path_escape(self):
        for kwargs in [dict(version="GLIBC_2.35"), dict(version="GLIBCXX_3.4.32"),
                       dict(dependencies="libmissing.so => not found"),
                       dict(dynamic="(RUNPATH) Library runpath: [/source/lib]"),
                       dict(dynamic="(NEEDED) Shared library: [/source/libexternal.so]"),
                       dict(dynamic="(RPATH) Library rpath: [$ORIGIN/../../../../outside]")]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.audit(**kwargs)

    def test_rejects_wrong_cpu_and_escaping_links(self):
        (self.root / "node/bin/node").write_bytes(b"\x7fELF\x02\x01" + bytes(12) + b"\xb7\x00")
        with self.assertRaises(ValueError):
            self.audit()
        link = self.root / "bad"
        for target in ["/etc/passwd", "../../outside", "missing"]:
            with self.subTest(target=target), self.assertRaises((ValueError, FileNotFoundError)):
                link.symlink_to(target)
                try:
                    metadata.links(self.root)
                finally:
                    link.unlink()


if __name__ == "__main__":
    unittest.main()
