#!/usr/bin/env python3
"""Generate cache credentials without printing passwords or passing them in argv."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import subprocess

ROOT = Path(__file__).resolve().parent


def write_private(path, content):
    with open(path, "x", opener=lambda name, flags: os.open(name, flags, 0o600)) as file:
        file.write(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("domain", help="Public DNS name, without a scheme or path")
    parser.add_argument("--size-gib", type=int, default=50)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", args.domain) or "." not in args.domain:
        parser.error("Use a DNS name such as cache.example.com")
    if args.size_gib < 1:
        parser.error("--size-gib must be positive")
    if (ROOT / ".env").exists() or (ROOT / ".secrets").exists():
        parser.error("Configuration exists. Follow README.md to rotate credentials.")

    # Resolve the pinned image from Compose so upgrades have one source of truth.
    env = {**os.environ, "CACHE_DOMAIN": args.domain}
    config = subprocess.check_output(
        ["docker", "compose", "config", "--format", "json"], cwd=ROOT, env=env, text=True
    )
    image = json.loads(config)["services"]["caddy"]["image"]
    credentials = []
    for user in ["reader", "writer"]:
        password = secrets.token_urlsafe(32)
        hashed = subprocess.run(
            ["docker", "run", "--rm", "-i", image, "caddy", "hash-password"],
            input=password + "\n", text=True, capture_output=True, check=True
        ).stdout.strip()
        if not hashed.startswith("$2"):
            raise RuntimeError("Caddy did not return a bcrypt password hash")
        header = "Authorization=Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        credentials.append((user, hashed, header))

    (ROOT / ".secrets").mkdir(mode=0o700)
    write_private(ROOT / ".secrets/cache-users", "".join(f"{user} {hashed}\n" for user, hashed, _ in credentials))
    for user, _, header in credentials:
        write_private(ROOT / f".secrets/{user}.header", header + "\n")
    write_private(ROOT / ".env", f"CACHE_DOMAIN={args.domain}\nCACHE_SIZE_GIB={args.size_gib}\n")
    print("Created .env and .secrets/ in infra/bazel-cache. No credentials were printed.")
    print("Start the cache with docker compose up -d from that directory.")


if __name__ == "__main__":
    main()
