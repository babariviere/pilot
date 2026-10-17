import importlib.util
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "patch_ghostty_layout", Path(__file__).parents[1] / "patch-ghostty-layout.py"
)
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


class GhosttyLayoutTests(unittest.TestCase):
    def test_patch_adds_viewport_sizing_on_fresh_and_cached_checkouts(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            views = package / "Sources/GhosttyTerminal/View"
            views.mkdir(parents=True)
            upstream = views / "TerminalViewRepresentable@AppKit.swift"
            upstream.write_text("// Original upstream source\n")

            patcher.patch(package)
            layout = views / "TerminalViewRepresentable+PilotLayout.swift"
            self.assertEqual(layout.read_text(), patcher.LAYOUT)
            self.assertIn("sizeThatFits", layout.read_text())
            self.assertIn("replacingUnspecifiedDimensions(by: .zero)", layout.read_text())
            self.assertEqual(upstream.read_text(), "// Original upstream source\n")

            before = layout.stat().st_mtime_ns
            patcher.patch(package)
            self.assertEqual(layout.stat().st_mtime_ns, before)

            layout.write_text("// Stale cached patch\n")
            patcher.patch(package)
            self.assertEqual(layout.read_text(), patcher.LAYOUT)
