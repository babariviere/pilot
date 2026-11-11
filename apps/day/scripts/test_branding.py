"""Check product display names without changing stable app identities."""
import json
from pathlib import Path
import unittest


class Branding(unittest.TestCase):
    def test_product_name_and_stable_bundle_identity(self):
        day = Path(__file__).resolve().parents[1]
        config = json.loads((day / "nsh.json").read_text())
        self.assertEqual(config["name"], "Pilot")
        self.assertEqual(config["id"], "dev.pilot.day")
        self.assertEqual(json.loads((day / "theme.json").read_text())["name"], "Pilot")


if __name__ == "__main__":
    unittest.main()
