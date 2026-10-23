#!/usr/bin/env python3
"""Decide whether this push needs the expensive Next invalidation experiment."""
import fnmatch
import json
import os
from pathlib import Path
import subprocess

PATTERNS = (
    ".github/workflows/*",
    "tools/bazel/*",
    "scripts/*next*proof*",
    "scripts/prove-next-invalidation.py",
    "scripts/http_cache_fixture.py",
    "scripts/bazel.py",
    "apps/*/vercel-build.json",
    "packages/*-e2e/*",
    "MODULE.bazel*",
    ".bazel*",
    ".nvmrc",
    "BUILD.bazel",
    "*/BUILD.bazel",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "*/package.json",
    "apps/*/next.config.*",
    "packages/typescript-config/*",
)


def needs_proof(event_name, event, changed_files):
    if event_name in {"schedule", "workflow_dispatch"}:
        return True
    # PR path filters compare the entire branch. Compare successive heads so
    # later application-only commits in a build-system PR can skip the proof.
    before = event.get("before")
    after = event.get("after")
    if event_name == "pull_request":
        pr = event["pull_request"]
        before = before or pr["base"]["sha"]
        after = pr["head"]["sha"]
    if not before or set(before) == {"0"} or not after:
        return True
    try:
        names = changed_files(before, after)
    except subprocess.CalledProcessError:
        # A force-pushed commit can be unavailable in the fetched history.
        return True
    return any(fnmatch.fnmatchcase(name, pattern) for name in names for pattern in PATTERNS)


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    def changed_files(before, after):
        return subprocess.check_output(
            ["git", "diff", "--name-only", "-z", before, after, "--"],
            text=True,
        ).split("\0")
    result = needs_proof(os.environ["GITHUB_EVENT_NAME"], event, changed_files)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"required={str(result).lower()}\n")
    print(f"Run Next invalidation proof: {result}")


if __name__ == "__main__":
    main()
