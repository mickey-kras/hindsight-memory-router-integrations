"""Verify Draft/full workflow boundaries without weakening required check identities."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
FULL = "github.event_name != 'pull_request' || github.event.pull_request.draft != true"
DRAFT = "github.event_name == 'pull_request' && github.event.pull_request.draft == true"


def workflow(name):
    return yaml.safe_load((ROOT / '.github/workflows' / name).read_text())


def canonical_keys(value):
    if isinstance(value, dict):
        return {(key.lower() if isinstance(key, str) else key): canonical_keys(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [canonical_keys(item) for item in value]
    return value


class DraftValidation(unittest.TestCase):
    def test_transition_events_and_cancellation(self):
        doc = workflow('pr-validation.yml')
        self.assertEqual(doc.get('on', doc.get(True))['pull_request']['types'],
                         ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft'])
        self.assertTrue(doc['concurrency']['cancel-in-progress'])
        self.assertEqual(set(doc['jobs']), {'guard', 'quality', 'aislop', 'codeql', 'branch-policy', 'dependabot-policy'})
        self.assertNotIn('if', doc['jobs']['quality'])
        for name in ['aislop', 'codeql']:
            self.assertEqual(doc['jobs'][name]['if'], FULL)

    def test_event_modes_and_same_sha_transition(self):
        # Evaluate the checked-in expressions, not a separate policy model.
        expressions = [workflow('pr-validation.yml')['jobs'][name]['if']
                       for name in ['aislop', 'codeql']]
        expressions.append(workflow('ci.yml')['jobs']['combination']['if'])
        for event in ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']:
            for draft in [True, False, None]:
                payload = {'event_name': 'pull_request', 'event': {'action': event,
                           'pull_request': {'draft': draft, 'head': {'sha': 'same-sha'}}}}
                for expression in expressions:
                    script = 'const github=' + json.dumps(payload) + ';console.log(' + expression + ');'
                    result = subprocess.check_output(['node', '-e', script], text=True).strip()
                    self.assertEqual(result == 'true', draft is not True, (event, draft))
        for event_name in ['workflow_dispatch', 'push', 'workflow_call']:
            for expression in expressions:
                script = 'const github={event_name:' + json.dumps(event_name) + ',event:{}};console.log(' + expression + ');'
                self.assertEqual(subprocess.check_output(['node', '-e', script], text=True).strip(), 'true')

    def test_explicit_draft_failure_preserves_required_checks(self):
        doc = workflow('ci.yml')
        self.assertEqual(set(doc['jobs']), {'checks', 'combination'})
        self.assertNotIn('if', doc['jobs']['checks'])
        self.assertEqual(doc['jobs']['combination']['if'], FULL)
        steps = doc['jobs']['checks']['steps']
        index = next(i for i, s in enumerate(steps) if s.get('name') == 'Require ready PR for full validation')
        self.assertEqual(steps[index]['if'], DRAFT)
        self.assertTrue(steps[index]['run'].rstrip().endswith('exit 1'))
        self.assertNotIn('continue-on-error', steps[index])
        self.assertTrue(any(s.get('run') == 'npm run lint' for s in steps[:index]))
        for name in ['Tests and coverage', 'Verify package', 'Nix dependency hash', 'Semgrep',
                     'Trivy dependency gate', 'Record coverage provenance', 'Retain verified coverage']:
            gate = next(i for i, s in enumerate(steps) if s.get('name') == name)
            self.assertGreater(gate, index)
            self.assertNotIn('if', steps[gate])
            self.assertNotIn('continue-on-error', steps[gate])

    def test_live_readiness_rejects_stale_runs(self):
        step = workflow('ci.yml')['jobs']['checks']['steps'][-1]
        self.assertEqual(step['name'], 'Verify current PR readiness')
        self.assertEqual(step['if'], "github.event_name == 'pull_request'")
        script = step['with']['script']
        for state, draft, head, base, passes in [
            ('open', False, 'h', 'b', True),
            ('open', True, 'h', 'b', False),
            ('closed', False, 'h', 'b', False),
            ('open', None, 'h', 'b', False),
            ('open', False, 'new', 'b', False),
            ('open', False, 'h', 'new', False),
        ]:
            current = {'state': state, 'draft': draft, 'head': {'sha': head}, 'base': {'sha': base}}
            prelude = ('const context={repo:{owner:"o",repo:"r"},payload:{pull_request:'
                       '{number:1,head:{sha:"h"},base:{sha:"b"}}}};'
                       'const github={rest:{pulls:{get:async()=>({data:' + json.dumps(current) + '})}}};')
            result = subprocess.run(['node', '-e', prelude + '(async()=>{' + script + '})().catch(()=>process.exit(1));'],
                                    capture_output=True)
            self.assertEqual(result.returncode == 0, passes, current)

    def test_only_reviewed_workflow_shapes_accepted(self):
        source = (ROOT / '.github/workflows/policy-guard.yml').read_text()
        for name in ['ci.yml', 'pr-validation.yml']:
            doc = canonical_keys(workflow(name))
            if True in doc:
                doc['on'] = doc.pop(True)
            for job in doc['jobs'].values():
                for step in job.get('steps', []):
                    if isinstance(step.get('uses'), str):
                        step['uses'] = re.sub(r'@[0-9a-f]{40}$', '@PINNED', step['uses'])
            line = next(line for line in source.splitlines() if f"'.github/workflows/{name}': (" in line)
            digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
            self.assertIn(digest(doc), line)
            doc['jobs']['unexpected'] = {'runs-on': 'ubuntu-latest', 'steps': [{'run': 'true'}]}
            self.assertNotIn(digest(doc), line)


if __name__ == '__main__':
    unittest.main()
