#!/usr/bin/env python3
"""Merge pinned upstream trees with reviewed adaptations using Git's three-way merge."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import TypedDict

ROOT = Path(__file__).resolve().parents[1]
CODING = Path("src/upstream/coding-agents")
PROVENANCE = Path("integrations/coding-agents/UPSTREAM.json")


def git(repo: Path, *args: str, input_data: bytes | None = None) -> bytes:
    # Repository selection and pinned objects must not depend on the caller's Git environment.
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_ATTR_NOSYSTEM="1", GIT_NO_REPLACE_OBJECTS="1")
    return subprocess.check_output(
        ["git", "--no-lazy-fetch", "-C", str(repo), "-c", "core.autocrlf=false",
         "-c", f"core.attributesFile={os.devnull}", *args], input=input_data, env=environment
    )


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def snapshot(repo, commit, path):
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Use an exact 40-character upstream commit SHA")
    # Read immutable blobs directly: archive honors local/global export-ignore,
    # export-subst and EOL attributes that are not part of the pinned commit.
    entries = git(repo, "ls-tree", "-rz", f"{commit}:{path}")
    files = {}
    for entry in entries.split(b"\0"):
        if not entry:
            continue
        metadata, raw_name = entry.split(b"\t", 1)
        mode, kind, sha = metadata.decode("ascii").split()
        name = raw_name.decode("utf-8")
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise ValueError(f"Unsupported upstream file type: {name}")
        if ".." in Path(name).parts:
            raise ValueError(f"Invalid upstream path: {name}")
        files[name] = git(repo, "cat-file", "blob", sha)
    if not files:
        raise ValueError(f"Empty upstream integration: {path}")
    return dict(sorted(files.items()))


def merge(name, base, local, incoming):
    if local == base:
        return incoming
    if incoming == base or local == incoming:
        return local
    if None in (base, local, incoming):
        raise ValueError(f"Upstream add/delete conflict: {name}; reconcile explicitly")
    with tempfile.TemporaryDirectory(prefix="integration-merge-") as directory:
        paths = [Path(directory) / label for label in ("local", "base", "upstream")]
        for path, data in zip(paths, (local, base, incoming)):
            path.write_bytes(data)
        result = subprocess.run(
            ["git", "merge-file", "-p", *map(str, paths)], capture_output=True, check=False
        )
    if result.returncode:
        raise ValueError(f"Upstream content conflict: {name}; reconcile explicitly")
    return result.stdout


def local_coding(upstream):
    changes = json.loads((ROOT / "integrations/coding-agents/LOCAL_CHANGES.json").read_text())
    return {
        name: (ROOT / CODING / name).read_bytes()
        for name, value in (upstream["files"] | changes).items()
        if value is not None
    }


def coding_patch(base: dict[str, bytes], local: dict[str, bytes]) -> bytes:
    with tempfile.TemporaryDirectory(prefix="integration-patch-") as directory:
        root = Path(directory)
        git(root, "init", "-q", "--object-format=sha1")
        for files in (base, local):
            git(root, "read-tree", "--empty")
            entries = []
            for name, data in sorted(files.items()):
                # Raw objects bypass tracked clean/EOL filters; accepted bytes are the artifact's input.
                sha = git(root, "hash-object", "-w", "--no-filters", "--stdin", input_data=data).strip()
                entries.append(b"100644 blob " + sha + b"\t" + name.encode("utf-8") + b"\0")
            git(root, "update-index", "-z", "--index-info", input_data=b"".join(entries))
            if files is base:
                tree = git(root, "write-tree").decode().strip()
        return git(
            root, "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv",
            "--find-renames=50%", "-l1000", "--no-color", "--abbrev=7", "--unified=1",
            "--diff-algorithm=myers", "--indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/", tree
        )


class CodingManifest(TypedDict):
    commit: str
    files: dict[str, str]
    path: str
    source: str
    version: str


def verify_provenance(repo: Path, coding: CodingManifest) -> tuple[dict[str, bytes], dict[str, str], dict[str, bytes]]:
    packaged = json.loads((ROOT / CODING / "UPSTREAM.json").read_text())
    if packaged != coding:
        raise ValueError("Packaged and canonical coding upstream manifests differ")
    base = snapshot(repo, coding["commit"], coding["path"])
    if {name: digest(data) for name, data in base.items()} != coding["files"]:
        raise ValueError("Coding upstream hashes do not match the pinned commit")
    if json.loads(base["package.json"])["version"] != coding["version"]:
        raise ValueError("Coding upstream version does not match the pinned commit")
    fields = dict(line.split("=", 1) for line in (ROOT / "UPSTREAM_VERSION").read_text().splitlines())
    if coding["source"] != f"https://github.com/{fields['upstream_repo']}":
        raise ValueError("Upstream source repositories differ")
    old_openclaw = snapshot(repo, fields["upstream_commit"], fields["upstream_path"])
    expected = "".join(f"{digest(data)}  ./{name}\n" for name, data in old_openclaw.items()).encode()
    if expected != (ROOT / "src/upstream/SHA256SUMS").read_bytes():
        raise ValueError("OpenClaw upstream hashes do not match the pinned commit")
    if json.loads(old_openclaw["package.json"])["version"] != fields["upstream_version"]:
        raise ValueError("OpenClaw upstream version does not match the pinned commit")
    return base, fields, old_openclaw


def run(repo: Path, commit: str | None, patch_only: bool = False, check_only: bool = False) -> None:
    for script in ("verify-coding-upstream.mjs", "verify-openclaw-overlay.mjs"):
        subprocess.run(["node", str(ROOT / "scripts" / script)], check=True)
    coding = json.loads((ROOT / PROVENANCE).read_text())
    base, fields, old_openclaw = verify_provenance(repo, coding)
    local = local_coding(coding)
    patch = ROOT / "integrations/coding-agents/router.patch"
    if check_only:
        if patch.read_bytes() != coding_patch(base, local):
            raise ValueError("router.patch differs from the pinned upstream-to-local diff; review before --patch-only")
        print("Verified pinned upstream provenance and router.patch; no files changed")
        return
    if patch_only:
        patch.write_bytes(coding_patch(base, local))
        return
    incoming = snapshot(repo, commit, coding["path"])
    merged = {
        name: merge(name, base.get(name), local.get(name), incoming.get(name))
        for name in sorted(base.keys() | local.keys() | incoming.keys())
    }
    coding = coding | {
        "commit": commit,
        "version": json.loads(incoming["package.json"])["version"],
        "files": {name: digest(data) for name, data in incoming.items()},
    }
    merged["UPSTREAM.json"] = encoded(coding)
    plan = {CODING / name: data for name, data in merged.items()}
    plan[PROVENANCE] = encoded(coding)

    new_openclaw = snapshot(repo, commit, fields["upstream_path"])
    overlay = json.loads((ROOT / "integrations/openclaw/LOCAL_CHANGES.json").read_text())
    pristine = json.loads((ROOT / "integrations/openclaw/VENDORED_PRISTINE_FILES.json").read_text())
    for name in sorted(set(overlay) | set(pristine)):
        if name not in new_openclaw:
            raise ValueError(f"Imported OpenClaw file removed upstream: {name}")
        path = Path("src/upstream") / name
        plan[path] = merge(name, old_openclaw[name], (ROOT / path).read_bytes(), new_openclaw[name])
    fields.update(upstream_ref=commit, upstream_commit=commit,
                  upstream_version=json.loads(new_openclaw["package.json"])["version"])
    plan[Path("UPSTREAM_VERSION")] = "".join(f"{key}={value}\n" for key, value in fields.items()).encode()
    plan[Path("src/upstream/SHA256SUMS")] = "".join(
        f"{digest(data)}  ./{name}\n" for name, data in new_openclaw.items()
    ).encode()
    # No source or manifest is written until all three-way merges have succeeded.
    for relative, data in plan.items():
        path = ROOT / relative
        if data is None:
            path.unlink(missing_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    print(f"Updated both integrations to {commit}. Review git diff before accepting provenance.")
    print("Run npm run upstream:accept, then regenerate router.patch with --patch-only.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path, help="Local vectorize-io/hindsight Git checkout")
    parser.add_argument("commit", nargs="?", help="Exact upstream commit; required for an upgrade")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--patch-only", action="store_true", help="Refresh the reviewed coding-agent patch")
    mode.add_argument("--check", action="store_true", help="Verify pinned provenance and patch without writing files")
    args = parser.parse_args()
    if not args.patch_only and not args.check and args.commit is None:
        parser.error("commit is required")
    try:
        if args.commit is not None and (args.patch_only or args.check):
            parser.error("commit is only accepted for an upgrade")
        run(args.checkout.resolve(), args.commit, args.patch_only, args.check)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")
