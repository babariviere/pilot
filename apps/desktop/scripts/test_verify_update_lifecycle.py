import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("lifecycle", Path(__file__).with_name("verify_update_lifecycle.py"))
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


class PhaseTimingsTest(unittest.TestCase):
    def test_only_fixed_labels_and_numeric_durations_are_exported(self):
        self.assertEqual(lifecycle.phase_timings("\n".join([
            "lifecycle-phase helper_prepare 12.345678",
            "lifecycle-phase arbitrary_user_text 1.000000",
            "lifecycle-phase exited_closure_hash /private/user/path",
            "lifecycle-phase commit_wait NaN",
            "lifecycle-phase commit_wait -2.000000",
            "lifecycle-phase blackout_upper_bound 3.250000",
            "ordinary diagnostics are not exported",
        ])), [("helper_prepare", 12.345678), ("blackout_upper_bound", 3.25)])


if __name__ == "__main__":
    unittest.main()
