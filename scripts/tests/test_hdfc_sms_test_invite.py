"""Synthetic issuer tests: subprocess is stubbed; never contact Cloudflare."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('invite_issuer', Path(__file__).resolve().parents[1] / 'hdfc_sms_test_invite.py')
issuer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(issuer)


class InviteIssuerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / 'invite.json'
        self.journal = Path(str(self.output) + '.pending.json')
        self.env = patch.dict(os.environ, {'AVATOK_TARGET': 'staging'}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.row = None
        self.calls = []
        self.files = []
        self.fail_insert = False
        self.commit_on_failure = False
        self.bad_read = False

    def remote(self, args, **kwargs):
        self.assertIsInstance(args, list)
        self.assertEqual(args[:6], [str(issuer.ROOT / 'scripts/cf.sh'), 'worker', 'd1', 'execute', 'DB_META', '--remote'])
        self.assertEqual(kwargs['env']['AVATOK_TARGET'], os.environ['AVATOK_TARGET'])
        self.assertEqual(kwargs['env'].get('ALLOW_PROD'), os.environ.get('ALLOW_PROD'))
        self.assertTrue(kwargs['capture_output'])
        self.assertNotIn('shell', kwargs)
        record = json.loads(self.journal.read_text())
        self.assertNotIn(record['token'], ' '.join(args))
        if '--command' in args:
            sql = args[args.index('--command') + 1]
            self.assertIn('--json', args)
            self.assertNotIn('--file', args)
            rows = [] if self.row is None else [self.row]
            out = 'unparseable raw secret output' if self.bad_read else json.dumps([{'success': True, 'results': rows}])
            self.calls.append(('read', sql))
            return SimpleNamespace(returncode=0, stdout=out, stderr='')
        path = Path(args[args.index('--file') + 1])
        self.files.append(path)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        sql = path.read_text()
        self.assertNotIn(record['token'], sql)
        self.assertIn(record['token_hash'], sql)
        self.calls.append(('write', sql))
        if not self.fail_insert or self.commit_on_failure:
            self.row = issuer.expected_row(record)
        return SimpleNamespace(returncode=1 if self.fail_insert else 0, stdout='suppressed remote output', stderr='suppressed')

    def issue(self, apply=True):
        return issuer.issue('https://avatok.example', str(self.output), 24, apply)

    def test_prepare_requires_apply_and_saves_no_shareable_output(self):
        with patch.object(issuer.subprocess, 'run') as run:
            self.assertFalse(self.issue(False))
            run.assert_not_called()
        self.assertFalse(self.output.exists())
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)
        record = json.loads(self.journal.read_text())
        self.assertTrue(re.fullmatch('[a-f0-9]{64}', record['token']))
        self.assertEqual(len(bytes.fromhex(record['token'])), 32)
        self.assertEqual(record['token_hash'], hashlib.sha256(record['token'].encode()).hexdigest())

    def test_verified_issue_wrapper_hash_only_output_permissions_and_no_secrets_in_logs(self):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(issuer.subprocess, 'run', side_effect=self.remote), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = issuer.main(['--origin', 'https://avatok.example', '--output', str(self.output), '--apply'])
        self.assertEqual(result, 0)
        record, result = json.loads(self.journal.read_text()), json.loads(self.output.read_text())
        self.assertEqual(result['url'], 'https://avatok.example/test/upi#invite=' + record['token'])
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(record['token'], out.getvalue() + err.getvalue())
        self.assertNotIn(result['url'], out.getvalue() + err.getvalue())
        self.assertEqual([c[0] for c in self.calls], ['read', 'write', 'read'])
        self.assertTrue(all(not path.exists() for path in self.files))

    def test_uncertain_write_retains_same_token_and_verified_retry_never_mints_another(self):
        self.fail_insert = True
        with patch.object(issuer.subprocess, 'run', side_effect=self.remote):
            with self.assertRaises(issuer.InviteError):
                self.issue()
            original = self.journal.read_text()
            self.assertFalse(self.output.exists())
            self.fail_insert = False
            self.assertTrue(self.issue())
            self.assertEqual(self.journal.read_text(), original)
            writes = len([c for c in self.calls if c[0] == 'write'])
            self.assertTrue(self.issue())
            self.assertEqual(len([c for c in self.calls if c[0] == 'write']), writes)

    def test_committed_but_failed_transport_is_verified_without_replacement(self):
        self.fail_insert = self.commit_on_failure = True
        with patch.object(issuer.subprocess, 'run', side_effect=self.remote):
            self.assertTrue(self.issue())
        self.assertEqual([c[0] for c in self.calls], ['read', 'write', 'read'])

    def test_unverified_read_never_writes_remote_or_output(self):
        self.bad_read = True
        out, err = io.StringIO(), io.StringIO()
        with patch.object(issuer.subprocess, 'run', side_effect=self.remote), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = issuer.main(['--origin', 'https://avatok.example', '--output', str(self.output), '--apply'])
        self.assertEqual(result, 1)
        self.assertFalse(self.output.exists())
        self.assertEqual([c[0] for c in self.calls], ['read'])
        self.assertNotIn('unparseable raw secret output', err.getvalue())

    def test_prod_guard_environment_is_inherited_never_fabricated(self):
        for allowed in [None, '1']:
            self.output = Path(self.temp.name) / ('prod-' + str(allowed) + '.json')
            self.journal = Path(str(self.output) + '.pending.json')
            self.row = None
            with patch.dict(os.environ, {'AVATOK_TARGET': 'prod', **({'ALLOW_PROD': allowed} if allowed else {})}, clear=True):
                def guarded(args, **kwargs):
                    result = self.remote(args, **kwargs)
                    return result if kwargs['env'].get('ALLOW_PROD') == '1' else SimpleNamespace(returncode=77, stdout='', stderr='guarded')
                with patch.object(issuer.subprocess, 'run', side_effect=guarded):
                    if allowed:
                        self.assertTrue(self.issue())
                    else:
                        with self.assertRaises(issuer.InviteError):
                            self.issue()
                        self.assertFalse(self.output.exists())

    def test_mismatched_resume_arguments_private_paths_and_hours_fail_before_remote(self):
        self.issue(False)
        original = self.journal.read_text()
        with patch.object(issuer.subprocess, 'run') as run:
            for origin, output, hours in [
                ('https://different.example', str(self.output), 24),
                ('https://avatok.example', str(self.output), 1),
                ('https://avatok.example/path', str(self.output), 24),
                ('https://avatok.example', str(issuer.ROOT / 'invite.json'), 24),
                ('https://avatok.example', str(self.output), 0),
                ('https://avatok.example', str(self.output), 73),
            ]:
                with self.assertRaises(issuer.InviteError):
                    issuer.issue(origin, output, hours, True)
            os.chmod(self.journal, 0o644)
            with self.assertRaises(issuer.InviteError):
                self.issue()
            run.assert_not_called()
        self.assertEqual(self.journal.read_text(), original)

    def test_verification_rejects_changed_remote_identity_without_output(self):
        self.issue(False)
        self.row = {**issuer.expected_row(json.loads(self.journal.read_text())), 'expires_at': 1}
        with patch.object(issuer.subprocess, 'run', side_effect=self.remote):
            with self.assertRaises(issuer.InviteError):
                self.issue()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
