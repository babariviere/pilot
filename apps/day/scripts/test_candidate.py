"""Isolated candidate assembly rules. Mocked code seals are NOT native acceptance."""
import json
import base64
import contextlib
import io
from pathlib import Path
import plistlib
import shlex
import tempfile
import unittest
from unittest.mock import patch

import candidate

bundle = candidate.bundle
day = candidate.day


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="day-candidate-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = "a" * 40
        self.config = dict(schema=1, mode="configured", public_key=base64.b64encode(bytes([42]) * 32).decode(),
                           repository="fixture/offline", application_id=bundle.APP_ID, build="100.1",
                           code_requirement=f'identifier "{bundle.APP_ID}"')
        self.inputs = self.root / "inputs"
        self.inputs.mkdir()
        binaries = []
        for name in ("pilot-desktop",):
            p = self.inputs / name
            p.write_bytes(b"synthetic fixture, not executable code")
            p.chmod(0o755)
            binaries.append(dict(name=name, bytes=p.stat().st_size, sha256=bundle.digest(p)))
        resources = self.inputs / "nsh"
        resources.mkdir()
        (resources / "bundle.nshc").write_bytes(b"synthetic fixture, never executed")
        bundle.write_json(resources / "capabilities.json", day.compiled_capabilities(["day.today.read", "day.flush.ack"]))
        bundle.write_json(resources / "app.json", {"id": bundle.APP_ID})
        self.compiled = dict(source=self.source, profile="release", updater_configuration=self.config)
        bundle.write_json(self.inputs / "manifest.json", dict(schema=1, kind="connected-candidate-inputs",
                          source=self.source, target=day.TARGET, profile="release", binaries=binaries,
                          updater_configuration=self.config, recipe_sha256="b" * 64, compiler="fixture",
                          compiled={"pilot-desktop": self.compiled}))
        bundle.write_json(self.inputs / "gui-resources.json", dict(schema=1, kind="nsh-ui-resources",
                          source=self.source, target=day.TARGET, nsh_release=bundle.NSH_RELEASE,
                          executable=binaries[0], files=bundle.inventory(resources)))
        self.calls = []

    def command(self, *args, **kwargs):
        self.calls.append(args)
        if args[:2] == ("/usr/bin/git", "show"):
            if args[2].endswith("bridge.rs"):
                return 'pub const METHODS: &[&str] = &["day.today.read", "day.flush.ack"];'
            return '{"version":"1.2.3"}'
        if args[-1] == "--build-input-receipt":
            return json.dumps(self.compiled)
        return ""

    def mocked(self):
        return patch.multiple(bundle, run=self.command,
                              native_closure=lambda app: [(app / "Contents/MacOS/pilot-desktop").resolve()])

    def test_prepare_never_assembles_signs_or_launches(self):
        with patch.object(candidate, "trust_from", return_value=self.config), \
                patch.object(day, "snapshot_day") as build, \
                patch.object(candidate, "checked_inputs") as checked, \
                patch.object(candidate, "assemble", side_effect=AssertionError("prepare must not assemble")):
            output = self.root / "prepared"
            self.assertEqual(candidate.prepare(self.source, self.root / "existing", output), output)
            build.assert_called_once_with(self.source, output, production=self.config, connected_only=True)
            checked.assert_called_once_with(output)

    def test_prepare_cli_prints_next_local_stage_without_an_extra_approval_hold(self):
        output = self.root / "prepared"
        stdout = io.StringIO()
        args = ["candidate.py", "prepare", "--source", self.source, "--trust-from", str(self.root / "existing"),
                "--output", str(output)]
        with patch.object(candidate.sys, "argv", args), \
                patch.object(candidate, "prepare", return_value=output) as prepare, \
                patch.object(candidate, "assemble", side_effect=AssertionError("prepare must not assemble")), \
                contextlib.redirect_stdout(stdout):
            candidate.main()
        prepare.assert_called_once_with(self.source, self.root / "existing", output)
        text = stdout.getvalue()
        self.assertIn("temporary development app", text)
        self.assertIn("No install, replacement or live update", text)
        self.assertNotIn("approval", text.lower())
        self.assertEqual(shlex.split(text.splitlines()[-1]),
                         [candidate.sys.executable, str(Path(candidate.__file__).resolve()), "assemble",
                          "--inputs", str(output), "--output", str(output.parent / "Pilot.app")])

    def test_cli_help_describes_local_assembly_without_granting_install_or_launch(self):
        stdout = io.StringIO()
        with patch.object(candidate.sys, "argv", ["candidate.py", "--help"]), \
                patch.object(candidate, "assemble", side_effect=AssertionError("help must not assemble")), \
                contextlib.redirect_stdout(stdout), self.assertRaises(SystemExit) as exit:
            candidate.main()
        self.assertEqual(exit.exception.code, 0)
        text = " ".join(stdout.getvalue().split())
        self.assertIn("temporary development app; no install or launch", text)
        self.assertNotIn("Separately authorized", text)

    def existing(self):
        app = self.root / "Existing/Pilot Next.app"
        (app / "Contents/Resources").mkdir(parents=True)
        bundle.write_json(app / "Contents/Resources/updater-inputs.json", {"configuration":self.config})
        with (app / "Contents/Info.plist").open("wb") as f:
            plistlib.dump({"CFBundleIdentifier":bundle.APP_ID, "CFBundleVersion":self.config["build"]}, f)
        return app

    def test_existing_trust_requires_real_verifier_and_same_adhoc_policy(self):
        app = self.existing()
        with patch.object(bundle, "verify") as verify, patch.object(bundle, "run", self.command), \
                patch.object(candidate.subprocess, "check_output", return_value="Signature=adhoc\n"):
            self.assertEqual(candidate.trust_from(app), self.config)
            verify.assert_called_once_with(app)
            self.assertTrue(any("--verify" in call and "-R=" + self.config["code_requirement"] in call for call in self.calls))
            self.assertFalse(any("--sign" in call for call in self.calls))
        with patch.object(bundle, "run", self.command), \
                patch.object(candidate.subprocess, "check_output", return_value="Authority=Developer ID\n"):
            with self.assertRaisesRegex(ValueError, "downgrade"):
                candidate.trust_from(app)

    def test_changed_existing_build_or_failed_signature_supplies_no_config(self):
        app = self.existing()
        with patch.object(bundle, "verify"), patch.object(bundle, "run", self.command), \
                patch.object(candidate.subprocess, "check_output", return_value="Signature=adhoc\n"):
            with (app / "Contents/Info.plist").open("wb") as f:
                plistlib.dump({"CFBundleIdentifier":bundle.APP_ID, "CFBundleVersion":"other"}, f)
            with self.assertRaisesRegex(ValueError, "differ"):
                candidate.trust_from(app)
        with patch.object(bundle, "run", side_effect=ValueError("signature refused")):
            with self.assertRaisesRegex(ValueError, "signature refused"):
                candidate.trust_from(app)

    def test_existing_public_config_cannot_change_identity_policy_or_add_authority(self):
        self.assertEqual(candidate.configuration(self.config), self.config)
        for changes in ({"mode":"unconfigured"}, {"public_key":"bad"}, {"application_id":"other"},
                        {"code_requirement":"always"}, {"extra":True}):
            with self.subTest(changes=changes), self.assertRaises((ValueError, KeyError)):
                candidate.configuration(self.config | changes)

    def test_output_is_fresh_temporary_and_never_an_install_path(self):
        for path in (Path("relative"), self.inputs):
            with self.subTest(path=path), self.assertRaises(ValueError):
                candidate.temporary_output(path)
        # Model an install directory outside the OS temporary root without
        # depending on /Applications existing on this host (or touching it).
        temporary = self.root / "temporary"
        temporary.mkdir(mode=0o700)
        applications = self.root / "Applications"
        applications.mkdir()
        with patch.object(candidate.tempfile, "gettempdir", return_value=str(temporary)):
            with self.assertRaisesRegex(ValueError, "private OS temporary directory"):
                candidate.temporary_output(applications / "Pilot Next.app")
            self.assertEqual(candidate.temporary_output(temporary / "fresh"), temporary / "fresh")
        self.assertEqual(candidate.temporary_output(self.root / "fresh"), self.root / "fresh")
        public = self.root / "public"
        public.mkdir(mode=0o755)
        public.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private"):
            candidate.temporary_output(public / "fresh")

    def test_prepared_inputs_recheck_binary_source_config_resources_and_exact_grants(self):
        with self.mocked(), patch.object(day, "compiled_receipt", return_value=self.compiled):
            candidate.checked_inputs(self.inputs)
            (self.inputs / "pilot-desktop").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "receipt mismatch"):
                candidate.checked_inputs(self.inputs)

    def test_missing_config_and_widened_grants_refuse_before_assembly(self):
        metadata = bundle.read_json(self.inputs / "manifest.json")
        bundle.write_json(self.inputs / "manifest.json", metadata | {"profile":"dev"})
        with self.assertRaisesRegex(ValueError, "release-profile"):
            candidate.checked_inputs(self.inputs)
        bundle.write_json(self.inputs / "manifest.json", metadata)
        bundle.write_json(self.inputs / "nsh/capabilities.json", {"host":["day.*"]})
        with self.mocked(), self.assertRaisesRegex(ValueError, "inventory mismatch"):
            candidate.checked_inputs(self.inputs)

    def test_full_distribution_kind_is_not_candidate_build_evidence(self):
        metadata = bundle.read_json(self.inputs / "manifest.json")
        bundle.write_json(self.inputs / "manifest.json", metadata | {"kind": "production-rust-inputs"})
        with self.assertRaisesRegex(ValueError, "release-profile inputs"):
            candidate.checked_inputs(self.inputs)

    def test_explicit_assembly_is_connected_only_and_keeps_exact_identity(self):
        app = self.root / "Pilot.app"
        with self.mocked(), patch.object(day, "compiled_receipt", return_value=self.compiled):
            candidate.assemble(self.inputs, app)
            value = candidate.verify(app)
        self.assertFalse(value["installable_update"])
        self.assertFalse(value["bundled_daemon"])
        self.assertFalse((app / "Contents/Resources/runtime").exists())
        self.assertFalse((app / "Contents/Helpers").exists())
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], bundle.APP_ID)
        self.assertEqual(info["CFBundleExecutable"], "pilot-desktop")
        self.assertEqual(info["CFBundleDisplayName"], "Pilot")
        self.assertNotIn("CFBundleURLTypes", info)
        self.assertTrue(any(call[0] == "/usr/bin/codesign" and "--sign" in call for call in self.calls))
        self.assertFalse(any(call[0] in ("open", "/usr/bin/open", "launchctl") for call in self.calls))

    def test_changed_compiled_identity_and_resource_copy_fail_closed(self):
        app = self.root / "Pilot.app"
        with self.mocked(), patch.object(day, "compiled_receipt", return_value=self.compiled):
            candidate.assemble(self.inputs, app)
            self.compiled = self.compiled | {"source":"c" * 40}
            with self.assertRaisesRegex(ValueError, "compiled identity"):
                candidate.verify(app)
            (app / "Contents/Resources/nsh/bundle.nshc").write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "closure mismatch"):
                candidate.verify(app)

    def test_failed_signature_does_not_leave_an_apparently_ready_app(self):
        app = self.root / "Pilot.app"
        with self.mocked(), patch.object(day, "compiled_receipt", return_value=self.compiled), \
                patch.object(candidate, "verify", side_effect=ValueError("signature refused")):
            with self.assertRaisesRegex(ValueError, "signature refused"):
                candidate.assemble(self.inputs, app)
        self.assertFalse(app.exists())


if __name__ == "__main__":
    unittest.main()
