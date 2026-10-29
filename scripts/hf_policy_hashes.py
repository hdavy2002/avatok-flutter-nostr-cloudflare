#!/usr/bin/env python3
"""[HF-PAGES-2] RETIRED. Policy pins are no longer SHA-256 hashes of web/src/pages/*.astro files.

Until HF-PAGES-2 this script re-pinned worker/src/lib/hf_registration_policies.ts after every edit to a policy page.
Now the five agreements (terms, privacy, disclaimer, community-guidelines, rules-of-engagement) live in D1 `site_pages` and the pin is
    site:<slug>:<material_version>
read from the database. To ask every user to accept a changed agreement again, save the edit through the admin API with
    PUT /api/admin/hf/pages/<slug>   { ..., "material": true }
An ordinary edit (no "material") never asks anyone to re-accept. Update HF_POLICY_CHANGE_NOTE in hf_registration_policies.ts first, so the prompt
says what changed. Nothing to run here; kept so old instructions fail loudly instead of silently editing the wrong thing.
"""
import sys
print(__doc__)
sys.exit(0)
