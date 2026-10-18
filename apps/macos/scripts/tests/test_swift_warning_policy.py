"""Check the evaluated manifest, not just a compiler flag in its source."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest


class SwiftWarningPolicyTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("swift"), "Swift toolchain unavailable")
    def test_every_first_party_target_treats_warnings_as_errors(self):
        package = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            ["swift", "package", "--package-path", str(package), "dump-package"],
            capture_output=True, text=True, check=True, timeout=30,
        )
        targets = json.loads(result.stdout)["targets"]
        self.assertTrue(targets)
        self.assertTrue(any(target["type"] == "test" for target in targets))
        for target in targets:
            with self.subTest(target=target["name"]):
                flags = [setting for setting in target.get("settings", [])
                         if setting["tool"] == "swift"
                         and "-warnings-as-errors" in setting["kind"].get("unsafeFlags", {}).get("_0", [])]
                self.assertEqual(len(flags), 1)
                self.assertNotIn("condition", flags[0], "Enforce debug and release builds alike")


if __name__ == "__main__":
    unittest.main()
