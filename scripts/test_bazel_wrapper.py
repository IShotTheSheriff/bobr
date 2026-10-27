import unittest
from bazel import cache_options


class CacheOptionsTest(unittest.TestCase):
    def test_disabled_without_endpoint(self):
        self.assertEqual(cache_options({}), [])

    def test_read_only_by_default(self):
        self.assertIn("--noremote_upload_local_results", cache_options({"BAZEL_REMOTE_CACHE": "https://cache.example"}))

    def test_explicit_writer(self):
        self.assertNotIn("--noremote_upload_local_results", cache_options({"BAZEL_REMOTE_CACHE": "grpcs://cache.example", "BAZEL_REMOTE_UPLOAD": "1"}))

    def test_reject_injected_rc_options(self):
        with self.assertRaises(ValueError):
            cache_options({"BAZEL_REMOTE_CACHE": "https://cache.example", "BAZEL_REMOTE_HEADER": "key=value\nbuild --remote_upload_local_results"})

    def test_reject_plaintext_remote(self):
        with self.assertRaises(ValueError):
            cache_options({"BAZEL_REMOTE_CACHE": "http://cache.example"})


class VercelCacheTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.home = Path(tempfile.mkdtemp())

    def login(self, token):
        import json
        auth = self.home / "Library/Application Support/com.vercel.cli/auth.json"
        auth.parent.mkdir(parents=True)
        auth.write_text(json.dumps({"token": token}))

    def test_token_from_environment_first(self):
        from bazel import vercel_token
        self.login("cli-token")
        self.assertEqual(vercel_token({"VERCEL_TOKEN": "env-token"}, self.home), "env-token")

    def test_token_from_vercel_cli_login(self):
        from bazel import vercel_token
        self.login("cli-token")
        self.assertEqual(vercel_token({}, self.home), "cli-token")

    def test_no_login_means_no_token(self):
        from bazel import vercel_token
        self.assertIsNone(vercel_token({}, self.home))

    def test_logged_in_developers_use_vercel_unless_opted_out(self):
        from bazel import uses_vercel
        self.assertTrue(uses_vercel({}, "token"))
        self.assertFalse(uses_vercel({}, None))
        self.assertFalse(uses_vercel({"BAZEL_REMOTE_CACHE": "off"}, "token"))
        self.assertFalse(uses_vercel({"BAZEL_REMOTE_CACHE": "https://cache.example"}, "token"))
        self.assertTrue(uses_vercel({"BAZEL_REMOTE_CACHE": "vercel"}, None))

    def test_developers_upload_and_ci_uploads_only_when_trusted(self):
        from bazel import vercel_options, REMOTE_STEPS_ONLY
        developer = vercel_options("4321", {})
        self.assertIn("--remote_cache=http://127.0.0.1:4321", developer)
        self.assertIn(REMOTE_STEPS_ONLY, developer)
        self.assertNotIn("--noremote_upload_local_results", developer)
        self.assertIn("--noremote_upload_local_results", vercel_options("1", {"BAZEL_CACHE_SIGNING_KEY": "key"}))
        self.assertIn("--noremote_upload_local_results", vercel_options("1", {"BAZEL_REMOTE_UPLOAD": "0"}))
        self.assertNotIn("--noremote_upload_local_results", vercel_options("1", {"BAZEL_CACHE_SIGNING_KEY": "key", "BAZEL_REMOTE_UPLOAD": "1"}))

    def test_off_disables_other_endpoints(self):
        self.assertEqual(cache_options({"BAZEL_REMOTE_CACHE": "off"}), [])
