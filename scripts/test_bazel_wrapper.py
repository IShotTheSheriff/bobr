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
