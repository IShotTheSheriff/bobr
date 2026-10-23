#!/usr/bin/env python3
"""Run Bazel with optional shared-cache credentials kept out of command arguments."""
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile


def cache_options(env):
    endpoint = env.get("BAZEL_REMOTE_CACHE", "")
    if not endpoint:
        return []
    if not endpoint.startswith(("https://", "grpcs://", "http://127.0.0.1:")):
        raise ValueError("BAZEL_REMOTE_CACHE must use HTTPS or gRPC TLS")
    options = [f"--remote_cache={endpoint}", "--remote_timeout=60"]
    if endpoint.startswith("grpcs://"):
        options.append("--remote_cache_compression")
    if env.get("BAZEL_REMOTE_UPLOAD") != "1":
        options.append("--noremote_upload_local_results")
    header = env.get("BAZEL_REMOTE_HEADER")
    if header:
        options.append(f"--remote_header={header}")
    if any("\n" in option or "\r" in option for option in options):
        raise ValueError("Cache settings must each fit on one line")
    return options


def main():
    with tempfile.TemporaryDirectory(prefix="bobr-bazel-") as directory:
        rc = Path(directory) / "remote.bazelrc"
        rc.touch(mode=0o600)
        rc.write_text("".join("build " + shlex.quote(option) + "\n" for option in cache_options(os.environ)))
        command = [os.environ.get("BAZEL_BIN", "bazel")]
        if os.environ.get("BAZEL_OUTPUT_USER_ROOT"):
            command.append("--output_user_root=" + os.environ["BAZEL_OUTPUT_USER_ROOT"])
        if os.environ.get("BAZEL_OUTPUT_BASE"):
            command.append("--output_base=" + os.environ["BAZEL_OUTPUT_BASE"])
        # An explicit user rc replaces ~/.bazelrc; workspace .bazelrc still loads.
        command += ["--bazelrc=" + str(rc)] + sys.argv[1:]
        return subprocess.call(command)


if __name__ == "__main__":
    sys.exit(main())
