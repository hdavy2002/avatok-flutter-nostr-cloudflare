#!/usr/bin/env python3
"""Issue a private customer test invite through the guarded D1 wrapper.

Repeat the identical --origin/--output after any uncertain result. A private
.pending.json journal retains the SAME token; no second invitation is minted.
The shareable output is written only after exact remote-row verification.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


class InviteError(Exception):
    """Only fixed, safe operational messages may cross the CLI boundary."""


def private_path(value):
    raw = Path(value).expanduser()
    path = raw.resolve()
    if not raw.is_absolute() or path == ROOT or ROOT in path.parents:
        raise InviteError('output must be an absolute path outside the repository')
    if raw.is_symlink():
        raise InviteError('private artifacts must not be symlinks')
    return path


def read_private(path):
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise InviteError('private artifact permissions must be 0600')
    return json.loads(path.read_text())


def write_once(path, value):
    if path.exists():
        if read_private(path) != value:
            raise InviteError('existing private artifact differs; use the original arguments')
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out, sort_keys=True)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())


def origin_value(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or
            parsed.password or parsed.path not in ('', '/') or parsed.query or
            parsed.fragment or re.search(r'\s', value)):
        raise InviteError('origin must be an explicit HTTPS web origin')
    return value.rstrip('/')


def target_value():
    target = os.environ.get('AVATOK_TARGET')
    if not target:
        marker = ROOT / '.avatok-target'
        target = marker.read_text().strip() if marker.exists() else None
    if target not in ('staging', 'prod'):
        raise InviteError('set AVATOK_TARGET or .avatok-target explicitly before issuing')
    return target


def validate_journal(record, origin, target, hours):
    try:
        valid = (record['format_version'] == 1 and record['origin'] == origin and
                 record['target'] == target and record['hours'] == hours and
                 str(uuid.UUID(record['invite_id'])) == record['invite_id'] and
                 re.fullmatch(r'[a-f0-9]{64}', record['token']) and
                 record['token_hash'] == hashlib.sha256(record['token'].encode()).hexdigest() and
                 isinstance(record['created_at'], int) and
                 record['expires_at'] == record['created_at'] + hours * 3600000)
    except (KeyError, TypeError, ValueError):
        valid = False
    if not valid:
        raise InviteError('private journal mismatch; retain it and use the original arguments')


def run_sql(target, sql, read=False):
    # Never use shell=True or put the invitation token in SQL/argv/logs.
    fd, name = tempfile.mkstemp(prefix='hdfc-invite-', suffix='.sql')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write(sql)
        args = [str(ROOT / 'scripts/cf.sh'), 'worker', 'd1', 'execute',
                'DB_META', '--remote']
        # --file imports SQL; SELECT readback must use the query command path.
        args += ['--command', sql, '--json'] if read else ['--file', name, '--yes']
        # Preserve ALLOW_PROD exactly as supplied; cf.sh remains the prod guard.
        proc = subprocess.run(args, cwd=ROOT,
                              env=dict(os.environ, AVATOK_TARGET=target),
                              text=True, capture_output=True, timeout=120)
        if proc.returncode:
            raise InviteError('D1 operation uncertain; retry the same output and arguments')
        return proc.stdout
    except (OSError, subprocess.SubprocessError):
        raise InviteError('D1 operation uncertain; retry the same output and arguments') from None
    finally:
        Path(name).unlink(missing_ok=True)


def expected_row(record):
    return {key: record[key] for key in ('invite_id', 'token_hash', 'created_at', 'expires_at')}


def verify(record):
    # Values are generated locally and revalidated before interpolation.
    sql = ("SELECT invite_id,token_hash,created_at,expires_at FROM hdfc_sms_test_invites "
           f"WHERE invite_id='{record['invite_id']}' OR token_hash='{record['token_hash']}';")
    output = run_sql(record['target'], sql, read=True)
    try:
        result = json.loads(output)
        if not isinstance(result, list) or len(result) != 1 or result[0].get('success') is not True:
            raise ValueError()
        rows = result[0]['results']
        if rows == []:
            return False
        if rows == [expected_row(record)]:
            return True
    except (ValueError, TypeError, KeyError):
        pass
    raise InviteError('D1 verification failed; private journal retained; do not issue a replacement')


def issue(origin, output, hours=24, apply=False):
    if not isinstance(hours, int) or not 1 <= hours <= 72:
        raise InviteError('hours must be between 1 and 72')
    origin, target, output = origin_value(origin), target_value(), private_path(output)
    journal = output.with_name(output.name + '.pending.json')
    if journal.exists():
        record = read_private(journal)
    elif output.exists():
        raise InviteError('output exists without its journal; do not issue a replacement')
    else:
        token = secrets.token_hex(32)
        created = time.time_ns() // 1000000
        record = dict(format_version=1, origin=origin, target=target, hours=hours,
                      invite_id=str(uuid.uuid4()), token=token,
                      token_hash=hashlib.sha256(token.encode()).hexdigest(),
                      created_at=created, expires_at=created + hours * 3600000)
        write_once(journal, record)
    validate_journal(record, origin, target, hours)
    if not apply:
        return False
    # Verify BEFORE any retry write. Unknown reads never trigger a new insert.
    if not verify(record):
        sql = ("INSERT INTO hdfc_sms_test_invites(invite_id,token_hash,created_at,expires_at) "
               f"VALUES('{record['invite_id']}','{record['token_hash']}',"
               f"{record['created_at']},{record['expires_at']}) ON CONFLICT(invite_id) DO NOTHING;")
        try:
            run_sql(target, sql)
        except InviteError:
            # A transport failure can still mean committed. Verify the same row.
            if not verify(record):
                raise InviteError('insertion not verified; retry the same output and arguments') from None
        else:
            if not verify(record):
                raise InviteError('insertion not verified; retry the same output and arguments')
    write_once(output, dict(invite_id=record['invite_id'], expires_at=record['expires_at'],
                            url=origin + '/test/upi#invite=' + record['token']))
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--hours', type=int, default=24)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        complete = issue(args.origin, args.output, args.hours, args.apply)
    except Exception as error:
        # Raw exceptions/remote stdout can contain SQL or private artifacts.
        message = str(error) if isinstance(error, InviteError) else 'operation failed; private journal retained; retry the same arguments'
        print('hdfc invite: ' + message, file=sys.stderr)
        return 1
    print('Invitation verified; private output saved.' if complete else
          'Private invitation prepared; --apply is required for remote issuance.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
