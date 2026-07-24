-- [AVABRAIN-VOICE-BILL-1] Session-lease state for the personal AvaBrain Gemini
-- Live voice path (worker/src/routes/ava_live.ts + worker/src/lib/voice_billing.ts).
--
-- WHY THIS TABLE EXISTS: ava_live.ts mints a Gemini Live ephemeral token and the
-- CLIENT connects DIRECTLY to Google's websocket — the Worker never proxies the
-- audio (unlike do/reception_room.ts, which bridges the call and can settle
-- exactly at hangup). Without a server-side witness to "the call is still live",
-- the server has no way to know when to stop billing except a lease the CLIENT
-- must renew (heartbeat) and a RESERVER-side expiry the server enforces on its
-- own clock. This table is that lease. The client is NEVER the billing
-- authority — it can only prove it's still connected; every token amount is
-- computed here from server timestamps (started_at / last_heartbeat_at), never
-- from a client-reported duration.
--
-- Money itself is NOT tracked here twice: the real, permanent debit happens in
-- WalletDO via feature_pricing.chargeAmount (idempotent by op_id, same primitive
-- receptionist billing uses), and the runway HOLD happens in WalletDO's existing
-- generic reserve/release_reservation escrow ([AVA-CAMP-B1-WALLET], reused
-- as-is — no wallet.ts changes). This D1 row is only the AvaBrain-voice-specific
-- lease/heartbeat bookkeeping: how much wall-clock time has been proven live,
-- how many tokens have already been permanently charged for it, and whether the
-- lease is still active — so a retried heartbeat/close/reap is a pure no-op
-- replay rather than a double charge.
--
-- D1 binding: DB_WALLET = avatok-wallet (same binding ai_billing_ledger.sql and
-- wallet_ledger.sql already use — no new D1 database needed).
--
-- Apply: scripts/cf.sh worker d1 execute DB_WALLET --remote \
--   --file=migrations/2026-07-24-avabrain-voice-leases.sql
-- (staging is the default target; prod requires ALLOW_PROD=1 — never invoke
-- wrangler directly, per the repo's staging/prod rules.)
-- [AVABRAIN-VOICE-BILL-1] SHOULD-FIX 6 (2026-07-24 Opus review) — added
-- `payer_uid`. The wallet that ADMITS a session (reserve/402 check at start)
-- must be the SAME wallet that ultimately PAYS for it (chargeAmount at
-- settle), or a Team member's admission check reads their own wallet while
-- the real charge silently lands on the team wallet. `payer_uid` is
-- `billingUidFor(env, uid)` resolved ONCE at lease start (voice_billing.ts
-- startVoiceLease) and used for every reserve/top-up/charge/release this
-- session ever makes, so admission and settlement can never split across two
-- wallets. NOTE: this table had not yet been applied anywhere (the feature is
-- still dark behind `avaBrainVoiceBillingEnabled`, which is not yet declared
-- in routes/config.ts), so `payer_uid` is folded straight into the CREATE
-- TABLE below rather than a separate ALTER TABLE. If this migration was
-- already applied to a live D1 before this column existed, run
-- `ALTER TABLE avabrain_voice_leases ADD COLUMN payer_uid TEXT NOT NULL DEFAULT ''`
-- by hand first (D1/SQLite has no `ADD COLUMN IF NOT EXISTS`).
CREATE TABLE IF NOT EXISTS avabrain_voice_leases (
  session_id         TEXT PRIMARY KEY,   -- server-generated (NEVER client-chosen) — the wallet reservation ref is `avalive:<session_id>`
  uid                 TEXT NOT NULL,      -- the session OWNER (whose call this is / whose identity the lease is scoped to)
  payer_uid           TEXT NOT NULL,      -- the wallet that pays (billingUidFor(uid) at lease start — team wallet if uid is a team member, else == uid)
  email               TEXT,               -- snapshotted at mint time, for telemetry pulls even if identity changes later
  status              TEXT NOT NULL,      -- 'active' | 'closed' | 'reaped' | 'blocked'
  started_at          INTEGER NOT NULL,   -- server clock at token mint == lease/billing origin instant
  last_heartbeat_at    INTEGER NOT NULL,   -- last proof-of-life instant (mint counts as the first one)
  lease_expires_at     INTEGER NOT NULL,   -- last_heartbeat_at + LEASE_TIMEOUT_MS; past this and still 'active' => reapable
  tokens_reserved_cum   INTEGER NOT NULL DEFAULT 0, -- cumulative amount ever added to the WalletDO reservation ref (reserve() is additive; never reset)
  tokens_charged       INTEGER NOT NULL DEFAULT 0, -- set EXACTLY ONCE, at settle (close or reap) — see voice_billing.ts settleOnce(); stays 0 for the whole life of an active lease (BLOCKER 1 fix: heartbeats never charge)
  close_reason         TEXT,               -- set when status leaves 'active': 'client_close' | 'lease_expired_no_heartbeat' | 'wallet_blocked' | ...
  closed_at            INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
-- Reaper sweep: find active leases whose lease has expired, oldest first.
CREATE INDEX IF NOT EXISTS idx_avabrain_voice_leases_reap ON avabrain_voice_leases(status, lease_expires_at);
-- Lazy per-user reap-on-touch (see startVoiceLease/heartbeatVoiceLease in
-- voice_billing.ts): before a user starts/continues a session, sweep THEIR OWN
-- stale leases first so an abandoned session's escrow hold is released promptly
-- even with no cron wired yet.
CREATE INDEX IF NOT EXISTS idx_avabrain_voice_leases_uid ON avabrain_voice_leases(uid, status, lease_expires_at);
