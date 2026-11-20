"""Shared source closure after removal of the obsolete Swift GUI. No builds or launches."""
from pathlib import Path
import re
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[4]


class SourceBoundaryTests(unittest.TestCase):
    def test_shared_native_inputs_remain(self):
        for path in (
            "apps/macos/Sources/PilotSystemEvents/main.swift",
            "apps/macos/Sources/PilotSystemEvents/SystemPowerMonitor.swift",
            "apps/macos/Sources/PilotPowerSupport/SleepOverride.swift",
            "apps/macos/Sources/PilotPowerSupport/SleepAcknowledgement.swift",
            "apps/macos/Sources/PilotVisualEngine/pilot_visual_engine.c",
            "apps/macos/Sources/PilotVisualEngine/include/pilot_visual_engine.h",
            "apps/macos/Resources/AppIcon.icns",
            "apps/macos/Resources/SystemEvents-Info.plist",
            "apps/macos/Resources/LegacyApp/HomeScenes-CREDITS.txt",
            "apps/macos/Resources/LegacyApp/Octicons-LICENSE.txt",
            "apps/macos/Resources/LegacyApp/OpenTelemetry-LICENSE.txt",
            "apps/macos/Resources/LegacyApp/OpenTelemetry-NOTICE.txt",
            "apps/macos/Resources/LegacyApp/MermaidKit-LICENSE.txt",
            "apps/macos/Tests/Fixtures/logical-mission-producer.json",
            "apps/macos/Tests/Fixtures/workspace-terminal.cjs",
            "apps/macos/Tests/Fixtures/loopback-websocket.cjs",
            "apps/macos/scripts/bundle-runtime.sh",
            "apps/macos/scripts/check-runtime.sh",
            "apps/macos/scripts/runtime-build.mjs",
            "apps/macos/scripts/release_metadata.py",
        ):
            with self.subTest(path=path):
                self.assertTrue((ROOT / path).is_file(), path)

    def test_desktop_workspace_only_builds_a_shared_helper(self):
        desktop = ROOT / "apps/desktop"
        manifest = tomllib.loads((desktop / "Cargo.toml").read_text())
        self.assertNotIn("package", manifest)
        self.assertEqual(manifest["workspace"]["members"], ["visual-worker"])
        for folder in ["src", "tests", "nsh", "patches"]:
            self.assertFalse(any(p.is_file() for p in (desktop / folder).rglob("*")), folder)
        lock = tomllib.loads((desktop / "Cargo.lock").read_text())
        self.assertTrue(all(not p["name"].startswith("gpui-") for p in lock["package"]))

    def test_no_gui_package_or_app_entry_point(self):
        manifest = (ROOT / "apps/macos/Package.swift").read_text()
        self.assertIn('name: "PilotNativeHelpers"', manifest)
        self.assertNotRegex(manifest, r'\.package\(|name: "(?:Pilot|PilotCore|PilotTelemetry|PilotVisuals)"')
        self.assertEqual(re.findall(r'\.testTarget\(name: "([^"]+)"', manifest), ["PilotPowerTests"])
        self.assertFalse((ROOT / "apps/macos/Package.resolved").exists())
        self.assertNotIn('"app:macos"', (ROOT / "package.json").read_text())
        for name in ("Pilot", "PilotCore", "PilotTelemetry", "PilotPower", "PilotVisuals", "PilotVisualsHost", "PilotVisualsKit"):
            self.assertEqual(list((ROOT / "apps/macos/Sources" / name).rglob("*.swift")), [])
        helpers = (ROOT / "apps/desktop/scripts/build-native-helpers.sh").read_text()
        self.assertIn("PilotSystemEvents/main.swift", helpers)
        self.assertNotRegex(helpers, r"swift (?:build|test)|Package\.swift")

    def test_active_source_and_workflows_have_no_removed_path_consumers(self):
        roots = [ROOT / ".github/workflows", ROOT / "scripts"]
        roots += [ROOT / path for path in (
            "apps/desktop/scripts", "apps/day/scripts", "apps/day/native/src",
            "apps/power/src", "apps/power/scripts", "apps/native-daemon",
            "apps/desktop/updater/src", "apps/desktop/visual-worker",
        )]
        roots += list((ROOT / "packages").glob("*/src"))
        removed = re.compile(
            r"(?:apps/)?macos/Sources/(?:Pilot|PilotCore|PilotTelemetry|PilotPower|PilotVisuals|PilotVisualsHost|PilotVisualsKit)/"
            r"|apps/macos/scripts/(?:build|test|bundle|lint|check-app|publish-release|setup-updates|vendor-ghostty|vendor-mermaidkit|vendor-quickjs)\.sh"
            r"|apps/macos/build/Pilot\.app"
        )
        for root in roots:
            self.assertTrue(root.is_dir(), f"Missing scan root: {root.relative_to(ROOT)}")
            for path in root.rglob("*"):
                if not path.is_file() or path.suffix not in {".ts", ".tsx", ".rs", ".c", ".h", ".sh", ".py", ".mjs", ".yaml", ".yml"}:
                    continue
                # Tests may explicitly assert rejection of old paths. They are not consumers.
                if "tests" in path.parts or ".test." in path.name or path.name.startswith("test_") or path.name.endswith("tests.rs"):
                    continue
                with self.subTest(path=str(path.relative_to(ROOT))):
                    match = removed.search(path.read_text())
                    self.assertIsNone(match, f"removed input: {match.group() if match else ''}")


if __name__ == "__main__":
    unittest.main()
