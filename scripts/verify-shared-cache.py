#!/usr/bin/env python3
"""Verify a configured cache with independent clients and no local disk cache."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
APPS = {"web", "docs"}


def recorded_actions(file):
    remaining = file.read_text().strip()
    decoder = json.JSONDecoder()
    while remaining:
        action, end = decoder.raw_decode(remaining)
        yield action
        remaining = remaining[end:].lstrip()


def require_hits(actions):
    for mnemonic, targets in {
        "NextBuild": {f"//apps/{app}:next_build" for app in APPS},
        "TestRunner": {f"//packages/{app}-e2e:test" for app in APPS},
    }.items():
        selected = [a for a in actions if a.get("mnemonic") == mnemonic]
        if {a["targetLabel"] for a in selected} != targets or not all(a.get("cacheHit") for a in selected):
            raise AssertionError(f"Expected remote cache hits for every {mnemonic} action")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory")
    args = parser.parse_args()
    for name in ["BAZEL_REMOTE_CACHE", "BAZEL_REMOTE_WRITE_HEADER", "BAZEL_REMOTE_READ_HEADER"]:
        if not os.environ.get(name):
            raise ValueError(f"Missing {name}")
    base = Path(args.directory).resolve() if args.directory else Path(tempfile.mkdtemp(prefix="bobr-shared-cache-"))
    checkout = base / "source"
    checkout.mkdir(parents=True, exist_ok=False)
    files = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=ROOT).decode().split("\0")
    for name in set(files):
        source = ROOT / name
        if name and source.is_file():
            destination = checkout / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
    results = []
    for client in ["producer", "consumer", "next-commit"]:
        if client == "next-commit":
            # A real source edit changes projection inputs, but neither app uses it.
            with (checkout / "packages/ui/src/utils/index.ts").open("a") as file:
                file.write("\nexport const unusedCacheAcceptanceExport = () => 987654321;\n")
        writer = client == "producer"
        env = {**os.environ, "BAZEL_OUTPUT_BASE": str(base / client),
               "BAZEL_REMOTE_HEADER": os.environ["BAZEL_REMOTE_WRITE_HEADER" if writer else "BAZEL_REMOTE_READ_HEADER"],
               "BAZEL_REMOTE_UPLOAD": "1" if writer else "0"}
        # Consumers do not inherit the writer credential, even outside Bazel actions.
        env.pop("BAZEL_REMOTE_WRITE_HEADER", None)
        env.pop("BAZEL_REMOTE_READ_HEADER", None)
        logfile = base / f"{client}.log"
        execution = base / f"{client}.actions.json"
        with logfile.open("w") as output:
            try:
                subprocess.run([sys.executable, "scripts/bazel.py", "test",
                                "//apps/web:next_build", "//apps/docs:next_build",
                                "//packages/web-e2e:test", "//packages/docs-e2e:test",
                                "--define=deploy_env=preview", "--disk_cache=", "--lockfile_mode=off",
                                f"--repository_cache={base / 'downloads'}", f"--symlink_prefix={base / 'links'}/",
                                f"--execution_log_json_file={execution}", "--color=no"],
                               cwd=checkout, env=env, stdout=output, stderr=subprocess.STDOUT, check=True)
            except subprocess.CalledProcessError:
                print(f"Build failed. Inspect {logfile}", file=sys.stderr)
                raise
            finally:
                subprocess.run([sys.executable, "scripts/bazel.py", "shutdown"], cwd=checkout,
                               env=env, stdout=output, stderr=subprocess.STDOUT, timeout=60)
        actions = list(recorded_actions(execution))
        if not writer:
            require_hits(actions)
        artifacts = {app: hashlib.sha256((base / f"links/bin/apps/{app}/vercel_output.tar").read_bytes()).hexdigest() for app in APPS}
        if results and artifacts != results[0]["artifacts"]:
            raise AssertionError("Restored deployment archives differ from the producer")
        results.append({"client": client, "artifacts": artifacts, "remote_reuse_verified": not writer})
        (base / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(f"PASS {client}", flush=True)
    print(f"Evidence: {base / 'results.json'}")


if __name__ == "__main__":
    main()
