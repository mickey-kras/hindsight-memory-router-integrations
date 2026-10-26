"""Exercise lock provenance and independent owner admission at the trust boundary."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
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
        self.rules = [{'type': 'pull_request', 'ruleset_id': 42, 'ruleset_source_type': 'Repository',
                       'ruleset_source': 'mickey-kras/test', 'parameters': {
            'required_approving_review_count': 1,
            'require_code_owner_review': True,
            'dismiss_stale_reviews_on_push': True,
            'require_last_push_approval': True,
        }}]
        self.reviews = [{'id': 1, 'user': {'id': 24433677, 'login': 'mickey-kras', 'type': 'User'},
                         'state': 'APPROVED', 'commit_id': 'a' * 40}]
        self.source = {'id': 42, 'source_type': 'Repository', 'source': 'mickey-kras/test',
                       'enforcement': 'active', 'target': 'branch', 'updated_at': '2026-10-23T00:00:00Z',
                       'bypass_actors': [], 'rules': copy.deepcopy(self.rules)}

    def lock_errors(self, lock):
        with patch.object(self.guard, 'base_file', return_value=json.dumps(self.lock)), patch.object(
            self.guard, 'fetch_file', return_value=(ROOT / '.github/scripts/package.json').read_text()
        ):
            self.guard.gate_lockfile(self.lock_path, lock if isinstance(lock, str) else json.dumps(lock))
        return list(self.guard.failures)

    def approved(self, settings_review=''):
        def api(path, paginate=False):
            if path.startswith('rulesets/'):
                self.assertEqual(path, 'rulesets/42')
                return self.source
            return self.rules if path.startswith('rules/') else self.reviews
        with patch.dict('os.environ', {'OWNER': 'mickey-kras', 'REPO': 'test', 'PR_NUMBER': '1',
                                      'CI_POLICY_SETTINGS_REVIEW': settings_review}), patch.object(
            self.guard, 'base_file', return_value='/.github/ @mickey-kras\n'
        ), patch.object(self.guard, 'api_json', side_effect=api):
            return self.guard.owner_approved()

    def settings_review(self, **values):
        return json.dumps({'repository': 'mickey-kras/test', 'ruleset_id': 42,
                           'updated_at': '2026-10-23T00:00:00Z', 'bypass_actors': [], **values})

    def test_redacted_bypasses_need_exact_current_administrator_readback(self):
        del self.source['bypass_actors']
        for value in ['', '{}', 'null', '[]', '{', self.settings_review(repository='other/repo'),
                      self.settings_review(ruleset_id=43), self.settings_review(ruleset_id=True),
                      self.settings_review(ruleset_id='42'), self.settings_review(updated_at='2026-10-22T00:00:00Z'),
                      self.settings_review(bypass_actors=[{}])]:
            with self.subTest(value=value):
                self.assertFalse(self.approved(value))
        self.assertTrue(self.approved(self.settings_review()))
        self.source['updated_at'] = '2026-10-23T00:00:01Z'
        self.assertFalse(self.approved(self.settings_review()))

    def test_readback_cannot_override_bypasses_or_disabled_or_weakened_source(self):
        original = copy.deepcopy(self.source)
        for values in [{'bypass_actors': [{'actor_id': 123, 'actor_type': 'Integration', 'bypass_mode': 'pull_request'}]},
                       {'bypass_actors': None}, {'bypass_actors': {}}, {'bypass_actors': ''},
                       {'enforcement': 'disabled'}, {'enforcement': 'evaluate'}, {'target': 'tag'}, {'id': 43},
                       {'source_type': 'Organization'}, {'source': 'other/repo'}, {'rules': []},
                       {'rules': [{'type': 'pull_request', 'parameters': {'required_approving_review_count': 1}}]}]:
            self.source = {**original, **values}
            with self.subTest(values=values):
                self.assertFalse(self.approved(self.settings_review()))
        self.source = original
        for values in [{'ruleset_id': 0}, {'ruleset_id': True}, {'ruleset_id': '42'},
                       {'ruleset_source_type': 'Organization'}, {'ruleset_source': 'other/repo'}]:
            self.rules = [{**original['rules'][0], **values}]
            with self.subTest(values=values):
                self.assertFalse(self.approved(self.settings_review()))

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
        changed['packages']['node_modules/..'] = changed['packages'].pop('node_modules/ip-address')
        self.guard.failures.clear()
        self.assertTrue(self.lock_errors(changed))

    def test_exact_owner_approval_with_native_controls(self):
        self.assertTrue(self.approved())
        self.reviews.append({**self.reviews[0], 'id': 2, 'state': 'COMMENTED'})
        self.assertTrue(self.approved())
        self.reviews.append({**self.reviews[0], 'id': 3, 'state': 'DISMISSED'})
        self.assertFalse(self.approved())

    def test_npm_publisher_sources_require_exact_head_owner_admission(self):
        for path in (
            '.github/scripts/publish-npm.cjs',
            '.github/trusted-ci/publish-npm.test.cjs',
            '.github/scripts/verify-package-inventory.cjs',
            '.github/scripts/coding-dependency-patch.cjs',
            '.github/scripts/dependency-files.cjs',
        ):
            original = (ROOT / path).read_text()
            for mutation in ('unchanged', 'unapproved', 'stale', 'dismissed', 'approved', 'removed', 'renamed'):
                self.guard.failures.clear()
                self.reviews = [{'id': 1, 'user': {'id': 24433677, 'login': 'mickey-kras', 'type': 'User'},
                                 'state': 'DISMISSED' if mutation == 'dismissed' else 'APPROVED',
                                 'commit_id': ('c' if mutation == 'stale' else 'a') * 40}]
                content = original if mutation == 'unchanged' else original + '\nthrow new Error("unreviewed publisher change");\n'
                entry = {'filename': path, 'status': 'modified'}
                if mutation == 'removed':
                    entry['status'] = 'removed'
                elif mutation == 'renamed':
                    entry = {'filename': path + '.moved', 'previous_filename': path, 'status': 'renamed'}
                with self.subTest(path=path, mutation=mutation):
                    admitted = mutation not in ('unchanged', 'unapproved') and self.approved()
                    with patch.dict('os.environ', {'GUARD_FIXTURE_DIR': 'test'}), patch.object(
                        self.guard, 'base_file', return_value=original
                    ), patch.object(
                        self.guard, 'resolve_pr_context', return_value=('a' * 40, 'OWNER', 'mickey-kras')
                    ), patch.object(self.guard, 'owner_approved', return_value=admitted), patch.object(
                        self.guard, 'load_files', return_value=[entry]
                    ), patch.object(self.guard, 'fetch_file', return_value=content), patch('builtins.print'):
                        if mutation in ('unchanged', 'approved'):
                            self.guard.main()
                            self.assertEqual(self.guard.failures, [])
                            continue
                        with self.assertRaises(SystemExit):
                            self.guard.main()
                    removal = mutation in ('removed', 'renamed')
                    reason = 'must not be removed or renamed' if removal else 'require independent exact-head owner approval'
                    self.assertIn(path + ':', '\n'.join(self.guard.failures))
                    self.assertIn(reason, '\n'.join(self.guard.failures))

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

    def test_policy_guard_admits_only_harden_runner_pin_and_comment_changes(self):
        path = '.github/workflows/policy-guard.yml'
        before = (ROOT / path).read_text()
        action = next(line for line in before.splitlines() if line.strip().startswith(
            '- uses: step-security/harden-runner@'
        ))
        prefix = action.split('@')[0] + '@'
        for changed in (
            before.replace(action, prefix + 'f' * 40),
            before.replace(action, prefix + 'f' * 40 + ' # v2.22.2'),
            before.replace(action, action.split('#')[0].rstrip() + ' # v2.22.2'),
        ):
            self.guard.failures.clear()
            with self.subTest(change='harden-runner'), patch.object(self.guard, 'base_file', return_value=before):
                self.guard.gate_policy_guard(path, changed)
                self.assertEqual(self.guard.failures, [])
        for mutation, changed in (
            ('trigger', before.replace('pull_request_target', 'workflow_run', 1)),
            ('permission', before.replace('contents: read', 'contents: write', 1)),
            ('source', before.replace("'safe_load', 'protected'", "'safe_load'", 1)),
            ('execution', before.replace('python3 "$RUNNER_TEMP/policy_guard.py"', 'python3 -c "pass"', 1)),
        ):
            self.guard.failures.clear()
            with self.subTest(change=mutation), patch.object(self.guard, 'base_file', return_value=before):
                self.guard.gate_policy_guard(path, changed)
                self.assertIn('require independent exact-head owner approval', '\n'.join(self.guard.failures))

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

    def test_real_pr_policy_entrypoint_reads_live_review_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            gh = directory / 'gh'
            gh.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
from pathlib import Path
data = json.loads(Path(os.environ['API_RESPONSES']).read_text())
value = data[sys.argv[2]]
print(value if isinstance(value, str) else json.dumps(value))
''')
            gh.chmod(0o755)
            responses = directory / 'responses.json'
            prefix = 'repos/mickey-kras/test/'
            pull = {**self.guard.pr_context, 'number': 1, 'state': 'open', 'author_association': 'NONE'}
            self.source.pop('bypass_actors')
            data = {
                prefix + 'pulls/1': pull,
                prefix + 'pulls/1/files?per_page=100': [[{'filename': '.github/scripts/release-settings.cjs', 'status': 'modified'}]],
                prefix + 'rules/branches/main': [self.rules],
                prefix + 'rulesets/42': self.source,
                prefix + 'pulls/1/reviews?per_page=100': [self.reviews],
                prefix + 'contents/.github/CODEOWNERS?ref=' + 'b' * 40: '/.github/ @mickey-kras\n',
                prefix + 'contents/.github/scripts/release-settings.cjs?ref=' + 'a' * 40: '// independently reviewed update\n',
            }
            command = ['node', '-e', "require('./.github/scripts/dependabot-validation.cjs').runPolicy({}, {owner:'mickey-kras',repo:'test'}, {number:1}, [], {live:true}).catch(error=>{console.error(error);process.exit(1)})"]
            environment = {**os.environ, 'PATH': str(directory) + os.pathsep + os.environ['PATH'],
                           'API_RESPONSES': str(responses), 'GH_TOKEN': 'test-read-only',
                           'GUARD_FIXTURE_DIR': 'must-not-be-used', 'FILES_JSON': 'must-not-be-used',
                           'CI_POLICY_SETTINGS_REVIEW': self.settings_review()}
            responses.write_text(json.dumps(data))
            passed = subprocess.run(command, env=environment, text=True, capture_output=True)
            self.assertEqual(passed.returncode, 0, passed.stderr)
            for mutation in ('missing-readback', 'bypass', 'stale', 'disabled', 'dismissed'):
                changed = copy.deepcopy(data)
                trial_env = dict(environment)
                if mutation == 'missing-readback':
                    trial_env['CI_POLICY_SETTINGS_REVIEW'] = ''
                elif mutation == 'bypass':
                    changed[prefix + 'rulesets/42']['bypass_actors'] = [{'actor_id': 123}]
                elif mutation == 'stale':
                    changed[prefix + 'rulesets/42']['updated_at'] = '2026-10-23T00:00:01Z'
                elif mutation == 'disabled':
                    changed[prefix + 'rulesets/42']['enforcement'] = 'disabled'
                else:
                    changed[prefix + 'pulls/1/reviews?per_page=100'][0][0]['state'] = 'DISMISSED'
                responses.write_text(json.dumps(changed))
                with self.subTest(mutation=mutation):
                    failed = subprocess.run(command, env=trial_env, text=True, capture_output=True)
                    self.assertNotEqual(failed.returncode, 0)
                    self.assertIn('release automation must match its reviewed policy', failed.stderr)


if __name__ == '__main__':
    unittest.main()
