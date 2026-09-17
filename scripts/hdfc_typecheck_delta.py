#!/usr/bin/env python3
"""CI-only no-new-TypeScript-errors gate; baseline debt is reported, never hidden.
Both revisions use one installed compiler/dependency tree. Compare the diagnostic
multiset by filename/code/full message (ignore line offsets). Any diagnostic in a
changed Worker source file fails, even if it also existed in the approved baseline.
"""
from collections import Counter
import io
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tarfile
import tempfile

BASELINE = 'c06a87b29c75fc0f77d786cdb6c5639637d5d76c'
ROOT = Path(__file__).resolve().parents[1]
DIAGNOSTIC = re.compile(r'^(?:(.+)\(\d+,\d+\): )?error (TS\d+): (.*)$')


def git(*args):
    return subprocess.run(['git', '-C', str(ROOT), *args], check=True, capture_output=True).stdout


def diagnostics(repo, label):
    compiler = ROOT / 'worker/node_modules/typescript/bin/tsc'
    result = subprocess.run(['node', str(compiler), '--noEmit', '--pretty', 'false', '--project', 'tsconfig.json'],
                            cwd=repo / 'worker', text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=300)
    output = result.stdout.replace(str(repo / 'worker') + '/', '').replace(str(repo) + '/', '../')
    print(f'::group::{label} TypeScript diagnostics\n{output or "(none)"}\n::endgroup::', flush=True)
    records, current = [], None
    for line in output.splitlines():
        match = DIAGNOSTIC.match(line)
        if match:
            if current is not None:
                records.append(tuple(current))
            filename, code, message = match.groups()
            current = [filename or '<global>', code, message]
        elif line.startswith((' ', '\t')) and current is not None:
            current[-1] += '\n' + line
        elif line.strip():
            raise RuntimeError('Unrecognized compiler output: ' + line)
    if current is not None:
        records.append(tuple(current))
    if result.returncode not in (0, 1, 2) or bool(result.returncode) != bool(records):
        raise RuntimeError(label + ' compiler failed to complete a valid diagnostic run')
    return Counter(records)


def render(counter):
    return '\n'.join(f'{file}: error {code}: {message}' for (file, code, message), count in sorted(counter.items()) for _ in range(count)) or '(none)'


def main():
    if git('rev-parse', BASELINE + '^{commit}').decode().strip() != BASELINE:
        raise RuntimeError('Approved baseline commit unavailable')
    git('merge-base', '--is-ancestor', BASELINE, 'HEAD')
    changed = set(git('diff', '--name-only', BASELINE, '--', 'worker/src').decode().splitlines())
    modules = ROOT / 'worker/node_modules'
    if not modules.is_dir():
        raise RuntimeError('Install Worker dependencies first')
    with tempfile.TemporaryDirectory(prefix='hdfc-typecheck-baseline-') as temporary:
        baseline_root = Path(temporary)
        # Read-only git archive; no checkout/index/worktree mutations. The safe
        # extraction filter rejects escaping links and paths (CI Python >=3.12).
        with tarfile.open(fileobj=io.BytesIO(git('archive', '--format=tar', BASELINE)), mode='r:') as archive:
            archive.extractall(baseline_root, filter='data')
        (baseline_root / 'worker/node_modules').symlink_to(modules, target_is_directory=True)
        if (baseline_root / 'worker/tsconfig.json').read_bytes() != (ROOT / 'worker/tsconfig.json').read_bytes():
            raise RuntimeError('Worker tsconfig changed; baseline comparison cannot waive compiler settings changes')
        baseline = diagnostics(baseline_root, 'Approved baseline ' + BASELINE)
        candidate = diagnostics(ROOT, 'Candidate')
    added, resolved = candidate - baseline, baseline - candidate
    changed_errors = Counter({entry: count for entry, count in candidate.items()
                              if posixpath.normpath('worker/' + entry[0]) in changed})
    blocked = added | changed_errors
    summary = (
        '## HDFC Worker TypeScript comparison\n\n'
        f'Approved baseline: `{BASELINE}`. Both revisions used the same installed compiler/dependencies and unchanged strict settings.\n\n'
        f'- Existing baseline diagnostics: **{sum(baseline.values())}**\n'
        f'- Candidate diagnostics: **{sum(candidate.values())}**\n'
        f'- New diagnostics: **{sum(added.values())}**\n'
        f'- Diagnostics in changed source files: **{sum(changed_errors.values())}**\n'
        f'- Resolved baseline diagnostics: **{sum(resolved.values())}**\n\n'
        'Existing Worker typecheck debt remains visible; this gate does not claim a clean whole-Worker typecheck.\n\n'
        '### Blocking diagnostics\n\n```text\n' + render(blocked) + '\n```\n\n'
        '<details><summary>Existing baseline debt (full diagnostics)</summary>\n\n```text\n'
        + render(baseline) + '\n```\n\n</details>\n'
    )
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as out:
            out.write(summary)
    print(f'Baseline debt: {sum(baseline.values())}; candidate: {sum(candidate.values())}; new: {sum(added.values())}; changed-file errors: {sum(changed_errors.values())}; resolved: {sum(resolved.values())}.', flush=True)
    if blocked:
        print('::error::New or changed-file TypeScript diagnostics block deployment.\n' + render(blocked), flush=True)
        return 1
    if baseline:
        print('::warning::Existing baseline TypeScript debt remains; no new or changed-file diagnostics.', flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError, tarfile.TarError) as error:
        print('::error::TypeScript baseline comparison failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
