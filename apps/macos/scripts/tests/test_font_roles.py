import importlib.util
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("check_font_roles", HERE.parent / "check-font-roles.py")
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)


class FontRolesTests(unittest.TestCase):
    def write(self, root, name, text):
        path = pathlib.Path(root) / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_counts_fixed_sizes_and_text_styles_only(self):
        with tempfile.TemporaryDirectory() as root:
            self.write(root, "Row.swift", "\n".join([
                ".font(.system(size: 10, weight: .medium))",
                ".font(.caption)",
                ".font(.headline.weight(.bold))",
                ".font(.pilot(.caption))",
                ".font(.system(size: role.size))",
                ".font(.captionLike)",
            ]))
            self.assertEqual(check.count(root), {"Row.swift": 3})

    def test_flags_files_over_their_baseline(self):
        counts = {"Legacy.swift": 2, "Row.swift": 1, "Old.swift": 1}
        allowed = {"Legacy.swift": 2, "Old.swift": 3}
        self.assertEqual(check.violations(counts, allowed), ["Row.swift: 1 fixed font size or text style use(s), 0 allowed"])

    def test_repository_sources_match_baseline(self):
        self.assertEqual(check.violations(check.count(check.SOURCES), check.read_baseline(check.BASELINE)), [])


if __name__ == "__main__":
    unittest.main()
