import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "update-screenshots.py"
spec = importlib.util.spec_from_file_location("update_screenshots", SCRIPT)
screenshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screenshots)


class ScreenshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.captures = self.root / "captures"
        self.output = self.root / "output"
        self.captures.mkdir()
        self.output.mkdir()
        for name in screenshots.SOURCES:
            (self.captures / name).write_bytes(b"fixture")
        self.sizes = {
            "session-changes.png": (1500, 860),
            "ask-chat.png": (1360, 860),
            "mission-window-tasks-1360.png": (2720, 1720),
            "readme-build.png": (1220, 860),
            "readme-ask.png": (1360, 860),
            "readme-mission.png": (2100, 1200),
        }

    def fake_convert(self, command):
        Path(command[-1]).write_bytes(b"converted")
        return ""

    def update(self, converter=None):
        with patch.object(screenshots, "dimensions", side_effect=lambda path: self.sizes[path.name]):
            with patch.object(screenshots, "run", side_effect=converter or self.fake_convert) as commands:
                screenshots.update(self.captures, self.output)
                return commands.call_args_list

    def test_updates_only_readme_images_with_retina_crop_and_no_upscaling(self):
        sentinel = self.output / "unrelated.png"
        sentinel.write_bytes(b"keep")
        commands = self.update()
        self.assertEqual(len(commands), 2)
        self.assertIn("1220x860+280+0", commands[0].args[0])
        self.assertIn("2100x1200+620+106", commands[1].args[0])
        for command in commands:
            self.assertNotIn("-resize", command.args[0])
            self.assertIn("-strip", command.args[0])
        self.assertEqual(sentinel.read_bytes(), b"keep")
        self.assertEqual((self.output / "readme-ask.png").read_bytes(), b"fixture")
        self.assertEqual(len(list(self.output.iterdir())), 4)

    def test_rejects_missing_capture_before_replacing_outputs(self):
        (self.captures / screenshots.SOURCES[2]).unlink()
        with self.assertRaisesRegex(ValueError, "Missing fixture"):
            self.update()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_rejects_small_or_truncated_mission_instead_of_upscaling(self):
        for size in [(1360, 860), (2720, 1000), (2700, 1720)]:
            with self.subTest(size=size):
                self.sizes[screenshots.SOURCES[2]] = size
                with self.assertRaises(ValueError):
                    self.update()
                self.assertEqual(list(self.output.iterdir()), [])

    def test_conversion_failure_leaves_previous_images_untouched(self):
        previous = self.output / "readme-build.png"
        previous.write_bytes(b"previous")

        def fail_second(command):
            if "readme-mission.png" in command[-1]:
                raise subprocess.CalledProcessError(1, command)
            return self.fake_convert(command)

        with self.assertRaises(subprocess.CalledProcessError):
            self.update(fail_second)
        self.assertEqual(previous.read_bytes(), b"previous")
        self.assertEqual(list(self.output.iterdir()), [previous])

    def test_invalid_staged_output_leaves_previous_images_untouched(self):
        self.sizes["readme-mission.png"] = (0, 0)
        with self.assertRaisesRegex(ValueError, "Invalid output"):
            self.update()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_render_launches_two_isolated_fixture_runs_without_building(self):
        app = self.root / "Pilot.app"
        executable = app / "Contents/MacOS/Pilot"
        executable.parent.mkdir(parents=True)
        executable.touch()
        home = self.root / "home"
        with patch.object(screenshots, "run") as run:
            screenshots.render(app, self.captures, home)
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            command = call.args[0]
            self.assertEqual(command[:3], ["open", "-n", "-W"])
            self.assertIn(f"HOME={home}", command)
            self.assertIn(f"CFFIXED_USER_HOME={home}", command)
            self.assertIn(f"PILOT_HOME={home / 'pilot'}", command)
            self.assertIn(f"PILOT_AGENT_DIR={home / 'agent'}", command)
            self.assertIn("--snapshot", command)
        self.assertNotIn("--missions-only", run.call_args_list[0].args[0])
        self.assertIn("--missions-only", run.call_args_list[1].args[0])

    def test_render_rejects_missing_app(self):
        with self.assertRaisesRegex(ValueError, "No Pilot executable"):
            screenshots.render(self.root / "missing.app", self.captures, self.root / "home")


if __name__ == "__main__":
    unittest.main()
