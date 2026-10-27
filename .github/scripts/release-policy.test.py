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

def policy(overrides=None):
    files = {
        str(path.relative_to(ROOT)): path.read_text()
        for path in (ROOT / ".github").rglob("*")
        if "node_modules" not in path.parts and path.is_file() and path.suffix in {".yml", ".yaml", ".cjs", ".mjs", ".py", ".sh", ".json"}
    }
    files["package.json"] = (ROOT / "package.json").read_text()
    for path in [".ste.yml", ".vale.ini", ".vale/styles/config/vocabularies/Project/accept.txt"]:
        files[path] = (ROOT / path).read_text()
    baseline = dict(files)
    baseline[".github/CODEOWNERS"] = (ROOT / ".github/CODEOWNERS").read_text()
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
        for path, content in baseline.items():
            target = fixtures / "base" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
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
        self.assertEqual(set(events), {"push", "workflow_call", "workflow_dispatch"})
        self.assertIsNone(events["workflow_dispatch"])
        self.assertEqual(events["push"], {"branches": ["main"]})
        publish = main["jobs"]["publish"]
        self.assertEqual(publish["if"], "github.ref == 'refs/heads/main' && inputs.candidate_sha != ''")
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
                ("revision_sha" if ACTIVE else "candidate_sha"): "${{ inputs.candidate_sha }}",
                ("revision_ref" if ACTIVE else "candidate_ref"): "${{ inputs.candidate_ref }}",
            })
        steps = {step.get("name"): step for step in main["jobs"]["publish"]["steps"]}
        self.assertEqual(steps["Attest tested packages"]["with"]["predicate-path"], "${{ steps.provenance.outputs.path }}")
        self.assertEqual(steps["Retain tested packages"]["with"]["name"], "packages-${{ inputs.candidate_sha }}")
        self.assertEqual(steps["Restore retained packages"]["with"]["artifact-ids"], "${{ steps.retained.outputs.artifact }}")

    def test_coverage_is_restored_from_successful_quality_output(self):
        ci = yaml.safe_load((ROOT / CI).read_text())
        main = yaml.safe_load((ROOT / MAIN).read_text())
        checks = ci["jobs"][BUILD]
        self.assertEqual(checks["outputs"]["coverage_artifact"], "${{ steps.coverage.outputs.artifact-id }}")
        if ACTIVE:
            self.assertEqual(ci.get("on", ci.get(True))["workflow_call"]["outputs"]["coverage_artifact"]["value"],
                             "${{ jobs.checks.outputs.coverage_artifact }}")
            self.assertEqual(ci["jobs"]["checks"]["outputs"]["coverage_artifact"],
                             "${{ needs.build.outputs.coverage_artifact }}")
            self.assertEqual(ci["jobs"]["checks"]["needs"], ["build", "security"])
        retained = next(step for step in checks["steps"] if step.get("id") == "coverage")
        self.assertNotIn("if", retained)
        self.assertEqual(checks["steps"][-1], retained)
        sonar = {step.get("name"): step for step in main["jobs"]["sonar"]["steps"]}
        self.assertEqual(sonar["Restore verified coverage"]["with"]["artifact-ids"],
                         "${{ needs.quality.outputs.coverage_artifact }}")
        self.assertEqual(sonar["Verify coverage provenance"]["run"],
                         "node .github/scripts/coverage-artifact.cjs verify")
        self.assertNotIn("Generate coverage for SonarQube", sonar)
        sonar_steps = main["jobs"]["sonar"]["steps"]
        install = sonar["Install SonarQube analysis dependencies"]
        self.assertEqual(install["run"].splitlines(), [
            "npm install --global npm@11.19.1 --ignore-scripts --no-audit --no-fund",
            'test "$(npm --version)" = 11.19.1',
            "npm ci --ignore-scripts --no-audit --no-fund",
            "npm ci --prefix src/upstream/coding-agents --ignore-scripts --no-audit --no-fund",
        ])
        self.assertNotIn("if", install)
        self.assertNotIn("continue-on-error", install)
        node = next(step for step in sonar_steps if step.get("uses", "").startswith("actions/setup-node@"))
        self.assertLess(sonar_steps.index(node), sonar_steps.index(install))
        self.assertLess(sonar_steps.index(install), sonar_steps.index(sonar["SonarQube analysis"]))
        for step in sonar_steps:
            self.assertNotRegex(step.get("run", ""), r"\bnpm\s+(?:run\s+)?(?:test|build)\b")

    def test_preparation_retains_packages_only_after_candidate_identity(self):
        release = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
        steps = release["jobs"]["prepare-release"]["steps"]
        names = [step.get("name") for step in steps]
        self.assertLess(names.index("Freeze inputs and create release branch"), names.index("Retain prepared packages"))
        retained = steps[names.index("Retain prepared packages")]
        self.assertEqual(retained["with"]["name"], "packages-${{ steps.prepared.outputs.sha }}")
        self.assertEqual(retained["if"], "steps.prepared.outputs.sha != '' && steps.retained.outputs.artifact == ''")
        main = yaml.safe_load((ROOT / MAIN).read_text())
        publish = {step.get("name"): step for step in main["jobs"]["publish"]["steps"]}
        self.assertIn("sha256sum --check PACKAGE_SHA256", publish["Verify retained package inventory"]["run"])

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
        ci = yaml.safe_load((ROOT / CI).read_text())
        steps = {step.get("name"): step for step in ci["jobs"][SECURITY]["steps"]}
        if ACTIVE:
            self.assertIn("--report-path", steps["Gitleaks"]["run"])
            identity = "steps.identity.outputs.sha"
        else:
            self.assertIs(steps["Gitleaks"]["env"]["GITLEAKS_ENABLE_UPLOAD_ARTIFACT"], False)
            identity = "inputs.candidate_sha || github.sha"
        self.assertEqual(steps["Retain Gitleaks report"]["with"]["name"],
                         "gitleaks-${{ " + identity + " }}-${{ github.run_attempt }}")

    def test_documentation_workflow_and_rules_cannot_be_disabled(self):
        for path in [".github/workflows/docs-ste.yml", ".ste.yml", ".vale.ini",
                     ".vale/styles/config/vocabularies/Project/accept.txt",
                     ".github/scripts/docs-ste.test.py"]:
            with self.subTest(path=path):
                self.assertTrue(policy({path: (ROOT / path).read_text() + "\nchanged\n"}))
        path = ".github/workflows/pr-validation.yml"
        original = yaml.safe_load((ROOT / path).read_text())
        for mutation in ["remove", "skip", "dependency", "result"]:
            doc = yaml.safe_load((ROOT / path).read_text())
            if mutation == "remove":
                del doc["jobs"]["docs-ste"]
            elif mutation == "skip":
                doc["jobs"]["docs-ste"]["if"] = False
            elif mutation == "dependency":
                del doc["jobs"]["guard"]["needs"]
            else:
                doc["jobs"]["guard"]["steps"][0]["run"] = "true"
            self.assertNotEqual(doc, original)
            self.assertTrue(policy({path: yaml.safe_dump(doc)}))

    def test_reviewed_release_workflows_pass(self):
        self.assertEqual(policy(), [])

    def test_publication_cannot_drop_a_gate_or_run_on_main_push(self):
        for mutation in ["condition", "preflight", "gate", "identity"]:
            doc = yaml.safe_load((ROOT / MAIN).read_text())
            publish = doc["jobs"]["publish"]
            if mutation == "condition":
                publish["if"] = "github.ref == 'refs/heads/main'"
            elif mutation == "preflight":
                next(step for step in publish["steps"] if step.get("name") == "Release preflight")["if"] = False
            elif mutation == "gate":
                publish["needs"].remove("aislop")
            else:
                doc["jobs"]["quality"]["with"]["revision_sha" if ACTIVE else "candidate_sha"] = "${{ github.sha }}"
            self.assertTrue(policy({MAIN: yaml.safe_dump(doc)}))

    def test_main_dispatch_stays_inputless_and_all_jobs_require_main(self):
        original = yaml.safe_load((ROOT / MAIN).read_text())
        for job in original["jobs"].values():
            self.assertIn("github.ref == 'refs/heads/main'", job["if"])
        for mutation in ["missing", "inputs", "condition"]:
            doc = yaml.safe_load((ROOT / MAIN).read_text())
            events = doc.get("on", doc.get(True))
            if mutation == "missing":
                del events["workflow_dispatch"]
            elif mutation == "inputs":
                events["workflow_dispatch"] = {"inputs": {"candidate_sha": {"type": "string"}}}
            else:
                doc["jobs"]["publish"]["if"] = "inputs.candidate_sha != ''"
            self.assertTrue(policy({MAIN: yaml.safe_dump(doc)}))

    def test_new_release_trigger_or_missing_entry_guard_fails(self):
        path = ".github/workflows/release.yml"
        for mutation in ["trigger", "dependency", "entry"]:
            doc = yaml.safe_load((ROOT / path).read_text())
            if mutation == "trigger":
                doc.get("on", doc.get(True))["push"] = {"branches": ["release/*"]}
            elif mutation == "dependency":
                doc["jobs"]["baseline"].pop("needs")
            else:
                doc["jobs"]["entry"]["steps"][0]["with"]["script"] = "core.info('unchecked')"
            self.assertTrue(policy({path: yaml.safe_dump(doc)}))

    def test_release_script_mutation_fails(self):
        for path, old, new in [
            (".github/scripts/release.cjs", "if (!condition)", "if (false)"),
            (".github/scripts/release-follow-up.cjs", "if (!condition)", "if (false)"),
        ]:
            text = (ROOT / path).read_text()
            self.assertIn(old, text)
            self.assertTrue(policy({path: text.replace(old, new, 1)}))

    def test_guard_concurrency_is_per_pr_and_cancels_stale(self):
        guard = yaml.safe_load(GUARD.read_text())
        self.assertIn("github.event.pull_request.number", guard["concurrency"]["group"])
        self.assertIs(guard["concurrency"]["cancel-in-progress"], True)


if __name__ == "__main__":
    unittest.main()
