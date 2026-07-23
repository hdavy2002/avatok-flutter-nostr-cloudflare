# [TOKENS-100-GRANT-1] One-time HARD RESET of every user's token balance to 100

**Owner decision 2026-07-23. DESTRUCTIVE. DO NOT RUN until reviewed.** Resets EVERY
user to exactly **100 spendable tokens**, including users who purchased or spent —
**paid balance is wiped**. This is intentional. Run it manually against prod, once,
after a count + backup.

---

## Why this is NOT a plain `.sql` migration

Per-user balances are **authoritative in the WalletDO's own SQLite** (one Durable
Object per uid). The D1 tables (`wallet_balances`, `wallet_transactions`,
`wallet_ledger` in `DB_WALLET` / avatok-wallet) are only an **eventually-consistent
audit mirror** — `wallet.sql` says so: *"Never compute spendable balance from here —
read the DO."* There is therefore **no SQL statement that can reset real balances**;
`UPDATE wallet_balances …` would change only the mirror and users would keep spending
their real DO balances.

The correct reset pages the `users` table and issues the DO `hard_reset` op per uid.
That is what the admin backfill route below does (it mirrors the existing
`/api/admin/welcome-backfill`). The DO op sets `balance=0, held=0, free=0, premium=0`,
drops all earning holds, and sets `bonus = 100`, so spendable becomes exactly 100 in
the one-time, non-renewable "explore" state (daily grant is already 0 after
[TOKENS-100-GRANT-1]).

**Idempotent** per uid on op_id `hardreset:v1:<uid>` — re-running / resuming the loop
never double-applies. To ever reset again you must bump `RESET_VERSION` in
`worker/src/routes/token_reset.ts` (deliberate guard).

---

## STEP 0 — Count + backup (orchestrator, before running)

```bash
# Count of users that will be reset (authoritative population = DB_META.users):
ALLOW_PROD=1 npx wrangler d1 execute avatok-meta --remote \
  --command "SELECT COUNT(*) AS users_to_reset FROM users;"

# Backup the D1 balance mirror + ledger for rollback reference (real truth is the
# DOs, which cannot be dumped in bulk — this mirror is the best available snapshot):
ALLOW_PROD=1 npx wrangler d1 execute avatok-wallet --remote \
  --command "SELECT uid, balance, held, updated_at FROM wallet_balances ORDER BY uid;" \
  --json > backup-wallet_balances-2026-07-23.json
```

## STEP 1 — Deploy the worker carrying this route (already reviewed) and set the secret

```bash
# One-time shared secret so the reset can be driven from the host shell without a
# Clerk admin token. Fails CLOSED when unset. Unset it again after the run.
ALLOW_PROD=1 npx wrangler secret put TOKEN_RESET_SECRET   # paste a long random value
# (deploy the worker via the project's normal ALLOW_PROD deploy path)
```

## STEP 2 — Run the reset loop (paged, idempotent, resumable)

```bash
SECRET='<the TOKEN_RESET_SECRET value>'
BASE='https://api.avatok.ai/api/admin/token-hard-reset'
cursor=''
while : ; do
  resp=$(curl -s -X POST "${BASE}/${SECRET}?batch=100&cursor=${cursor}")
  echo "$resp"
  next=$(echo "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("next_cursor") or "")')
  [ -z "$next" ] && break
  cursor="$next"
done
```

Each page returns `{ processed, reset, amount, next_cursor, failed? }`. `reset` counts
FIRST-time applications; a resumed run shows `reset:0` for already-done users (dedup).
Re-run any page listing `failed` uids — it is safe.

## STEP 3 — (optional) Align the D1 audit mirror + note recon

The DOs are now correct. To keep the **display/audit mirror** consistent, reset it too.
This is display-only and does NOT change what users can spend (the DO already did that).
`wallet_balances` mirrors the **paid** `balance`, which the reset set to 0 (the 100 lives
in the promo `bonus` bucket, which is not mirrored here):

```sql
-- D1: avatok-wallet — align the paid-balance mirror to the post-reset DO state.
UPDATE wallet_balances SET balance = 0, held = 0, updated_at = strftime('%s','now') * 1000;
```

Nightly **recon** (`/api/admin/recon`, compares DO balance vs `wallet_ledger` Σ) will
report diffs for users who previously held PAID coins, because the hard reset zeroes paid
balance without a matching per-user ledger entry (by design — see token_reset.ts). This
is expected for a one-time administrative wipe; re-baseline recon after the run.

## STEP 4 — Clean up

```bash
ALLOW_PROD=1 npx wrangler secret delete TOKEN_RESET_SECRET
```

---

## Verify a sample user afterwards

```bash
# Should show spendable=100, bonus=100, free=0, balance=0.
curl -s -X POST https://api.avatok.ai/api/wallet/op ...   # (or read via the app wallet chip)
```
