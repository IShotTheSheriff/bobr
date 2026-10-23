import importlib.util
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location("trigger", Path(__file__).with_name("next-proof-trigger.py"))
trigger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trigger)


class ProofTriggerTest(unittest.TestCase):
    def test_followup_pr_uses_previous_head(self):
        event = {"before": "old-head", "pull_request": {"base": {"sha": "main"}, "head": {"sha": "new-head"}}}
        def files(before, after):
            self.assertEqual((before, after), ("old-head", "new-head"))
            return ["packages/ui/src/utils/add/index.ts"]
        self.assertFalse(trigger.needs_proof("pull_request", event, files))

    def test_initial_pr_checks_full_diff(self):
        event = {"pull_request": {"base": {"sha": "main"}, "head": {"sha": "head"}}}
        def files(before, after):
            self.assertEqual((before, after), ("main", "head"))
            return ["tools/bazel/project-ui.cjs"]
        self.assertTrue(trigger.needs_proof("pull_request", event, files))

    def test_build_inputs_trigger_proof(self):
        event = {"before": "old", "after": "new"}
        for name in [".nvmrc", "package.json", "apps/web/BUILD.bazel", "pnpm-lock.yaml", "tools/bazel/project-ui.cjs", "scripts/prove-next-invalidation.py", "scripts/next-proof-trigger.py"]:
            with self.subTest(name=name):
                self.assertTrue(trigger.needs_proof("push", event, lambda *_: [name]))

    def test_manual_and_scheduled_runs(self):
        for event in ["schedule", "workflow_dispatch"]:
            self.assertTrue(trigger.needs_proof(event, {}, None))

    def test_missing_history_runs_proof(self):
        def unavailable(*_):
            raise subprocess.CalledProcessError(128, "git diff")
        self.assertTrue(trigger.needs_proof("push", {"before": "old", "after": "new"}, unavailable))
        self.assertTrue(trigger.needs_proof("push", {"before": "0" * 40, "after": "new"}, None))


if __name__ == "__main__":
    unittest.main()
