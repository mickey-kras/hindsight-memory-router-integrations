#!/usr/bin/env python3
"""Mirror CI helpers that the router repository owns, at a pinned router commit.

    python3 scripts/sync-router-ci.py <40-hex router commit>   update the pin and the files
    python3 scripts/sync-router-ci.py --check                   compare the files with the pin
    python3 scripts/sync-router-ci.py --check --upstream        also compare with the router commit
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / "compat/router-ci.json"
COMMIT = re.compile(r"[0-9a-f]{40}")


def upstream(repository: str, commit: str, path: str) -> bytes:
    url = f"https://raw.githubusercontent.com/{repository}/{commit}/{path}"
    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - fixed HTTPS host
        return response.read()


def check(pin: dict[str, object], *, compare_upstream: bool) -> list[str]:
    errors = []
    repository, commit, files = str(pin["repository"]), str(pin["commit"]), pin["files"]
    if not COMMIT.fullmatch(commit) or not isinstance(files, dict):
        return ["compat/router-ci.json: commit must be a full SHA and files must be a mapping"]
    for path, expected in files.items():
        local = (ROOT / path).read_bytes()
        if hashlib.sha256(local).hexdigest() != expected:
            errors.append(f"{path}: differs from the SHA-256 in compat/router-ci.json")
        elif compare_upstream and upstream(repository, commit, path) != local:
            errors.append(f"{path}: differs from {repository}@{commit}")
    return errors


def main(arguments: list[str]) -> int:
    pin = json.loads(PIN.read_text(encoding="utf-8"))
    if arguments and arguments[0] == "--check" and set(arguments[1:]) <= {"--upstream"}:
        errors = check(pin, compare_upstream="--upstream" in arguments)
        for error in errors:
            print(error, file=sys.stderr)
        return 1 if errors else 0
    if len(arguments) != 1 or not COMMIT.fullmatch(arguments[0]):
        print(__doc__, file=sys.stderr)
        return 2
    pin["commit"] = arguments[0]
    for path in pin["files"]:
        content = upstream(str(pin["repository"]), arguments[0], path)
        (ROOT / path).write_bytes(content)
        pin["files"][path] = hashlib.sha256(content).hexdigest()
    PIN.write_text(json.dumps(pin, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
