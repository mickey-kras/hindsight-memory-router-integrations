"""Exercise lock provenance and independent owner admission at the trust boundary."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path.cwd()


class AdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        workflow = yaml.safe_load((ROOT / '.github/workflows/policy-guard.yml').read_text())
        source = ''
        for step in workflow['jobs']['guard']['steps']:
            run = step.get('run', '')
            if "cat <<'POLICY_SOURCE'" in run:
                source += run.split('\n', 2)[2].rsplit('\nPOLICY_SOURCE', 1)[0] + '\n'
        cls.directory = tempfile.TemporaryDirectory()
        path = Path(cls.directory.name) / 'guard.py'
        path.write_text(source)
        spec = importlib.util.spec_from_file_location('guard', path)
        cls.guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.guard)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        self.guard.failures.clear()
        self.guard.review_admitted = False
        self.guard.pr_context = {
            'head': {'sha': 'a' * 40},
            'base': {'sha': 'b' * 40, 'ref': 'main', 'repo': {'full_name': 'mickey-kras/test'}},
            'user': {'type': 'Bot', 'login': 'implementer[bot]', 'id': 123},
        }
        self.lock_path = '.github/scripts/package-lock.json'
        self.lock = json.loads((ROOT / self.lock_path).read_text())
        self.rules = [{'type': 'pull_request', 'parameters': {
            'required_approving_review_count': 1,
            'require_code_owner_review': True,
            'dismiss_stale_reviews_on_push': True,
            'require_last_push_approval': True,
        }}]
        self.reviews = [{'id': 1, 'user': {'id': 24433677, 'login': 'mickey-kras', 'type': 'User'},
                         'state': 'APPROVED', 'commit_id': 'a' * 40}]

    def lock_errors(self, lock):
        with patch.object(self.guard, 'base_file', return_value=json.dumps(self.lock)), patch.object(
            self.guard, 'fetch_file', return_value=(ROOT / '.github/scripts/package.json').read_text()
        ):
            self.guard.gate_lockfile(self.lock_path, lock if isinstance(lock, str) else json.dumps(lock))
        return list(self.guard.failures)

    def approved(self):
        def api(path, paginate=False):
            return self.rules if path.startswith('rules/') else self.reviews
        with patch.dict('os.environ', {'OWNER': 'mickey-kras', 'REPO': 'test', 'PR_NUMBER': '1'}), patch.object(
            self.guard, 'base_file', return_value='/.github/ @mickey-kras\n'
        ), patch.object(self.guard, 'api_json', side_effect=api):
            return self.guard.owner_approved()

    def test_registry_patch_needs_no_hash_admission(self):
        key = 'node_modules/ip-address'
        self.lock['packages'][key]['version'] = '10.7.4'
        self.lock['packages'][key]['resolved'] = 'https://registry.npmjs.org/ip-address/-/ip-address-10.7.4.tgz'
        self.lock['packages'][key]['integrity'] = 'sha512-' + base64.b64encode(b'x' * 64).decode()
        self.assertEqual(self.lock_errors(self.lock), [])
        self.assertFalse(self.guard.LOCKFILES & self.guard.RELEASE_SOURCE_HASHES.keys())
        self.assertTrue(all(isinstance(value, str) for value in self.guard.RELEASE_SOURCE_HASHES.values()))

    def test_untrusted_sources_and_execution_metadata_fail(self):
        key = 'node_modules/ip-address'
        mutations = [
            ('resolved', 'https://registry.npmjs.org.evil.test/a.tgz'),
            ('resolved', 'https://user@registry.npmjs.org/ip-address/-/x.tgz'),
            ('resolved', 'http://registry.npmjs.org/ip-address/-/x.tgz'),
            ('resolved', 'https://registry.npmjs.org:443/ip-address/-/x.tgz'),
            ('resolved', 'https://registry.npmjs.org/ip-address/-/x.tgz?redirect=x'),
            ('resolved', 'file:../../escape'),
            ('integrity', 'sha1-abc'), ('integrity', ''),
            ('link', True), ('inBundle', True), ('hasShrinkwrap', True), ('hasInstallScript', True),
            ('resolved', 'https://registry.npmjs.org/other/-/other-10.7.2.tgz'),
            ('version', 'file:../escape'),
            ('hasInstallScript', 'false'),
        ]
        for field, value in mutations:
            with self.subTest(field=field, value=value):
                lock = copy.deepcopy(self.lock)
                lock['packages'][key][field] = value
                self.guard.failures.clear()
                self.assertTrue(self.lock_errors(lock))

    def test_duplicate_keys_manifest_drift_and_traversal_fail(self):
        for content in ['{"lockfileVersion":3,"lockfileVersion":3}',
                        json.dumps({**self.lock, 'lockfileVersion': 2})]:
            self.guard.failures.clear()
            self.assertTrue(self.lock_errors(content))
        changed = copy.deepcopy(self.lock)
        changed['packages']['']['dependencies']['evil'] = '*'
        self.guard.failures.clear()
        self.assertTrue(self.lock_errors(changed))
        changed = copy.deepcopy(self.lock)
        changed['packages']['node_modules/..'] = changed['packages'].pop('node_modules/ip-address')
        self.guard.failures.clear()
        self.assertTrue(self.lock_errors(changed))

    def test_exact_owner_approval_with_native_controls(self):
        self.assertTrue(self.approved())
        self.reviews.append({**self.reviews[0], 'id': 2, 'state': 'COMMENTED'})
        self.assertTrue(self.approved())
        self.reviews.append({**self.reviews[0], 'id': 3, 'state': 'DISMISSED'})
        self.assertFalse(self.approved())

    def test_wrong_head_self_approval_and_missing_rules_fail(self):
        self.reviews[0]['commit_id'] = 'c' * 40
        self.assertFalse(self.approved())
        self.reviews[0]['commit_id'] = 'a' * 40
        for flag in ('require_code_owner_review', 'dismiss_stale_reviews_on_push', 'require_last_push_approval'):
            self.rules[0]['parameters'][flag] = False
            self.assertFalse(self.approved())
            self.rules[0]['parameters'][flag] = True
        self.guard.pr_context['user'] = {'type': 'User', 'login': 'mickey-kras', 'id': 24433677}
        self.assertFalse(self.approved())

    def test_review_does_not_waive_workflow_invariants(self):
        path = '.github/workflows/trusted-ci.yml'
        before = (ROOT / path).read_text()
        malicious = "'on': pull_request_target\npermissions: {contents: write}\njobs:\n  attack:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@main\n      - run: node attacker.js\n"
        self.guard.review_admitted = True
        with patch.object(self.guard, 'base_file', return_value=before):
            self.guard.check_workflow(path, self.guard.load_yaml(malicious))
        errors = '\n'.join(self.guard.failures)
        self.assertIn('preserve workflow triggers', errors)
        self.assertIn('preserve top-level permissions', errors)
        self.assertIn('pinned', errors)
        self.assertIn('cannot check out code', errors)

    def test_approval_allows_additive_work_without_disabling_existing_gates(self):
        path = '.github/workflows/trusted-ci.yml'
        before = (ROOT / path).read_text()
        doc = self.guard.load_yaml(before)
        doc['jobs']['extra'] = {'runs-on': 'ubuntu-latest', 'steps': [{'run': 'echo extra-check'}]}
        self.guard.review_admitted = True
        with patch.object(self.guard, 'base_file', return_value=before):
            self.guard.check_workflow(path, doc)
        self.assertEqual(self.guard.failures, [])

    def test_approval_cannot_skip_required_scans_or_failure_propagation(self):
        path = '.github/workflows/trusted-ci.yml'
        before = (ROOT / path).read_text()
        original = self.guard.load_yaml(before)
        for mutation in ('replace', 'skip', 'ignore', 'remove', 'root-shell', 'job-shell', 'job-env'):
            self.guard.failures.clear()
            doc = copy.deepcopy(original)
            job_name = next(name for name, job in doc['jobs'].items() if job.get('steps'))
            job = doc['jobs'][job_name]
            if mutation == 'replace':
                job['steps'] = [{'run': 'true'}]
            elif mutation == 'skip':
                job['steps'][0]['if'] = False
            elif mutation == 'ignore':
                job['continue-on-error'] = True
            elif mutation == 'root-shell':
                doc['defaults'] = {'run': {'shell': 'true {0}'}}
            elif mutation == 'job-shell':
                job['defaults'] = {'run': {'shell': 'true {0}'}}
            elif mutation == 'job-env':
                job['env'] = {'PATH': '/attacker'}
            else:
                del doc['jobs'][job_name]
            self.guard.review_admitted = True
            with self.subTest(mutation=mutation), patch.object(self.guard, 'base_file', return_value=before):
                self.guard.check_workflow(path, doc)
                self.assertTrue(self.guard.failures)

    def test_npm_configuration_cannot_redirect_registry_even_with_approval(self):
        for path in ['.npmrc', '.github/.npmrc', '.github/scripts/.npmrc',
                     '.github/trusted-ci/.npmrc', '.github/scripts/npm-shrinkwrap.json']:
            self.guard.failures.clear()
            with self.subTest(path=path), patch.dict('os.environ', {'GUARD_FIXTURE_DIR': 'test'}), patch.object(
                self.guard, 'resolve_pr_context', return_value=('a' * 40, 'OWNER', 'mickey-kras')
            ), patch.object(self.guard, 'owner_approved', return_value=True), patch.object(
                self.guard, 'load_files', return_value=[{'filename': path, 'status': 'added'}]
            ), patch('builtins.print'):
                with self.assertRaises(SystemExit):
                    self.guard.main()
                self.assertIn('CI npm configuration', '\n'.join(self.guard.failures))

    def test_live_guard_rejects_head_base_or_state_changes(self):
        for mutation in ('stable', 'head', 'base', 'closed'):
            self.guard.failures.clear()
            current = copy.deepcopy(self.guard.pr_context)
            current['state'] = 'open'
            if mutation in ('head', 'base'):
                current[mutation]['sha'] = 'c' * 40
            if mutation == 'closed':
                current['state'] = 'closed'
            def api(path, paginate=False):
                return [] if '/files?' in path else current
            with self.subTest(mutation=mutation), patch.dict('os.environ', {
                'OWNER': 'mickey-kras', 'REPO': 'test', 'PR_NUMBER': '1'
            }, clear=True), patch.object(self.guard, 'resolve_pr_context', return_value=(
                'a' * 40, 'OWNER', 'mickey-kras'
            )), patch.object(self.guard, 'owner_approved', return_value=True), patch.object(
                self.guard, 'api_json', side_effect=api
            ), patch('builtins.print'):
                if mutation == 'stable':
                    self.guard.main()
                    self.assertEqual(self.guard.failures, [])
                else:
                    with self.assertRaises(SystemExit):
                        self.guard.main()
                    self.assertIn('changed during evaluation', '\n'.join(self.guard.failures))

    def test_api_failure_is_not_an_approval(self):
        with patch.dict('os.environ', {'OWNER': 'mickey-kras', 'REPO': 'test'}), patch.object(
            self.guard, 'base_file', return_value='/.github/ @mickey-kras\n'
        ), patch.object(self.guard, 'api_json', side_effect=RuntimeError('API unavailable')):
            with self.assertRaises(RuntimeError):
                self.guard.owner_approved()


if __name__ == '__main__':
    unittest.main()
