"""Offline helper binding tests. Fake bytes/signing are not native acceptance."""
import shlex
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import bundle_runtime as bundle
import day_artifact_host as host


class ArtifactHostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="day-artifact-binding-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.recipe = "a" * 40, "b" * 64
        self.identity = {"schema": 1, "kind": "nsh-source-host", "runtime": "nsh 0.5.0",
                             "source": self.source, "recipe": self.recipe}
        self.binary = self.root / host.NAME
        self.binary.write_bytes(b"\xcf\xfa\xed\xfe" + b"synthetic executable, never executed")
        self.binary.chmod(0o755)
        bundle.write_json(self.root / "manifest.json", {"source": self.source, "recipe_sha256": self.recipe,
            "target": "aarch64-apple-darwin", "binaries": [{"name": host.NAME,
            "bytes": self.binary.stat().st_size, "sha256": bundle.digest(self.binary)}]})
        self.runtime = self.root / "runtime"
        (self.runtime / "packages/artifacts").mkdir(parents=True)
        bundle.write_json(self.runtime / "runtime-build.json", {"source": self.source})

    def test_day_stage_and_post_sign_bytes_are_bound_without_touching_inputs(self):
        before = self.binary.read_bytes()
        with patch.object(host, "identity", return_value=self.identity) as query:
            host.stage(self.root, self.runtime, self.source)
            copied = self.runtime / host.RELATIVE / host.NAME
            descriptor = copied.parent / host.DESCRIPTOR
            binding = bundle.read_json(descriptor)
            self.assertEqual(binding["sha256"], bundle.digest(copied))
            self.assertEqual(binding["identity"], self.identity)
            copied.write_bytes(before + b"synthetic signing change")
            host.write_binding(self.runtime, self.source)
            self.assertEqual(bundle.read_json(descriptor)["sha256"], bundle.digest(copied))
            self.assertEqual(self.binary.read_bytes(), before)
            self.assertEqual(query.call_count, 3)
            with self.assertRaisesRegex(ValueError, "absent"):
                host.stage(self.root, self.runtime, self.source)

    def test_mismatched_input_bytes_source_links_and_native_kind_refuse(self):
        with patch.object(host, "identity", return_value=self.identity):
            with self.assertRaisesRegex(ValueError, "source/target"):
                host.checked(self.root, "c" * 40)
            self.binary.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "receipt mismatch"):
                host.checked(self.root, self.source)
            manifest = bundle.read_json(self.root / "manifest.json")
            manifest["binaries"][0].update(bytes=self.binary.stat().st_size, sha256=bundle.digest(self.binary))
            bundle.write_json(self.root / "manifest.json", manifest)
            with self.assertRaisesRegex(ValueError, "Mach-O"):
                host.checked(self.root, self.source)

    def test_runtime_source_mismatch_and_existing_native_alias_refuse(self):
        with patch.object(host, "identity", return_value=self.identity):
            directory = self.runtime / host.RELATIVE
            directory.symlink_to(self.root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "absent"):
                host.stage(self.root, self.runtime, self.source)
            directory.unlink()
            bundle.write_json(self.runtime / "runtime-build.json", {"source": "c" * 40})
            with self.assertRaisesRegex(ValueError, "runtime source"):
                host.stage(self.root, self.runtime, self.source)

    def program(self, body):
        script = self.root / "program.py"
        script.write_text(body)
        self.binary.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(script)) + "\n")
        self.binary.chmod(0o755)

    def test_identity_uses_strict_existing_compile_protocol_and_empty_environment(self):
        self.program("import json,sys,os\nr=json.load(sys.stdin)\n"
            "assert r['action']=='compile' and len(sys.argv)==1\n"
            "assert 'HOME' not in os.environ and 'GH_TOKEN' not in os.environ\n"
            "print(json.dumps({'identity':" + repr(self.identity) + ", 'value':"
            "{'rendering':'unsupported','sourceSha256':r['captured']['sourceSha256']}}))\n")
        self.assertEqual(host.identity(self.binary, self.source, self.recipe), self.identity)
        with self.assertRaisesRegex(ValueError, "compiled source"):
            host.identity(self.binary, "c" * 40, self.recipe)

    def test_identity_deadline_overflow_and_malformed_output_are_joined(self):
        for body in ("print('not json')", "print('x'*9000)"):
            self.program(body)
            with self.assertRaises(ValueError):
                host.identity(self.binary, self.source, self.recipe)
        self.program("import time\ntime.sleep(30)")
        with patch.object(host.time, "monotonic", side_effect=[0, 6]), self.assertRaisesRegex(ValueError, "deadline"):
            host.identity(self.binary, self.source, self.recipe)


if __name__ == "__main__":
    unittest.main()
