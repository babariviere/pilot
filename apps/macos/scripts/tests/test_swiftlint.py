import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "lint.sh"


class SwiftLintTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / "calls.json"
        self.binary = self.root / "swiftlint"
        self.binary.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
if sys.argv[1:] == ['version']:
    print(os.environ.get('MOCK_VERSION', '0.65.1'))
else:
    Path(os.environ['MOCK_LOG']).write_text(json.dumps({'cwd': os.getcwd(), 'args': sys.argv[1:]}))
    sys.exit(int(os.environ.get('MOCK_EXIT', '0')))
""")
        self.binary.chmod(0o755)
        self.env = {**os.environ, "SWIFTLINT_BIN": str(self.binary), "MOCK_LOG": str(self.log)}

    def run_lint(self, *arguments):
        return subprocess.run(["bash", str(SCRIPT), *arguments], cwd=self.root,
                              env=self.env, capture_output=True, text=True, timeout=15)

    def test_pinned_binary_runs_strictly_from_package_directory(self):
        result = self.run_lint("Sources/Pilot")
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(self.log.read_text())
        package = SCRIPT.parent.parent
        self.assertEqual(Path(call["cwd"]).resolve(), package)
        self.assertEqual(call["args"], ["lint", "--config", str(package / ".swiftlint.yml"),
                                       "--strict", "--force-exclude", "--no-cache", "--quiet", "Sources/Pilot"])

    def test_wrong_version_fails_before_linting(self):
        self.env["MOCK_VERSION"] = "0.0.0"
        result = self.run_lint()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SwiftLint 0.65.1 is required", result.stderr)
        self.assertFalse(self.log.exists())

    def test_lint_failures_propagate(self):
        self.env["MOCK_EXIT"] = "2"
        self.assertEqual(self.run_lint().returncode, 2)

    def test_download_is_verified_before_extraction_and_execution(self):
        tools = self.root / "tools"
        tools.mkdir()
        events = self.root / "events"
        self.env.update({"PATH": str(tools) + os.pathsep + self.env["PATH"],
                         "MOCK_EVENTS": str(events), "MOCK_BINARY": str(self.binary),
                         "TMPDIR": str(self.root), "SWIFTLINT_BIN": ""})
        # Shadow any system installation with a different version so this exercises the download path.
        stubs = {
            "swiftlint": "#!/bin/sh\necho 0.0.0\n",
            "curl": """#!/usr/bin/env python3
import os, sys
from pathlib import Path
assert 'https://github.com/realm/SwiftLint/releases/download/0.65.1/portable_swiftlint.zip' in sys.argv
Path(sys.argv[sys.argv.index('-o') + 1]).write_bytes(b'archive')
Path(os.environ['MOCK_EVENTS']).write_text('download\\n')
""",
            "shasum": """#!/usr/bin/env python3
import os, sys
with open(os.environ['MOCK_EVENTS'], 'a') as f: f.write('verify\\n')
assert sys.argv[1:] == ['-a', '256', '--check']
assert sys.stdin.read().startswith('c1e429b0599cf1b516f369a2d9ec04eaf0e436f3c12b637df8851fa52ff694d0  ')
sys.exit(int(os.environ.get('MOCK_HASH_EXIT', '0')))
""",
            "unzip": """#!/usr/bin/env python3
import os, shutil, sys
from pathlib import Path
with open(os.environ['MOCK_EVENTS'], 'a') as f: f.write('extract\\n')
destination = Path(sys.argv[sys.argv.index('-d') + 1])
destination.mkdir()
shutil.copy2(os.environ['MOCK_BINARY'], destination / 'swiftlint')
""",
        }
        for name, source in stubs.items():
            path = tools / name
            path.write_text(source)
            path.chmod(0o755)
        result = self.run_lint()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.read_text(), "download\nverify\nextract\n")
        self.assertTrue(self.log.exists())
        self.assertEqual(list(self.root.glob("pilot-swiftlint.*")), [])

        self.log.unlink()
        self.env["MOCK_HASH_EXIT"] = "1"
        result = self.run_lint()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events.read_text(), "download\nverify\n")
        self.assertFalse(self.log.exists())
        self.assertEqual(list(self.root.glob("pilot-swiftlint.*")), [])


if __name__ == "__main__":
    unittest.main()
