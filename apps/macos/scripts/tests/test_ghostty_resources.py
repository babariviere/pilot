import importlib.util
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "patch_ghostty_resources", Path(__file__).parents[1] / "patch-ghostty-resources.py"
)
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


class GhosttyResourceTests(unittest.TestCase):
    def test_patch_covers_runtime_and_localization_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            sources = package / "Sources/GhosttyTerminal"
            config = sources / "Configuration"
            config.mkdir(parents=True)
            runtime = config / "GhosttyRuntimeResources.swift"
            runtime.write_text('Bundle.module.url(forResource: "Ghostty", withExtension: nil)\n')
            menu = sources / "AppTerminalView.swift"
            menu.write_text('String(localized: "Copy", bundle: .module)\n')

            patcher.patch(package)
            self.assertIn("Bundle.pilotModule", runtime.read_text())
            self.assertIn("bundle: .pilotModule", menu.read_text())
            accessor = config / "PilotResourceBundle.swift"
            self.assertIn("Bundle.main.resourceURL", accessor.read_text())
            self.assertIn('pathExtension == "app"', accessor.read_text())
            self.assertIn("return Bundle.module", accessor.read_text())

            before = {p: (p.read_text(), p.stat().st_mtime_ns) for p in sources.rglob("*.swift")}
            patcher.patch(package)
            after = {p: (p.read_text(), p.stat().st_mtime_ns) for p in before}
            self.assertEqual(before, after)
