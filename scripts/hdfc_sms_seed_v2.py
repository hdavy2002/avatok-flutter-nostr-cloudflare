#!/usr/bin/env python3
"""One-shot frozen legacy exclusion seed. Never used by normal Worker requests.

prepare is read-only. apply executes one atomic D1 file import through cf.sh.
Private manifest and generated SQL live outside git with mode 0600. Only counts
and the deterministic seed digest are printed; subprocess errors are redacted.
Cloudflare documents atomic --file imports:
https://blog.cloudflare.com/building-d1-a-global-database/
No BEGIN/COMMIT is emitted (D1 imports already run in a transaction).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / 'worker/migrations/2026-09-18-hdfc-sms-smoke-v2.sql'
MAX_ROWS = 1000
REFERENCE = re.compile(r'\b(?:UTR|UPI\s*(?:REF(?:ERENCE)?|RRN)|REF(?:ERENCE)?(?:\s*NO\.?)?)\s*[:#-]?\s*(\d{12})(?![A-Za-z0-9])|\(\s*UPI\s+(\d{12})\s*\)', re.I)
ACCOUNT = re.compile(r'\b(?:a\s*/\s*c|acct|account|ac)\b\s*(?:(?:no\.?|number)\s*)?[:.\-]?\s*([xX*0-9]+)(?![A-Za-z0-9])', re.I)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def bank_reference(body):
    refs = {a or b for a, b in REFERENCE.findall(body)}
    if len(refs) > 1:
        raise ValueError('ambiguous legacy bank reference')
    return next(iter(refs), None)


def seed_rows(inventory, suffix):
    if not re.fullmatch(r'\d{4,6}', suffix):
        raise ValueError('invalid configured account suffix')
    account = hashlib.sha256(f'HDFC|{suffix}|INR'.encode()).hexdigest()
    receipts = sorted(inventory['receipts'], key=lambda r: (r['created_at'], r['message_hash']))
    rows, reserved = [], set()
    for r in receipts:
        hashes = r['message_hash']
        if not isinstance(hashes, str) or not hashes or len(hashes) > 128 or hashes.startswith('legacy-intent:'):
            raise ValueError('unsupported legacy hash')
        values = ACCOUNT.findall(r['message'])
        # A missing or contradictory account cannot be assigned from today's config.
        if not values or any(not v.endswith(suffix) for v in values):
            raise ValueError('ambiguous legacy account attribution')
        ref = bank_reference(r['message'])
        duplicate = ref is not None and ref in reserved
        reason = 'legacy_duplicate_reference' if duplicate else 'legacy_receipt'
        rows.append(dict(message_hash=hashes, receiving_account_key=account,
                         bank_reference=None if duplicate else ref, ingested_at=r['created_at'], reason_code=reason))
        if ref:
            reserved.add(ref)
    # Intent-only reservations have no invented raw SMS or receipt metadata. The
    # original single-bank harness had no per-intent account field; this is its
    # explicitly supplied bank namespace, checked against every stored receipt.
    for i in sorted(inventory['intents'], key=lambda r: (r['created_at'], r['intent_id'])):
        raw = i.get('bank_reference')
        ref = raw.strip() if isinstance(raw, str) and re.fullmatch(r'\d{12}', raw.strip()) else None
        if ref and ref not in reserved:
            rows.append(dict(message_hash='legacy-intent:' + i['intent_id'], receiving_account_key=account,
                             bank_reference=ref, ingested_at=i['created_at'], reason_code='legacy_reference_only'))
            reserved.add(ref)
    return account, rows


def make_manifest(inventory, suffix, target, cutover_ms, schema_text):
    if any(len(inventory[k]) > MAX_ROWS for k in ('receipts', 'intents')):
        raise ValueError('legacy inventory exceeds bounded one-shot migration')
    account, rows = seed_rows(inventory, suffix)
    manifest = dict(format_version=2, target=target, cutover_ms=cutover_ms,
                    receiving_account_key=account, inventory=inventory, seed_rows=rows,
                    schema_sha256=hashlib.sha256(schema_text.encode()).hexdigest())
    manifest['seed_digest'] = digest(manifest)
    return manifest


def validate_manifest(m, target, schema_text):
    payload = {k: v for k, v in m.items() if k != 'seed_digest'}
    if m.get('format_version') != 2 or m.get('target') != target or digest(payload) != m.get('seed_digest'):
        raise ValueError('manifest identity mismatch')
    if m['schema_sha256'] != hashlib.sha256(schema_text.encode()).hexdigest():
        raise ValueError('migration schema changed after prepare')
    if not isinstance(m['cutover_ms'], int) or m['cutover_ms'] % 1000:
        raise ValueError('invalid frozen cutover')


def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def guard(condition):
    # Invalid JSON aborts the import transaction without adding a third state table.
    return "SELECT CASE WHEN (" + condition + ") THEN 1 ELSE json('hdfc_seed_guard_failed') END;"


def inventory_guard(inventory):
    clauses = []
    for key, table in [('receipts', 'hdfc_sms_receipts'), ('intents', 'hdfc_sms_payment_intents')]:
        rows = inventory[key]
        clauses.append(f'(SELECT count(*) FROM {table})={len(rows)}')
        for row in rows:
            predicates = [f'{column} IS {literal(value)}' for column, value in sorted(row.items())]
            clauses.append(f'EXISTS(SELECT 1 FROM {table} WHERE ' + ' AND '.join(predicates) + ')')
    return guard(' AND '.join(clauses))


def seed_sql(m, schema_text):
    validate_manifest(m, m['target'], schema_text)
    parts = [schema_text, inventory_guard(m['inventory'])]
    # A migration rerun must not overwrite a v2 claim or quietly relabel a row.
    parts.append(guard('(SELECT count(*) FROM hdfc_sms_smoke_intents)=0'))
    for r in m['seed_rows']:
        # Canonical JSON sorts object keys; use the same order before and after
        # loading the immutable manifest so its SQL sidecar stays byte-identical.
        keys = sorted(r)
        columns = ','.join(keys)
        values = ','.join(literal(r[key]) for key in keys)
        parts.append(f"INSERT INTO hdfc_sms_smoke_receipts({columns},disposition) VALUES({values},'legacy') ON CONFLICT(message_hash) DO NOTHING;")
        predicates = [f'{key} IS {literal(r[key])}' for key in keys]
        predicates += ["disposition='legacy'", 'claimed_intent_id IS NULL', 'claimed_at IS NULL']
        parts.append(guard('EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts WHERE ' + ' AND '.join(predicates) + ')'))
    parts.append(guard(f"(SELECT count(*) FROM hdfc_sms_smoke_receipts)={len(m['seed_rows'])}"))
    # Final immutable readiness literal. A different manifest cannot replace it.
    parts.append('CREATE VIEW IF NOT EXISTS hdfc_sms_smoke_ready AS SELECT 2 AS protocol_version, '
                 + str(m['cutover_ms']) + ' AS cutover_ms, ' + literal(m['seed_digest']) + ' AS seed_digest, '
                 + literal(m['receiving_account_key']) + ' AS receiving_account_key;')
    parts.append(guard('EXISTS(SELECT 1 FROM hdfc_sms_smoke_ready WHERE protocol_version=2 AND cutover_ms='
                       + str(m['cutover_ms']) + ' AND seed_digest=' + literal(m['seed_digest'])
                       + ' AND receiving_account_key=' + literal(m['receiving_account_key']) + ')'))
    return '\n'.join(parts) + '\n'


def run_wrapper(target, *args):
    env = dict(os.environ, AVATOK_TARGET=target)
    # Production wrapper refuses unless caller explicitly set ALLOW_PROD=1.
    proc = subprocess.run([str(ROOT / 'scripts/cf.sh'), 'worker', 'd1', 'execute', 'DB_META', '--remote', *args],
                          cwd=ROOT, env=env, text=True, capture_output=True)
    if proc.returncode:
        raise RuntimeError('D1 wrapper failed; raw output suppressed; retry same manifest')
    return proc.stdout


def query(target, sql):
    output = run_wrapper(target, '--command', sql, '--json')
    try:
        results = json.loads(output)
        if not isinstance(results, list) or any(not r.get('success', True) for r in results):
            raise ValueError()
        return results
    except (ValueError, TypeError):
        raise RuntimeError('D1 response invalid; raw output suppressed') from None


def snapshot(target):
    results = query(target, f'SELECT * FROM hdfc_sms_receipts ORDER BY created_at,message_hash LIMIT {MAX_ROWS+1};'
                    + f'SELECT * FROM hdfc_sms_payment_intents ORDER BY created_at,intent_id LIMIT {MAX_ROWS+1};')
    if len(results) != 2:
        raise RuntimeError('unexpected legacy snapshot result count')
    return dict(receipts=results[0]['results'], intents=results[1]['results'])


def readiness(target):
    tables = query(target, "SELECT name FROM sqlite_master WHERE type='view' AND name='hdfc_sms_smoke_ready';")
    if not tables[0]['results']:
        return None
    rows = query(target, 'SELECT * FROM hdfc_sms_smoke_ready;')[0]['results']
    if len(rows) != 1:
        raise ValueError('invalid readiness marker')
    return rows[0]


def private_path(value):
    path = Path(value).expanduser().resolve()
    if not Path(value).expanduser().is_absolute() or path == ROOT or ROOT in path.parents:
        raise ValueError('manifest must be an absolute durable path outside the repository')
    return path


def write_once(path, content):
    if path.exists():
        if path.read_text() != content:
            raise ValueError('immutable migration artifact differs; do not overwrite')
        if path.stat().st_mode & 0o077:
            raise ValueError('private artifact must have mode 0600')
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(content)
        out.flush()
        os.fsync(out.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'apply'])
    parser.add_argument('--target', choices=['staging', 'prod'], required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--account-suffix-env', default='HDFC_SMS_ACCOUNT_SUFFIX')
    args = parser.parse_args()
    path = private_path(args.manifest)
    schema = SCHEMA.read_text()
    if path.exists():
        if path.stat().st_mode & 0o077:
            raise ValueError('manifest permissions must be 0600')
        m = json.loads(path.read_text())
        validate_manifest(m, args.target, schema)
    elif args.mode == 'prepare':
        if readiness(args.target):
            raise ValueError('v2 already ready; use the original durable manifest')
        inventory = snapshot(args.target)
        m = make_manifest(inventory, os.environ.get(args.account_suffix_env, ''), args.target,
                          ((time.time_ns() // 1000000 + 999) // 1000) * 1000, schema)
        write_once(path, canonical(m) + '\n')
    else:
        raise ValueError('prepare the frozen manifest before apply')
    sql_path = path.with_suffix(path.suffix + '.sql')
    write_once(sql_path, seed_sql(m, schema))
    if args.mode == 'apply':
        marker = readiness(args.target)
        if marker:
            if marker != dict(protocol_version=2, cutover_ms=m['cutover_ms'], seed_digest=m['seed_digest'], receiving_account_key=m['receiving_account_key']):
                raise ValueError('different readiness marker; refusing migration')
            # Successful prior import: no legacy re-scan or write after v2 resumes.
        else:
            if snapshot(args.target) != m['inventory']:
                raise ValueError('legacy source inventory changed; keep ingress paused and investigate')
            run_wrapper(args.target, '--file', str(sql_path), '--yes')
            marker = readiness(args.target)
            if not marker or marker['seed_digest'] != m['seed_digest']:
                raise RuntimeError('readiness not confirmed; retry original manifest')
    print(canonical(dict(mode=args.mode, receipt_count=len(m['inventory']['receipts']), intent_count=len(m['inventory']['intents']), reservation_count=len(m['seed_rows']), seed_digest=m['seed_digest'])))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Only our fixed messages escape: never a raw remote response or reference.
        safe = str(error) if isinstance(error, (ValueError, RuntimeError)) else 'seed operation failed; private artifacts retained'
        print('hdfc seed: ' + safe, file=sys.stderr)
        sys.exit(1)
