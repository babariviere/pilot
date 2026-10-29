"""Synthetic observation timing, not native Wayland qualification."""
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

import linux_gui_package_native as native


class ObservationTests(unittest.TestCase):
    def observe(self, frame_at=None, exit_at=None, protocol=None):
        clock = [0.0]
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / "wayland.log"
            trace.write_text("fixture renderer starting\n")

            class App:
                def poll(self):
                    return 1 if exit_at is not None and clock[0] >= exit_at else None

                def wait(self, timeout):
                    clock[0] += timeout
                    if frame_at is not None and clock[0] >= frame_at:
                        trace.write_text(protocol if protocol is not None else
                                         "xdg_surface@1.get_toplevel(new id xdg_toplevel@2)\n"
                                         "wl_surface@3.attach(wl_buffer@4, 0, 0)\n")
                    if self.poll() is not None:
                        return 1
                    raise subprocess.TimeoutExpired("synthetic GUI", timeout)

            with patch.object(native.time, "monotonic", side_effect=lambda: clock[0]):
                native.observe_frame(App(), trace)
        return clock[0]

    def test_cold_software_frame_after_old_twelve_second_cutoff(self):
        elapsed = self.observe(frame_at=15)
        self.assertGreaterEqual(elapsed, 15)
        self.assertLess(elapsed, 16)

    def test_fast_frame_keeps_original_liveness_observation(self):
        elapsed = self.observe(frame_at=1)
        self.assertGreaterEqual(elapsed, 12)
        self.assertLess(elapsed, 13)

    def test_process_exit_is_not_success_even_after_a_frame(self):
        with self.assertRaisesRegex(ValueError, "Fixture exited before observation"):
            self.observe(frame_at=1, exit_at=2)

    def test_missing_frame_remains_bounded_and_reports_trace(self):
        with self.assertRaisesRegex(ValueError, "No actual Wayland.*renderer starting"):
            self.observe()

    def test_both_toplevel_and_rendered_buffer_are_still_required(self):
        for protocol in ("xdg_surface@1.get_toplevel(new id xdg_toplevel@2)\n",
                         "wl_surface@3.attach(wl_buffer@4, 0, 0)\n"):
            with self.subTest(protocol=protocol), self.assertRaisesRegex(ValueError, "No actual Wayland"):
                self.observe(frame_at=1, protocol=protocol)


class SourceTests(unittest.TestCase):
    def test_release_retry_uses_tag_checkout_not_workflow_commit(self):
        source = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / "binaries"
            binaries.mkdir()
            for name in native.package.BINARIES:
                (binaries / name).write_text("synthetic binary, never executed")
            output = root / "receipt.json"
            with patch.object(native.package, "native_host"), \
                    patch.dict(os.environ, GITHUB_SHA="b" * 40), \
                    patch.object(native.subprocess, "check_output", side_effect=[source, "c" * 40]), \
                    patch.object(native.package, "elf_closure", return_value=[{"path": name} for name in native.package.BINARIES]), \
                    patch.object(native.subprocess, "run", side_effect=[
                        subprocess.CompletedProcess([], 0, b"Pilot Next", b""),
                        subprocess.CompletedProcess([], 1, b"", b"Native Wayland required")]), \
                    patch.object(native, "compositor_display", return_value=nullcontext("synthetic")), \
                    patch.object(native.subprocess, "Popen"), \
                    patch.object(native, "observe_frame") as observe, patch.object(native, "stop"):
                native.probe(binaries, output, source)
            observe.assert_called_once()
            self.assertEqual(json.loads(output.read_text())["source"], source)


if __name__ == "__main__":
    unittest.main()
