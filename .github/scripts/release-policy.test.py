"""Exercise release policy against meaningful workflow and source mutations."""

import json
import os
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
PATHS = [
    ".github/workflows/policy-guard.yml",
    MAIN,
    ".github/workflows/release.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/aislop.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/pr-branch-updater.yml",
    ".github/scripts/package.json",
    ".github/scripts/package-lock.json",
    ".github/scripts/combination.cjs",
    ".github/scripts/combination.test.cjs",
    ".github/scripts/release.test.cjs",
    ".github/scripts/release-policy.test.py",
    ".github/scripts/release.cjs",
    ".github/scripts/release-settings.cjs",
    ".github/rulesets/protect-release-branches.json",
]
if ROUTER:
    PATHS.append(".github/scripts/publish-image.sh")
else:
    PATHS.append(".github/scripts/release-cleanup.cjs")
    PATHS.append(".github/scripts/release-cleanup.test.cjs")


def policy(overrides=None):
    files = {
        str(path.relative_to(ROOT)): path.read_text()
        for path in (ROOT / ".github").rglob("*")
        if "node_modules" not in path.parts and path.is_file() and path.suffix in {".yml", ".yaml", ".cjs", ".mjs", ".py", ".sh", ".json"}
    }
    files["package.json"] = (ROOT / "package.json").read_text()
    files.update(overrides or {})
    guard = yaml.safe_load(GUARD.read_text())
    steps = guard["jobs"]["guard"]["steps"]
    if ROUTER:
        script = next(step["with"]["script"] for step in steps if "with" in step)
        driver = r"""
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const failures = [];
const github = { paginate: async () => input.paths.map(filename => ({filename, status: 'modified'})),
  rest: { pulls: {listFiles() {}}, repos: {getContent: async ({path}) => ({data: {
    content: Buffer.from(input.files[path]).toString('base64'), encoding: 'base64'
  }})}}};
const context = {repo: {owner: 'test', repo: 'test'}, payload: {pull_request: {number: 1, head: {sha: 'test'}}}};
const core = {setFailed: text => failures.push(text), info() {}};
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
new AsyncFunction('github', 'context', 'core', 'require', input.script)(github, context, core, require)
  .then(() => process.stdout.write(JSON.stringify(failures))).catch(error => {console.error(error); process.exit(1);});
"""
        result = subprocess.run(
            ["node", "-e", driver],
            input=json.dumps({"script": script, "files": files, "paths": PATHS}),
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)
    source = ""
    for step in steps:
        run = step.get("run", "")
        if "cat <<'POLICY_SOURCE'" in run:
            source += run.split("\n", 2)[2].rsplit("\nPOLICY_SOURCE", 1)[0] + "\n"
    # Exercise the guard's existing fixture mode in its own process, including
    # its real author checks and main entry point. Do not evaluate source in the
    # test runner or disable the repository's dynamic-execution security rule.
    with tempfile.TemporaryDirectory(prefix="release-policy-") as temporary:
        directory = Path(temporary)
        program = directory / "policy_guard.py"
        program.write_text(source)
        fixtures = directory / "fixtures"
        fixtures.mkdir()
        for path, content in files.items():
            target = fixtures / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        for name, value in {
            "head_sha": "a" * 40,
            "author_association": "OWNER",
            "author_login": "test-owner",
        }.items():
            (fixtures / name).write_text(value)
        changed = directory / "files.json"
        changed.write_text(json.dumps([{"filename": path, "status": "modified"} for path in PATHS]))
        result = subprocess.run(
            [sys.executable, str(program)],
            env={**os.environ, "GUARD_FIXTURE_DIR": str(fixtures), "FILES_JSON": str(changed)},
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        return [] if result.returncode == 0 else [result.stdout + result.stderr]


class ReleasePolicyTests(unittest.TestCase):
    def test_release_dispatch_rejects_non_main_before_preparation(self):
        release = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
        self.assertEqual(release.get("on", release.get(True)), {"workflow_dispatch": None})
        entry = release["jobs"]["entry"]
        self.assertEqual(entry["permissions"], {})
        script = entry["steps"][0]["with"]["script"]
        for ref, event, accepted in [
            ("refs/heads/main", "workflow_dispatch", True),
            ("refs/heads/release/0.2.0", "workflow_dispatch", False),
            ("refs/heads/fix/example", "workflow_dispatch", False),
            ("refs/heads/main", "push", False),
        ]:
            driver = "const context=" + json.dumps({"ref": ref, "eventName": event}) + ";" + script
            result = subprocess.run(["node", "-e", driver], capture_output=True)
            self.assertEqual(result.returncode == 0, accepted)
        self.assertEqual(release["jobs"]["baseline"]["needs"], "entry")
        self.assertEqual(release["jobs"]["prepare-release"]["needs"], "baseline")
        self.assertEqual(release["jobs"]["release"]["needs"], "prepare-release")

    def test_main_and_candidate_share_gates_without_main_publication(self):
        main = yaml.safe_load((ROOT / MAIN).read_text())
        events = main.get("on", main.get(True))
        self.assertEqual(set(events), {"push", "workflow_call"})
        self.assertEqual(events["push"], {"branches": ["main"]})
        publish = main["jobs"]["publish"]
        self.assertEqual(publish["if"], "inputs.candidate_sha != ''")
        self.assertEqual(publish["needs"], ["quality", "aislop", "codeql"])
        for name in ["sonar", "update-pr-branches"]:
            self.assertEqual(main["jobs"][name]["if"], "github.ref == 'refs/heads/main' && inputs.candidate_sha == ''")
        steps = [step.get("name") for step in publish["steps"]]
        self.assertLess(steps.index("Release preflight"), steps.index("Release App token"))
        self.assertLess(steps.index("Publish immutable release"), steps.index("Queue next version"))
        self.assertLess(steps.index("Queue next version"), steps.index("Delete published candidate"))
        self.assertTrue(all(not step.get("continue-on-error") for step in publish["steps"]))

    def test_candidate_identity_reaches_checks_and_attestations(self):
        main = yaml.safe_load((ROOT / MAIN).read_text())
        for name in ["quality", "aislop", "codeql"]:
            self.assertEqual(main["jobs"][name]["with"], {
                "candidate_sha": "${{ inputs.candidate_sha }}",
                "candidate_ref": "${{ inputs.candidate_ref }}",
            })
        steps = {step.get("name"): step for step in main["jobs"]["publish"]["steps"]}
        self.assertEqual(steps["Attest tested packages"]["with"]["predicate-path"], "${{ steps.provenance.outputs.path }}")
        self.assertEqual(steps["Retain tested packages"]["with"]["name"], "packages-${{ inputs.candidate_sha }}")
        self.assertEqual(steps["Restore retained packages"]["with"]["artifact-ids"], "${{ steps.retained.outputs.artifact }}")

    def test_cancellation_keeps_recovery_state_and_suppresses_reporting(self):
        main = yaml.safe_load((ROOT / MAIN).read_text())
        self.assertNotIn("cleanup", main["jobs"])
        sonar = {step.get("name"): step for step in main["jobs"]["sonar"]["steps"]}
        self.assertIn("!cancelled()", sonar["Synchronize SonarQube findings"]["if"])
        release = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
        retained = release["jobs"]["retain-preparation"]
        self.assertIn("!cancelled()", retained["if"])
        self.assertEqual(retained["permissions"], {"contents": "read"})
        self.assertTrue(all("app-token" not in step.get("uses", "") for step in retained["steps"]))

    def test_gitleaks_artifacts_are_unique_per_source_and_attempt(self):
        ci = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
        steps = {step.get("name"): step for step in ci["jobs"]["checks"]["steps"]}
        self.assertIs(steps["Gitleaks"]["env"]["GITLEAKS_ENABLE_UPLOAD_ARTIFACT"], False)
        self.assertEqual(steps["Retain Gitleaks report"]["with"]["name"],
                         "gitleaks-${{ inputs.candidate_sha || github.sha }}-${{ github.run_attempt }}")

    def test_reviewed_release_workflows_pass(self):
        self.assertEqual(policy(), [])

    def test_publication_cannot_drop_a_gate_or_run_on_main_push(self):
        original = (ROOT / MAIN).read_text()
        for content in [
            original.replace("inputs.candidate_sha != ''", "github.ref == 'refs/heads/main'"),
            original.replace("      - name: Release preflight", "      - if: false\n        name: Release preflight"),
            original.replace("needs: [quality, aislop, codeql]", "needs: [quality, codeql]"),
            original.replace("candidate_sha: ${{ inputs.candidate_sha }}", "candidate_sha: ${{ github.sha }}"),
        ]:
            self.assertNotEqual(content, original)
            self.assertTrue(policy({MAIN: content}))

    def test_new_release_trigger_or_missing_entry_guard_fails(self):
        path = ".github/workflows/release.yml"
        original = (ROOT / path).read_text()
        for content in [
            original.replace("on:\n", "on:\n  push:\n    branches: ['release/*']\n"),
            original.replace("needs: entry", "if: always()"),
            original.replace("context.ref !== 'refs/heads/main'", "false"),
        ]:
            self.assertTrue(policy({path: content}))

    def test_release_script_mutation_fails(self):
        path = ".github/scripts/release.cjs"
        self.assertTrue(policy({path: (ROOT / path).read_text().replace("if (!condition)", "if (false)")}))

    def test_scan_neutralization_fails(self):
        path = ".github/workflows/ci.yml"
        changed = (ROOT / path).read_text().replace(
            "      - name: Trivy dependency gate", "      - continue-on-error: true\n        name: Trivy dependency gate")
        self.assertTrue(policy({path: changed}))

    def test_combination_cannot_use_floating_router_images(self):
        path = ".github/workflows/ci.yml"
        original = (ROOT / path).read_text()
        changed = original.replace("${{ steps.pins.outputs.router_image }}", "latest")
        self.assertTrue(policy({path: changed}))

    def test_candidate_scans_cannot_report_main_or_checkout_floating_sources(self):
        for path in [".github/workflows/ci.yml", ".github/workflows/aislop.yml", ".github/workflows/codeql.yml"]:
            original = (ROOT / path).read_text()
            for changed in [
                original.replace("ref: ${{ inputs.candidate_sha || github.sha }}", "ref: main"),
                original.replace("sha: ${{ inputs.candidate_sha }}", "sha: ${{ github.sha }}"),
            ]:
                self.assertNotEqual(changed, original)
                self.assertTrue(policy({path: changed}))

    def test_full_action_pin_refresh_is_allowed(self):
        doc = yaml.safe_load((ROOT / MAIN).read_text())
        action = next(step["uses"] for job in doc["jobs"].values() for step in job.get("steps", []) if "uses" in step)
        changed = (ROOT / MAIN).read_text().replace(action, action.split("@")[0] + "@" + "f" * 40)
        self.assertEqual(policy({MAIN: changed}), [])


if __name__ == "__main__":
    unittest.main()
