import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("measure-tool-selection.py")


@unittest.skipUnless(platform.system() == "Darwin", "macOS-only fixture runner")
class ToolSelectionRunner(unittest.TestCase):
    def run_fixture(self, body, timeout=2):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        binary = root / "fixture"
        binary.write_text(f"#!{sys.executable}\n" + body)
        binary.chmod(0o700)
        output = root / "result"
        result = subprocess.run([sys.executable, str(SCRIPT), str(binary), str(output),
                                 "--base-patch-sha256", "a" * 64, "--timeout", str(timeout)],
                                capture_output=True, text=True, timeout=10)
        return result, output, binary

    def test_exact_frozen_binary_and_closed_environment(self):
        result, output, binary = self.run_fixture("""import json, os
from pathlib import Path
root = Path(os.environ['PILOT_NEXT_TOOL_SELECTION_DIR'])
assert os.environ['HOME'] == str(root)
assert not any(key.startswith(('ANTHROPIC_', 'OPENAI_')) for key in os.environ)
(root / 'stages.ndjson').write_text(json.dumps({'passed': True}) + '\\n')
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((output / "report.json").read_text())
        self.assertTrue(report["passed"])
        self.assertEqual(report["binary_sha256"], hashlib.sha256(binary.read_bytes()).hexdigest())
        self.assertEqual((output / "disclosure").read_bytes(), binary.read_bytes())

    def test_deadline_preserves_stage_and_confirms_group_cleanup(self):
        result, output, _ = self.run_fixture("""import os
from pathlib import Path
(Path(os.environ['PILOT_NEXT_TOOL_SELECTION_DIR']) / 'stages.ndjson').write_text('{"stage":"pointer_move","event":"start"}\\n')
while True: pass
""", timeout=2)
        self.assertNotEqual(result.returncode, 0)
        report = json.loads((output / "report.json").read_text())
        self.assertFalse(report["passed"])
        self.assertEqual(report["stages"][0]["cleanup"]["state"], "group-signaled")
        self.assertEqual(json.loads((output / "stages.ndjson").read_text())["stage"], "pointer_move")


if __name__ == "__main__":
    unittest.main()
