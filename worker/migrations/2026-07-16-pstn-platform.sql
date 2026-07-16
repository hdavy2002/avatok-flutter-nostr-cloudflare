-- [AVA-RCPT-*] PSTN voicemail platform (Canonical Architecture v1.0).
-- Spec: Specs/PLAN-2026-07-16-ava-receptionist-guardian-FINAL.md ("Rollout
-- inversion": V1 ships VOICEMAIL FOR EVERYONE; AI pipeline merged but dark).
-- Everything here ships DARK behind the `pstnVoicemail` flag
-- (worker/src/routes/config.ts DEFAULTS, default false) — while OFF, the
-- webhook routes run in pure-probe mode and these tables see only orphan/
-- probe writes (never routed to a real owner's inbox).
--
-- Apply (DB_META): scripts/cf.sh worker d1 execute avatok-meta --remote --file=migrations/2026-07-16-pstn-platform.sql
-- Idempotent (CREATE ... IF NOT EXISTS); safe to run once. Worker guards every
-- read/write in try/catch, so shipping the code before this migration lands
-- simply keeps the (already probe-only) feature's D1 writes best-effort no-ops.

-- Vobiz DIDs in the shared pool (plan §"Cost guardrails": DIDs are shared,
-- never per-user). Separate namespace from AvaTOK virtual numbers
-- (numbering.ts never-PSTN invariant) — this table never intersects it.
CREATE TABLE IF NOT EXISTS pstn_dids (
  did        TEXT NOT NULL,   -- E.164 of the Vobiz DID
  status     TEXT NOT NULL,   -- 'active' | 'disabled'
  added_ms   INTEGER NOT NULL,
  PRIMARY KEY (did)
);

-- Per-owner carrier conditional-forwarding state (Phase 2, AVA-RCPT-7 — the
-- forwarding-setup screen). One row per account; sim_slot/carrier record
-- WHICH SIM the MMI codes were dialed on (forwarding is per-SIM).
CREATE TABLE IF NOT EXISTS pstn_forwarding (
  uid          TEXT NOT NULL,      -- owner account uid
  sim_slot     INTEGER,            -- 0/1 dual-SIM slot the codes were dialed on
  carrier      TEXT,               -- carrier name/mcc-mnc, best-effort
  cfb_set      INTEGER NOT NULL DEFAULT 0,  -- forward-when-busy (*67*<DID>#) confirmed set
  cfnry_set    INTEGER NOT NULL DEFAULT 0,  -- forward-when-unanswered (*61*<DID>#) confirmed set
  did          TEXT,               -- pool DID assigned to this owner's forwarding
  consent_ms   INTEGER,            -- when the owner confirmed the recording-consent notice
  updated_ms   INTEGER NOT NULL,
  PRIMARY KEY (uid)
);

-- Per-call cost/outcome accounting (plan AVA-RCPT-22). Populated best-effort
-- from the hangup webhook (BillDuration/cost) and the execution path
-- (execution_mode, degraded). Feeds per-owner-per-month cost rollups later.
CREATE TABLE IF NOT EXISTS pstn_call_costs (
  call_uuid       TEXT NOT NULL,   -- Vobiz CallUUID — natural key for this leg
  owner_uid       TEXT,            -- resolved owner, if any (null for ORPHAN calls)
  trace_id        TEXT,
  bill_duration   INTEGER,         -- Vobiz-reported billed seconds
  vobiz_cost      REAL,            -- Vobiz-reported cost for the leg, if provided
  execution_mode  TEXT,            -- 'VOICEMAIL' | 'AI_AGENT' | 'REJECT' (platform_types.ExecutionMode)
  degraded        INTEGER NOT NULL DEFAULT 0, -- 1 if this call hit a failure/fallback edge
  created_ms      INTEGER NOT NULL,
  PRIMARY KEY (call_uuid)
);
CREATE INDEX IF NOT EXISTS idx_pstn_call_costs_owner
  ON pstn_call_costs (owner_uid, created_ms);
