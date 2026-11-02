#!/usr/bin/env python3
"""Report which Next builds and checks ran and which came from cache.

Reads Bazel JSON execution logs and appends a table to the GitHub step summary.
"""
import json
import os
from pathlib import Path
import sys

KINDS = {"NextBuild": "Next build", "TestRunner": "Check"}


def spawns(path):
    text = Path(path).read_text().strip()
    decoder = json.JSONDecoder()
    while text:
        spawn, end = decoder.raw_decode(text)
        yield spawn
        text = text[end:].lstrip()


def summarize(entries):
    ran, cached = {}, {}
    for spawn in entries:
        kind = KINDS.get(spawn.get("mnemonic"))
        if not kind:
            continue
        label = spawn.get("targetLabel", "").replace("@@//", "//").lstrip("@")
        (cached if spawn.get("cacheHit") else ran)[label] = kind
    # A test also spawns a step that writes test.xml. Any executed spawn counts.
    return ran, {label: kind for label, kind in cached.items() if label not in ran}


def report(ran, cached):
    lines = ["### What this commit ran", "", "| Target | Kind | Result |", "| --- | --- | --- |"]
    lines += [f"| `{label}` | {kind} | ran |" for label, kind in sorted(ran.items())]
    lines += [f"| `{label}` | {kind} | reused from cache |" for label, kind in sorted(cached.items())]
    if not ran and not cached:
        lines.append("| everything | | up to date |")
    return "\n".join(lines) + "\n"


def notice(ran, cached, cache=""):
    """A GitHub annotation, readable on the run page and through the public API without logs."""
    total = len(ran) + len(cached)
    if ran:
        text = f"Ran {len(ran)} of {total} Next builds and checks: {', '.join(sorted(ran))}."
    else:
        text = f"Ran 0 of {total} Next builds and checks."
    text += f" {len(cached)} came from cache."
    if cache:
        text += f" Shared Bazel cache: {cache}."
    return "::notice title=What this commit ran::" + text


def main():
    entries = [spawn for path in sys.argv[1:] if Path(path).exists() for spawn in spawns(path)]
    ran, cached = summarize(entries)
    text = report(ran, cached)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(text)
    print(text)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(notice(ran, cached, os.environ.get("BAZEL_REMOTE_CACHE", "")))


if __name__ == "__main__":
    main()
