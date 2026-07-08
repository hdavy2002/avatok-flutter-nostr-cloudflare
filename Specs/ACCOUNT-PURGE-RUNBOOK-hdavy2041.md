# Full Account Purge Runbook — hdavy2041@gmail.com (2026-07-08)

Goal: fully remove this Gmail's account(s) so a fresh signup re-experiences first-run
onboarding. There is **no admin "delete by email"** endpoint — deletion is self-serve
(authenticated) + a 30-day-grace cascade (`worker/src/routes/account.ts` →
`consumers/src/deletion.ts`). The cascade auto-deletes the **Clerk user** (step 13) and
**PostHog person** (step 14), so it is a genuine full purge once it runs.

## Identifiers (from PostHog)
This Gmail has **two Clerk accounts** + a legacy id — repeat the per-uid steps for BOTH:
- `user_3GCnsBsOgq0jkk8X6N3aY8LeD3H`
- `user_3AuqQadIDHJftJtTkLD0DtKM8MB`
- legacy: `npub14fzhc3x44cjcarel02m6qy3lvdvc0fhe7yj0ssusmp3nu57266ns6zmy84`

The backend keys on the Clerk `uid` (`user_…`).

## Steps (owner-run — requires Cloudflare/wrangler + device access)

1. **Release the AvaTOK number** (cascade does NOT free it). In-app: Settings → AvaTOK
   number → Release. (Optional — a fresh signup gets a new number regardless.)

2. **Request deletion.** Signed in as the account: Settings → Delete Account
   (`POST /api/account/delete`). Immediately wipes liveness evidence; writes a
   `deletion_requests` row (`status=pending`, `scheduled_at = now + 30d`).

3. **Skip the 30-day grace** so the cascade runs now (owner machine):
   ```bash
   wrangler d1 execute DB_META --remote \
     --command "UPDATE deletion_requests SET scheduled_at=0, status='pending', processed_at=NULL WHERE clerk_user_id='user_3GCnsBsOgq0jkk8X6N3aY8LeD3H'"
   ```
   Then re-enqueue to `Q_DELETE` (or let the cron sweep pick up the matured row).
   `handleDeletion` wipes 15 stores: DB_BRAIN → DB_WALLET → InboxDO → DB_MEDIA → R2
   blobs/verification/agent-audio → DB_MODERATION → DB_META → Vectorize → AI Search →
   KV → DOs → **Clerk** → **PostHog** → Stripe. Repeat for the 2nd `user_…` id.

4. **Clear the device** — uninstall / clear app data so local `onboarding_done`, saved
   profile, and identity keys are gone (true first run).

5. **Sign up again** with the Gmail → new Clerk uid → full onboarding.

## Notes / caveats
- Do steps 2–3 for BOTH `user_…` ids.
- The claimed number stays orphaned unless released in step 1.
- Everything here is destructive and irreversible; run it yourself. The agent will not
  execute production deletes.
