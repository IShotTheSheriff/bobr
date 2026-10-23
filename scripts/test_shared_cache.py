import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("verify", Path(__file__).with_name("verify-shared-cache.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class SharedCacheTest(unittest.TestCase):
    def actions(self):
        return [{"mnemonic": mnemonic, "targetLabel": target, "cacheHit": True}
                for mnemonic, targets in {
                    "NextBuild": ["//apps/web:next_build", "//apps/docs:next_build"],
                    "TestRunner": ["//packages/web-e2e:test", "//packages/docs-e2e:test"],
                }.items() for target in targets]

    def test_requires_all_build_and_browser_hits(self):
        verify.require_hits(self.actions())
        for index in range(4):
            actions = self.actions()
            actions[index]["cacheHit"] = False
            with self.assertRaises(AssertionError):
                verify.require_hits(actions)
            with self.assertRaises(AssertionError):
                verify.require_hits(self.actions()[:index] + self.actions()[index + 1:])


if __name__ == "__main__":
    unittest.main()
