#!/usr/bin/env python3
"""Merge pinned upstream trees with reviewed adaptations using Git's three-way merge."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CODING = Path("src/upstream/coding-agents")
PROVENANCE = Path("integrations/coding-agents/UPSTREAM.json")


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def snapshot(repo, commit, path):
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Use an exact 40-character upstream commit SHA")
    archive = git(repo, "archive", commit, path)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        for member in source:
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"Unsupported upstream file type: {member.name}")
            name = str(Path(member.name).relative_to(path))
            if ".." in Path(name).parts:
                raise ValueError(f"Invalid upstream path: {name}")
            files[name] = source.extractfile(member).read()
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


def coding_patch(base, local):
    with tempfile.TemporaryDirectory(prefix="integration-patch-") as directory:
        root = Path(directory)
        git(root, "init", "-q")
        for files in (base, local):
            for path in root.iterdir():
                if path.name == ".git":
                    continue
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            for name, data in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            git(root, "add", "--force", "--all")
            if files is base:
                tree = git(root, "write-tree").decode().strip()
        return git(root, "diff", "--cached", "--binary", "--no-ext-diff", tree)


def run(repo, commit, patch_only=False):
    for script in ("verify-coding-upstream.mjs", "verify-openclaw-overlay.mjs"):
        subprocess.run(["node", str(ROOT / "scripts" / script)], check=True)
    coding = json.loads((ROOT / PROVENANCE).read_text())
    base = snapshot(repo, coding["commit"], coding["path"])
    if {name: digest(data) for name, data in base.items()} != coding["files"]:
        raise ValueError("Coding upstream hashes do not match the pinned commit")
    local = local_coding(coding)
    if patch_only:
        (ROOT / "integrations/coding-agents/router.patch").write_bytes(coding_patch(base, local))
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

    fields = dict(line.split("=", 1) for line in (ROOT / "UPSTREAM_VERSION").read_text().splitlines())
    old_openclaw = snapshot(repo, fields["upstream_commit"], fields["upstream_path"])
    expected = "".join(f"{digest(data)}  ./{name}\n" for name, data in old_openclaw.items()).encode()
    if expected != (ROOT / "src/upstream/SHA256SUMS").read_bytes():
        raise ValueError("OpenClaw upstream hashes do not match the pinned commit")
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
    parser.add_argument("commit", nargs="?", help="Exact upstream commit; required unless --patch-only")
    parser.add_argument("--patch-only", action="store_true", help="Refresh the reviewed coding-agent patch")
    args = parser.parse_args()
    if not args.patch_only and args.commit is None:
        parser.error("commit is required")
    try:
        run(args.checkout.resolve(), args.commit, args.patch_only)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")
