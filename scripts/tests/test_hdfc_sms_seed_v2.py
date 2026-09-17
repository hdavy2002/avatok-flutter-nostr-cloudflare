"""CI-only real SQLite seed regression tests; never contacts D1.

The transaction harness validates SQL rollback/invariants. It does not simulate
or claim to verify Wrangler transport; atomic file import is Cloudflare's contract.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('hdfc_seed', ROOT / 'scripts/hdfc_sms_seed_v2.py')
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)
SCHEMA = seed.SCHEMA.read_text()
BASE = (ROOT / 'worker/migrations/2026-09-17-hdfc-sms-payments.sql').read_text()


def old_receipt(hash_value, ref='000123456789', created=1, suffix='1234'):
    return dict(message_hash=hash_value, device_id='synthetic-device', sender='VM-HDFCBK',
                message=f'Rs.1.00 credited to A/c XX{suffix} from Shopping sapin@okhdfc (UPI {ref})',
                received_at='2026-09-18T12:00:00+03:00', nonce='n-' + hash_value, created_at=created)


def old_intent(id_value, ref=None, created=0):
    return dict(intent_id=id_value, uid='admin', listing_id='avatok-upi-smoke-2026', kind='live_event',
                amount_paise=100, status='confirmed', bank_reference=ref, commercial_order_id=None,
                last_error=None, expires_at=1, created_at=created, updated_at=0)


def insert_rows(db, inventory):
    for key, table in [('receipts', 'hdfc_sms_receipts'), ('intents', 'hdfc_sms_payment_intents')]:
        for row in inventory[key]:
            db.execute(f"INSERT INTO {table}({','.join(row)}) VALUES({','.join('?' for _ in row)})", list(row.values()))
    db.commit()


def transactional_sql(db, sql):
    """Execute exact artifact statements in a real SQLite transaction for tests."""
    db.execute('BEGIN')
    pending = ''
    try:
        for char in sql:
            pending += char
            if char == ';' and sqlite3.complete_statement(pending):
                db.execute(pending)
                pending = ''
        if pending.strip():
            raise AssertionError('unterminated SQL')
        db.commit()
    except Exception:
        db.rollback()
        raise


class SeedTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.executescript(BASE)
        self.inventory = dict(receipts=[old_receipt('b', created=2), old_receipt('a', created=1), old_receipt('c', ref='unsupported')],
                              intents=[old_intent('intent-only', '000123456788'), old_intent('random', 'sms:not-a-bank-reference'), old_intent('already-reserved', '000123456789')])
        insert_rows(self.db, self.inventory)
        self.m = seed.make_manifest(self.inventory, '1234', 'staging', 2000, SCHEMA)

    def tearDown(self):
        self.db.close()

    def test_duplicate_legacy_reference_preserves_every_hash_and_intent_only_reservations(self):
        transactional_sql(self.db, seed.seed_sql(self.m, SCHEMA))
        rows = [dict(r) for r in self.db.execute('SELECT * FROM hdfc_sms_smoke_receipts ORDER BY message_hash')]
        self.assertEqual(len(rows), 4)
        self.assertEqual([r['bank_reference'] for r in rows if r['message_hash'] == 'a'], ['000123456789'])
        sibling = next(r for r in rows if r['message_hash'] == 'b')
        self.assertIsNone(sibling['bank_reference'])
        self.assertEqual(sibling['reason_code'], 'legacy_duplicate_reference')
        intent = next(r for r in rows if r['message_hash'] == 'legacy-intent:intent-only')
        self.assertEqual(intent['bank_reference'], '000123456788')
        self.assertIsNone(intent['amount_paise'])
        self.assertIsNone(intent['received_at_ms'])
        self.assertTrue(all(r['disposition'] == 'legacy' and r['claimed_intent_id'] is None for r in rows))
        self.assertEqual(self.db.execute('SELECT count(*) FROM hdfc_sms_receipts').fetchone()[0], 3)
        self.assertEqual(self.db.execute('SELECT seed_digest FROM hdfc_sms_smoke_ready').fetchone()[0], self.m['seed_digest'])

    def test_manifest_is_deterministic_and_tampering_schema_or_cutover_fails(self):
        again = seed.make_manifest(self.inventory, '1234', 'staging', 2000, SCHEMA)
        self.assertEqual(self.m, again)
        damaged = dict(self.m, cutover_ms=3000)
        with self.assertRaises(ValueError):
            seed.validate_manifest(damaged, 'staging', SCHEMA)
        with self.assertRaises(ValueError):
            seed.validate_manifest(self.m, 'staging', SCHEMA + '-- edit')
        with self.assertRaises(ValueError):
            seed.validate_manifest(self.m, 'prod', SCHEMA)
        self.assertNotIn('BEGIN', seed.seed_sql(self.m, SCHEMA))
        self.assertNotIn('COMMIT', seed.seed_sql(self.m, SCHEMA))

    def test_ambiguous_account_and_multiple_references_abort_preflight(self):
        for message in ['Rs.1 credited (UPI 000123456789)', 'Rs.1 credited A/c XX9999 (UPI 000123456789)', 'Rs.1 credited A/c XX1234 (UPI 000123456789) UTR 000123456788']:
            inventory = dict(receipts=[dict(old_receipt('ambiguous'), message=message)], intents=[])
            with self.assertRaises(ValueError):
                seed.make_manifest(inventory, '1234', 'staging', 2000, SCHEMA)
        with self.assertRaises(ValueError):
            seed.make_manifest(dict(receipts=[old_receipt(str(n)) for n in range(1001)], intents=[]), '1234', 'staging', 2000, SCHEMA)

    def test_source_drift_aborts_entire_transaction_before_readiness(self):
        self.db.execute("UPDATE hdfc_sms_receipts SET message=message||' changed' WHERE message_hash='a'")
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            transactional_sql(self.db, seed.seed_sql(self.m, SCHEMA))
        self.assertEqual(self.db.execute("SELECT count(*) FROM sqlite_master WHERE name='hdfc_sms_smoke_ready'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM sqlite_master WHERE name='hdfc_sms_smoke_receipts'").fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM hdfc_sms_receipts').fetchone()[0], 3)

    def test_seed_rerun_keeps_legacy_and_never_relabels_existing_v2_claim(self):
        sql = seed.seed_sql(self.m, SCHEMA)
        transactional_sql(self.db, sql)
        transactional_sql(self.db, sql)
        account = self.m['receiving_account_key']
        self.db.execute("INSERT INTO hdfc_sms_smoke_intents(intent_id,uid,request_key,receiving_account_key,created_at,expires_at,recover_until,updated_at) VALUES('new','admin','key',?,2000,3000,86403000,2000)", [account])
        self.db.execute("INSERT INTO hdfc_sms_smoke_receipts(message_hash,receiving_account_key,bank_reference,amount_paise,currency,received_at_ms,received_at_end_ms,ingested_at,disposition,claimed_intent_id,claimed_at) VALUES('new-hash',?,'000123456777',100,'INR',2001,2001,2002,'accepted','new',2003)", [account])
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            transactional_sql(self.db, sql)
        row = self.db.execute("SELECT disposition,claimed_intent_id FROM hdfc_sms_smoke_receipts WHERE message_hash='new-hash'").fetchone()
        self.assertEqual(tuple(row), ('accepted', 'new'))
        self.assertEqual(self.db.execute('SELECT seed_digest FROM hdfc_sms_smoke_ready').fetchone()[0], self.m['seed_digest'])

    def test_nonlegacy_null_metadata_is_rejected(self):
        transactional_sql(self.db, seed.seed_sql(self.m, SCHEMA))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO hdfc_sms_smoke_receipts(message_hash,receiving_account_key,ingested_at,disposition) VALUES('invalid','x',0,'accepted')")
        self.db.rollback()

    def test_successful_apply_retry_is_read_only_and_private_artifacts_are_immutable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private.json'
            seed.write_once(path, seed.canonical(self.m) + '\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                seed.write_once(path, 'changed')
            marker = dict(protocol_version=2, cutover_ms=self.m['cutover_ms'], seed_digest=self.m['seed_digest'], receiving_account_key=self.m['receiving_account_key'])
            with patch.object(seed, 'readiness', return_value=marker), patch.object(seed, 'snapshot') as snapshot, patch.object(seed, 'run_wrapper') as wrapper, patch('sys.argv', ['seed', 'apply', '--target', 'staging', '--manifest', str(path)]), contextlib.redirect_stdout(io.StringIO()) as out:
                seed.main()
            snapshot.assert_not_called()
            wrapper.assert_not_called()
            output = json.loads(out.getvalue())
            self.assertEqual(output['seed_digest'], self.m['seed_digest'])
            self.assertNotIn('000123456789', out.getvalue())
            self.assertNotIn('sapin', out.getvalue())


if __name__ == '__main__':
    unittest.main()
