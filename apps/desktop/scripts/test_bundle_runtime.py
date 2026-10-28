"""Portable synthetic staging fixtures. Mocked signing is NOT macOS bundle verification."""
import json
import plistlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import bundle_runtime as bundle
import make_dev_icon


class NativeSnapshotTests(unittest.TestCase):
    def snapshot(self, root, layout, fault=None):
        staged = root / "staged"
        source = "a" * 40
        builds = []

        def command(args, **kwargs):
            if args[:2] == ["git", "archive"]:
                self.assertEqual(args[-1], source)
                with tarfile.open(fileobj=kwargs["stdout"], mode="w"):
                    pass
            else:
                package = Path(args[1]).parents[1]
                self.assertEqual(args, ["/bin/bash", str(package / "scripts/build.sh"),
                                        "-c", "release", "--product", args[-1]])
                builds.append(args[-1])
                bin_path = package / layout
                bin_path.mkdir(parents=True, exist_ok=True)
                helper = bin_path / args[-1]
                helper.write_text("snapshot " + args[-1])
                helper.chmod(0o755)

        def query(*args, **kwargs):
            if args[:2] == ("/usr/bin/uname", "-m"):
                return "arm64"
            if args[:2] == ("git", "cat-file"):
                return "commit"
            self.assertEqual(builds, ["PilotPower", "PilotSystemEvents"])
            self.assertEqual(args[:2], ("/bin/bash", "-c"))
            self.assertIn('source "$1/scripts/swift-env.sh"', args[2])
            self.assertIn('swift build --package-path "$1" -c release --show-bin-path', args[2])
            self.assertEqual(kwargs["timeout"], 60)
            package = Path(args[-1])
            self.assertEqual(package, (kwargs["cwd"] / "apps/macos").resolve())
            bin_path = package / layout
            if fault == "alias":
                alias = package / ".build/release"
                alias.symlink_to(bin_path.relative_to(alias.parent), target_is_directory=True)
                return str(alias)
            if fault in ("empty", "relative", "multiline"):
                return {"empty": "", "relative": layout, "multiline": str(bin_path) + "\nextra"}[fault]
            if fault == "outside-directory":
                return str(root)
            if fault == "escaped-directory-link":
                alias = package / ".build/release"
                alias.symlink_to(root, target_is_directory=True)
                return str(alias)
            if fault == "missing-directory":
                return str(package / "missing")
            helper = bin_path / "PilotSystemEvents"
            if fault == "file-directory":
                return str(helper)
            if fault in ("missing-helper", "escaped-helper", "directory-helper"):
                helper.unlink()
                if fault == "escaped-helper":
                    external = root / "external"
                    external.write_text("not from the immutable source")
                    external.chmod(0o755)
                    helper.symlink_to(external)
                elif fault == "directory-helper":
                    helper.mkdir()
            if fault == "nonexecutable-helper":
                helper.chmod(0o644)
            return str(bin_path)

        with patch.object(bundle.sys, "platform", "darwin"), \
             patch.object(bundle, "run", side_effect=query), \
             patch.object(bundle.subprocess, "run", side_effect=command):
            bundle.snapshot_build(source, staged, native=True)
        return staged

    def test_swiftpm_reported_legacy_new_and_release_alias_layouts(self):
        for layout, fault in ((".build/arm64-apple-macosx/release", None),
                              (".build/out/Products/Release", None),
                              (".build/out/Products/Release", "alias")):
            with self.subTest(layout=layout, fault=fault), tempfile.TemporaryDirectory() as temporary:
                staged = self.snapshot(Path(temporary), layout, fault)
                receipt = bundle.read_json(staged / "manifest.json")
                self.assertEqual(receipt["source"], "a" * 40)
                self.assertEqual(receipt["target"], "aarch64-apple-darwin")
                for entry in receipt["binaries"]:
                    helper = staged / entry["name"]
                    self.assertEqual(helper.read_text(), "snapshot " + entry["name"])
                    self.assertEqual(entry["sha256"], bundle.digest(helper))
                    self.assertEqual(entry["bytes"], helper.stat().st_size)
                    self.assertEqual(helper.stat().st_mode & 0o777, 0o755)

    def test_invalid_paths_and_helpers_fail_before_staging(self):
        for fault in ("empty", "relative", "multiline", "outside-directory", "escaped-directory-link",
                      "missing-directory", "file-directory", "missing-helper", "escaped-helper",
                      "directory-helper", "nonexecutable-helper"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                with self.assertRaises((ValueError, FileNotFoundError)):
                    self.snapshot(root, ".build/out/Products/Release", fault)
                self.assertFalse((root / "staged").exists())


class BundleRuntimeTests(unittest.TestCase):
    def test_native_deployment_metadata_requires_macos_15_or_older(self):
        current="Load command 1\n cmd LC_BUILD_VERSION\n platform 1\n minos 15.0\n sdk 26.2\n"
        self.assertTrue(bundle.supports_macos_15(current))
        self.assertTrue(bundle.supports_macos_15("Load command 0\n cmd LC_VERSION_MIN_MACOSX\n version 11.0\n"))
        for bad in ("",current.replace("15.0","15.0.1"),current.replace("platform 1","platform 2"),current.replace("minos 15.0","minos unknown")):
            self.assertFalse(bundle.supports_macos_15(bad))
    def test_next_development_icon_is_deterministic_and_self_contained(self):
        first = make_dev_icon.icon()
        self.assertEqual(first, make_dev_icon.icon())
        self.assertEqual(first[:4], b"icns")
        self.assertEqual(int.from_bytes(first[4:8], "big"), len(first))
        self.assertIn(b"ic09", first)
        self.assertIn(b"\x89PNG\r\n\x1a\n", first)

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("clang"), "needs macOS lipo and clang")
    def test_universal_prebuilds_keep_only_the_arm64_slice(self):
        with tempfile.TemporaryDirectory(prefix="next-thin-") as directory:
            root = Path(directory)
            (root / "a.c").write_text("int f(void) { return 1; }\n")
            fat = root / "node_modules/fsevents/fsevents.node"
            fat.parent.mkdir(parents=True)
            subprocess.run(["clang", "-arch", "arm64", "-arch", "x86_64", "-shared", "-o", str(fat), str(root / "a.c")], check=True)
            (root / "link.node").symlink_to(fat)
            fat.chmod(0o755)
            bundle.thin_universal(root)
            self.assertEqual(bundle.run("/usr/bin/lipo", "-archs", str(fat)), "arm64")
            self.assertEqual(fat.stat().st_mode & 0o777, 0o755)
            self.assertEqual(sorted(p.name for p in fat.parent.iterdir()), ["fsevents.node"])
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="next-bundle-faux-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.runtime = self.root / "runtime"
        self.executables = self.root / "executables"
        self.native = self.root / "native"
        self.output = self.root / "Pilot Next.app"
        self.source = "a" * 40
        for directory in (self.runtime, self.executables, self.native):
            directory.mkdir()
        for name in bundle.REQUIRED:
            path = self.runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic resource")
        bundle.write_json(self.runtime / "package.json", dict(version="1.64.0"))
        bundle.write_json(self.runtime / "runtime-build.json", dict(schema=1, source=self.source, version="1.64.0", protocol=1, platform="darwin", arch="arm64", node="24.21.0"))
        for directory, names in [(self.executables, ["pilot-desktop", "pilot-visual-worker", "pilot-desktop-update-helper"]),
                                 (self.native, ["PilotPower", "PilotSystemEvents"])]:
            binaries = []
            for name in names:
                path = directory / name
                path.write_text("faux executable, never executed")
                path.chmod(0o755)
                binaries.append(dict(name=name, bytes=path.stat().st_size, sha256=bundle.digest(path)))
            bundle.write_json(directory / "manifest.json", dict(tested_sha=self.source, target="aarch64-apple-darwin", updater_configuration=dict(schema=1, mode="unconfigured"), binaries=binaries))

    def assemble(self):
        with patch.object(bundle, "native_closure", return_value=[]), patch.object(bundle, "run", return_value=""):
            bundle.assemble(self.runtime, self.executables, self.native, self.output, self.source)

    def test_relocatable_closed_inventory_without_checkout_or_external_runtime(self):
        link = self.runtime / "node_modules/@pilot/daemon"
        link.parent.mkdir(parents=True)
        link.symlink_to("../../packages/daemon")
        self.assemble()
        relocated = self.root / "unrelated" / "Pilot Next.app"
        relocated.parent.mkdir()
        shutil.move(self.output, relocated)
        shutil.rmtree(self.runtime)
        shutil.rmtree(self.executables)
        shutil.rmtree(self.native)
        bundle.verify(relocated)
        manifest = bundle.read_json(relocated / bundle.MANIFEST)
        self.assertEqual(manifest["build"]["source"], self.source)
        self.assertTrue((relocated / "Contents/Resources/runtime/node_modules/@pilot/daemon/src/main.ts").is_file())

    def test_runtime_source_arch_protocol_version_and_node_mismatch(self):
        path = self.runtime / "runtime-build.json"
        original = bundle.read_json(path)
        for changes in [dict(source="b" * 40), dict(arch="x86_64"), dict(protocol=2), dict(version="0.0.0"), dict(node="22.0.0")]:
            with self.subTest(changes=changes):
                bundle.write_json(path, original | changes)
                with self.assertRaisesRegex(ValueError, "identity mismatch"):
                    self.assemble()
                self.assertFalse(self.output.exists())
        bundle.write_json(path, original)

    def test_missing_required_resources_are_not_masked_by_developer_modules(self):
        for name in bundle.REQUIRED:
            with self.subTest(name=name):
                path = self.runtime / name
                original = path.read_bytes()
                path.unlink()
                with self.assertRaises((ValueError, FileNotFoundError)):
                    self.assemble()
                path.write_bytes(original)

    def test_source_and_executable_receipts_must_match(self):
        (self.executables / "pilot-desktop").write_text("wrong build")
        with self.assertRaisesRegex(ValueError, "receipt mismatch"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_version_helper_and_exact_runtime_policy_are_sealed_resources(self):
        self.assemble()
        with (self.output / "Contents/Info.plist").open("rb") as stream:
            info = plistlib.load(stream)
        self.assertEqual(info["CFBundleVersion"], "1.64.0")
        self.assertEqual(info["CFBundleShortVersionString"], "1.64.0")
        self.assertNotEqual(info["CFBundleIdentifier"], "com.babariviere.pilot")
        self.assertEqual(info["CFBundleURLTypes"], [dict(CFBundleURLName=bundle.APP_ID + ".chat", CFBundleURLSchemes=["pilot"], CFBundleTypeRole="Viewer")])
        self.assertTrue((self.output / "Contents/Helpers/pilot-desktop-update-helper").is_file())
        self.assertEqual(bundle.read_json(self.output / "Contents/Resources/update-runtime-policy.json"), dict(schema=1, accepted_capsules=[]))
        self.assertTrue((self.output / "Contents/Resources/updater-inputs.json").is_file())

    def test_missing_helper_mismatched_configuration_and_unbounded_policy_are_refused(self):
        helper = self.executables / "pilot-desktop-update-helper"
        original = helper.read_bytes()
        helper.unlink()
        with self.assertRaisesRegex(ValueError, "receipt mismatch"):
            self.assemble()
        helper.write_bytes(original)
        path = self.executables / "manifest.json"
        original_receipt = bundle.read_json(path)
        # A separate helper receipt must identify exactly the GUI's compiled public configuration.
        separate = self.root / "updater"
        shutil.copytree(self.executables, separate)
        bundle.write_json(separate / "manifest.json", original_receipt | {"updater_configuration": "different"})
        with self.assertRaisesRegex(ValueError, "configuration receipts differ"):
            bundle.assemble(self.runtime, self.executables, self.native, self.output, self.source, separate)
        for policy in [["wrong"], ["a" * 64] * 2, [str(i) * 64 for i in range(5)]]:
            with self.subTest(policy=policy), self.assertRaisesRegex(ValueError, "exact bounded"):
                bundle.assemble(self.runtime, self.executables, self.native, self.output, self.source, accepted_capsules=policy)

    def test_production_requires_matching_configured_optimized_inputs(self):
        config = dict(schema=1, mode="configured", build="200.1", repository="owner/repo")
        path = self.executables / "manifest.json"
        original = bundle.read_json(path)
        for changes in ({}, dict(updater_configuration=config),
                        dict(updater_configuration=config, profile="dev", kind="production-rust-inputs")):
            bundle.write_json(path, original | changes)
            with self.assertRaisesRegex(ValueError, "Production"):
                bundle.assemble(self.runtime, self.executables, self.native, self.output, self.source,
                                bundle_build="200.1", production=config)
            self.assertFalse(self.output.exists())
        bundle.write_json(path, original | dict(updater_configuration=config, profile="release", kind="production-rust-inputs"))
        with patch.object(bundle, "native_closure", return_value=[]), patch.object(bundle, "run", return_value=""):
            bundle.assemble(self.runtime, self.executables, self.native, self.output, self.source,
                            bundle_build="200.1", production=config)
        self.assertEqual(bundle.read_json(self.output / bundle.MANIFEST)["kind"], "production-bundled-runtime")
        bundle.verify(self.output)

    def test_production_plane_icon_comes_from_immutable_source(self):
        plane = bundle.ROOT / "apps/macos/Resources/AppIcon.icns"
        approved = plane.read_bytes()
        self.assertEqual(approved[:4], b"icns")
        self.assertNotEqual(approved, make_dev_icon.icon())
        # A live checkout has a different icon. Only the archived source is authoritative.
        repository = self.root / "repository"
        live_icon = repository / "apps/macos/Resources/AppIcon.icns"
        live_icon.parent.mkdir(parents=True)
        live_icon.write_bytes(b"uncommitted icon must not ship")
        staged = self.root / "staged-runtime"

        def command(args, **kwargs):
            if args[:2] == ["git", "archive"]:
                self.assertEqual(args[-1], self.source)
                self.assertEqual(kwargs["cwd"], repository)
                with tarfile.open(fileobj=kwargs["stdout"], mode="w") as archive:
                    archive.add(plane, arcname="apps/macos/Resources/AppIcon.icns")
                    archive.add(self.runtime / "package.json", arcname="package.json")
            elif args[:1] == ["/bin/bash"] and args[1].endswith("/apps/macos/scripts/bundle-runtime.sh"):
                shutil.copytree(self.runtime, staged)
                # The installer does not stage desktop assets; snapshot_build owns them.
                shutil.rmtree(staged / "desktop-assets")
            else:
                self.fail(f"Unexpected build command: {args}")

        def query(*args, **kwargs):
            if args[:2] == ("git", "cat-file"):
                return "commit"
            return "v24.21.0" if args[-1] == "--version" else "arm64"

        with patch.object(bundle, "ROOT", repository), patch.object(bundle.sys, "platform", "darwin"), \
             patch.object(bundle, "run", side_effect=query), patch.object(bundle.subprocess, "run", side_effect=command), \
             patch.object(bundle, "thin_universal"):
            bundle.snapshot_build(self.source, staged)
        self.assertEqual((staged / "desktop-assets/AppIcon.icns").read_bytes(), approved)

        config = dict(schema=1, mode="configured", build="200.1", repository="owner/repo")
        receipt_path = self.executables / "manifest.json"
        bundle.write_json(receipt_path, bundle.read_json(receipt_path) | dict(
            updater_configuration=config, profile="release", kind="production-rust-inputs"))
        with patch.object(bundle, "native_closure", return_value=[]), patch.object(bundle, "run", return_value=""):
            bundle.assemble(staged, self.executables, self.native, self.output, self.source,
                            bundle_build="200.1", production=config)
        with (self.output / "Contents/Info.plist").open("rb") as stream:
            info = plistlib.load(stream)
        self.assertEqual(info["CFBundleIdentifier"], "com.babariviere.pilot-next")
        self.assertEqual(info["CFBundleIconFile"], "AppIcon")
        self.assertEqual((self.output / "Contents/Resources/AppIcon.icns").read_bytes(), approved)
        bundle.verify(self.output)

    def test_immutable_rust_commands_build_release_with_only_explicit_public_trust(self):
        repository = self.root / "repository"
        tools = repository / "apps/desktop/.tools"
        (tools / "bin").mkdir(parents=True)
        (tools / "bin/mbx").touch()
        (tools / "rustup").mkdir()
        config = dict(schema=1, mode="configured", public_key="public-only", repository="owner/repo",
                      application_id=bundle.APP_ID, build="200.1", code_requirement="explicit")
        calls = []
        def command(args, **kwargs):
            calls.append((args, kwargs))
            if args[:2] == ["git", "archive"]:
                with tarfile.open(fileobj=kwargs["stdout"], mode="w"):
                    pass
            if "build" in args:
                desktop = kwargs["cwd"] / "apps/desktop"
                output = desktop / "target/dev/release"
                output.mkdir(parents=True, exist_ok=True)
                for name in ("pilot-desktop", "pilot-visual-worker", "pilot-desktop-update-helper"):
                    (output / name).write_text("synthetic build output, never executed or qualified")
        def query(*args, **kwargs):
            return "commit" if "cat-file" in args else "arm64"
        with patch.object(bundle, "ROOT", repository), patch.object(bundle.sys, "platform", "darwin"), \
             patch.object(bundle, "run", side_effect=query), patch.object(bundle.subprocess, "run", side_effect=command), \
             patch.dict(os.environ, {"PILOT_NEXT_UPDATER_PRIVATE_KEY": "must-not-inherit", "PILOT_NEXT_UPDATER_PUBLIC_KEY": "wrong-ambient"}):
            bundle.snapshot_rust(self.source, self.root / "release-inputs", production=config)
        builds = [(args, opts) for args, opts in calls if "build" in args]
        self.assertEqual(len(builds), 2)
        for args, options in builds:
            self.assertIn("--locked", args)
            self.assertIn("--release", args)
            self.assertNotIn("PILOT_NEXT_UPDATER_PRIVATE_KEY", options["env"])
            self.assertEqual(options["env"]["PILOT_NEXT_UPDATER_PUBLIC_KEY"], config["public_key"])
        self.assertTrue(any(args[-1] == "--fetch" and "prepare-patches.py" in args[-2] for args, _ in calls))
        receipt = bundle.read_json(self.root / "release-inputs/manifest.json")
        self.assertEqual(receipt["profile"], "release")
        self.assertEqual(receipt["source"], self.source)
        self.assertEqual(receipt["updater_configuration"], config)

    def test_escape_links_and_unsafe_file_objects_are_refused_before_copy(self):
        link = self.runtime / "escape"
        link.symlink_to("../executables")
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.assemble()
        link.unlink()
        link.symlink_to(self.executables)
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.assemble()
        link.unlink()
        os.mkfifo(link)
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_tamper_added_missing_truncated_and_duplicate_manifest_data(self):
        self.assemble()
        manifest = self.output / bundle.MANIFEST
        original = manifest.read_bytes()
        for raw in [b"{", b'{"schema":1,"schema":1}', b"x" * (8 * 1024**2 + 1)]:
            manifest.write_bytes(raw)
            with self.assertRaises((ValueError, json.JSONDecodeError)):
                bundle.verify(self.output)
        manifest.write_bytes(original)
        path = self.output / "Contents/Resources/runtime/node/bin/node"
        path.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "inventory/hash mismatch"):
            bundle.verify(self.output)

    def test_existing_destination_is_never_replaced_or_deleted(self):
        self.output.mkdir()
        retained = self.output / "retained"
        retained.write_text("untouched")
        with self.assertRaisesRegex(ValueError, "fresh output"):
            self.assemble()
        self.assertEqual(retained.read_text(), "untouched")

    def test_platform_signing_failure_removes_only_fresh_staging(self):
        with patch.object(bundle, "native_closure", side_effect=ValueError("wrong native architecture")):
            with self.assertRaisesRegex(ValueError, "architecture"):
                bundle.assemble(self.runtime, self.executables, self.native, self.output, self.source)
        self.assertFalse(self.output.exists())
        self.assertTrue((self.runtime / "node/bin/node").exists())

    def test_outer_build_metadata_must_match_the_hashed_runtime_stamp(self):
        self.assemble()
        path = self.output / bundle.MANIFEST
        original = bundle.read_json(path)
        for change in [dict(arch="x86_64"), dict(version="0.0.0"), dict(node="22.0.0")]:
            with self.subTest(change=change):
                value = original | {"build": original["build"] | change}
                bundle.write_json(path, value)
                with self.assertRaisesRegex(ValueError, "identity mismatch"):
                    bundle.verify(self.output)

    @unittest.skipUnless(sys.platform == "darwin" and os.environ.get("PILOT_DESKTOP_BUNDLE_NATIVE_TEST") == "1",
                         "explicit macOS faux-Mach-O packaging lane only")
    def test_native_faux_bundle_signs_and_relocates_without_installing_or_running(self):
        # Real macOS tools, five synthetic executables. No Swift, real daemon,
        # LaunchServices registration, application launch, user profile or production artifact.
        source, binary = self.root / "faux.c", self.root / "faux-executable"
        source.write_text("int main(void) { return 0; }\n")
        subprocess.run(["/usr/bin/xcrun", "clang", "-target", "arm64-apple-macos15.0", str(source), "-o", str(binary)], check=True, timeout=30)
        for directory, names in [(self.executables, ["pilot-desktop", "pilot-visual-worker", "pilot-desktop-update-helper"]),
                                 (self.native, ["PilotPower", "PilotSystemEvents"])]:
            entries = []
            for name in names:
                shutil.copyfile(binary, directory / name)
                (directory / name).chmod(0o755)
                entries.append(dict(name=name, bytes=(directory / name).stat().st_size, sha256=bundle.digest(directory / name)))
            bundle.write_json(directory / "manifest.json", dict(tested_sha=self.source, target="aarch64-apple-darwin", updater_configuration=dict(schema=1, mode="unconfigured"), binaries=entries))
        node = self.runtime / "node/bin/node"
        shutil.copyfile(binary, node)
        node.chmod(0o755)
        bundle.assemble(self.runtime, self.executables, self.native, self.output, self.source)
        moved = self.root / "relocated" / "Pilot Next.app"
        moved.parent.mkdir()
        shutil.move(self.output, moved)
        shutil.rmtree(self.runtime)
        shutil.rmtree(self.executables)
        shutil.rmtree(self.native)
        bundle.verify(moved)
        subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(moved)], check=True, timeout=30)


if __name__ == "__main__":
    unittest.main()
