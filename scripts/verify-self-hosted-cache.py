#!/usr/bin/env python3
"""Run the actual cache and proxy in a disposable Docker Compose project."""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bazel", action="store_true", help="Also prove fresh-client Next build and browser-test reuse")
    parser.add_argument("--directory", help="Bazel proof output directory")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="bobr-cache-server-") as directory:
        server = Path(directory)
        for name in ["compose.yml", "Caddyfile", "configure.py"]:
            shutil.copyfile(ROOT / "infra/bazel-cache" / name, server / name)
        subprocess.run([sys.executable, str(server / "configure.py"), "cache.example.test", "--size-gib", "5"], check=True)
        (server / "test.yml").write_text('services:\n  caddy:\n    ports: !override\n      - "127.0.0.1::80"\n')
        env = {**os.environ, "CACHE_DOMAIN": "http://:80"}
        compose = ["docker", "compose", "-p", "bobr-test-" + secrets.token_hex(4), "-f", str(server / "compose.yml"), "-f", str(server / "test.yml")]

        def run(*command, **kwargs):
            return subprocess.run([*compose, *command], cwd=server, env=env, check=True, **kwargs)

        try:
            run("up", "-d")
            address = run("port", "caddy", "80", capture_output=True, text=True).stdout.strip()
            endpoint = "http://" + address
            for attempt in range(30):
                try:
                    urlopen(endpoint + "/status", timeout=2).close()
                except HTTPError as error:
                    if error.code == 401:
                        break
                except (URLError, TimeoutError):
                    pass
                time.sleep(1)
            else:
                raise RuntimeError("Cache proxy did not become ready")
            client = {**os.environ, "BAZEL_REMOTE_CACHE": endpoint,
                      "BAZEL_REMOTE_READ_HEADER": (server / ".secrets/reader.header").read_text().strip(),
                      "BAZEL_REMOTE_WRITE_HEADER": (server / ".secrets/writer.header").read_text().strip()}
            subprocess.run([sys.executable, str(ROOT / "scripts/verify-cache-access.py")], env=client, check=True)
            if args.bazel:
                subprocess.run([sys.executable, str(ROOT / "scripts/verify-shared-cache.py"),
                                *(["--directory", args.directory] if args.directory else [])], env=client, check=True)
        finally:
            run("down", "--volumes")


if __name__ == "__main__":
    main()
