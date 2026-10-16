"""Exercise provenance and patch verification against independent temporary Git commits."""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("sync_upstream", Path(__file__).with_name("sync-upstream.py"))
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)
SCRIPTS = Path(__file__).parent


class GitInvocationTests(unittest.TestCase):
    def test_git_disables_lazy_fetch_despite_caller_environment(self) -> None:
        with patch.dict("os.environ", {"GIT_NO_LAZY_FETCH": "0"}), \
                patch.object(sync.subprocess, "check_output", return_value=b"blob") as execute:
            self.assertEqual(sync.git(Path("upstream"), "cat-file", "blob", "object"), b"blob")
        command = execute.call_args.args[0]
        self.assertEqual(command[:2], ["git", "--no-lazy-fetch"])
        self.assertNotIn("GIT_NO_LAZY_FETCH", execute.call_args.kwargs["env"])


class UpstreamVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "downstream"
        self.repo = Path(self.directory.name) / "upstream"
        self.root.mkdir()
        self.repo.mkdir()
        self.root_patch = patch.object(sync, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        shutil.copytree(SCRIPTS, self.root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        self.base = {"package.json": b'{"version":"1.0.0"}\n', "changed.txt": b"before\n",
                     "deleted.txt": b"remove\n", "binary.bin": b"\0old"}
        self.openclaw = {"package.json": b'{"version":"2.0.0"}\n', "src/types.ts": b"upstream\n"}
        sync.git(self.repo, "init", "-q")
        for prefix, files in (("coding", self.base), ("openclaw", self.openclaw)):
            for name, data in files.items():
                self.write(self.repo / prefix / name, data)
        sync.git(self.repo, "add", "--all")
        sync.git(self.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "pristine snapshot")
        self.commit = sync.git(self.repo, "rev-parse", "HEAD").decode().strip()
        self.manifest = {"commit": self.commit, "path": "coding", "source": "https://github.com/fixture/upstream",
                         "version": "1.0.0", "files": {name: sync.digest(data) for name, data in self.base.items()}}
        self.write(self.root / sync.PROVENANCE, sync.encoded(self.manifest))
        local = self.base | {"changed.txt": b"after\n", "added.txt": b"new\n", "binary.bin": b"\0new",
                             "UPSTREAM.json": sync.encoded(self.manifest)}
        del local["deleted.txt"]
        for name, data in local.items():
            self.write(self.root / sync.CODING / name, data)
        self.write(self.root / "UPSTREAM_VERSION", (
            f"upstream_repo=fixture/upstream\nupstream_ref={self.commit}\nupstream_commit={self.commit}\n"
            "upstream_path=openclaw\nupstream_version=2.0.0\n"
        ).encode())
        self.write(self.root / "src/upstream/SHA256SUMS", "".join(
            f"{sync.digest(data)}  ./{name}\n" for name, data in sorted(self.openclaw.items())
        ).encode())
        self.write(self.root / "src/upstream/src/types.ts", b"adapted\n")
        self.write(self.root / "integrations/openclaw/LOCAL_CHANGES.json",
                   sync.encoded({"src/types.ts": sync.digest(b"adapted\n")}))
        self.write(self.root / "integrations/openclaw/VENDORED_PRISTINE_FILES.json", b"[]\n")
        self.accept()
        sync.run(self.repo, None, patch_only=True)

    @staticmethod
    def write(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def accept(self) -> None:
        subprocess.run(["node", str(self.root / "scripts/regen-coding-local-changes.mjs")], check=True,
                       capture_output=True)

    def files(self) -> dict[str, bytes]:
        return {str(path.relative_to(self.root)): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()}

    def test_check_reconstructs_changes_additions_deletions_and_binary_without_writes(self) -> None:
        before = self.files()
        sync.run(self.repo, None, check_only=True)
        self.assertEqual(before, self.files())
        artifact = before["integrations/coding-agents/router.patch"]
        for expected in (b"-before\n+after", b"new file mode", b"deleted file mode", b"GIT binary patch"):
            self.assertIn(expected, artifact)

    def test_deterministic_under_user_git_config(self) -> None:
        config = Path(self.directory.name) / "gitconfig"
        config.write_text("[core]\n autocrlf = true\n[diff]\n noprefix = true\n renames = copies\n algorithm = histogram\n")
        before = self.files()
        with patch.dict("os.environ", {"GIT_CONFIG_GLOBAL": str(config), "GIT_DEFAULT_HASH": "sha256"}):
            sync.run(self.repo, None, check_only=True)
            sync.run(self.repo, None, patch_only=True)
        self.assertEqual(before, self.files())

    def test_snapshot_ignores_global_and_checkout_export_attributes(self) -> None:
        attributes = Path(self.directory.name) / "global-attributes"
        attributes.write_text("*.txt export-ignore\n")
        config = Path(self.directory.name) / "gitconfig"
        config.write_text(f"[core]\n attributesFile = {attributes}\n")
        self.write(self.repo / ".git/info/attributes", b"*.json export-ignore\n")
        before = self.files()
        with patch.dict("os.environ", {"GIT_CONFIG_GLOBAL": str(config)}):
            self.assertEqual(sync.snapshot(self.repo, self.commit, "coding"), self.base)
            sync.run(self.repo, None, check_only=True)
        self.assertEqual(before, self.files())

    def test_git_reads_use_the_selected_repository_and_original_objects(self) -> None:
        before = self.files()
        with patch.dict("os.environ", {"GIT_DIR": str(self.root / "unrelated.git"),
                                       "GIT_WORK_TREE": str(self.root), "GIT_NO_REPLACE_OBJECTS": "0"}):
            self.assertEqual(sync.snapshot(self.repo, self.commit, "coding"), self.base)
            sync.run(self.repo, None, check_only=True)
        self.assertEqual(before, self.files())
        with patch.object(sync.subprocess, "check_output", return_value=b"") as execute:
            sync.git(self.repo, "rev-parse", "HEAD")
        environment = execute.call_args.kwargs["env"]
        self.assertEqual(environment["GIT_NO_REPLACE_OBJECTS"], "1")
        self.assertNotIn("GIT_DIR", environment)
        self.assertNotIn("GIT_WORK_TREE", environment)

    def test_patch_preserves_line_ending_bytes_despite_tracked_attributes(self) -> None:
        base = {".gitattributes": b"*.txt text eol=lf\n", "sample.txt": b"same text\n"}
        local = base | {"sample.txt": b"same text\r\n"}
        artifact = sync.coding_patch(base, local)
        self.assertNotEqual(artifact, sync.coding_patch(base, base))
        self.assertEqual(artifact, sync.coding_patch(dict(reversed(list(base.items()))), local))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            for name, data in base.items():
                self.write(destination / name, data)
            subprocess.run(["git", "apply", "--binary"], cwd=destination, input=artifact, check=True)
            self.assertEqual((destination / "sample.txt").read_bytes(), local["sample.txt"])

    def test_unaccepted_source_mutation_is_rejected_without_writes(self) -> None:
        (self.root / sync.CODING / "changed.txt").write_bytes(b"unreviewed\n")
        before = self.files()
        with self.assertRaises(subprocess.CalledProcessError):
            sync.run(self.repo, None, check_only=True)
        self.assertEqual(before, self.files())

    def test_accepted_source_with_stale_patch_is_rejected(self) -> None:
        (self.root / sync.CODING / "changed.txt").write_bytes(b"reviewed next change\n")
        self.accept()
        before = self.files()
        with self.assertRaisesRegex(ValueError, "router.patch differs"):
            sync.run(self.repo, None, check_only=True)
        self.assertEqual(before, self.files())
        sync.run(self.repo, None, patch_only=True)
        sync.run(self.repo, None, check_only=True)

    def test_accepted_packaged_manifest_drift_is_rejected(self) -> None:
        self.write(self.root / sync.CODING / "UPSTREAM.json", sync.encoded(self.manifest | {"version": "0.0.0"}))
        self.accept()
        with self.assertRaises(subprocess.CalledProcessError):
            sync.run(self.repo, None, check_only=True)

    def test_changed_pin_with_self_consistent_manifests_requires_pristine_provenance(self) -> None:
        (self.repo / "coding/changed.txt").write_bytes(b"different upstream\n")
        sync.git(self.repo, "add", "--all")
        sync.git(self.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "new upstream")
        manifest = self.manifest | {"commit": sync.git(self.repo, "rev-parse", "HEAD").decode().strip()}
        for relative in (sync.PROVENANCE, sync.CODING / "UPSTREAM.json"):
            self.write(self.root / relative, sync.encoded(manifest))
        self.accept()
        with self.assertRaisesRegex(ValueError, "Coding upstream hashes"):
            sync.run(self.repo, None, check_only=True)

    def test_openclaw_provenance_is_checked_even_in_patch_only_mode(self) -> None:
        manifest = self.root / "src/upstream/SHA256SUMS"
        manifest.write_text(manifest.read_text().replace(sync.digest(b"upstream\n"), "0" * 64))
        before = self.files()
        with self.assertRaisesRegex(ValueError, "OpenClaw upstream hashes"):
            sync.run(self.repo, None, patch_only=True)
        self.assertEqual(before, self.files())

    def test_three_way_merge_preserves_local_changes_and_rejects_conflicts(self) -> None:
        self.assertEqual(sync.merge("file", b"old", b"adapted", b"old"), b"adapted")
        self.assertEqual(sync.merge("file", b"old", b"old", b"upstream"), b"upstream")
        with self.assertRaisesRegex(ValueError, "add/delete conflict"):
            sync.merge("file", b"old", None, b"upstream")
        with self.assertRaisesRegex(ValueError, "content conflict"):
            sync.merge("file", b"old\n", b"adapted\n", b"upstream\n")


if __name__ == "__main__":
    unittest.main()
