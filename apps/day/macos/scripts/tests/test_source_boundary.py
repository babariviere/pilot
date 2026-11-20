"""Shared source closure after removal of the obsolete Swift GUI. No builds or launches."""
from pathlib import Path
import re
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[5]


class SourceBoundaryTests(unittest.TestCase):
    def test_shared_native_inputs_remain(self):
        for path in (
            "apps/day/macos/Sources/PilotSystemEvents/main.swift",
            "apps/day/macos/Sources/PilotSystemEvents/SystemPowerMonitor.swift",
            "apps/day/macos/Sources/PilotPowerSupport/SleepOverride.swift",
            "apps/day/macos/Sources/PilotPowerSupport/SleepAcknowledgement.swift",
            "apps/day/macos/Resources/AppIcon.icns",
            "apps/day/macos/Resources/SystemEvents-Info.plist",
            "apps/day/macos/Resources/LegacyApp/HomeScenes-CREDITS.txt",
            "apps/day/macos/Resources/LegacyApp/Octicons-LICENSE.txt",
            "apps/day/macos/Resources/LegacyApp/OpenTelemetry-LICENSE.txt",
            "apps/day/macos/Resources/LegacyApp/OpenTelemetry-NOTICE.txt",
            "apps/day/macos/Resources/LegacyApp/MermaidKit-LICENSE.txt",
            "apps/day/macos/Tests/Fixtures/logical-mission-producer.json",
            "apps/day/macos/Tests/Fixtures/workspace-terminal.cjs",
            "apps/day/macos/Tests/Fixtures/loopback-websocket.cjs",
            "apps/day/macos/scripts/bundle-runtime.sh",
            "apps/day/macos/scripts/check-runtime.sh",
            "apps/day/macos/scripts/runtime-build.mjs",
            "apps/day/macos/scripts/release_metadata.py",
        ):
            with self.subTest(path=path):
                self.assertTrue((ROOT / path).is_file(), path)

    def test_native_helpers_are_standalone_without_gpui(self):
        for path in (
            "apps/desktop/Cargo.toml", "apps/desktop/Cargo.lock",
            "apps/desktop/updater/Cargo.toml",
            "apps/power/Cargo.toml", "crates/Cargo.toml", "crates/Cargo.lock",
        ):
            self.assertFalse((ROOT / path).exists(), path)
        for folder, name in (
            ("power", "pilot-power"),
            ("updater", "pilot-desktop-updater"),
        ):
            with self.subTest(crate=folder):
                crate = ROOT / "crates" / folder
                manifest = tomllib.loads((crate / "Cargo.toml").read_text())
                self.assertEqual(manifest["package"]["name"], name)
                self.assertNotIn("workspace", manifest["package"])
                lock = tomllib.loads((crate / "Cargo.lock").read_text())
                names = {p["name"] for p in lock["package"]}
                self.assertIn(name, names)
                self.assertFalse(any(p == "gpui" or p.startswith(("gpui-", "gpui_")) for p in names))

    def test_no_gui_package_or_app_entry_point(self):
        self.assertFalse((ROOT / "apps/macos/Package.swift").exists())
        manifest = (ROOT / "apps/day/macos/Package.swift").read_text()
        self.assertIn('name: "PilotNativeHelpers"', manifest)
        self.assertNotRegex(manifest, r'\.package\(|name: "(?:Pilot|PilotCore|PilotTelemetry|PilotVisuals)"')
        self.assertEqual(re.findall(r'\.testTarget\(name: "([^"]+)"', manifest), ["PilotPowerTests"])
        self.assertFalse((ROOT / "apps/day/macos/Package.resolved").exists())
        self.assertNotIn('"app:macos"', (ROOT / "package.json").read_text())
        for name in ("Pilot", "PilotCore", "PilotTelemetry", "PilotPower", "PilotVisuals", "PilotVisualsHost", "PilotVisualsKit"):
            self.assertEqual(list((ROOT / "apps/day/macos/Sources" / name).rglob("*.swift")), [])
        helpers = (ROOT / "apps/day/scripts/build-native-helpers.sh").read_text()
        self.assertIn("PilotSystemEvents/main.swift", helpers)
        self.assertNotRegex(helpers, r"swift (?:build|test)|Package\.swift")

    def test_active_source_and_workflows_have_no_removed_path_consumers(self):
        roots = [ROOT / ".github/workflows", ROOT / "scripts"]
        roots += [ROOT / path for path in (
            "crates/scripts", "apps/day/scripts", "apps/day/native/src",
            "crates/power/src", "crates/power/scripts", "apps/native-daemon",
            "crates/updater/src",
        )]
        roots += list((ROOT / "packages").glob("*/src"))
        removed = re.compile(
            r"(?:apps/)?macos/Sources/(?:Pilot|PilotCore|PilotTelemetry|PilotPower|PilotVisuals|PilotVisualsHost|PilotVisualsKit)/"
            r"|apps/day/macos/scripts/(?:build|test|bundle|lint|check-app|publish-release|setup-updates|vendor-ghostty|vendor-mermaidkit|vendor-quickjs)\.sh"
            r"|apps/day/macos/build/Pilot\.app"
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
