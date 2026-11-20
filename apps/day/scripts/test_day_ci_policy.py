"""Caller/event truth table, including reusable workflow caller semantics."""
import ast
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import day_ci_policy as policy


class SourcePolicyTests(unittest.TestCase):
    def setUp(self):
        self.source = "a" * 40
        self.env = dict(GITHUB_SHA=self.source, GITHUB_REPOSITORY="owner/repo",
                        GITHUB_EVENT_NAME="push", GITHUB_REF="refs/heads/main")
        self.event = dict(repository=dict(full_name="owner/repo", fork=False))

    def check(self, source=None, head=None):
        policy.validate(self.source if source is None else source, self.env, self.event,
                        self.source if head is None else head)

    def pr(self):
        self.env.update(GITHUB_EVENT_NAME="pull_request", GITHUB_REF="refs/pull/12/merge")
        self.event.update(number=12, pull_request=dict(
            base=dict(ref="main", repo=dict(full_name="owner/repo")),
            head=dict(sha="b" * 40, repo=dict(full_name="owner/repo"))))

    def test_main_push_and_same_repo_pr_test_event_sha_not_head(self):
        self.check()
        self.pr()
        self.check()
        with self.assertRaises(ValueError):
            self.check(source="b" * 40)

    def test_mutable_wrong_and_overlaid_source_are_refused(self):
        for source in ("main", "refs/heads/main", "a" * 39, "A" * 40, "b" * 40):
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.check(source=source)
        with self.assertRaises(ValueError):
            self.check(head="b" * 40)

    def test_non_ci_or_privileged_events_and_other_refs_are_refused(self):
        for kind in ("workflow_call", "workflow_dispatch", "pull_request_target", "release", "workflow_run", "schedule"):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.env["GITHUB_EVENT_NAME"] = kind
                self.check()
        self.env["GITHUB_EVENT_NAME"] = "push"
        for ref in ("refs/heads/feature", "refs/tags/v1.0", ""):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                self.env["GITHUB_REF"] = ref
                self.check()

    def test_forks_non_main_prs_missing_or_mismatched_context_refuse(self):
        self.pr()
        original = copy.deepcopy(self.event)
        for change in (lambda e: e["repository"].update(fork=True),
                       lambda e: e["repository"].pop("fork"),
                       lambda e: e["repository"].update(full_name="other/repo"),
                       lambda e: e["pull_request"]["head"].update(repo=dict(full_name="fork/repo")),
                       lambda e: e["pull_request"]["base"].update(ref="feature"),
                       lambda e: e["pull_request"]["base"].update(repo=dict(full_name="other/repo")),
                       lambda e: e.update(number=13), lambda e: e.pop("pull_request")):
            self.event = copy.deepcopy(original)
            change(self.event)
            with self.assertRaises(ValueError):
                self.check()
        self.event = original
        for ref in ("refs/pull/12/head", "refs/heads/main", "refs/pull/13/merge"):
            self.env["GITHUB_REF"] = ref
            with self.assertRaises(ValueError):
                self.check()

    def test_cli_checks_the_actual_checkout_without_effects(self):
        script = Path(policy.__file__).resolve()
        with tempfile.TemporaryDirectory(prefix="day-ci-policy-") as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, text=True).strip()
            git("init", "-q")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Fixture")
            source = git("rev-parse", "HEAD")
            event = root / "event.json"
            event.write_text(json.dumps(self.event))
            env = dict(os.environ, **self.env, GITHUB_EVENT_PATH=str(event))
            env["GITHUB_SHA"] = source
            result = subprocess.run(["python3", script, "--source", source], cwd=root, env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(["python3", script, "--source", self.source], cwd=root, env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(git("status", "--porcelain"), "?? event.json")

    def test_actual_reusable_and_pr_job_conditions(self):
        root = Path(__file__).resolve().parents[3]
        native = (root / ".github/workflows/day-qualification.yml").read_text()
        pr = (root / ".github/workflows/pr.yaml").read_text().split("  day-qualification:\n", 1)[1]
        def condition(workflow, context):
            expression = re.search(r"^    if: (.+)$", workflow, re.M)[1]
            def value(match):
                item = context
                for key in match[0].split("."):
                    item = item.get(key) if isinstance(item, dict) else None
                return repr(item)
            expression = re.sub(r"(?:github|inputs)\.[A-Za-z_.]+", value, expression)
            expression = expression.replace("&&", " and ").replace("||", " or ").replace("false", "False")
            def evaluate(node):
                if isinstance(node, ast.BoolOp):
                    values = [evaluate(item) for item in node.values]
                    return all(values) if isinstance(node.op, ast.And) else any(values)
                if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.Eq):
                    return ast.literal_eval(node.left) == ast.literal_eval(node.comparators[0])
                self.fail("Unexpected workflow condition: " + ast.dump(node))
            return evaluate(ast.parse(expression, mode="eval").body)
        def context():
            return dict(inputs=dict(ref=self.source), github=dict(sha=self.source, repository="owner/repo",
                ref=self.env["GITHUB_REF"], event_name=self.env["GITHUB_EVENT_NAME"], event=self.event))
        self.assertTrue(condition(native, context()))
        for kind, ref in (("workflow_call", "refs/heads/main"), ("workflow_dispatch", "refs/heads/main"),
                          ("pull_request_target", "refs/heads/main"), ("push", "refs/tags/v1"),
                          ("push", "refs/heads/feature")):
            self.env.update(GITHUB_EVENT_NAME=kind, GITHUB_REF=ref)
            self.assertFalse(condition(native, context()))
        self.pr()
        self.assertTrue(condition(native, context()))
        self.assertTrue(condition(pr, context()))
        bad = context()
        bad["inputs"]["ref"] = "b" * 40
        self.assertFalse(condition(native, bad))
        for change in (lambda e: e["repository"].update(fork=True),
                       lambda e: e["pull_request"]["base"].update(ref="other"),
                       lambda e: e["pull_request"]["head"].update(repo=dict(full_name="fork/repo"))):
            bad = copy.deepcopy(context())
            change(bad["github"]["event"])
            self.assertFalse(condition(native, bad))
            self.assertFalse(condition(pr, bad))


if __name__ == "__main__":
    unittest.main()
