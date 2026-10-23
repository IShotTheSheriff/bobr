import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("summary", Path(__file__).with_name("ci-summary.py"))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class CiSummaryTest(unittest.TestCase):
    def test_separates_executed_and_cached_work(self):
        ran, cached = summary.summarize([
            {"mnemonic": "NextBuild", "targetLabel": "@@//apps/docs:next_build", "cacheHit": False},
            {"mnemonic": "NextBuild", "targetLabel": "@@//apps/web:next_build", "cacheHit": True},
            {"mnemonic": "TestRunner", "targetLabel": "//packages/web-e2e:test", "cacheHit": True},
            {"mnemonic": "UiProjection", "targetLabel": "//apps/web:ui_projection", "cacheHit": False},
        ])
        self.assertEqual(ran, {"//apps/docs:next_build": "Next build"})
        self.assertEqual(cached, {"//apps/web:next_build": "Next build", "//packages/web-e2e:test": "Check"})

    def test_a_test_with_any_executed_spawn_ran(self):
        ran, cached = summary.summarize([
            {"mnemonic": "TestRunner", "targetLabel": "//apps/web:lint", "cacheHit": True},
            {"mnemonic": "TestRunner", "targetLabel": "//apps/web:lint", "cacheHit": False},
        ])
        self.assertEqual(ran, {"//apps/web:lint": "Check"})
        self.assertEqual(cached, {})


if __name__ == "__main__":
    unittest.main()
