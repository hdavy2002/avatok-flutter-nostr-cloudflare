#!/usr/bin/env python3
"""[HF-POLICY-WITHDRAW-1] Re-pin the Hello Fraands registration policy versions.

worker/src/lib/hf_registration_policies.ts pins the SHA-256 of each linked
web/src/pages/*.astro policy page. Editing a policy page changes its hash; run
this afterwards (it rewrites the pins in place) so the test "pins versions to the
linked policy sources" passes. A changed pin is also what makes the dashboard ask
existing users to accept the new version.   Usage: python3 scripts/hf_policy_hashes.py
"""
import hashlib, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
target = root / "worker/src/lib/hf_registration_policies.ts"
text = target.read_text()

def repl(m):
    path = m.group(2)
    digest = hashlib.sha256((root / f"web/src/pages{path}.astro").read_bytes()).hexdigest()
    return f'{m.group(1)}{path}", version: "sha256:{digest}"'

new = re.sub(r'(\w+: \{ path: ")(/[a-z-]+)", version: "sha256:[0-9a-f]{64}"', repl, text)
if new != text:
    target.write_text(new)
    print("re-pinned policy hashes")
else:
    print("policy hashes already current")
sys.exit(0)
