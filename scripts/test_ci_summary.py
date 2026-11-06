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
            {"mnemonic": "Projection", "targetLabel": "//apps/web:projection", "cacheHit": False},
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

    def test_notice_names_what_ran_and_the_shared_cache(self):
        line = summary.notice({"//apps/docs:next_build": "Next build"}, {"//apps/web:next_build": "Next build"}, "vercel")
        self.assertEqual(line, "::notice title=What this commit ran::Ran 1 of 2 Next builds and checks: "
                               "//apps/docs:next_build. 1 came from cache. Shared Bazel cache: vercel.")

    def test_notice_for_a_run_that_reused_everything(self):
        line = summary.notice({}, {"//apps/web:lint": "Check", "//apps/web:typecheck": "Check"})
        self.assertEqual(line, "::notice title=What this commit ran::Ran 0 of 2 Next builds and checks. 2 came from cache.")


    def test_projection_report_lists_counts_and_fallbacks(self):
        text = summary.projection_report([{
            "app": "apps/web",
            "mode": "runtime",
            "packages": {"@repo/ui": {"files": 3, "whole": 1, "sliced": 2}},
            "fallbacks": [{"file": "packages/ui/src/load.ts", "pattern": "import(name)", "width": "package", "included": ["packages/ui"]}],
            "unresolved": [{"file": "apps/web/app/page.tsx", "specifier": "@repo/ui/missing"}],
        }])
        self.assertEqual(text, "\n".join([
            "### Projection",
            "",
            "| App | Mode | Package | Files | Whole | Sliced |",
            "| --- | --- | --- | --- | --- | --- |",
            "| `apps/web` | runtime | `@repo/ui` | 3 | 1 | 2 |",
            "",
            "Fallbacks and unresolved imports:",
            "",
            "- `apps/web` runtime: `packages/ui/src/load.ts` has `import(name)`, so `packages/ui` stays whole (package).",
            "- `apps/web` runtime: `apps/web/app/page.tsx` imports `@repo/ui/missing`, which does not resolve.",
        ]) + "\n")

    def test_no_reports_add_nothing(self):
        self.assertEqual(summary.projection_report([]), "")


if __name__ == "__main__":
    unittest.main()
