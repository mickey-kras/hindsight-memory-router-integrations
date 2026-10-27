"""Exercise release policy against meaningful workflow and source mutations."""

import base64
import hashlib
import json
import os
import shlex
import sys
import tempfile
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path.cwd()
GUARD = ROOT / ".github/workflows/policy-guard.yml"
ROUTER = (ROOT / ".github/workflows/publish.yml").exists()
MAIN = ".github/workflows/publish.yml" if ROUTER else ".github/workflows/main.yml"
# Accept both the old absolute SHA-pinned form and the relative same-repo form.
_main_text = (ROOT / MAIN).read_text()
ACTIVE = "trusted-ci.yml@" in _main_text or "./.github/workflows/trusted-ci.yml" in _main_text
CI = ".github/workflows/trusted-ci.yml" if ACTIVE else ".github/workflows/ci.yml"
BUILD = "build" if ACTIVE else "checks"
SECURITY = "security" if ACTIVE else "checks"
PATHS = [
    ".github/dependency-review-config.yml",
    ".github/workflows/policy-guard.yml",
    MAIN,
    ".github/workflows/release.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/pr-validation.yml",
    ".github/workflows/docs-ste.yml",
    ".github/scripts/docs-ste.test.py",
    ".ste.yml",
    ".vale.ini",
    ".vale/styles/config/vocabularies/Project/accept.txt",
    ".github/workflows/branch-policy.yml",
    ".github/workflows/aislop.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/pr-branch-updater.yml",
    ".github/scripts/package.json",
    ".github/scripts/package-lock.json",
    ".github/scripts/combination.cjs",
    ".github/scripts/combination-identity.cjs",
    ".github/scripts/combination-smoke.sh",
    ".github/scripts/combination-smoke.mjs",
    ".github/scripts/combination.test.cjs",
    ".github/scripts/release.test.cjs",
    ".github/scripts/release-policy.test.py",
    ".github/scripts/release.cjs",
    ".github/scripts/coverage-artifact.cjs",
    ".github/scripts/coverage-artifact.test.cjs",
    ".github/scripts/release-follow-up.cjs",
    ".github/scripts/release-settings.cjs",
    ".github/rulesets/protect-release-branches.json",
]
if ROUTER:
    PATHS.append(".github/scripts/publish-image.sh")
else:
    PATHS.append(".github/scripts/release-cleanup.cjs")
    PATHS.append(".github/scripts/release-cleanup.test.cjs")


PATHS.extend(str(path.relative_to(ROOT)) for path in (ROOT / ".github/workflows").glob("trusted-*.yml"))
