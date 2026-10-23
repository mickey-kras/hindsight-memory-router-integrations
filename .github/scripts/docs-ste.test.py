"""Test documentation discovery, extraction, and the required PR gate."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


class DocumentationGateTests(unittest.TestCase):
    def workflow(self, name):
        return yaml.safe_load((ROOT / f".github/workflows/{name}.yml").read_text())

    def test_required_guard_rejects_every_unsuccessful_documentation_result(self):
        jobs = self.workflow("pr-validation")["jobs"]
        self.assertEqual(jobs["docs-ste"]["uses"], "./.github/workflows/docs-ste.yml")
        guard = jobs["guard"]
        self.assertEqual(guard["needs"], ["docs-ste"])
        self.assertEqual(guard["if"], "always()")
        step = next(step for step in guard["steps"] if step.get("name") == "Require documentation checks")
        self.assertEqual(step["env"]["DOCS_STE"], "${{ needs.docs-ste.result }}")
        self.assertNotIn("if", step)
        for result in ["success", "failure", "cancelled", "skipped", ""]:
            with self.subTest(result=result):
                completed = subprocess.run(
                    ["bash", "-euo", "pipefail", "-c", step["run"]],
                    env={**os.environ, "DOCS_STE": result}, capture_output=True,
                )
                self.assertEqual(completed.returncode == 0, result == "success")

    def test_both_jobs_discover_markdown_and_extract_openapi_prose(self):
        workflow = self.workflow("docs-ste")
        self.assertIn("github.event.pull_request.number || github.ref", workflow["concurrency"]["group"])
        jobs = workflow["jobs"]
        self.assertEqual(set(jobs), {"ste-cli", "vale"})
        for name, job in jobs.items():
            with self.subTest(job=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                subprocess.run(["git", "init", "-q", directory], check=True)
                paths = ["CONTRIBUTING.md", "new folder/Readme.MARKDOWN", ".hidden/Guide.MD",
                         "-guide.md", "same.md", "same.markdown"]
                for path in paths:
                    target = root / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(f"Prose from {path}.\n")
                legal = root / "LICENSE.md"
                legal.write_text("Exact legal text.\n")
                (root / "specs").mkdir()
                spec = root / "specs/new api.json"
                spec.write_text(json.dumps({"openapi": "3.1.0", "info": {
                    "title": "Title prose.", "description": "Description prose.",
                    "summary": "Summary prose.", "version": "IGNORE_VERSION"}}))
                (root / "package.json").write_text('{"description":"Not an API specification."}')
                subprocess.run(["git", "-C", directory, "add", "."], check=True)
                stage = root / "temp"
                step = next(step for step in job["steps"] if step.get("name") == "Prepare documentation")
                subprocess.run(["bash", "-euo", "pipefail", "-c", step["run"]], cwd=root,
                               env={**os.environ, "RUNNER_TEMP": str(stage)}, check=True)
                for path in paths:
                    self.assertEqual((stage / "docs-ste" / f"{path}.md").read_text(),
                                     (root / path).read_text())
                self.assertFalse((stage / "docs-ste/LICENSE.md.md").exists())
                prose = (stage / "docs-ste/specs/new api.json.md").read_text()
                for value in ["Title prose.", "Description prose.", "Summary prose."]:
                    self.assertIn(value, prose)
                self.assertNotIn("IGNORE_VERSION", prose)
                self.assertFalse((stage / "docs-ste/package.json.md").exists())
                self.assertNotIn("if", job)
                self.assertNotIn("continue-on-error", job)
                for item in job["steps"]:
                    self.assertNotIn("continue-on-error", item)
        ste = jobs["ste-cli"]["steps"][-1]["with"]
        self.assertIn("--warnings-as-errors", ste["args"])
        self.assertIn("--all", ste["args"])
        vale = jobs["vale"]["steps"][-1]["with"]
        self.assertEqual(vale["fail_level"], "warning")
        self.assertIs(vale["fail_on_error"], True)


if __name__ == "__main__":
    unittest.main()
