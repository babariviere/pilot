"""Build adapters keep resource and cache policy with the caller."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
POLICY = {
    "MBX_CACHE_DIR": "/fixture/shared-cache",
    "MBX_SCHEDULER": "0",
    "MBX_SCHEDULER_CPUS": "7",
    "MBX_SCHEDULER_MEMORY": "8GiB",
    "MBX_GC_MAX_SIZE": "9GiB",
    "MBX_GC_MIN_FREE_SIZE": "1GiB",
    "MBX_TARGET_VIEWS": "1",
    "MBX_GC_AUTO": "1",
    "MBX_REMOTE_URL": "https://cache.invalid",
    "MBX_DISABLE": "1",
    "MBX_BLAZE": "1",
    "CARGO_BUILD_JOBS": "7",
    "CARGO_INCREMENTAL": "1",
    "CARGO_PROFILE_DEV_DEBUG": "2",
}


class BuildEnvironment(unittest.TestCase):
    def test_wrappers_preserve_policy_and_do_not_supply_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binaries = root / "bin"
            binaries.mkdir()
            program = "#!/usr/bin/env python3\nimport json,os,sys\nif '--version' in sys.argv:\n print('mbx 1.26.0')\nelse:\n print(json.dumps(dict(os.environ)))\n"
            for name in ("mbx", "cargo"):
                tool = binaries / name
                tool.write_text(program)
                tool.chmod(0o755)
            for app, files in {
                "day": ("scripts/cargo", "scripts/build-env.sh"),
                "desktop": ("scripts/cargo.sh",),
                "power": ("scripts/cargo.sh",),
            }.items():
                for name in files:
                    destination = root / "apps" / app / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(ROOT / "apps" / app / name, destination)
            (root / "apps/desktop/scripts/prepare-patches.py").write_text("")
            base = {key: value for key, value in os.environ.items()
                    if not key.startswith(("MBX_", "CARGO_PROFILE_", "NSH_DAY_"))
                    and key not in {"CARGO", "CARGO_BUILD_JOBS", "CARGO_INCREMENTAL", "GITHUB_ACTIONS"}}
            base.update(HOME=str(root / "home"), PATH=str(binaries) + os.pathsep + os.environ["PATH"],
                        NSH_DAY_REAL_CARGO=str(binaries / "cargo"))
            for supplied in ({}, POLICY):
                for app, entry, ci in (("day", "cargo", False), ("desktop", "cargo.sh", False),
                                       ("power", "cargo.sh", False), ("desktop", "cargo.sh", True),
                                       ("power", "cargo.sh", True)):
                    with self.subTest(app=app, ci=ci, explicit=bool(supplied)):
                        env = dict(base, **supplied)
                        if ci:
                            env["GITHUB_ACTIONS"] = "true"
                        result = subprocess.run(["bash", str(root / "apps" / app / "scripts" / entry), "check"],
                                                env=env, check=True, capture_output=True, text=True)
                        actual = json.loads(result.stdout)
                        for key in POLICY:
                            if key in supplied:
                                self.assertEqual(actual[key], supplied[key])
                            else:
                                self.assertNotIn(key, actual)


if __name__ == "__main__":
    unittest.main()
