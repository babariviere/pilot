import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("stable_mtimes", Path(__file__).parents[1] / "stable-mtimes.py")
stable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stable)


def tree(root: Path, files: dict) -> None:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


class StableMtimeTests(unittest.TestCase):
    def test_same_contents_get_the_same_old_stamp_and_edits_change_it(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            a, b = Path(first), Path(second)
            tree(a, {"Sources/A.swift": "let a = 1\n", "Package.swift": "// p\n"})
            tree(b, {"Sources/A.swift": "let a = 2\n", "Package.swift": "// p\n"})
            self.assertEqual(stable.stabilize(a), 2)
            self.assertEqual(stable.stabilize(b), 2)
            mtime = lambda root, name: os.stat(root / name).st_mtime
            self.assertEqual(mtime(a, "Package.swift"), mtime(b, "Package.swift"))
            self.assertNotEqual(mtime(a, "Sources/A.swift"), mtime(b, "Sources/A.swift"))
            for root in (a, b):
                for name in ("Package.swift", "Sources/A.swift"):
                    self.assertLess(mtime(root, name), stable.EPOCH + stable.SPAN)
                    self.assertGreaterEqual(mtime(root, name), stable.EPOCH)

    def test_build_products_and_symlink_targets_are_left_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tree(root, {".build/debug/Pilot": "bin", "build/Pilot.app/x": "app", "Sources/build/B.swift": "b",
                        "outside.txt": "o"})
            os.utime(root / "outside.txt", (5, 5))
            (root / "Sources/link").symlink_to(root / "outside.txt")
            before = {name: os.stat(root / name).st_mtime for name in (".build/debug/Pilot", "build/Pilot.app/x")}
            stable.stabilize(root / "Sources")
            stable.stabilize(root)
            for name, when in before.items():
                self.assertEqual(os.stat(root / name).st_mtime, when)
            self.assertLess(os.stat(root / "Sources/build/B.swift").st_mtime, stable.EPOCH + stable.SPAN)
            self.assertEqual(os.lstat(root / "Sources/link").st_mtime,
                             stable.stamp(stable.contents(str(root / "Sources/link"))))


if __name__ == "__main__":
    unittest.main()
