-- One Brain — §10 Guardian, Phase 1 (SPEC-2026-07-17 §10.3). The SAFETY store.
--
-- guardian_events is the restricted, legal-basis safety store (BRAIN_DOMAINS.safety,
-- basis:'legal'). It is NOT per-user brain memory (§10.3): a separate store on the
-- SAME governance plane as the brain (one ingest contract, §3.2 idempotency, one
-- audit, one retention policy) but with its OWN retention clock and NO brainRecall
-- path. Written directly and only by worker/src/lib/guardian/ (guardianIngest); read
-- only via guardianContext() (ACL, lint-enforced). Lives in DB_BRAIN (avatok-brain),
-- following the brain_events convention (high-volume, idempotency-keyed event log).
--
-- Records MINIMAL derived facts only — category/severity, subject+counterparty ids,
-- action, model version, appeal state, ts. NEVER raw message content (§10.3, B-D1).
--
-- Apply: wrangler d1 execute avatok-brain --remote --file=worker/migrations/guardian_phase1.sql
--        (and the staging DB avatok-brain-staging). IF-safe / additive — re-runnable.

-- ── DB_BRAIN (avatok-brain) ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS guardian_events (
  id               TEXT PRIMARY KEY,
  subject_uid      TEXT NOT NULL,      -- the actor the event is ABOUT (the sender / flagged party)
  counterparty_uid TEXT,              -- the other party (recipient), if any — two-party by nature (§10.3)
  conversation_id  TEXT,              -- the conversation the event arose in (guardianContext filter)
  category         TEXT NOT NULL,     -- 'scam' | 'grooming' | 'csae' | 'trafficking' | 'threat' | 'hate' | 'spam'
  severity         INTEGER NOT NULL,  -- 1 low … 3 high
  action           TEXT NOT NULL,     -- 'flag' | 'warn' | 'block' | 'ban'
  model_version    TEXT,              -- classifier/model version if available (provenance — §10.6)
  appeal_state     TEXT,              -- 'none' | 'requested' | 'upheld' | 'overturned'
  idempotency_key  TEXT,              -- §3.2 stable dedup key (queue redelivery / double-fire collapse)
  ts               INTEGER NOT NULL,  -- event time (producer clock)
  created_at       INTEGER NOT NULL   -- server ingest time (retention clock reads this)
);

-- §3.2 idempotency — partial unique index (only where a key is present, so multiple
-- NULLs never collide). Mirrors ux_brain_events_idem.
CREATE UNIQUE INDEX IF NOT EXISTS ux_guardian_events_idem
  ON guardian_events(subject_uid, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- guardianContext() reader: recent events for a subject (optionally per conversation).
CREATE INDEX IF NOT EXISTS idx_guardian_events_subject
  ON guardian_events(subject_uid, created_at DESC);

-- §10.2 retention sweep: age out by created_at, partitioned by enforcement vs flag.
CREATE INDEX IF NOT EXISTS idx_guardian_events_retention
  ON guardian_events(created_at);
