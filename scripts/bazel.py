#!/usr/bin/env python3
"""Run Bazel with the shared cache configured and credentials kept out of command arguments."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
# The Vercel team whose Remote Cache stores this repository's Bazel results.
VERCEL_TEAM = "team_741BpS6ntDg8vt3g4Mb4VW3d"
# Vercel's Hobby plan allows 100 cache requests a minute. Next builds and test
# results are worth a round trip; every other step reruns locally in seconds.
REMOTE_STEPS_ONLY = "--modify_execution_info=^(?!(NextBuild|TestRunner)$).*$=+no-remote-cache"


def cache_options(env):
    endpoint = env.get("BAZEL_REMOTE_CACHE", "")
    if endpoint in ("", "off"):
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


def vercel_token(env, home):
    """Returns VERCEL_TOKEN, or the token from the Vercel CLI's login."""
    if env.get("VERCEL_TOKEN"):
        return env["VERCEL_TOKEN"]
    data = Path(env["XDG_DATA_HOME"]) if env.get("XDG_DATA_HOME") else home / ".local/share"
    for auth in (home / "Library/Application Support/com.vercel.cli/auth.json", data / "com.vercel.cli/auth.json"):
        try:
            token = json.loads(auth.read_text()).get("token")
        except (OSError, ValueError, AttributeError):
            continue
        if token:
            return token
    return None


def refresh_vercel_login(env):
    """Lets the Vercel CLI renew its short-lived login token before the build reads it."""
    cli = ROOT / "node_modules/.bin/vercel"
    if env.get("VERCEL_TOKEN") or not cli.exists():
        return
    try:
        subprocess.run([str(cli), "whoami"], env={**env, "VERCEL_TELEMETRY_DISABLED": "1"},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        pass


def uses_vercel(env, token):
    """Vercel's cache is the default for anyone logged into the Vercel CLI."""
    mode = env.get("BAZEL_REMOTE_CACHE", "")
    return mode == "vercel" or (mode == "" and token is not None)


def uploads_to_vercel(env):
    """Developers share results by default. CI uploads only from trusted pushes."""
    if "BAZEL_REMOTE_UPLOAD" in env:
        return env["BAZEL_REMOTE_UPLOAD"] == "1"
    return not env.get("BAZEL_CACHE_SIGNING_KEY")


def vercel_options(port, env):
    options = [f"--remote_cache=http://127.0.0.1:{port}", "--remote_timeout=120", REMOTE_STEPS_ONLY]
    if not uploads_to_vercel(env):
        options.append("--noremote_upload_local_results")
    return options


def start_vercel_cache(env, token):
    """Starts the localhost proxy to Vercel's Remote Cache and returns it with its port."""
    try:
        proxy = subprocess.Popen(
            ["node", str(ROOT / "tools/bazel/vercel-cache.cjs")],
            env={**env, "VERCEL_TOKEN": token, "BOBR_VERCEL_TEAM": env.get("BOBR_VERCEL_TEAM", VERCEL_TEAM),
                 "BAZEL_REMOTE_UPLOAD": "1" if uploads_to_vercel(env) else "0"},
            stdout=subprocess.PIPE, text=True)
    except OSError as error:
        print(f"Building without Vercel's cache: {error}", file=sys.stderr)
        return None, None
    port = proxy.stdout.readline().strip()
    if not port.isdigit():
        proxy.wait()
        print("Building without Vercel's cache.", file=sys.stderr)
        return None, None
    return proxy, port


def main():
    env = os.environ
    token = vercel_token(env, Path.home())
    if token and uses_vercel(env, token):
        refresh_vercel_login(env)
        token = vercel_token(env, Path.home())
    proxy = None
    with tempfile.TemporaryDirectory(prefix="bobr-bazel-") as directory:
        if uses_vercel(env, token):
            options = []
            if token:
                proxy, port = start_vercel_cache(env, token)
                if proxy:
                    options = vercel_options(port, env)
            else:
                print("BAZEL_REMOTE_CACHE=vercel needs VERCEL_TOKEN or `vercel login`.", file=sys.stderr)
        else:
            options = cache_options(env)
        rc = Path(directory) / "remote.bazelrc"
        rc.touch(mode=0o600)
        rc.write_text("".join("build " + shlex.quote(option) + "\n" for option in options))
        command = [env.get("BAZEL_BIN", "bazel")]
        if env.get("BAZEL_OUTPUT_USER_ROOT"):
            command.append("--output_user_root=" + env["BAZEL_OUTPUT_USER_ROOT"])
        if env.get("BAZEL_OUTPUT_BASE"):
            command.append("--output_base=" + env["BAZEL_OUTPUT_BASE"])
        # An explicit user rc replaces ~/.bazelrc; workspace .bazelrc still loads.
        command += ["--bazelrc=" + str(rc)] + sys.argv[1:]
        try:
            return subprocess.call(command)
        finally:
            if proxy:
                proxy.terminate()
                proxy.wait(timeout=30)


if __name__ == "__main__":
    sys.exit(main())
